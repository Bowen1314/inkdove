import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { badRequest, clip, HttpError, newId, normalizeText, notFound, nowIso } from '../util.js';
import { detectKind, KIND_MIME, parseBuffer, UNSUPPORTED_MESSAGE } from '../sources/parse.js';
import { fetchSite } from '../sources/fetch-url.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function rowToSource(r) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    size: r.size,
    chars: r.chars,
    status: r.status,
    error: r.error ?? null,
    createdAt: r.created_at,
    distilledAt: r.distilled_at ?? null,
  };
}

/** @param {any} ctx */
export function sourcesRouter(ctx) {
  const { db, config } = ctx;
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 20 },
    defParamCharset: 'utf8',
  });

  const insert = (s) => {
    db.prepare(
      `INSERT INTO sources(id, kind, name, mime, size, chars, status, error, text, file_path, created_at, distilled_at)
       VALUES(@id, @kind, @name, @mime, @size, @chars, @status, @error, @text, @filePath, @createdAt, NULL)`,
    ).run(s);
    return rowToSource(db.prepare('SELECT * FROM sources WHERE id = ?').get(s.id));
  };

  router.get('/', (_req, res) => {
    res.json(db.prepare('SELECT * FROM sources ORDER BY created_at DESC, rowid DESC').all().map(rowToSource));
  });

  router.post('/upload', (req, res, next) => {
    upload.array('files')(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'file_too_large', '单个文件不能超过 20MB'));
        if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('上传字段名应为 files', 'upload_error'));
        return next(badRequest(`上传失败：${err.message}`, 'upload_error'));
      }
      next(err);
    });
  }, async (req, res) => {
    const files = /** @type {Express.Multer.File[]} */ (req.files || []);
    if (!files.length) throw badRequest('没有收到文件（字段名 files）');
    const out = [];
    for (const f of files) {
      const id = newId();
      const name = path.basename(f.originalname || 'file');
      const kind = detectKind(name, f.mimetype);
      const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      const filePath = path.join('uploads', `${id}${ext}`);
      fs.writeFileSync(path.join(config.dataDir, filePath), f.buffer);
      let text = '';
      let status = 'ready';
      let error = null;
      try {
        if (!kind) throw new Error(UNSUPPORTED_MESSAGE);
        text = await parseBuffer(f.buffer, kind);
      } catch (e) {
        status = 'error';
        error = `解析失败：${e?.message || e}`;
      }
      out.push(
        insert({
          id,
          kind: 'file',
          name,
          mime: kind ? KIND_MIME[kind] : f.mimetype || 'application/octet-stream',
          size: f.size,
          chars: text.length,
          status,
          error,
          text,
          filePath,
          createdAt: nowIso(),
        }),
      );
    }
    res.json(out);
  });

  router.post('/url', async (req, res) => {
    const { url, crawl } = req.body || {};
    if (typeof url !== 'string' || !url.trim()) throw badRequest('请填写网址');
    let maxPages = 10;
    if (req.body?.maxPages !== undefined && req.body.maxPages !== null) {
      maxPages = Number(req.body.maxPages);
      if (!Number.isInteger(maxPages) || maxPages < 1) throw badRequest('maxPages 必须是正整数');
    }
    maxPages = Math.min(maxPages, 30);
    const doCrawl = crawl === true;
    const { pages, bytes, firstError } = await fetchSite(url.trim(), { crawl: doCrawl, maxPages: doCrawl ? maxPages : 1 });
    const text = normalizeText(pages.map((p) => `## ${p.title} (${p.url})\n\n${p.text}`).join('\n\n'));
    const ok = pages.length > 0 && text.length > 0;
    const source = insert({
      id: newId(),
      kind: 'url',
      name: clip(pages[0]?.title && pages[0].title !== pages[0].url ? pages[0].title : url.trim(), 200),
      mime: 'text/html',
      size: bytes,
      chars: ok ? text.length : 0,
      status: ok ? 'ready' : 'error',
      error: ok ? null : `抓取失败：${firstError?.message || '没有提取到文字'}`,
      text: ok ? text : '',
      filePath: null,
      createdAt: nowIso(),
    });
    res.json(source);
  });

  router.post('/text', (req, res) => {
    const { name, text } = req.body || {};
    if (typeof text !== 'string' || !normalizeText(text)) throw badRequest('文本不能为空');
    if (name !== undefined && typeof name !== 'string') throw badRequest('name 必须是字符串');
    const body = normalizeText(text);
    const source = insert({
      id: newId(),
      kind: 'text',
      name: clip((name || '').trim() || `粘贴文本 ${nowIso().slice(0, 16).replace('T', ' ')}`, 200),
      mime: 'text/plain',
      size: Buffer.byteLength(text),
      chars: body.length,
      status: 'ready',
      error: null,
      text: body,
      filePath: null,
      createdAt: nowIso(),
    });
    res.json(source);
  });

  router.get('/:id', (req, res) => {
    const r = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
    if (!r) throw notFound('资料不存在');
    res.json({ ...rowToSource(r), preview: r.text.slice(0, 3000) });
  });

  router.delete('/:id', (req, res) => {
    const r = db.prepare('SELECT file_path FROM sources WHERE id = ?').get(req.params.id);
    if (!r) throw notFound('资料不存在');
    db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
    if (r.file_path) fs.rm(path.join(config.dataDir, r.file_path), { force: true }, () => {});
    res.json({ ok: true });
  });

  return router;
}
