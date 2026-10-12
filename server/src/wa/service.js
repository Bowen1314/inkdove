// WhatsApp 业务层（第二期：按号）。每个号（Account）有自己的接入方式、自动回复开关、回复范围、通知和代理；
// 会话 id 是 <accountId>:<chatId>。四层防滥用的第 4 层（会话级闸门）在这里，回复拟真（F1/F14）和
// 在 WhatsApp 里处理转人工（F3）也在这里。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { conversationIdOf, DELETED_ACCOUNT_NAME, metaConfigured } from '../accounts.js';
import { internalFileUrl } from '../files/signed.js';
import { MAX_FILES_PER_REPLY } from '../files/store.js';
import { ENTRY_TYPES, normalizeTags } from '../kb/store.js';
import { buildReplyContext, decideReply, normalizeFileIds } from '../reply/engine.js';
import { llmConfigured } from '../settings.js';
import { badRequest, clip, HttpError, newId, notFound, nowIso, safeJsonParse, sleep } from '../util.js';
import { baseMime, MEDIA_LIMITS, mediaTypeOf, oggDurationSeconds, wahaVoiceSeconds } from './media.js';
import { metaDownloadMedia, metaMarkRead, metaSendMedia, metaSendText, metaUploadMedia } from './meta.js';
import { createNotifier, shortMessageId } from './notify.js';
import { needsRelay } from './relay.js';
import { createWahaClient, mapWahaStatus, TooLargeError, WahaError } from './waha.js';

const REPLIES_PER_MINUTE_PER_ACCOUNT = 30;
const OFFTOPIC_STRIKES = 3;
const OFFTOPIC_WINDOW_MS = 24 * 3600 * 1000;
const MUTE_MS = 24 * 3600 * 1000;
export const DAILY_LLM_LIMIT = 60;
const LID_CACHE_MS = 10 * 60 * 1000;
const OLD_MESSAGE_GRACE_MS = 60 * 1000;
const MAX_STORED_TEXT = 10_000;
const MAX_OPERATOR_TEXT = 4096;
const USAGE_HINT_INTERVAL_MS = 10 * 60 * 1000;
const ECHO_ID_KEEP_MS = 10 * 60 * 1000;
const ECHO_TEXT_WINDOW_MS = 30 * 1000;
// F15：同一会话每天最多自动发 5 个文件；WAHA 15MB 以内直接传 base64，更大的给签名下载地址；Meta 的 media id 缓存 25 天
export const DAILY_FILE_LIMIT = 5;
export const WAHA_INLINE_MAX_BYTES = 15 * 1024 * 1024;
const META_MEDIA_CACHE_MS = 25 * 24 * 3600 * 1000;
const META_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DRAFT_TEXT = 4000;
const MAX_CAPTION = 1024;

// F14：两段及以上、总长超过 160 字符的回复按段落拆开发，最多 3 条
export const SPLIT_MIN_CHARS = 160;
export const MAX_REPLY_PARTS = 3;

export const USAGE_HINT =
  '用法：引用（回复）某条转人工通知再发文字，内容会转发给那位客户；引用后发 /d 发送通知里的草稿，发 /resume 恢复机器人。通知超过 7 天后不能再引用。';

const rand = (a, b) => a + Math.random() * (b - a);
/** F1 拟真等待的默认时长（毫秒）。测试里整体注入成 0 */
export const DEFAULT_HUMANIZE = {
  preMs: () => rand(1000, 3000),
  typingMs: (len) => Math.min(10, Math.max(2, len / 12)) * 1000 * rand(0.8, 1.2),
  betweenMs: () => rand(500, 1500),
  // F15：文字发完后停 1–2 秒再发文件
  fileGapMs: () => rand(1000, 2000),
};

const CONV_SQL = `SELECT c.*, a.name AS account_name, m.text AS lm_text, m.attachment AS lm_attachment, m.direction AS lm_direction, m.ts AS lm_ts
  FROM conversations c
  LEFT JOIN accounts a ON a.id = c.account_id
  LEFT JOIN messages m ON m.seq = (SELECT MAX(seq) FROM messages WHERE conversation_id = c.id)`;

/** 群聊、广播、频道 */
export const isNonPrivateChat = (chatId) =>
  /@g\.us$/i.test(chatId) || /@broadcast$/i.test(chatId) || /@newsletter$/i.test(chatId);

/** 本地日期 YYYY-MM-DD（容器可用 TZ 环境变量调整） */
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function mediaLabel(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return '[图片]';
  if (m.startsWith('audio/')) return '[语音]';
  if (m.startsWith('video/')) return '[视频]';
  if (m) return '[文件]';
  return '[媒体消息]';
}

/** F14：按空行分段，两段及以上且总长超过 160 字符时拆成最多 3 条，多出来的段落并进第 3 条 */
export function splitReply(text) {
  const t = String(text || '').trim();
  const paras = t
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length < 2 || t.length <= SPLIT_MIN_CHARS) return [t];
  if (paras.length <= MAX_REPLY_PARTS) return paras;
  return [...paras.slice(0, MAX_REPLY_PARTS - 1), paras.slice(MAX_REPLY_PARTS - 1).join('\n\n')];
}

/** 被引用消息的 id：WAHA 文档的 replyTo.id；GOWS 没填时退回原始消息里的 contextInfo.stanzaID */
function wahaQuotedId(p) {
  const direct = p.replyTo?.id;
  if (typeof direct === 'string' && direct) return direct;
  const msg = p._data?.Message || p._data?.message || {};
  const ctxInfo = msg.extendedTextMessage?.contextInfo || msg.ExtendedTextMessage?.ContextInfo || null;
  const sid = ctxInfo?.stanzaID ?? ctxInfo?.stanzaId ?? ctxInfo?.StanzaID ?? null;
  return typeof sid === 'string' && sid ? sid : null;
}

/** WAHA message payload → 统一的入站结构 */
export function parseWahaMessage(p) {
  const rawChat = String((p.fromMe ? p.to : p.from) || '');
  const chatId = rawChat.replace(/@s\.whatsapp\.net$/i, '@c.us');
  const body = typeof p.body === 'string' ? p.body.trim() : '';
  let label = null;
  if (!body) {
    if (p.hasMedia) label = mediaLabel(p.media?.mimetype);
    else if (p.location) label = '[位置]';
    else if (Array.isArray(p.vCards) && p.vCards.length) label = '[名片]';
    else label = '[非文字消息]';
  }
  const id = typeof p.id === 'string' ? p.id : p.id?._serialized || p.id?.id || null;
  let ts = Number(p.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
  else if (ts < 1e12) ts *= 1000; // payload.timestamp 是秒
  const d = p._data || {};
  const contactName = String(d.notifyName || d.pushName || d.Info?.PushName || d.pushname || '').trim();
  // F4：图片和语音。media.url 是 WAHA 下载好的文件地址（没下载时为 null），media.error 是下载出错的原因
  let media = null;
  const mtype = p.hasMedia ? mediaTypeOf(p.media?.mimetype) : null;
  if (mtype) {
    media = {
      type: mtype,
      mime: baseMime(p.media?.mimetype),
      url: typeof p.media?.url === 'string' && p.media.url ? p.media.url : null,
      error: p.media?.error ? String(typeof p.media.error === 'string' ? p.media.error : JSON.stringify(p.media.error)) : null,
      seconds: mtype === 'voice' ? wahaVoiceSeconds(p) : null,
    };
  }
  return {
    channel: 'waha',
    externalId: id,
    chatId,
    fromMe: !!p.fromMe,
    timestampMs: ts,
    text: body,
    mediaLabel: label,
    media,
    contactName,
    replyToId: wahaQuotedId(p),
  };
}

/** Meta webhook value.messages[] 里的一条 → 统一结构；reaction 返回 null */
export function parseMetaMessage(msg, names) {
  const type = msg.type;
  if (type === 'reaction' || type === 'system') return null;
  let text = '';
  let label = null;
  switch (type) {
    case 'text':
      text = msg.text?.body || '';
      break;
    case 'button':
      text = msg.button?.text || '';
      break;
    case 'interactive':
      text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
      break;
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker':
      text = msg[type]?.caption || '';
      label = { image: '[图片]', video: '[视频]', document: '[文件]', audio: '[语音]', sticker: '[贴纸]' }[type];
      break;
    case 'location':
      label = '[位置]';
      break;
    case 'contacts':
      label = '[名片]';
      break;
    default:
      label = '[非文字消息]';
  }
  text = String(text).trim();
  const ts = Number(msg.timestamp);
  const from = String(msg.from || '').replace(/\D+/g, '');
  // F4：图片 {id, mime_type, caption}、语音 {id, mime_type, voice}；文件要先用 media id 换下载地址
  let media = null;
  if ((type === 'image' || type === 'audio') && msg[type]?.id) {
    media = { type: type === 'image' ? 'image' : 'voice', mime: baseMime(msg[type].mime_type), id: String(msg[type].id), seconds: null };
  }
  return {
    channel: 'meta',
    externalId: msg.id ? String(msg.id) : null,
    chatId: from,
    fromMe: false,
    timestampMs: Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now(),
    text,
    mediaLabel: text ? null : label || '[非文字消息]',
    media,
    contactName: names.get(msg.from) || '',
    // 引用回复：messages[].context.id 是被引用消息的 wamid
    replyToId: msg.context?.id ? String(msg.context.id) : null,
  };
}

/** 会话草稿 {text, fileIds, createdAt}（F2a / F15）。A 段存的 {text, createdAt} 也认，fileIds 记 []；文字和文件都没有时视为没有草稿 */
export const parseDraft = (raw) => {
  const d = safeJsonParse(raw, null);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const text = typeof d.text === 'string' ? d.text : '';
  const fileIds = normalizeFileIds(d.fileIds).slice(0, MAX_FILES_PER_REPLY);
  if (!text.trim() && !fileIds.length) return null;
  return { text, fileIds, createdAt: typeof d.createdAt === 'string' ? d.createdAt : null };
};

/**
 * @param {any} ctx  需要 ctx.accounts（accounts.js 的存储）、ctx.mailer、ctx.relays
 * @param {{
 *   humanize?: Partial<typeof DEFAULT_HUMANIZE>,
 *   notifyRetryDelayMs?: number,
 *   onDecision?: (row:any) => void,
 *   wahaInlineMaxBytes?: number,
 * }} [opts]
 */
export function createWaService(ctx, opts = {}) {
  const { db, config, log, accounts, relays } = ctx;
  const waha = createWahaClient(config);
  const humanize = { ...DEFAULT_HUMANIZE, ...(opts.humanize || {}) };
  /** @type {Map<string, NodeJS.Timeout>} 会话 id → 防抖定时器 */
  const timers = new Map();
  /** @type {Map<string, {rerun:boolean}>} */
  const processing = new Map();
  /** @type {Map<string, AbortController>} 会话 id → 正在拟真发送的取消令牌（F1） */
  const sending = new Map();
  const inflight = new Set();
  /** @type {Map<string, number>} 已处理过的通知号码消息（防 webhook 重试） */
  const seenCommands = new Map();
  const lidCache = new Map();
  /** @type {Map<string, any>} 号 id → 运行时状态 */
  const accState = new Map();
  /** @type {Map<string, {id:string|null, short:string|null, chatId:string, text:string, at:number}[]>} 本服务经 API 发出的消息（F12 剔除回声用） */
  const recentSent = new Map();
  /** @type {Map<string, number>} 会话 id → 正在识别的语音/图片条数（F4）；识别完之前不处理这个会话 */
  const converting = new Map();
  const wahaInlineMax = opts.wahaInlineMaxBytes ?? WAHA_INLINE_MAX_BYTES;
  const startedAt = Date.now();
  let closed = false;

  const settings = () => ctx.getSettings();

  function state(accountId) {
    let s = accState.get(accountId);
    if (!s) {
      s = { lastWahaStatus: null, connectedAt: 0, lastWebhookAt: null, statusCache: null, replies: [], usageHintAt: 0 };
      accState.set(accountId, s);
    }
    return s;
  }

  // ---------------- 处理记录（F12 的 decisions 表由下一段接上） ----------------
  function recordDecision(accountId, conversationId, r) {
    if (!opts.onDecision) return;
    try {
      opts.onDecision({
        ts: nowIso(),
        accountId,
        conversationId,
        decision: r.decision,
        code: r.code,
        reason: r.reason,
        usedEntryIds: r.usedEntryIds || [],
        // F15：这一轮实际发出去的文件（F12 的 topFiles 用）
        sentFileIds: r.sentFileIds || [],
        latencyMs: r.latencyMs ?? 0,
      });
    } catch (err) {
      log.warn(`[wa] 记录处理结果失败：${err?.message || err}`);
    }
  }

  // ---------------- 发送 ----------------
  function rememberSent(accountId, chatId, text) {
    const now = Date.now();
    const list = (recentSent.get(accountId) || []).filter((e) => now - e.at < ECHO_ID_KEEP_MS);
    const entry = { id: null, short: null, chatId, text, at: now };
    list.push(entry);
    recentSent.set(accountId, list);
    return entry;
  }

  /** 发文本（不落库）。号被删了、未配置时抛错 */
  async function sendRaw(acc, chatId, text) {
    if (!acc) throw new Error('这个号已删除');
    const entry = rememberSent(acc.id, chatId, text);
    let id;
    if (acc.channel === 'waha') id = await waha.sendText(acc.sessionName, chatId, text);
    else if (acc.channel === 'meta') id = await metaSendText(config.metaGraphUrl, acc.meta, chatId, text);
    else throw new Error('未知的接入方式');
    entry.id = id || null;
    entry.short = id ? shortMessageId(id) : null;
    return id;
  }

  /**
   * F15：发一个文件（不落库）。WAHA：jpeg/png 用 sendImage，其余用 sendFile；15MB 以内传 base64，更大的给签名下载地址。
   * Meta：先上传拿 media id（按号码缓存 25 天），jpeg/png 且不超过 5MB 的发 image，其余发 document；缓存的 id 失效时重传一次。
   */
  async function sendFileRaw(acc, chatId, file, caption = '') {
    if (!acc) throw new Error('这个号已删除');
    const entry = rememberSent(acc.id, chatId, caption);
    const diskPath = ctx.files.filePath(file.id);
    const asImage = file.mime === 'image/jpeg' || file.mime === 'image/png';
    let id;
    if (acc.channel === 'waha') {
      const wfile = { mimetype: file.mime, filename: file.filename };
      if (file.size <= wahaInlineMax) wfile.data = (await fs.promises.readFile(diskPath)).toString('base64');
      else wfile.url = internalFileUrl(config, file.id);
      id = await waha.sendMedia(asImage ? 'image' : 'file', acc.sessionName, chatId, wfile, caption);
    } else if (acc.channel === 'meta') {
      if (file.mime === 'image/webp') throw new Error('Meta 不支持把 webp 图片当图片或文档发送，请换成 jpg 或 png');
      if (asImage && file.size > META_IMAGE_MAX_BYTES) throw new Error('Meta 发图片不能超过 5MB，请压缩后再上传');
      const pnid = acc.meta.phoneNumberId;
      const upload = async () => {
        // Meta 的文档类型里没有 csv，按纯文本上传（文件名不变）
        const mime = file.mime === 'text/csv' ? 'text/plain' : file.mime;
        const mediaId = await metaUploadMedia(config.metaGraphUrl, acc.meta, { buffer: await fs.promises.readFile(diskPath), mime, filename: file.filename });
        ctx.files.metaMediaSet(file.id, pnid, mediaId);
        return mediaId;
      };
      const send = (mediaId) =>
        metaSendMedia(config.metaGraphUrl, acc.meta, chatId, {
          kind: asImage ? 'image' : 'document',
          mediaId,
          filename: file.filename,
          caption,
        });
      const cached = ctx.files.metaMediaGet(file.id, pnid, META_MEDIA_CACHE_MS);
      if (cached) {
        try {
          id = await send(cached);
        } catch (err) {
          log.warn(`[wa] 用缓存的 media id 发文件失败，重新上传：${err?.message || err}`);
          id = await send(await upload());
        }
      } else {
        id = await send(await upload());
      }
    } else {
      throw new Error('未知的接入方式');
    }
    entry.id = id || null;
    entry.short = id ? shortMessageId(id) : null;
    return id;
  }

  /** 给某个号码发文本（通知、F3 回执用） */
  const sendToNumber = (acc, number, text) => sendRaw(acc, acc.channel === 'waha' ? `${number}@c.us` : number, text);

  const notifier = createNotifier({
    getSettings: ctx.getSettings,
    config,
    db,
    mailer: ctx.mailer,
    sendToNumber,
    retryDelayMs: opts.notifyRetryDelayMs,
    log,
  });

  // ---------------- 会话与消息 ----------------
  const getConvRow = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

  const attachmentLabel = (raw) => {
    const a = safeJsonParse(raw, null);
    return a?.filename ? `[文件] ${a.filename}` : '';
  };

  function rowToConversation(r) {
    const muted = r.muted_until && Date.parse(r.muted_until) > Date.now() ? r.muted_until : null;
    return {
      id: r.id,
      accountId: r.account_id,
      accountName: r.account_name ?? DELETED_ACCOUNT_NAME,
      contactName: r.contact_name,
      contactNumber: r.contact_number,
      lastMessage: r.lm_ts ? { text: r.lm_text || attachmentLabel(r.lm_attachment), direction: r.lm_direction, ts: r.lm_ts } : null,
      botPaused: !!r.bot_paused,
      needsHuman: !!r.needs_human,
      // 待处理原因：让会话进入待处理的那条消息的处理原因（置 needsHuman 时写入，清 needsHuman 时清空）
      pendingReason: r.needs_human ? r.pending_reason ?? null : null,
      mutedUntil: muted,
      draft: parseDraft(r.draft),
      updatedAt: r.updated_at,
    };
  }

  function rowToMessage(r) {
    const decision = r.direction === 'in' ? r.bot_decision ?? null : null;
    return {
      id: r.id,
      direction: r.direction,
      author: r.author,
      text: r.text,
      ts: r.ts,
      usedEntryIds: safeJsonParse(r.used_entry_ids, []),
      confident: r.confident === null || r.confident === undefined ? null : !!r.confident,
      botDecision: decision,
      decisionReason: decision && decision !== 'replied' ? r.decision_reason ?? null : null,
      via: r.via ?? null,
      sentByUserId: r.sent_by_user_id ?? null,
      sentByName: r.sent_by_name ?? null,
      // F4：客户发来的语音/图片 {type, mime}；F15：这条消息发的文件 {fileId, filename, mime, size}
      media: safeJsonParse(r.media, null),
      attachment: safeJsonParse(r.attachment, null),
      status: r.status,
      error: r.error ?? null,
    };
  }

  function conversationById(id) {
    const r = db.prepare(`${CONV_SQL} WHERE c.id = ?`).get(id);
    return r ? rowToConversation(r) : null;
  }

  const displayName = (conv) => conv.contact_name || (conv.contact_number ? `+${conv.contact_number}` : conv.chat_id || conv.id);

  function cancelTimer(convId) {
    const t = timers.get(convId);
    if (t) clearTimeout(t);
    timers.delete(convId);
  }

  /** 取消正在拟真等待的发送（F1：新消息、人工接管时） */
  function abortSending(convId, why) {
    const ac = sending.get(convId);
    if (ac && !ac.signal.aborted) ac.abort(new Error(why));
  }

  /** 把尚未处理的入站消息标为已处理（botDecision=skipped） */
  function skipPending(convId, reason) {
    db.prepare(
      `UPDATE messages SET handled = 1,
         decision_reason = CASE WHEN bot_decision IS NULL THEN ? ELSE decision_reason END,
         bot_decision = COALESCE(bot_decision, 'skipped')
       WHERE conversation_id = ? AND direction = 'in' AND handled = 0`,
    ).run(reason, convId);
  }

  /** 只处理已经是文字的客户消息；还在识别的语音/图片（kind=media）留给识别完的下一轮 */
  function settleMessages(convId, lastSeq, decision, reason, code = null) {
    db.prepare(
      `UPDATE messages SET handled = 1, bot_decision = ?, decision_reason = ?, decision_code = ?
       WHERE conversation_id = ? AND direction = 'in' AND kind = 'text' AND handled = 0 AND seq <= ?`,
    ).run(decision, decision === 'replied' ? null : reason || null, code, convId, lastSeq);
  }

  /**
   * 发出并落库。author=operator 时 via/sentBy 记是谁回的（F8 / F3）。
   * @param {any} acc
   * @param {any} conv 会话行
   */
  async function sendAndRecord(acc, conv, text, { author, via = null, sentBy = null, usedEntryIds = [], confident = null, partIndex = null }) {
    let status = 'sent';
    let error = null;
    let externalId = null;
    try {
      externalId = await sendRaw(acc, conv.chat_id || conv.id, text);
    } catch (err) {
      status = 'failed';
      error = String(err?.message || err);
      log.warn(`[wa] 发送到 ${conv.id} 失败：${error}`);
    }
    if (externalId && db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?').get(conv.id, externalId)) {
      externalId = null;
    }
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, used_entry_ids, confident, status, error, handled,
                            via, sent_by_user_id, sent_by_name, part_index)
       VALUES(?, ?, ?, 'out', ?, 'text', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      conv.id,
      externalId,
      author,
      text,
      ts,
      JSON.stringify(usedEntryIds),
      confident === null ? null : confident ? 1 : 0,
      status,
      error,
      via,
      sentBy?.id ?? null,
      sentBy?.name ?? null,
      partIndex,
    );
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conv.id);
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  /**
   * F15：发一个文件并另存一条消息（attachment 记文件信息，text 是 caption，没有就为空）。成功后文件的 sendCount 加 1。
   * @param {any} file SendableFile
   */
  async function sendFileAndRecord(acc, conv, file, { author, via = null, sentBy = null, caption = '' }) {
    let status = 'sent';
    let error = null;
    let externalId = null;
    try {
      externalId = await sendFileRaw(acc, conv.chat_id || conv.id, file, caption);
    } catch (err) {
      status = 'failed';
      error = String(err?.message || err);
      log.warn(`[wa] 发文件到 ${conv.id} 失败：${error}`);
    }
    if (externalId && db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?').get(conv.id, externalId)) {
      externalId = null;
    }
    if (status === 'sent') ctx.files.markSent(file.id);
    const id = newId();
    const ts = nowIso();
    const attachment = { fileId: file.id, filename: file.filename, mime: file.mime, size: file.size };
    db.prepare(
      `INSERT INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, used_entry_ids, confident, status, error, handled,
                            via, sent_by_user_id, sent_by_name, attachment)
       VALUES(?, ?, ?, 'out', ?, 'file', ?, ?, '[]', ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      conv.id,
      externalId,
      author,
      caption,
      ts,
      author === 'bot' ? 1 : null,
      status,
      error,
      via,
      sentBy?.id ?? null,
      sentBy?.name ?? null,
      JSON.stringify(attachment),
    );
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conv.id);
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  function sendNotice(acc, convId, reason, detail) {
    setImmediate(() => {
      notifier.notifyHandoff(acc, convId, reason, detail).catch((err) => log.error(`[notify] 通知失败：${err?.message || err}`));
    });
  }

  /**
   * 标 needsHuman（同时记下待处理原因）。needsHuman 从 false 变 true 时才发通知（4.2）；notify=false 时由调用方稍后自己发
   * （F2a：先生成草稿再通知）。返回这次是不是从 false 变成了 true。
   * @param {'handoff'|'blocked'|'non_text'|'rate_limit'} reason
   * @param {{pause:boolean, pendingReason?:string, notify?:boolean}} o pendingReason 默认用 detail
   */
  function flagNeedsHuman(acc, convId, reason, detail, { pause, pendingReason, notify = true }) {
    const before = getConvRow(convId);
    if (!before) return false;
    const why = clip(String(pendingReason ?? detail ?? '').trim(), 500) || null;
    db.prepare(`UPDATE conversations SET needs_human = 1, pending_reason = ?${pause ? ', bot_paused = 1' : ''} WHERE id = ?`).run(why, convId);
    if (pause) {
      cancelTimer(convId);
      abortSending(convId, 'paused');
      skipPending(convId, '会话已暂停（等人工处理）');
    }
    const fresh = !before.needs_human;
    if (fresh && acc && notify) sendNotice(acc, convId, reason, detail);
    return fresh;
  }

  /** 人工接管：会话进入 botPaused，草稿清空，取消防抖和拟真发送 */
  function operatorTakeover(convId) {
    db.prepare('UPDATE conversations SET bot_paused = 1, draft = NULL WHERE id = ?').run(convId);
    cancelTimer(convId);
    abortSending(convId, 'operator');
    skipPending(convId, '人工已接管');
  }

  /** 人工发送（后台或 F3 转发）：立即发，不做拟真等待；会话进入 botPaused，草稿清空 */
  async function operatorDeliver(acc, convId, text, { via, sentBy }) {
    operatorTakeover(convId);
    return sendAndRecord(acc, getConvRow(convId), clip(text, MAX_OPERATOR_TEXT), { author: 'operator', via, sentBy });
  }

  /** 人工发文件（后台或 F3 的 /d）：和人工发消息一样，会话进入 botPaused */
  async function operatorDeliverFile(acc, convId, file, { via, sentBy, caption = '' }) {
    operatorTakeover(convId);
    return sendFileAndRecord(acc, getConvRow(convId), file, { author: 'operator', via, sentBy, caption: clip(caption, MAX_CAPTION) });
  }

  function resumeBot(convId) {
    db.prepare('UPDATE conversations SET bot_paused = 0, needs_human = 0, pending_reason = NULL, draft = NULL WHERE id = ?').run(convId);
  }

  // ---------------- 入站 ----------------
  function cutoffMs(acc) {
    return Math.max(startedAt, acc.channel === 'waha' ? state(acc.id).connectedAt : 0) - OLD_MESSAGE_GRACE_MS;
  }

  async function resolveNumber(acc, m) {
    if (m.channel === 'meta') return m.chatId.replace(/\D+/g, '') || null;
    const at = m.chatId.lastIndexOf('@');
    const user = at >= 0 ? m.chatId.slice(0, at) : m.chatId;
    const server = at >= 0 ? m.chatId.slice(at + 1).toLowerCase() : '';
    if (server === 'c.us') return user.replace(/\D+/g, '') || null;
    if (server === 'lid') {
      const key = `${acc.id}|${m.chatId}`;
      const cached = lidCache.get(key);
      if (cached && Date.now() - cached.at < LID_CACHE_MS) return cached.number;
      let number = null;
      try {
        number = await waha.lidToNumber(acc.sessionName, m.chatId);
      } catch (err) {
        log.warn(`[wa] ${m.chatId} 换算手机号失败：${err?.message || err}`);
      }
      lidCache.set(key, { number, at: Date.now() });
      return number;
    }
    return null;
  }

  /** 4.1 黑白名单（按号） */
  function inScope(acc, number, chatId) {
    if (number && acc.blocklist.includes(number)) return false;
    if (acc.scope === 'allowlist') {
      if (!number) {
        log.info(`[wa] ${chatId} 换算不出手机号，allowlist 模式下按范围外处理`);
        return false;
      }
      return acc.allowlist.includes(number);
    }
    if (!number) log.warn(`[wa] ${chatId} 换算不出手机号，黑名单无法匹配，按 all 模式照常处理`);
    return true;
  }

  /**
   * 处理一条入站消息。返回处理结果（测试用）。
   * @param {any} acc 号（内部对象）
   * @param {ReturnType<typeof parseWahaMessage>} m
   */
  async function handleInbound(acc, m) {
    if (closed) return 'closed';
    if (!acc) return 'ignored_account';
    if (m.fromMe) return 'ignored_from_me';
    const chatId = m.chatId;
    if (!chatId || isNonPrivateChat(chatId)) return 'ignored_non_private';
    const convId = conversationIdOf(acc.id, chatId);
    const key = m.externalId ? `${acc.id}|${m.externalId}` : null;
    if (
      key &&
      (inflight.has(key) ||
        seenCommands.has(key) ||
        db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?').get(convId, m.externalId))
    ) {
      return 'ignored_duplicate';
    }
    if (m.timestampMs < cutoffMs(acc)) return 'ignored_old';
    if (key) inflight.add(key);
    try {
      const number = await resolveNumber(acc, m);
      const n = acc.notify.whatsapp;
      if (number && n.number && number === n.number) {
        // 通知号码：开了 WhatsApp 通知时按 F3 处理，否则按黑名单处理（4.2）
        if (!n.enabled) return 'out_of_scope';
        if (key) {
          const now = Date.now();
          for (const [k, t] of seenCommands) if (now - t > 3600_000) seenCommands.delete(k);
          seenCommands.set(key, now);
        }
        return await handleNotifyReply(acc, m);
      }
      if (!inScope(acc, number, chatId)) return 'out_of_scope';
      return archive(acc, m, number);
    } finally {
      if (key) inflight.delete(key);
    }
  }

  function archive(acc, m, number) {
    const now = nowIso();
    const convId = conversationIdOf(acc.id, m.chatId);
    const isText = !!m.text;
    db.prepare(
      `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         contact_name = CASE WHEN excluded.contact_name <> '' THEN excluded.contact_name ELSE conversations.contact_name END,
         contact_number = CASE WHEN excluded.contact_number <> '' THEN excluded.contact_number ELSE conversations.contact_number END`,
    ).run(convId, acc.id, m.chatId, acc.channel, clip(m.contactName || '', 100), number || '', now, now);
    const conv = getConvRow(convId);
    // F4：开了对应的识别、这个号在自动回复、会话没暂停、模型已配置时，先存一条占位消息，识别成文字后再进回复流程
    const s = settings();
    if (
      m.media &&
      (m.media.type === 'voice' ? s.media.voice : s.media.image) &&
      acc.autoReply &&
      !conv.bot_paused &&
      llmConfigured(s, config)
    ) {
      const label = m.media.type === 'voice' ? '[语音]' : '[图片]';
      const msgId = newId();
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, status, handled, media)
           VALUES(?, ?, ?, 'in', 'customer', 'media', ?, ?, 'received', 0, ?)`,
        )
        .run(
          msgId,
          convId,
          m.externalId || null,
          m.text ? `${label}\n${clip(m.text, MAX_STORED_TEXT)}` : label,
          new Date(m.timestampMs).toISOString(),
          JSON.stringify({ type: m.media.type, mime: m.media.mime || null }),
        );
      if (res.changes === 0) return 'ignored_duplicate';
      abortSending(convId, 'new_message');
      startConversion(acc, convId, msgId, m);
      return 'converting';
    }
    const willProcess = isText && acc.autoReply && !conv.bot_paused;
    let skipReason = null;
    if (!isText) skipReason = `非文字消息${m.mediaLabel ? `${m.mediaLabel}` : ''}，已通知人工`;
    else if (!acc.autoReply) skipReason = '这个号没开自动回复';
    else if (conv.bot_paused) skipReason = '会话已暂停（人工接管中）';
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, bot_decision, decision_reason, status, handled, media)
         VALUES(?, ?, ?, 'in', 'customer', ?, ?, ?, ?, ?, 'received', ?, ?)`,
      )
      .run(
        newId(),
        convId,
        m.externalId || null,
        isText ? 'text' : 'media',
        isText ? clip(m.text, MAX_STORED_TEXT) : m.mediaLabel || '[非文字消息]',
        new Date(m.timestampMs).toISOString(),
        willProcess ? null : 'skipped',
        willProcess ? null : skipReason,
        willProcess ? 0 : 1,
        m.media ? JSON.stringify({ type: m.media.type, mime: m.media.mime || null }) : null,
      );
    if (res.changes === 0) return 'ignored_duplicate';
    // F1 / F14：正在拟真发送时客户又来了消息，没发出去的取消，新消息合进去重新走
    abortSending(convId, 'new_message');
    if (!isText) {
      flagNeedsHuman(acc, convId, 'non_text', m.mediaLabel || '', { pause: false, pendingReason: skipReason });
      return 'archived_media';
    }
    if (willProcess) {
      scheduleFlush(convId);
      return 'scheduled';
    }
    return 'archived';
  }

  // ---------------- F4：语音、图片转文字 ----------------
  function startConversion(acc, convId, msgId, m) {
    converting.set(convId, (converting.get(convId) || 0) + 1);
    convertMedia(acc, convId, msgId, m)
      .catch((err) => log.error(`[wa] 识别会话 ${convId} 的${m.media.type === 'voice' ? '语音' : '图片'}出错：${err?.stack || err}`))
      .finally(() => {
        const n = (converting.get(convId) || 1) - 1;
        if (n > 0) converting.set(convId, n);
        else converting.delete(convId);
        // 识别结果当作客户刚发来的文字，走防抖合并
        if (!closed) scheduleFlush(convId);
      });
  }

  async function downloadMedia(acc, media, maxBytes) {
    if (acc.channel === 'waha') {
      if (media.error) throw new Error(`WAHA 下载媒体出错：${media.error}`);
      if (!media.url) throw new Error('WAHA 没有提供媒体地址（检查 WAHA_EVENTS_DOWNLOAD_MEDIA）');
      return waha.downloadMedia(media.url, { maxBytes });
    }
    return metaDownloadMedia(config.metaGraphUrl, acc.meta, media.id, { maxBytes });
  }

  /**
   * 下载 → 检查大小、格式、时长 → 转写或描述 → 把占位消息改成文字（kind=text，等下一轮处理）。
   * 失败或超限：这条消息记为 handoff（media_failed / media_unsupported），needsHuman 并通知，不暂停（和原来的非文字消息一样）。
   */
  async function convertMedia(acc, convId, msgId, m) {
    const started = Date.now();
    const { type } = m.media;
    const what = type === 'voice' ? '语音' : '图片';
    const limits = MEDIA_LIMITS[type];
    const fail = (code, why) => {
      const row = db.prepare('SELECT handled FROM messages WHERE id = ?').get(msgId);
      if (!row || row.handled || closed) return;
      const reason = code === 'media_unsupported' ? `${what}超出识别范围：${why}，已通知人工` : `${what}识别失败：${why}，已通知人工`;
      db.prepare("UPDATE messages SET handled = 1, bot_decision = 'handoff', decision_reason = ?, decision_code = ? WHERE id = ?").run(
        reason,
        code,
        msgId,
      );
      recordDecision(acc.id, convId, { decision: 'handoff', code, reason, latencyMs: Date.now() - started });
      flagNeedsHuman(accounts.get(acc.id), convId, 'non_text', `${what}：${why}`, { pause: false, pendingReason: reason });
    };
    const today = localDay();
    const conv = getConvRow(convId);
    if (!conv) return;
    const used = conv.llm_day === today ? conv.llm_calls : 0;
    if (used + 1 > DAILY_LLM_LIMIT) return fail('media_failed', `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次）`);
    if (type === 'image' && m.media.mime && !limits.mimes.includes(m.media.mime)) {
      return fail('media_unsupported', `格式 ${m.media.mime} 不支持，只支持 jpeg、png、webp`);
    }
    if (type === 'voice' && m.media.seconds && m.media.seconds > limits.maxSeconds) {
      return fail('media_unsupported', `语音 ${Math.round(m.media.seconds)} 秒，超过 3 分钟`);
    }
    let buffer;
    let mime;
    try {
      ({ buffer, mime } = await downloadMedia(acc, m.media, limits.maxBytes));
    } catch (err) {
      if (err instanceof TooLargeError || /文件太大/.test(String(err?.message))) {
        return fail('media_unsupported', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB`);
      }
      return fail('media_failed', `下载失败：${err?.message || err}`);
    }
    mime = m.media.mime || baseMime(mime);
    if (type === 'image' && !limits.mimes.includes(mime)) return fail('media_unsupported', `格式 ${mime || '未知'} 不支持，只支持 jpeg、png、webp`);
    if (type === 'voice') {
      const secs = m.media.seconds || oggDurationSeconds(buffer);
      if (secs && secs > limits.maxSeconds) return fail('media_unsupported', `语音 ${Math.round(secs)} 秒，超过 3 分钟`);
    }
    // 识别调用计入每会话每日 LLM 上限
    const now = getConvRow(convId);
    if (!now) return;
    db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(
      today,
      (now.llm_day === today ? now.llm_calls : 0) + 1,
      convId,
    );
    let text;
    try {
      text =
        type === 'voice'
          ? await ctx.ai.transcribe({ audio: buffer, mime: mime || 'audio/ogg', filename: `voice.${/mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : 'ogg'}` })
          : await ctx.ai.describeImage({ mime, data: buffer.toString('base64') });
    } catch (err) {
      return fail('media_failed', err?.message || String(err));
    }
    text = clip(String(text || '').trim(), MAX_STORED_TEXT - 200);
    if (!text) return fail('media_failed', '模型没有返回内容');
    if (closed) return;
    const caption = type === 'image' && m.text ? `\n${clip(m.text, MAX_STORED_TEXT - 200)}` : '';
    const full = `[${what}] ${text}${caption}`;
    // 识别期间人工接管了的：占位消息已记为 skipped，只把文字补上给人看
    db.prepare("UPDATE messages SET kind = 'text', text = ? WHERE id = ?").run(full, msgId);
  }

  function scheduleFlush(convId, delayMs) {
    if (closed) return;
    cancelTimer(convId);
    const ms = delayMs ?? Math.round(settings().reply.debounceSeconds * 1000);
    const t = setTimeout(() => {
      timers.delete(convId);
      flush(convId).catch((err) => log.error(`[wa] 处理会话 ${convId} 出错：${err?.stack || err}`));
    }, ms);
    timers.set(convId, t);
  }

  async function flush(convId) {
    if (closed) return;
    // 还有语音/图片在识别：等识别完（startConversion 结束时会重新排一次）
    if (converting.get(convId)) return;
    const busy = processing.get(convId);
    if (busy) {
      busy.rerun = true;
      return;
    }
    const me = { rerun: false };
    processing.set(convId, me);
    try {
      await processPending(convId);
    } finally {
      processing.delete(convId);
      if (me.rerun && !closed) scheduleFlush(convId);
    }
  }

  async function processPending(convId) {
    const s = settings();
    let conv = getConvRow(convId);
    if (!conv) return;
    const pending = db
      .prepare(
        "SELECT seq, text, external_id FROM messages WHERE conversation_id = ? AND direction = 'in' AND kind = 'text' AND handled = 0 ORDER BY seq",
      )
      .all(convId);
    if (!pending.length) return;
    const lastSeq = pending[pending.length - 1].seq;
    const settle = (decision, reason, code = null) => settleMessages(convId, lastSeq, decision, reason, code);
    const acc = conv.account_id ? accounts.get(conv.account_id) : null;

    if (!acc) return void settle('skipped', '这个号已删除');
    if (!acc.autoReply) return void settle('skipped', '这个号没开自动回复');
    if (conv.bot_paused) return void settle('skipped', '会话已暂停（人工接管中）');
    if (!llmConfigured(s, config)) {
      log.warn('[wa] 模型未配置，跳过自动回复');
      return void settle('skipped', '还没有配置模型');
    }
    // 第 4 层：反复离题静默
    if (conv.muted_until) {
      if (Date.parse(conv.muted_until) > Date.now()) {
        const reason = `反复离题，静默中（到 ${conv.muted_until}）`;
        settle('offtopic', reason, 'muted');
        recordDecision(acc.id, convId, { decision: 'offtopic', code: 'muted', reason });
        return;
      }
      db.prepare('UPDATE conversations SET muted_until = NULL WHERE id = ?').run(convId);
    }
    // 每会话每小时回复上限（拆条发送的只数第一条）
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const botCount = db
      .prepare(
        "SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND author = 'bot' AND (part_index IS NULL OR part_index = 0) AND ts >= ?",
      )
      .get(convId, hourAgo).n;
    if (botCount >= s.reply.maxBotRepliesPerChatPerHour) {
      const detail = `过去一小时已自动回复 ${botCount} 次`;
      const reason = `回复次数超限：${detail}`;
      settle('handoff', reason, 'rate_limit');
      recordDecision(acc.id, convId, { decision: 'handoff', code: 'rate_limit', reason });
      flagNeedsHuman(acc, convId, 'rate_limit', detail, { pause: true, pendingReason: reason });
      return;
    }
    // 第 4 层：每会话每天 LLM 调用上限（一轮至少 2 次：生成 + 审核；命中套话时再加 1 次重写）
    const today = localDay();
    const usedToday = conv.llm_day === today ? conv.llm_calls : 0;
    if (usedToday + 2 > DAILY_LLM_LIMIT) {
      log.warn(`[wa] 会话 ${convId} 今天的模型调用已达上限（${usedToday}/${DAILY_LLM_LIMIT}）`);
      return void settle('skipped', `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次）`);
    }
    // 每个号每分钟 30 条
    const st = state(acc.id);
    const now = Date.now();
    while (st.replies.length && now - st.replies[0] > 60_000) st.replies.shift();
    if (st.replies.length >= REPLIES_PER_MINUTE_PER_ACCOUNT) {
      log.warn(`[wa] 号 ${acc.id} 自动回复达到每分钟上限，10 秒后重试`);
      scheduleFlush(convId, 10_000);
      return;
    }

    const history = db
      .prepare('SELECT direction, text, attachment FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT 12')
      .all(convId, pending[0].seq)
      .reverse()
      .map((r) => {
        const label = attachmentLabel(r.attachment);
        return { role: r.direction === 'in' ? 'customer' : 'bot', text: label ? `${label}${r.text ? ` ${r.text}` : ''}` : r.text };
      });
    const message = pending.map((p) => p.text).join('\n');
    // F15：这个会话今天还能自动发几个文件
    const d0 = new Date();
    const dayStart = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).toISOString();
    const filesToday = db
      .prepare(
        "SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND author = 'bot' AND attachment IS NOT NULL AND status = 'sent' AND ts >= ?",
      )
      .get(convId, dayStart).n;

    const result = await decideReply(ctx, {
      message,
      history,
      persona: acc.persona,
      allowRewrite: usedToday + 3 <= DAILY_LLM_LIMIT,
      fileQuota: Math.max(0, DAILY_FILE_LIMIT - filesToday),
    });

    conv = getConvRow(convId);
    if (!conv) return;
    const used = (conv.llm_day === today ? conv.llm_calls : 0) + result.llmCalls;
    db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(today, used, convId);
    const accNow = accounts.get(acc.id);
    if (!accNow) return void settle('skipped', '这个号已删除');
    if (conv.bot_paused || closed) return void settle('skipped', '生成回复期间人工接管了这个会话');

    switch (result.decision) {
      case 'replied':
        st.replies.push(Date.now());
        await deliverReply(accNow, convId, pending, lastSeq, result);
        return;
      case 'offtopic': {
        settle('offtopic', result.reason, result.code);
        recordDecision(acc.id, convId, result);
        db.prepare('UPDATE messages SET offtopic_strike = 1 WHERE seq = ?').run(lastSeq);
        const since = new Date(Date.now() - OFFTOPIC_WINDOW_MS).toISOString();
        const strikes = db
          .prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND offtopic_strike = 1 AND ts >= ?')
          .get(convId, since).n;
        if (strikes >= OFFTOPIC_STRIKES) {
          const until = new Date(Date.now() + MUTE_MS).toISOString();
          db.prepare('UPDATE conversations SET muted_until = ? WHERE id = ?').run(until, convId);
          log.info(`[wa] 会话 ${convId} 24 小时内离题 ${strikes} 次，静默到 ${until}`);
        }
        return;
      }
      default: {
        // handoff / blocked：不回复客户，标 needsHuman 并暂停；先起草（F2a）再发通知。不标已读（F1）
        settle(result.decision, result.reason, result.code);
        recordDecision(acc.id, convId, result);
        // F2c：知识库答不了的问题进缺口清单
        if (result.decision === 'handoff' && result.handoffType === 'insufficient_info') {
          try {
            ctx.kb.addConversationGap(result.questionZh || clip(message.replace(/\s+/g, ' ').trim(), 200), convId);
          } catch (err) {
            log.warn(`[wa] 写缺口清单失败：${err?.message || err}`);
          }
        }
        const fresh = flagNeedsHuman(accNow, convId, result.decision, result.reason, { pause: true, notify: false });
        await prepareDraft(accNow, convId, { message, history, reason: result.reason, usedToday: used });
        if (fresh && !closed) sendNotice(accounts.get(acc.id) || accNow, convId, result.decision, result.reason);
      }
    }
  }

  /**
   * F2a：转人工时给人工起草一条回复（不自动发送）。当天 LLM 次数不够、生成失败时不带草稿；
   * 生成期间人工已经回了或机器人已恢复的，丢掉这份草稿。
   */
  async function prepareDraft(acc, convId, { message, history, reason, usedToday }) {
    if (closed || usedToday + 1 > DAILY_LLM_LIMIT || !ctx.ai.draft) return;
    const today = localDay();
    const before = getConvRow(convId);
    if (!before) return;
    const startSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ?').get(convId).n;
    db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(
      today,
      (before.llm_day === today ? before.llm_calls : 0) + 1,
      convId,
    );
    let draft;
    try {
      const c = buildReplyContext(ctx, { message, history });
      const out = await ctx.ai.draft({
        message: c.msg,
        history: c.hist,
        entries: c.entries,
        files: c.files,
        filesTruncated: c.filesTruncated,
        profile: c.profile,
        persona: acc.persona && acc.persona.trim() ? acc.persona : settings().reply.persona,
        reason,
      });
      const active = new Set(c.activeFiles.map((f) => f.id));
      const fileIds = normalizeFileIds(out?.fileIds)
        .filter((id) => active.has(id))
        .slice(0, MAX_FILES_PER_REPLY);
      const text = clip(String(out?.text ?? '').trim(), MAX_DRAFT_TEXT);
      if (!text && !fileIds.length) throw new Error('草稿是空的');
      draft = { text, fileIds, createdAt: nowIso() };
    } catch (err) {
      log.warn(`[wa] 会话 ${convId} 生成草稿失败，不带草稿通知：${err?.message || err}`);
      return;
    }
    if (closed) return;
    const conv = getConvRow(convId);
    const operatorSince = db
      .prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND author = 'operator' AND seq > ? LIMIT 1")
      .get(convId, startSeq);
    if (!conv || !conv.needs_human || operatorSince) return;
    db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(draft), convId);
  }

  // ---------------- F1 / F14：拟真发送 ----------------
  async function markRead(acc, chatId, ids) {
    // Meta 的标已读和"正在输入"是同一个请求，在 typing() 里一起发
    if (acc.channel !== 'waha') return;
    try {
      await waha.sendSeen(acc.sessionName, chatId, ids);
    } catch (err) {
      log.warn(`[wa] 标已读失败（${chatId}）：${err?.message || err}`);
    }
  }

  async function typing(acc, chatId, lastInboundId, on) {
    try {
      if (acc.channel === 'waha') await waha.setPresence(acc.sessionName, chatId, on ? 'typing' : 'paused');
      else if (acc.channel === 'meta' && on && lastInboundId) {
        // Meta 没有单独的停止接口：发出回复或 25 秒后自动消失
        await metaMarkRead(config.metaGraphUrl, acc.meta, lastInboundId, { typing: true });
      }
    } catch (err) {
      log.warn(`[wa] "正在输入"${on ? '开启' : '关闭'}失败（${chatId}）：${err?.message || err}`);
    }
  }

  /**
   * replied 的回复：humanize 关闭时直接发；开启时 等 1–3 秒 → 标已读 → 每条：正在输入 + 按字数等待 → 停止输入 → 发送。
   * F15：文字都发出后停 1–2 秒，再按顺序发文件（不带 caption）。
   * 第一条发出时才把客户消息记为 replied；一条都没发出就被取消的，客户消息保持未处理，合进下一轮。
   * decisions 记录在这一轮发完（或被取消）之后写，带上实际发出的文件 sentFileIds；一条都没发出的不写（下一轮会重新处理）。
   */
  async function deliverReply(acc, convId, pending, lastSeq, result) {
    const human = settings().reply.humanize;
    const parts = human ? splitReply(result.reply) : [result.reply];
    const files = (result.sendFileIds || []).map((id) => ctx.files.get(id)).filter((f) => f && f.status === 'active');
    const opts = { author: 'bot', usedEntryIds: result.usedEntryIds, confident: true };
    const chatId = getConvRow(convId).chat_id;
    const inboundIds = pending.map((p) => p.external_id).filter(Boolean);
    const lastInbound = inboundIds[inboundIds.length - 1] || null;
    const ac = new AbortController();
    sending.set(convId, ac);
    const { signal } = ac;
    let sent = 0;
    const sentFileIds = [];
    const stillOn = () => {
      if (signal.aborted || closed) return null;
      const conv = getConvRow(convId);
      return conv && !conv.bot_paused ? conv : null;
    };
    try {
      if (human) {
        await sleep(humanize.preMs(), signal);
        await markRead(acc, chatId, inboundIds);
      }
      for (let i = 0; i < parts.length; i++) {
        if (human) {
          if (i > 0) await sleep(humanize.betweenMs(), signal);
          await typing(acc, chatId, lastInbound, true);
          try {
            await sleep(humanize.typingMs(parts[i].length), signal);
          } finally {
            await typing(acc, chatId, lastInbound, false);
          }
        }
        const conv = stillOn();
        if (!conv) break;
        if (i === 0) settleMessages(convId, lastSeq, 'replied', null, result.code);
        await sendAndRecord(acc, conv, parts[i], { ...opts, partIndex: parts.length > 1 ? i : null });
        sent++;
      }
      if (sent === parts.length && files.length) {
        await sleep(humanize.fileGapMs(), signal);
        for (const f of files) {
          const conv = stillOn();
          if (!conv) break;
          const msg = await sendFileAndRecord(acc, conv, f, { author: 'bot' });
          if (msg.status === 'sent') sentFileIds.push(f.id);
        }
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    } finally {
      if (sending.get(convId) === ac) sending.delete(convId);
    }
    if (sent > 0) recordDecision(acc.id, convId, { ...result, sentFileIds });
    if (sent < parts.length) {
      log.info(`[wa] 会话 ${convId} 拟真发送被取消：已发 ${sent}/${parts.length} 条`);
      // 一条都没发出：客户消息还没处理，重新从防抖开始（新消息已在库里，会一起合并）
      if (sent === 0 && !closed) scheduleFlush(convId);
    } else if (sentFileIds.length < files.length) {
      log.info(`[wa] 会话 ${convId} 文件没有全部发出：已发 ${sentFileIds.length}/${files.length} 个`);
    }
  }

  // ---------------- F3：通知号码发来的消息 ----------------
  async function handleNotifyReply(acc, m) {
    const replyAdmin = async (text) => {
      try {
        await sendRaw(acc, m.chatId, text);
      } catch (err) {
        log.warn(`[wa] 给通知号码回执失败：${err?.message || err}`);
      }
    };
    if (!m.text) {
      await replyAdmin('暂时只支持转发文字');
      return 'command_non_text';
    }
    const convId = notifier.findNotice(acc.id, m.replyToId);
    if (!convId) {
      const st = state(acc.id);
      if (st.usageHintAt && Date.now() - st.usageHintAt < USAGE_HINT_INTERVAL_MS) return 'command_usage_throttled';
      st.usageHintAt = Date.now();
      await replyAdmin(USAGE_HINT);
      return 'command_usage';
    }
    const conv = getConvRow(convId);
    if (!conv) {
      await replyAdmin('❌ 发送失败：这个会话已不存在');
      return 'command_failed';
    }
    const who = displayName(conv);
    const cmd = m.text.trim();
    if (/^\/resume$/i.test(cmd)) {
      resumeBot(convId);
      await replyAdmin(`✅ 已恢复机器人：${who}`);
      return 'command_resume';
    }
    if (/^\/d$/i.test(cmd)) {
      const draft = parseDraft(conv.draft);
      if (!draft) {
        await replyAdmin('这个会话没有草稿');
        return 'command_no_draft';
      }
      // F15：先发草稿文字，再发草稿里的文件；视为人工亲自发送
      const errors = [];
      operatorTakeover(convId);
      if (draft.text.trim()) {
        const msg = await operatorDeliver(acc, convId, draft.text, { via: 'whatsapp', sentBy: null });
        if (msg.status !== 'sent') errors.push(msg.error || '未知原因');
      }
      for (const fid of draft.fileIds) {
        const f = ctx.files.get(fid);
        if (!f || f.status !== 'active') {
          errors.push('草稿里的文件已删除或停用');
          continue;
        }
        const msg = await operatorDeliverFile(acc, convId, f, { via: 'whatsapp', sentBy: null });
        if (msg.status !== 'sent') errors.push(`${f.filename}：${msg.error || '未知原因'}`);
      }
      if (!errors.length) {
        await replyAdmin(`✅ 已发给 ${who}`);
        return 'command_draft';
      }
      await replyAdmin(`❌ 发送失败：${errors.join('；')}`);
      return 'command_failed';
    }
    const msg = await operatorDeliver(acc, convId, m.text, { via: 'whatsapp', sentBy: null });
    if (msg.status === 'sent') {
      await replyAdmin(`✅ 已发给 ${who}`);
      return 'command_forward';
    }
    await replyAdmin(`❌ 发送失败：${msg.error || '未知原因'}`);
    return 'command_failed';
  }

  // ---------------- 状态 ----------------
  function observeWahaStatus(accountId, status) {
    if (!status) return;
    const st = state(accountId);
    if (status === 'WORKING' && st.lastWahaStatus && st.lastWahaStatus !== 'WORKING') st.connectedAt = Date.now();
    st.lastWahaStatus = status;
  }

  async function computeStatus(acc, timeoutMs) {
    const st = state(acc.id);
    const base = { state: 'not_configured', me: null, error: null, lastWebhookAt: st.lastWebhookAt };
    if (acc.channel === 'meta') return { ...base, state: metaConfigured(acc) ? 'configured' : 'not_configured' };
    const relayError = relays.error(acc.id);
    try {
      const sess = await waha.getSession(acc.sessionName, timeoutMs);
      if (!sess) return { ...base, state: 'stopped', error: relayError };
      observeWahaStatus(acc.id, sess.status);
      const { state: s, error } = mapWahaStatus(sess.status);
      const me = sess.me && sess.me.id ? { id: String(sess.me.id), pushName: String(sess.me.pushName || '') } : null;
      return { ...base, state: s, error: error || relayError, me };
    } catch (err) {
      return { ...base, state: 'failed', error: String(err?.message || err) };
    }
  }

  async function getStatus(acc, { maxAgeMs = 0, timeoutMs = 3000 } = {}) {
    const st = state(acc.id);
    if (maxAgeMs && st.statusCache && Date.now() - st.statusCache.at < maxAgeMs) return st.statusCache.value;
    const value = await computeStatus(acc, timeoutMs);
    st.statusCache = { at: Date.now(), value };
    return value;
  }

  const wahaFail = (err) => {
    if (err instanceof WahaError) return new HttpError(502, 'waha_error', err.message);
    return err;
  };

  const assertWaha = (acc) => {
    if (acc.channel !== 'waha') throw badRequest('这个号不是扫码接入', 'wrong_channel');
  };

  /**
   * WAHA session 的代理配置（4.5 / F13）。http 上游直接交给 WAHA；https / socks 上游指向 kbwa 的中继。
   * server 按文档不带协议头；WAHA 把账号密码原样拼进代理 URL，所以先做 URL 编码。
   */
  function wahaProxyFor(acc) {
    const px = acc.waha?.proxy;
    if (!px?.enabled || !px.host || !px.port) return null;
    if (needsRelay(acc)) {
      if (!acc.relay) return null;
      return { server: `${config.proxyRelayHost}:${acc.relay.port}`, username: acc.relay.username, password: acc.relay.password };
    }
    const host = px.host.includes(':') && !px.host.startsWith('[') ? `[${px.host}]` : px.host;
    const out = { server: `${host}:${px.port}` };
    if (px.username) out.username = encodeURIComponent(px.username);
    if (px.password) out.password = encodeURIComponent(px.password);
    return out;
  }

  /** kbwa 管理的那部分 session 配置：webhook 和代理 */
  function wahaManagedConfig(acc) {
    const cfg = {
      webhooks: [
        {
          url: config.wahaWebhookUrl,
          events: ['message', 'session.status'],
          hmac: { key: config.wahaWebhookSecret },
          retries: { policy: 'constant', delaySeconds: 2, attempts: 3 },
        },
      ],
    };
    const proxy = wahaProxyFor(acc);
    if (proxy) cfg.proxy = proxy;
    return cfg;
  }

  /** 上次推给 WAHA 的配置的指纹（带密钥的 HMAC，库里不存明文）。WAHA 读回来的配置可能把密码打码，所以不拿它比 */
  const configHash = (cfg) => crypto.createHmac('sha256', config.sessionSecret).update(JSON.stringify(cfg)).digest('hex');

  function mergeConfig(current, managed) {
    const out = { ...(current || {}), webhooks: managed.webhooks };
    if (managed.proxy) out.proxy = managed.proxy;
    else delete out.proxy;
    return out;
  }

  async function wahaStart(acc) {
    assertWaha(acc);
    const r = await relays.ensure(acc);
    if (r === 'failed') throw new HttpError(502, 'relay_failed', relays.error(acc.id) || '代理中继启动失败');
    const managed = wahaManagedConfig(acc);
    const hash = configHash(managed);
    try {
      const sess = await waha.getSession(acc.sessionName, 10_000);
      if (!sess) {
        await waha.createSession(acc.sessionName, managed);
        accounts.setWahaConfigHash(acc.id, hash);
      } else {
        const update = acc.wahaConfigHash !== hash || r === 'started' || r === 'restarted';
        // 文档：session 不在 STOPPED 状态时，PUT 会用新配置自动 stop 再 start；stop 不会登出
        if (update) {
          await waha.updateSession(acc.sessionName, mergeConfig(sess.config, managed));
          accounts.setWahaConfigHash(acc.id, hash);
        }
        if (sess.status === 'STOPPED' || (sess.status === 'FAILED' && !update)) await waha.startSession(acc.sessionName);
      }
    } catch (err) {
      throw wahaFail(err);
    }
    state(acc.id).statusCache = null;
    return getStatus(accounts.get(acc.id) || acc);
  }

  /**
   * 号的代理设置改动后调用：先按新配置重启中继，session 已存在就把新配置 PUT 过去（运行中的 session 由 WAHA 自动重启，登录态保留）。
   * @returns {Promise<'updated'|'no_session'|'unchanged'|'skipped'|'relay_failed'>}
   */
  async function applyWahaConfig(acc) {
    if (acc.channel !== 'waha') return 'skipped';
    const r = await relays.ensure(acc);
    if (r === 'failed') return 'relay_failed';
    const managed = wahaManagedConfig(acc);
    const hash = configHash(managed);
    const relayChanged = r === 'started' || r === 'restarted' || r === 'stopped';
    if (acc.wahaConfigHash === hash && !relayChanged) return 'unchanged';
    const sess = await waha.getSession(acc.sessionName, 10_000);
    if (!sess) return 'no_session';
    await waha.updateSession(acc.sessionName, mergeConfig(sess.config, managed));
    accounts.setWahaConfigHash(acc.id, hash);
    state(acc.id).statusCache = null;
    return 'updated';
  }

  async function wahaQr(acc) {
    assertWaha(acc);
    let sess;
    try {
      sess = await waha.getSession(acc.sessionName, 5000);
    } catch (err) {
      throw wahaFail(err);
    }
    if (!sess || sess.status !== 'SCAN_QR_CODE') throw new HttpError(409, 'not_scan_qr', '当前不是等待扫码状态');
    try {
      return await waha.getQrPng(acc.sessionName);
    } catch (err) {
      throw wahaFail(err);
    }
  }

  async function wahaLogout(acc) {
    assertWaha(acc);
    const ignore404 = (err) => {
      if (err instanceof WahaError && (err.status === 404 || err.status === 422)) return;
      throw wahaFail(err);
    };
    // WAHA 文档：logout 后会话会从头重启（回到扫码），所以再 stop 一次才是"登出并停止"
    await waha.logoutSession(acc.sessionName).catch(ignore404);
    await waha.stopSession(acc.sessionName).catch(ignore404);
    const st = state(acc.id);
    st.connectedAt = 0;
    st.statusCache = null;
    return getStatus(acc);
  }

  /** DELETE /api/accounts/:id：扫码号先登出、再删 WAHA session；会话和消息保留 */
  async function deleteAccount(acc) {
    if (acc.channel === 'waha') {
      const warn = (err) => {
        if (err instanceof WahaError && (err.status === 404 || err.status === 422)) return;
        log.warn(`[waha] 删除号 ${acc.id} 时 WAHA 出错（号照常删除）：${err?.message || err}`);
      };
      await waha.logoutSession(acc.sessionName).catch(warn);
      await waha.deleteSession(acc.sessionName).catch(warn);
    }
    await relays.stop(acc.id);
    for (const r of db.prepare('SELECT id FROM conversations WHERE account_id = ?').all(acc.id)) {
      cancelTimer(r.id);
      abortSending(r.id, 'account_deleted');
    }
    accounts.delete(acc.id);
    accState.delete(acc.id);
    recentSent.delete(acc.id);
  }

  // ---------------- webhook ----------------
  async function handleWahaWebhook(body) {
    if (!body || typeof body !== 'object') return 'ignored';
    const acc = typeof body.session === 'string' ? accounts.bySession(body.session) : null;
    if (!acc) return 'ignored_session';
    const st = state(acc.id);
    st.lastWebhookAt = nowIso();
    st.statusCache = null;
    if (body.event === 'session.status') {
      observeWahaStatus(acc.id, body.payload?.status);
      return 'status';
    }
    if (body.event !== 'message') return 'ignored_event';
    return handleInbound(acc, parseWahaMessage(body.payload || {}));
  }

  async function handleMetaWebhook(accountId, body) {
    const acc = accounts.get(accountId);
    if (!acc || acc.channel !== 'meta') return [];
    const st = state(acc.id);
    st.lastWebhookAt = nowIso();
    st.statusCache = null;
    const results = [];
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const value = change?.value || {};
        if (change?.field && change.field !== 'messages') continue;
        const pid = value.metadata?.phone_number_id;
        if (acc.meta.phoneNumberId && pid && String(pid) !== acc.meta.phoneNumberId) continue;
        const names = new Map();
        for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
          if (c?.wa_id) names.set(String(c.wa_id), String(c.profile?.name || ''));
        }
        for (const msg of Array.isArray(value.messages) ? value.messages : []) {
          const m = parseMetaMessage(msg || {}, names);
          if (m) results.push(await handleInbound(accounts.get(acc.id), m));
        }
      }
    }
    return results;
  }

  return {
    getStatus,
    wahaStart,
    applyWahaConfig,
    wahaQr,
    wahaLogout,
    deleteAccount,
    handleWahaWebhook,
    handleMetaWebhook,
    handleInbound,
    notifier,

    /** 进程启动时按配置拉起所有需要的代理中继（F13） */
    async init() {
      for (const acc of accounts.list()) {
        if (!needsRelay(acc)) continue;
        const r = await relays.ensure(acc);
        if (r === 'failed') log.error(`[relay] 号 ${acc.id} 的代理中继没能拉起：${relays.error(acc.id)}`);
      }
    },

    /**
     * F12 下一段用：这条 fromMe 消息是不是本服务经 API 发出去的回声。按 message id 判断，再用"同一 chat + 相同文本 + 30 秒内"兜底。
     */
    isOwnEcho(accountId, chatId, externalId, text) {
      const now = Date.now();
      const list = recentSent.get(accountId) || [];
      const short = externalId ? shortMessageId(externalId) : null;
      return list.some(
        (e) =>
          (externalId && (e.id === externalId || (short && e.short === short))) ||
          (e.chatId === chatId && e.text === text && now - e.at <= ECHO_TEXT_WINDOW_MS),
      );
    },

    /** @param {{accountIds?: string[]|null, accountId?: string|null}} f accountIds=null 表示不限（admin） */
    listConversations({ accountIds = null, accountId = null } = {}) {
      const where = [];
      const params = [];
      if (accountId) {
        where.push('c.account_id = ?');
        params.push(accountId);
      }
      if (accountIds) {
        if (!accountIds.length) return [];
        where.push(`c.account_id IN (${accountIds.map(() => '?').join(', ')})`);
        params.push(...accountIds);
      }
      const sql = `${CONV_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.updated_at DESC, c.rowid DESC`;
      return db
        .prepare(sql)
        .all(...params)
        .map(rowToConversation);
    },
    getConversation(id) {
      return conversationById(id);
    },
    listMessages(id) {
      if (!getConvRow(id)) throw notFound('会话不存在');
      return db
        .prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 200) ORDER BY seq')
        .all(id)
        .map(rowToMessage);
    },
    /** 后台人工发送：via=admin，记下发送人 */
    async operatorSend(id, text, user) {
      const conv = getConvRow(id);
      if (!conv) throw notFound('会话不存在');
      if (typeof text !== 'string' || !text.trim()) throw badRequest('消息不能为空');
      const acc = conv.account_id ? accounts.get(conv.account_id) : null;
      if (!acc) throw badRequest('这个会话所属的号已删除，不能再发送', 'account_deleted');
      return operatorDeliver(acc, id, text.trim(), { via: 'admin', sentBy: user ? { id: user.id, name: user.name } : null });
    },
    /** F15：后台人工发文件（权限同手动回复）。发完会话进入 botPaused */
    async operatorSendFile(id, body, user) {
      const conv = getConvRow(id);
      if (!conv) throw notFound('会话不存在');
      const fileId = body?.fileId;
      if (typeof fileId !== 'string' || !fileId) throw badRequest('请选择要发送的文件（fileId）');
      const caption = body?.caption ?? '';
      if (typeof caption !== 'string') throw badRequest('caption 必须是字符串');
      const file = ctx.files.get(fileId);
      if (!file) throw notFound('文件不存在');
      if (file.status !== 'active') throw badRequest('这个文件已停用，启用后才能发送', 'file_disabled');
      const acc = conv.account_id ? accounts.get(conv.account_id) : null;
      if (!acc) throw badRequest('这个会话所属的号已删除，不能再发送', 'account_deleted');
      return operatorDeliverFile(acc, id, file, {
        via: 'admin',
        sentBy: user ? { id: user.id, name: user.name } : null,
        caption: caption.trim(),
      });
    },

    /**
     * F2b：把一条人工回复（连同它前面的客户提问）改写成知识条目，不落库。
     * @returns {Promise<{type:string, title:string, content:string, tags:string[], sourceRefs:any[]}>}
     */
    async kbDraftFromMessage(convId, messageId) {
      const conv = getConvRow(convId);
      if (!conv) throw notFound('会话不存在');
      const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, convId);
      if (!msg) throw notFound('消息不存在');
      if (msg.author !== 'operator') throw badRequest('只能把人工回复存进知识库', 'not_operator_message');
      const answer = String(msg.text || '').trim();
      if (!answer) throw badRequest('这条人工消息没有文字', 'empty_message');
      if (!llmConfigured(settings(), config)) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
      // 它前面的客户提问：往前找，跳过紧挨着的我方消息，取连续的客户消息（最多 3 条）
      const before = db
        .prepare('SELECT author, text FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT 30')
        .all(convId, msg.seq);
      const asked = [];
      for (const r of before) {
        if (r.author === 'customer') {
          if (r.text) asked.unshift(r.text);
          if (asked.length >= 3) break;
        } else if (asked.length) {
          break;
        }
      }
      let out;
      try {
        out = await ctx.ai.kbDraft({ question: clip(asked.join('\n'), 2000), answer: clip(answer, 4000) });
      } catch (err) {
        throw new HttpError(502, 'llm_error', `改写失败：${err?.message || err}`);
      }
      const title = typeof out?.title === 'string' && out.title.trim() ? out.title.trim() : clip(asked[asked.length - 1] || answer, 40);
      const content = typeof out?.content === 'string' && out.content.trim() ? out.content.trim() : answer;
      return {
        type: ENTRY_TYPES.includes(out?.type) ? out.type : 'faq',
        title: clip(title, 200),
        content: clip(content, 20000),
        tags: normalizeTags(Array.isArray(out?.tags) ? out.tags : []),
        sourceRefs: [{ sourceId: null, sourceName: `会话：${displayName(conv)}`, quote: answer.slice(0, 200) }],
      };
    },

    setBotPaused(id, paused) {
      if (!getConvRow(id)) throw notFound('会话不存在');
      if (typeof paused !== 'boolean') throw badRequest('paused 必须是布尔值');
      if (paused) {
        db.prepare('UPDATE conversations SET bot_paused = 1 WHERE id = ?').run(id);
        cancelTimer(id);
        abortSending(id, 'paused');
        skipPending(id, '人工已接管');
      } else {
        resumeBot(id);
      }
      return conversationById(id);
    },
    /** 测试用：防抖和处理都结束了 */
    idle() {
      return timers.size === 0 && processing.size === 0 && converting.size === 0;
    },
    async close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const ac of sending.values()) ac.abort(new Error('closing'));
      await relays.closeAll();
    },
  };
}
