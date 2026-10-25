// F15 产品资料库：可以发给客户的文件。文件本体存在 DATA_DIR/files/<id>，元数据在 files 表。
// 描述（description）告诉机器人这个文件是什么、什么时候该发；上传后排队自动生成（并发 1），管理员改过就记 manual。
import fs from 'node:fs';
import path from 'node:path';
import { bm25Rank, createTokenCache } from '../kb/search.js';
import { llmConfigured } from '../settings.js';
import { KIND_MIME, parseBuffer } from '../sources/parse.js';
import { clip, newId, nowIso, safeJsonParse } from '../util.js';

export const MAX_SENDABLE_BYTES = 50 * 1024 * 1024;
export const MAX_CONTEXT_FILES = 50;
export const MAX_FILES_PER_REPLY = 3;
export const DESCRIPTION_STATUSES = ['pending', 'ready', 'failed', 'manual'];
const MAX_STORED_TEXT = 20_000;
const DESCRIBE_TEXT_CHARS = 12_000;
const MAX_DESCRIPTION = 2000;

/** 扩展名 → {mime, kind}；kind 是 sources/parse.js 的解析类型，图片为 image */
const SENDABLE = {
  '.pdf': { kind: 'pdf' },
  '.xlsx': { kind: 'xlsx' },
  '.xls': { kind: 'xls' },
  '.csv': { kind: 'csv' },
  '.docx': { kind: 'docx' },
  '.pptx': { kind: 'pptx' },
  '.txt': { kind: 'txt' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.webp': { kind: 'image', mime: 'image/webp' },
};
const MIME_EXT = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
export const SUPPORTED_FILE_HINT = '支持 pdf、xlsx、xls、csv、docx、pptx、txt、jpg、png、webp';

/**
 * 判断能不能作为可发送文件。先看扩展名，没有扩展名时看 mime。
 * @returns {{kind:string, mime:string}|null}
 */
export function detectSendable(filename, mime) {
  let ext = path.extname(filename || '').toLowerCase();
  if (!SENDABLE[ext]) ext = MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
  const d = SENDABLE[ext];
  if (!d) return null;
  return { kind: d.kind, mime: d.mime || KIND_MIME[d.kind] };
}

export const isImageMime = (mime) => /^image\/(jpeg|png|webp)$/.test(String(mime || ''));

/** 文件在检索和提示词里用的文本 */
export const fileSearchText = (f) => `${f.name}\n${f.filename}\n${f.description}\n${(f.tags || []).join(' ')}`;

/** 文件切好的词按文本缓存：文件超过 50 个时每次回复都要排，不用每次把所有文件重新切一遍 */
const fileTokens = createTokenCache();

/**
 * 回复上下文里的文件：不超过 50 个就全放；超过时按和客户消息的 BM25 相关度取前 50，不够 50 个再按发送次数补齐。
 * @returns {{files:any[], truncated:boolean}}
 */
export function selectContextFiles(files, query, limit = MAX_CONTEXT_FILES) {
  if (files.length <= limit) return { files, truncated: false };
  const ranked = bm25Rank(query, files, fileSearchText, { tokenCache: fileTokens }).map((r) => r.doc);
  const picked = new Set(ranked.slice(0, limit));
  if (picked.size < limit) {
    const rest = files.filter((f) => !picked.has(f)).sort((a, b) => b.sendCount - a.sendCount);
    for (const f of rest) {
      if (picked.size >= limit) break;
      picked.add(f);
    }
  }
  return { files: files.filter((f) => picked.has(f)), truncated: true };
}

export function rowToFile(r) {
  return {
    id: r.id,
    name: r.name,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    description: r.description,
    descriptionStatus: r.description_status,
    tags: safeJsonParse(r.tags, []),
    status: r.status,
    kbSourceId: r.kb_source_id ?? null,
    sendCount: r.send_count,
    lastSentAt: r.last_sent_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * @param {any} ctx 需要 db、config、log、ai、getSettings
 */
export function createFileStore(ctx) {
  const { db, config, log } = ctx;
  const dir = path.join(config.dataDir, 'files');
  /** @type {string[]} */
  const queue = [];
  let running = false;
  let closed = false;

  const getRow = (id) => db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  const filePath = (id) => path.join(dir, path.basename(String(id)));

  /** 新文件的描述状态：模型没配 → manual；图片且没开图片识别 → manual；文档没提取到文字 → failed；其余排队生成 */
  function initialDescriptionStatus(kind, text) {
    if (!llmConfigured(ctx.getSettings(), config)) return 'manual';
    if (kind === 'image') return ctx.getSettings().media.image ? 'pending' : 'manual';
    return text ? 'pending' : 'failed';
  }

  async function describeOne(id) {
    const r = getRow(id);
    if (!r || r.description_status !== 'pending') return;
    let description = '';
    try {
      const args = { name: r.name, filename: r.filename, mime: r.mime };
      if (isImageMime(r.mime)) {
        args.image = { mime: r.mime, data: (await fs.promises.readFile(filePath(id))).toString('base64') };
      } else {
        args.text = clip(r.text, DESCRIBE_TEXT_CHARS);
      }
      description = clip(String((await ctx.ai.describeFile(args)) || '').trim(), MAX_DESCRIPTION);
      if (!description) throw new Error('模型未返回描述');
    } catch (err) {
      if (closed) return;
      log.warn(`[files] 文件 ${id} 自动生成描述失败：${err?.message || err}`);
      db.prepare("UPDATE files SET description_status = 'failed', updated_at = ? WHERE id = ? AND description_status = 'pending'").run(
        nowIso(),
        id,
      );
      return;
    }
    if (closed) return;
    // 生成期间管理员手动改过描述的，以管理员的为准
    db.prepare(
      "UPDATE files SET description = ?, description_status = 'ready', updated_at = ? WHERE id = ? AND description_status = 'pending'",
    ).run(description, nowIso(), id);
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !closed) {
        const id = queue.shift();
        try {
          await describeOne(id);
        } catch (err) {
          if (!closed) log.error(`[files] 描述队列出错：${err?.stack || err}`);
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(id) {
    if (closed || queue.includes(id)) return;
    queue.push(id);
    setImmediate(() => pump());
  }

  const store = {
    filePath,
    get(id) {
      const r = getRow(id);
      return r ? rowToFile(r) : null;
    },
    /** @param {{q?:string, status?:string}} f */
    list({ q = '', status = '' } = {}) {
      let rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC, rowid DESC').all().map(rowToFile);
      if (status) rows = rows.filter((f) => f.status === status);
      const needle = String(q || '').trim().toLowerCase();
      if (needle) rows = rows.filter((f) => fileSearchText(f).toLowerCase().includes(needle));
      return rows;
    },
    activeFiles() {
      return db.prepare("SELECT * FROM files WHERE status = 'active' ORDER BY created_at, rowid").all().map(rowToFile);
    },

    /**
     * 收下一个已经落到临时目录的上传文件：挪到 files/<id>，抽文字，按需建知识库资料，排队生成描述。
     * @param {{tmpPath:string, originalname:string, size:number, kind:string, mime:string}} up
     */
    async add(up, { addToKb = true } = {}) {
      const id = newId();
      const filename = clip(path.basename(up.originalname || 'file'), 200);
      const dest = filePath(id);
      await fs.promises.rename(up.tmpPath, dest);
      let text = '';
      let parseError = null;
      if (up.kind !== 'image') {
        try {
          text = await parseBuffer(await fs.promises.readFile(dest), up.kind);
        } catch (err) {
          parseError = String(err?.message || err);
        }
      }
      const now = nowIso();
      let kbSourceId = null;
      if (addToKb && up.kind !== 'image') {
        kbSourceId = newId();
        db.prepare(
          `INSERT INTO sources(id, kind, name, mime, size, chars, status, error, text, file_path, created_at, distilled_at)
           VALUES(?, 'file', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        ).run(kbSourceId, filename, up.mime, up.size, text.length, text ? 'ready' : 'error', text ? null : `解析失败：${parseError}`, text, now);
      }
      const status = initialDescriptionStatus(up.kind, text);
      db.prepare(
        `INSERT INTO files(id, name, filename, mime, size, description, description_status, tags, status, kb_source_id, send_count, last_sent_at, text, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, '', ?, '[]', 'active', ?, 0, NULL, ?, ?, ?)`,
      ).run(id, clip(filename.replace(/\.[a-z0-9]{1,5}$/i, '') || filename, 200), filename, up.mime, up.size, status, kbSourceId, clip(text, MAX_STORED_TEXT), now, now);
      if (status === 'pending') enqueue(id);
      return store.get(id);
    },

    /** @param {{name?:string, description?:string, tags?:string[], status?:string}} patch 已校验 */
    update(id, patch) {
      const r = getRow(id);
      if (!r) return null;
      const next = {
        name: patch.name ?? r.name,
        description: patch.description ?? r.description,
        descriptionStatus: patch.description !== undefined ? 'manual' : r.description_status,
        tags: patch.tags ? JSON.stringify(patch.tags) : r.tags,
        status: patch.status ?? r.status,
      };
      db.prepare('UPDATE files SET name = ?, description = ?, description_status = ?, tags = ?, status = ?, updated_at = ? WHERE id = ?').run(
        next.name,
        next.description,
        next.descriptionStatus,
        next.tags,
        next.status,
        nowIso(),
        id,
      );
      return store.get(id);
    },

    /** 删除文件（对应的知识库资料保留） */
    remove(id) {
      const r = getRow(id);
      if (!r) return false;
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
      db.prepare('DELETE FROM file_meta_media WHERE file_id = ?').run(id);
      fs.rm(filePath(id), { force: true }, () => {});
      return true;
    },

    /** 重新生成描述。调用方先检查模型是否配置、图片识别是否开启 */
    redescribe(id) {
      db.prepare("UPDATE files SET description_status = 'pending', updated_at = ? WHERE id = ?").run(nowIso(), id);
      enqueue(id);
      return store.get(id);
    },

    /** 成功发出一次（机器人、后台人工、F3 /d 都算） */
    markSent(id) {
      const now = nowIso();
      db.prepare('UPDATE files SET send_count = send_count + 1, last_sent_at = ? WHERE id = ?').run(now, id);
    },

    /** Meta 上传后的 media id 缓存（按号码 id 分开，25 天） */
    metaMediaGet(fileId, phoneNumberId, maxAgeMs) {
      const r = db.prepare('SELECT media_id, uploaded_at FROM file_meta_media WHERE file_id = ? AND phone_number_id = ?').get(fileId, phoneNumberId);
      if (!r || Date.now() - Date.parse(r.uploaded_at) > maxAgeMs) return null;
      return r.media_id;
    },
    metaMediaSet(fileId, phoneNumberId, mediaId) {
      db.prepare(
        `INSERT INTO file_meta_media(file_id, phone_number_id, media_id, uploaded_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(file_id, phone_number_id) DO UPDATE SET media_id = excluded.media_id, uploaded_at = excluded.uploaded_at`,
      ).run(fileId, phoneNumberId, mediaId, nowIso());
    },

    /** 进程启动时把上次没生成完的描述重新排队 */
    resumePending() {
      for (const r of db.prepare("SELECT id FROM files WHERE description_status = 'pending' ORDER BY created_at").all()) enqueue(r.id);
    },
    /** 测试用：描述队列空了 */
    idle() {
      return !running && queue.length === 0;
    },
    close() {
      closed = true;
      queue.length = 0;
    },
  };
  return store;
}
