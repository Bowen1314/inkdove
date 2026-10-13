// WhatsApp 业务层（第二期：按号）。每个号（Account）有自己的接入方式、回复方式（人工回复 / 自动回复）、回复范围、通知和代理；
// 会话 id 是 <accountId>:<chatId>。四层防滥用的第 4 层（会话级闸门）在这里，回复拟真（F1/F14）和
// 在 WhatsApp 里处理转人工（F3）也在这里。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { conversationIdOf, DELETED_ACCOUNT_NAME, metaConfigured } from '../accounts.js';
import { internalFileUrl } from '../files/signed.js';
import { MAX_FILES_PER_REPLY } from '../files/store.js';
import { ENTRY_TYPES, normalizeTags } from '../kb/store.js';
import { llmScope } from '../records.js';
import { buildReplyContext, decideReply, normalizeFileIds } from '../reply/engine.js';
import { llmConfigured } from '../settings.js';
import { badRequest, clip, HttpError, newId, notFound, nowIso, safeJsonParse, sleep } from '../util.js';
import { assignCampaignConversation } from './assign.js';
import {
  baseMime,
  cleanFilename,
  downloadName,
  MEDIA_LABELS,
  MEDIA_LIMITS,
  MEDIA_STORE_MAX_BYTES,
  mediaKindOf,
  mediaTypeOf,
  oggDurationSeconds,
  publicMedia,
  wahaVoiceSeconds,
} from './media.js';
import { createMediaStore } from './media-store.js';
import {
  metaDownloadMedia,
  metaMarkRead,
  metaOpenMedia,
  metaSendMedia,
  metaSendTemplate,
  metaSendText,
  metaUploadMedia,
} from './meta.js';
import { createNotifier, shortMessageId } from './notify.js';
import { needsRelay } from './relay.js';
import { createWahaClient, mapWahaStatus, TooLargeError, WAHA_STATUS_LABEL, WahaError } from './waha.js';

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
/** 推荐回复：「客户这次的消息」最多合并最近几条 */
const MAX_SUGGEST_MESSAGES = 20;
/** 推荐回复跟进时：客户最后那段消息之后我方发的消息，最多单独列出（并参与检索）最近几条 */
const MAX_FOLLOWUP_MESSAGES = 8;
const MAX_CAPTION = 1024;
/** 手机号配对码：同一个号两次申请的最小间隔（连点会让 WhatsApp 风控这个号），等会话进入 SCAN_QR_CODE 的上限 */
export const PAIR_CODE_INTERVAL_MS = 20_000;
const PAIR_WAIT_MS = 15_000;
const PAIR_POLL_MS = 500;
/**
 * 关联后导入已有聊天：最多导入多少个聊天、每个聊天最多取几条（WhatsApp 目前只给新关联设备每个聊天最后 1 条，留余量）。
 * 进入 WORKING 后等一会儿再导入，给手机同步历史留时间（同步要多久没在真机上核实）。
 */
export const HISTORY_CHAT_LIMIT = 100;
export const HISTORY_MESSAGES_PER_CHAT = 20;
const HISTORY_IMPORT_DELAY_MS = 10_000;
const HISTORY_SKIP_REASON = '导入的历史消息，机器人不处理';
/** 客户媒体存盘：一个文件最多下这么久（64MB 的视频在慢线路上也够） */
const MEDIA_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MEDIA_TOO_LARGE_TEXT = '文件太大，没有保存';

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

/** 负责人的列都起别名（users 和 conversations 有同名的 id、created_at） */
const CONV_SQL = `SELECT c.*, a.name AS account_name, m.text AS lm_text, m.attachment AS lm_attachment, m.direction AS lm_direction, m.ts AS lm_ts,
    u.name AS assignee_name, u.email AS assignee_email, u.disabled AS assignee_disabled
  FROM conversations c
  LEFT JOIN accounts a ON a.id = c.account_id
  LEFT JOIN users u ON u.id = c.assignee_id
  LEFT JOIN messages m ON m.seq = (SELECT MAX(seq) FROM messages WHERE conversation_id = c.id)`;

/** 群聊、广播、频道 */
export const isNonPrivateChat = (chatId) =>
  /@g\.us$/i.test(chatId) || /@broadcast$/i.test(chatId) || /@newsletter$/i.test(chatId);

/** 本地日期 YYYY-MM-DD（容器可用 TZ 环境变量调整）。F6 线索提取也按它数每会话每日模型次数 */
export function localDay(d = new Date()) {
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

/**
 * 聊天对象的 chat id。别人发来的取 from。自己发的（F12 的 message.any）各引擎不一样：GOWS 的 from 是聊天对象
 * （原始消息的 Info.Chat），私聊的 to 是 null，群里的 to 是自己；WEBJS 的 from 是自己、to 是聊天对象。
 * 所以先取 _data.Info.Chat，没有时 from 是群、广播、频道就用 from，否则 to 优先。
 */
function wahaChatOf(p) {
  if (!p.fromMe) return p.from;
  const infoChat = p._data?.Info?.Chat;
  if (typeof infoChat === 'string' && infoChat) return infoChat;
  if (typeof p.from === 'string' && isNonPrivateChat(p.from)) return p.from;
  return p.to || p.from;
}

/**
 * WAHA 原始消息里看得出的类型：贴纸、文件（documentMessage）。payload 本身没有 type 字段，所以看 _data：
 * GOWS 是 _data.Message.<x>Message，NOWEB 是 _data.message.<x>Message，WEBJS 是 _data.type。认不出返回 null。
 * 只按源码和文档推断，GOWS 下的贴纸还没在真机上核实。
 */
function wahaRawKind(p) {
  const d = p?._data || {};
  const msg = d.Message || d.message || null;
  if (msg && typeof msg === 'object') {
    if (msg.stickerMessage) return 'sticker';
    if (msg.documentMessage || msg.documentWithCaptionMessage) return 'document';
  }
  if (d.type === 'sticker') return 'sticker';
  if (d.type === 'document') return 'document';
  return null;
}

/** WAHA message payload → 统一的入站结构 */
export function parseWahaMessage(p) {
  const rawChat = String(wahaChatOf(p) || '');
  const chatId = rawChat.replace(/@s\.whatsapp\.net$/i, '@c.us');
  const body = typeof p.body === 'string' ? p.body.trim() : '';
  let label = null;
  const rawKind = p.hasMedia ? wahaRawKind(p) : null;
  if (!body) {
    // 标签跟 media.type 一致：贴纸、按文件发的（SVG、按文件发的照片等）看消息本身，其他按 mime
    if (p.hasMedia) label = rawKind ? MEDIA_LABELS[rawKind] : mediaLabel(p.media?.mimetype);
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
  // 媒体：media.url 是 WAHA 下载好的文件地址（没下载时为 null），media.error 是下载出错的原因，media.filename 是文件的原始名字。
  // type 是显示类型（图片、视频、语音、文件、贴纸）；f4Type 是 F4 识别的类型，按 mime 判断（image/* 和 audio/*，和原来一样）。
  // 导入的历史消息 media 是 null（没下载），没有 mime 也认不出类型，这时不记媒体
  let media = null;
  const mime = p.hasMedia ? baseMime(p.media?.mimetype) : '';
  if (p.hasMedia && p.media && typeof p.media === 'object' && (mime || p.media.url)) {
    const f4Type = mediaTypeOf(mime);
    media = {
      type: rawKind || mediaKindOf(mime),
      f4Type,
      mime,
      url: typeof p.media.url === 'string' && p.media.url ? p.media.url : null,
      error: p.media.error ? String(typeof p.media.error === 'string' ? p.media.error : JSON.stringify(p.media.error)) : null,
      filename: cleanFilename(p.media.filename),
      seconds: f4Type === 'voice' ? wahaVoiceSeconds(p) : null,
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
    // F12：自己发的消息是从哪发的。WAHA 发出的（经它的 API）是 api，手机等其他设备发的是 app；有的引擎不给
    source: typeof p.source === 'string' ? p.source : null,
  };
}

const META_MEDIA_KIND = { image: 'image', video: 'video', audio: 'voice', document: 'document', sticker: 'sticker' };

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
  // 图片、视频、语音、文件、贴纸都是 {id, mime_type, …}（文件还有 filename），要先用 media id 换下载地址。
  // F4 只识别图片和语音（audio）
  let media = null;
  if (META_MEDIA_KIND[type] && msg[type]?.id) {
    media = {
      type: META_MEDIA_KIND[type],
      f4Type: type === 'image' ? 'image' : type === 'audio' ? 'voice' : null,
      mime: baseMime(msg[type].mime_type),
      id: String(msg[type].id),
      filename: type === 'document' ? cleanFilename(msg.document.filename) : null,
      seconds: null,
    };
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

/**
 * 配对码要关联的手机号：去掉空格、横线、括号，允许开头 + 或 00，剩下是 8–15 位、不以 0 开头的数字（带国家码）。
 * 返回纯数字号码，不合格返回 null。
 */
export function parsePairingPhone(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(?:\+|00)?([1-9]\d{7,14})$/.exec(raw.replace(/[\s\-()（）]/g, ''));
  return m ? m[1] : null;
}

/** 日志里的手机号只留后 4 位 */
export const maskPhone = (digits) => `***${String(digits).slice(-4)}`;

/**
 * 会话草稿 {kind, text, fileIds, createdAt}（F2a / F15 / 推荐回复）。kind：handoff 是转人工时起草的，suggest 是推荐回复；
 * 老数据没有 kind，当 handoff。A 段存的 {text, createdAt} 也认，fileIds 记 []；文字和文件都没有时视为没有草稿
 */
export const parseDraft = (raw) => {
  const d = safeJsonParse(raw, null);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const text = typeof d.text === 'string' ? d.text : '';
  const fileIds = normalizeFileIds(d.fileIds).slice(0, MAX_FILES_PER_REPLY);
  if (!text.trim() && !fileIds.length) return null;
  return { kind: d.kind === 'suggest' ? 'suggest' : 'handoff', text, fileIds, createdAt: typeof d.createdAt === 'string' ? d.createdAt : null };
};

/**
 * @param {any} ctx  需要 ctx.accounts（accounts.js 的存储）、ctx.mailer、ctx.relays
 * @param {{
 *   humanize?: Partial<typeof DEFAULT_HUMANIZE>,
 *   notifyRetryDelayMs?: number,
 *   onDecision?: (row:any) => void,
 *   onDeclined?: (p:{accountId:string, conversationId:string, ts:string}) => void,
 *   wahaInlineMaxBytes?: number,
 *   wahaPairWaitMs?: number,
 *   wahaPollMs?: number,
 *   historyImportDelayMs?: number,
 * }} [opts]
 *   onDecision：每写一行处理记录调一次（测试用）；onDeclined：会话被判 declined 时调（测试用；外联对象记 declinedAt 走 ctx.outreach）
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
  /** 客户媒体单个文件的上限（测试里可以调小） */
  const mediaMaxBytes = opts.mediaStoreMaxBytes ?? MEDIA_STORE_MAX_BYTES;
  const pairWaitMs = opts.wahaPairWaitMs ?? PAIR_WAIT_MS;
  const wahaPollMs = opts.wahaPollMs ?? PAIR_POLL_MS;
  const historyDelayMs = opts.historyImportDelayMs ?? HISTORY_IMPORT_DELAY_MS;
  /** @type {Map<string, NodeJS.Timeout>} 号 id → 等着导入已有聊天的定时器 */
  const historyTimers = new Map();
  /** @type {Set<string>} 正在导入已有聊天的号 */
  const historyRunning = new Set();
  const startedAt = Date.now();
  let closed = false;
  /** 客户媒体存盘 */
  const mediaStore = createMediaStore(config.dataDir);
  /** @type {Set<{promise:Promise<any>, ac:AbortController}>} 正在下载存盘的媒体（关闭时中止） */
  const mediaJobs = new Set();
  // 上次进程退出时没下完的：半截文件删掉，消息记为下载失败
  try {
    mediaStore.cleanTmp();
    db.prepare(
      `UPDATE messages SET media = json_set(media, '$.stored', 'failed', '$.error', '下载被中断（服务重启），请在手机上查看')
       WHERE media IS NOT NULL AND json_valid(media) AND json_extract(media, '$.stored') = 'pending'`,
    ).run();
  } catch (err) {
    log.warn(`[wa] 清理没下完的媒体出错：${err?.message || err}`);
  }

  const settings = () => ctx.getSettings();

  function state(accountId) {
    let s = accState.get(accountId);
    if (!s) {
      s = { lastWahaStatus: null, connectedAt: 0, lastWebhookAt: null, statusCache: null, replies: [], usageHintAt: 0, pairCodeAt: 0 };
      accState.set(accountId, s);
    }
    return s;
  }

  // ---------------- 处理记录（F12 的 decisions 表） ----------------
  /** 每处理一轮写一行（合并的几条消息算一轮）；skipped 不调这里 */
  function recordDecision(accountId, conversationId, r) {
    const row = {
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
    };
    ctx.records.decision(row);
    if (!opts.onDecision) return;
    try {
      opts.onDecision(row);
    } catch (err) {
      log.warn(`[wa] 记录处理结果失败：${err?.message || err}`);
    }
  }

  // ---------------- 发送 ----------------
  /**
   * 记下本服务经 API 发出去的消息（bot 回复、后台人工、F3 转发和回执、通知、文件、F11 外联），
   * 用来从 message.any 的 fromMe 消息里剔除回声（F12）。发请求之前就记，id 等 API 返回后再补：回声可能比 API 响应先到。
   */
  function rememberSent(accountId, chatId, text) {
    const now = Date.now();
    const list = (recentSent.get(accountId) || []).filter((e) => now - e.at < ECHO_ID_KEEP_MS);
    const entry = { id: null, short: null, chatId, text: String(text ?? '').trim(), at: now };
    list.push(entry);
    recentSent.set(accountId, list);
    return entry;
  }

  /**
   * F12：这条 fromMe 消息是不是本服务经 API 发出去的回声。WAHA 标了 source=api 的调用方已经直接判掉；这里先按
   * message id 判断（完整 id 或最后一段），再用"同一 chat + 相同文本 + 30 秒内"兜底（回声比 API 响应先到时还没有 id）。
   * WAHA 标了 source=app（手机等其他设备发的）时不用文本兜底，免得机主刚好发了同样的文字、或者在机器人发文件后
   * 30 秒内发了不带说明的图片（文本都是空）被误删；id 对得上的照样剔除。
   */
  function isOwnEcho(accountId, chatId, externalId, text, byText = true) {
    const now = Date.now();
    const list = recentSent.get(accountId) || [];
    const short = externalId ? shortMessageId(externalId) : null;
    const body = String(text ?? '').trim();
    return list.some(
      (e) =>
        (externalId && (e.id === externalId || (short && e.short === short))) ||
        (byText && e.chatId === chatId && e.text === body && now - e.at <= ECHO_TEXT_WINDOW_MS),
    );
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
    // 按客户分配：负责人（未分配、或负责人的用户行已经没了时为 null）和最近一次分配的时间
    const assigned = !!r.assignee_id && r.assignee_email != null;
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
      assignee: assigned ? { id: r.assignee_id, name: r.assignee_name ?? '', email: r.assignee_email, disabled: !!r.assignee_disabled } : null,
      assignedAt: assigned ? r.assigned_at ?? null : null,
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
      // 客户发来的媒体 {type, mime, size, filename, stored, error}（旧数据只有 {type, mime}）；F15：这条消息发的文件 {fileId, filename, mime, size}
      media: publicMedia(safeJsonParse(r.media, null)),
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
    if (status === 'sent') clearSuggestion(conv.id);
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
    if (status === 'sent') clearSuggestion(conv.id);
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  function sendNotice(acc, convId, reason, detail) {
    setImmediate(() => {
      notifier.notifyHandoff(acc, convId, reason, detail).catch((err) => log.error(`[notify] 通知失败：${err?.message || err}`));
    });
  }

  /**
   * 标 needsHuman（同时记下待处理原因）。needsHuman 从 false 变 true 时才发通知（4.2）；notify=false 时由调用方稍后自己发
   * （F2a：先生成草稿再通知）。从 false 变 true 时还新建一条转人工记录（F12 handoffs，code 是这次的 F12 code）。
   * 返回这次是不是从 false 变成了 true。
   * @param {'handoff'|'blocked'|'non_text'|'rate_limit'} reason
   * @param {{pause:boolean, code:string, pendingReason?:string, notify?:boolean}} o pendingReason 默认用 detail
   */
  function flagNeedsHuman(acc, convId, reason, detail, { pause, code, pendingReason, notify = true }) {
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
    if (fresh) ctx.records.handoffStart({ conversationId: convId, accountId: before.account_id, code });
    if (fresh && acc && notify) sendNotice(acc, convId, reason, detail);
    return fresh;
  }

  /**
   * 我方发出了消息（机器人、手机上回、外联）：清掉推荐回复（kind=suggest 的草稿）。
   * 转人工草稿照旧只在人工接管（operatorTakeover，同时也清推荐）和恢复机器人时清
   */
  function clearSuggestion(convId) {
    db.prepare("UPDATE conversations SET draft = NULL WHERE id = ? AND json_valid(draft) AND json_extract(draft, '$.kind') = 'suggest'").run(convId);
  }

  /** 人工接管：会话进入 botPaused，草稿清空，取消防抖和拟真发送 */
  function operatorTakeover(convId) {
    db.prepare('UPDATE conversations SET bot_paused = 1, draft = NULL WHERE id = ?').run(convId);
    cancelTimer(convId);
    abortSending(convId, 'operator');
    skipPending(convId, '人工已接管');
  }

  /**
   * F12：发出去的人工消息填转人工记录的首次回复。后台发的记 admin_ui（带发送人），F3 在 WhatsApp 里转发的记 whatsapp_relay。
   * 发送失败的不算（客户没收到）。
   */
  function noteOperatorResponse(convId, msg, { via, sentBy }) {
    if (msg.status !== 'sent') return;
    ctx.records.handoffResponse({
      conversationId: convId,
      kind: via === 'whatsapp' ? 'whatsapp_relay' : 'admin_ui',
      userId: via === 'whatsapp' ? null : sentBy?.id ?? null,
      at: msg.ts,
    });
  }

  /** 人工发送（后台或 F3 转发）：立即发，不做拟真等待；会话进入 botPaused，草稿清空 */
  async function operatorDeliver(acc, convId, text, { via, sentBy }) {
    operatorTakeover(convId);
    const msg = await sendAndRecord(acc, getConvRow(convId), clip(text, MAX_OPERATOR_TEXT), { author: 'operator', via, sentBy });
    noteOperatorResponse(convId, msg, { via, sentBy });
    return msg;
  }

  /** 人工发文件（后台或 F3 的 /d）：和人工发消息一样，会话进入 botPaused */
  async function operatorDeliverFile(acc, convId, file, { via, sentBy, caption = '' }) {
    operatorTakeover(convId);
    const msg = await sendFileAndRecord(acc, getConvRow(convId), file, { author: 'operator', via, sentBy, caption: clip(caption, MAX_CAPTION) });
    noteOperatorResponse(convId, msg, { via, sentBy });
    return msg;
  }

  /** 恢复机器人：清掉暂停、待处理和草稿；还开着的转人工记录填上 resumedAt（F12） */
  function resumeBot(convId) {
    db.prepare('UPDATE conversations SET bot_paused = 0, needs_human = 0, pending_reason = NULL, draft = NULL WHERE id = ?').run(convId);
    ctx.records.handoffResume({ conversationId: convId });
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

  /** 是不是这个号的通知号码。它发来的消息只当 F3 指令或按黑名单处理，不进会话（入站和导入已有聊天共用） */
  const isNotifyNumber = (acc, number) => !!(number && acc.notify.whatsapp.number && number === acc.notify.whatsapp.number);

  /** 4.1 黑白名单（按号） */
  function inScope(acc, number, chatId) {
    if (number && acc.blocklist.includes(number)) return false;
    if (acc.scope === 'allowlist') {
      // F11：这个号发过外联的对象算在范围内（黑名单仍然优先）
      if (ctx.outreach?.isContact(acc.id, number, chatId)) return true;
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
    // F12：只有扫码号（WAHA message.any）会推自己发的消息；Meta 没有这一项
    if (m.fromMe && acc.channel !== 'waha') return 'ignored_from_me';
    const chatId = m.chatId;
    if (!chatId || isNonPrivateChat(chatId)) return 'ignored_non_private';
    // F12：本服务经 API 发出去的消息（机器人、人工、F3 转发和回执、通知）推回来的回声，剔除
    if (m.fromMe && (m.source === 'api' || isOwnEcho(acc.id, chatId, m.externalId, m.text, m.source !== 'app'))) return 'ignored_echo';
    const convId = conversationIdOf(acc.id, chatId);
    const key = m.externalId ? `${acc.id}|${m.externalId}` : null;
    if (
      key &&
      (inflight.has(key) ||
        seenCommands.has(key) ||
        (m.fromMe
          ? hasMessageId(convId, m.externalId)
          : db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?').get(convId, m.externalId)))
    ) {
      return 'ignored_duplicate';
    }
    if (m.timestampMs < cutoffMs(acc)) return 'ignored_old';
    if (key) inflight.add(key);
    try {
      const number = await resolveNumber(acc, m);
      if (m.fromMe) {
        // 机主在手机上发的：发给通知号码的、回复范围外的不存
        if (isNotifyNumber(acc, number) || !inScope(acc, number, chatId)) return 'out_of_scope';
        return archiveOwner(acc, m, number);
      }
      if (isNotifyNumber(acc, number)) {
        // 通知号码：开了 WhatsApp 通知时按 F3 处理，否则按黑名单处理（4.2）
        if (!acc.notify.whatsapp.enabled) return 'out_of_scope';
        if (key) {
          const now = Date.now();
          for (const [k, t] of seenCommands) if (now - t > 3600_000) seenCommands.delete(k);
          seenCommands.set(key, now);
        }
        return await handleNotifyReply(acc, m);
      }
      if (!inScope(acc, number, chatId)) return 'out_of_scope';
      // F11：外联对象回复了，记 repliedAt（之后照常进回复流程）
      ctx.outreach?.noteInbound({ accountId: acc.id, number, chatId, conversationId: convId });
      return archive(acc, m, number);
    } finally {
      if (key) inflight.delete(key);
    }
  }

  /**
   * 会话里有没有这个 id 的消息：完整 id 相同，或者最后一段（短 id）相同。WAHA 不同地方给的 id 前缀可能不同
   * （true_<chat>_<id> 和 <id>，@c.us 和 @s.whatsapp.net），和导入已有聊天的去重规则一样。
   */
  function hasMessageId(convId, externalId) {
    const short = shortMessageId(externalId);
    return !!db
      .prepare(
        `SELECT 1 FROM messages WHERE conversation_id = ? AND external_id IS NOT NULL
           AND (external_id = ? OR external_id = ? OR substr(external_id, -length(?) - 1) = '_' || ?) LIMIT 1`,
      )
      .get(convId, externalId, short, short, short);
  }

  /**
   * F12：机主在手机上直接发的消息（fromMe、不是回声），存成 author=owner、via=phone 的消息，只用于统计和展示：
   * 不暂停机器人、不取消防抖和拟真发送、不标待处理、不通知，只拿来填转人工记录的 phone 首次回复（时间按收到的时间），
   * 以及清掉推荐回复。
   * 会话不存在就新建；联系人名字不从这条消息取（fromMe 消息里的 pushName 是机主自己），号码只补空的。
   */
  function archiveOwner(acc, m, number) {
    const now = nowIso();
    const convId = conversationIdOf(acc.id, m.chatId);
    const isText = !!m.text;
    let inserted = 0;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
         VALUES(?, ?, ?, ?, '', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           contact_number = CASE WHEN conversations.contact_number = '' THEN excluded.contact_number ELSE conversations.contact_number END`,
      ).run(convId, acc.id, m.chatId, acc.channel, number || '', now, now);
      inserted = db
        .prepare(
          `INSERT OR IGNORE INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, status, handled, via, media)
           VALUES(?, ?, ?, 'out', 'owner', ?, ?, ?, 'sent', 1, 'phone', ?)`,
        )
        .run(
          newId(),
          convId,
          m.externalId || null,
          isText ? 'text' : 'media',
          // 媒体不下载，只存标签（有说明文字时存文字），和导入的手机回复一样
          isText ? clip(m.text, MAX_STORED_TEXT) : m.mediaLabel || '[非文字消息]',
          new Date(m.timestampMs).toISOString(),
          m.media ? JSON.stringify({ type: m.media.type, mime: m.media.mime || null }) : null,
        ).changes;
    })();
    if (!inserted) return 'ignored_duplicate';
    ctx.records.handoffResponse({ conversationId: convId, kind: 'phone', at: now });
    // 手机上回了：推荐回复作废
    clearSuggestion(convId);
    return 'archived_owner';
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
    // 机器人只在自动回复、会话没暂停时处理；人工回复的号只存消息，不调用模型（推荐回复要业务员在会话页手动要）
    const botOn = acc.replyMode === 'auto' && !conv.bot_paused;
    // F4：开了对应的识别、机器人要处理、模型已配置时，先存一条占位消息，识别成文字后再进回复流程
    const s = settings();
    const f4Type = m.media?.f4Type || null;
    if (f4Type && (f4Type === 'voice' ? s.media.voice : s.media.image) && botOn && llmConfigured(s, config)) {
      const label = f4Type === 'voice' ? '[语音]' : '[图片]';
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
          storedMediaJson(m.media),
        );
      if (res.changes === 0) return 'ignored_duplicate';
      abortSending(convId, 'new_message');
      // 存盘和识别共用一次下载：识别等存盘的结果，存成了就读文件
      const saved = startMediaStore(acc, msgId, m.media);
      startConversion(acc, convId, msgId, m, saved);
      return 'converting';
    }
    const willProcess = isText && botOn;
    let skipReason = null;
    if (!isText) skipReason = `非文字消息${m.mediaLabel ? `${m.mediaLabel}` : ''}，已通知人工`;
    else if (acc.replyMode !== 'auto') skipReason = '这个号没开自动回复';
    else if (conv.bot_paused) skipReason = '会话已暂停（人工接管中）';
    const msgId = newId();
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, bot_decision, decision_reason, status, handled, media)
         VALUES(?, ?, ?, 'in', 'customer', ?, ?, ?, ?, ?, 'received', ?, ?)`,
      )
      .run(
        msgId,
        convId,
        m.externalId || null,
        isText ? 'text' : 'media',
        isText ? clip(m.text, MAX_STORED_TEXT) : m.mediaLabel || '[非文字消息]',
        new Date(m.timestampMs).toISOString(),
        willProcess ? null : 'skipped',
        willProcess ? null : skipReason,
        willProcess ? 0 : 1,
        m.media ? storedMediaJson(m.media) : null,
      );
    if (res.changes === 0) return 'ignored_duplicate';
    // 客户发来的媒体：后台下载存盘，不等结果
    if (m.media) startMediaStore(acc, msgId, m.media);
    // F1 / F14：正在拟真发送时客户又来了消息，没发出去的取消，新消息合进去重新走
    abortSending(convId, 'new_message');
    if (!isText) {
      // 没开识别时机器人处理不了这条：转人工记录的 code 记 media_unsupported（F12 的表里没有非文字消息这一项）
      flagNeedsHuman(acc, convId, 'non_text', m.mediaLabel || '', { pause: false, code: 'media_unsupported', pendingReason: skipReason });
      return 'archived_media';
    }
    if (willProcess) {
      scheduleFlush(convId);
      return 'scheduled';
    }
    return 'archived';
  }

  // ---------------- 客户媒体存盘 ----------------
  /** 新消息里 media 列的初始值：stored=pending，下载完改成 ok / too_large / failed */
  function storedMediaJson(media) {
    return JSON.stringify({
      type: media.type,
      mime: media.mime || null,
      size: null,
      filename: media.filename || null,
      stored: 'pending',
      error: null,
      fileKey: null,
    });
  }

  /** 把存盘结果并进消息的 media 列（读出来合并再写回，不动别的列） */
  function patchStoredMedia(msgId, result) {
    db.transaction(() => {
      const row = db.prepare('SELECT media FROM messages WHERE id = ?').get(msgId);
      if (!row) return;
      const cur = safeJsonParse(row.media, null) || {};
      const next = {
        ...cur,
        mime: cur.mime || result.mime || null,
        size: result.size ?? cur.size ?? null,
        stored: result.stored,
        error: result.error ?? null,
        fileKey: result.fileKey ?? null,
      };
      db.prepare('UPDATE messages SET media = ? WHERE id = ?').run(JSON.stringify(next), msgId);
    })();
  }

  /**
   * 下载一条客户消息里的媒体存进 <dataDir>/media/，结果写回消息的 media 列。不抛错。
   * WAHA 用事件里的 media.url（WAHA 默认只留 180 秒，所以收到就下）；Meta 用 media id 走 Graph API（下载地址 5 分钟有效）。
   * @returns {Promise<{stored:'ok'|'too_large'|'failed', fileKey?:string, size?:number|null, mime?:string, error?:string}>}
   */
  async function storeMedia(acc, msgId, media, signal) {
    let result;
    try {
      let res;
      let mime = media.mime || '';
      if (acc.channel === 'waha') {
        if (media.error) throw new Error(`WAHA 下载媒体出错：${media.error}`);
        if (!media.url) throw new Error('WAHA 没有提供下载地址（检查 WAHA_EVENTS_DOWNLOAD_MEDIA）');
        res = await waha.fetchMedia(media.url, { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS, signal });
      } else {
        if (!media.id) throw new Error('消息里没有 media id');
        const opened = await metaOpenMedia(config.metaGraphUrl, acc.meta, media.id, {
          maxBytes: mediaMaxBytes,
          timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
          signal,
        });
        res = opened.res;
        mime = mime || opened.mime;
      }
      // res 是 node:http 的 IncomingMessage（媒体下载不走 fetch，见 media-download.js）
      mime = mime || baseMime(res.headers['content-type']);
      const { key, size } = await mediaStore.saveResponse(res, { maxBytes: mediaMaxBytes });
      result = { stored: 'ok', fileKey: key, size, mime };
    } catch (err) {
      if (err instanceof TooLargeError) result = { stored: 'too_large', size: Number.isFinite(err.size) ? err.size : null, error: MEDIA_TOO_LARGE_TEXT };
      else result = { stored: 'failed', error: clip(String(err?.message || err), 300) };
    }
    if (closed) {
      // 关闭时被中止的：消息留在 pending，下次启动时记为中断；已经存下的文件不要了
      if (result.fileKey) await mediaStore.remove(result.fileKey);
      return { stored: 'failed', error: '服务正在关闭' };
    }
    try {
      patchStoredMedia(msgId, result);
    } catch (err) {
      log.warn(`[wa] 记录媒体存盘结果出错：${err?.message || err}`);
    }
    if (result.stored !== 'ok') log.warn(`[wa] 消息 ${msgId} 的媒体没有存下（${result.stored}）：${result.error}`);
    return result;
  }

  /** 后台开始下载存盘，返回结果的 promise（不会 reject）；F4 识别要用它 */
  function startMediaStore(acc, msgId, media) {
    const ac = new AbortController();
    const job = { ac, promise: null };
    job.promise = storeMedia(acc, msgId, media, ac.signal)
      .catch((err) => {
        log.error(`[wa] 媒体存盘出错：${err?.stack || err}`);
        return { stored: 'failed', error: String(err?.message || err) };
      })
      .finally(() => mediaJobs.delete(job));
    mediaJobs.add(job);
    return job.promise;
  }

  // ---------------- F4：语音、图片转文字 ----------------
  function startConversion(acc, convId, msgId, m, saved) {
    converting.set(convId, (converting.get(convId) || 0) + 1);
    // F12：识别用的模型调用记到这个号和会话上
    llmScope({ accountId: acc.id, conversationId: convId }, () => convertMedia(acc, convId, msgId, m, saved))
      .catch((err) => log.error(`[wa] 识别会话 ${convId} 的${m.media.f4Type === 'voice' ? '语音' : '图片'}出错：${err?.stack || err}`))
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
  async function convertMedia(acc, convId, msgId, m, saved) {
    const started = Date.now();
    const type = m.media.f4Type;
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
      flagNeedsHuman(accounts.get(acc.id), convId, 'non_text', `${what}：${why}`, { pause: false, code, pendingReason: reason });
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
    let buffer = null;
    let mime;
    const tooBig = () => fail('media_unsupported', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB`);
    // 优先用存盘下来的文件，不重复下载；没存成功（下载失败）再按原来的方式下载一次
    const stored = saved ? await saved : null;
    if (stored?.stored === 'too_large') return tooBig();
    if (stored?.stored === 'ok' && stored.fileKey) {
      if (Number(stored.size) > limits.maxBytes) return tooBig();
      try {
        buffer = await mediaStore.read(stored.fileKey);
        mime = stored.mime;
      } catch (err) {
        log.warn(`[wa] 读存下的媒体文件失败，改为重新下载：${err?.message || err}`);
        buffer = null;
      }
    }
    if (!buffer) {
      try {
        ({ buffer, mime } = await downloadMedia(acc, m.media, limits.maxBytes));
      } catch (err) {
        if (err instanceof TooLargeError || /文件太大/.test(String(err?.message))) return tooBig();
        return fail('media_failed', `下载失败：${err?.message || err}`);
      }
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
      // F12：这一轮的模型调用（生成、重写、审核、草稿）都记到这个号和会话上
      const accountId = getConvRow(convId)?.account_id ?? null;
      await llmScope({ accountId, conversationId: convId }, () => processPending(convId));
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
    if (acc.replyMode !== 'auto') return void settle('skipped', '这个号没开自动回复');
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
      flagNeedsHuman(acc, convId, 'rate_limit', detail, { pause: true, code: 'rate_limit', pendingReason: reason });
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

    const history = historyBefore(convId, pending[0].seq);
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
      case 'declined': {
        // F11：客户明确拒绝。不回复、不通知、不标待处理（needsHuman 保持 false）；会话暂停，之后不再自动发出任何消息，
        // 管理员可以手动恢复。这期间又来的消息不再处理
        settle('declined', result.reason, result.code);
        recordDecision(acc.id, convId, result);
        db.prepare('UPDATE conversations SET bot_paused = 1 WHERE id = ?').run(convId);
        cancelTimer(convId);
        skipPending(convId, '客户已拒绝，机器人已停止');
        customerDeclined(acc.id, convId);
        return;
      }
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
        const fresh = flagNeedsHuman(accNow, convId, result.decision, result.reason, { pause: true, code: result.code, notify: false });
        await prepareDraft(accNow, convId, { message, history, reason: result.reason, usedToday: used });
        if (fresh && !closed) sendNotice(accounts.get(acc.id) || accNow, convId, result.decision, result.reason);
      }
    }
  }

  /**
   * F11：会话被判 declined 时调。这个会话对应的外联对象（Recipient）记 declinedAt；他有会话了，后续任务按 already_contacted
   * 跳过他。opts.onDeclined 是测试用的钩子。
   */
  function customerDeclined(accountId, convId) {
    const p = { accountId, conversationId: convId, ts: nowIso() };
    for (const fn of [ctx.outreach?.noteDeclined, opts.onDeclined]) {
      if (!fn) continue;
      try {
        fn(p);
      } catch (err) {
        log.warn(`[wa] 处理客户拒绝的钩子出错：${err?.message || err}`);
      }
    }
  }

  /** 一条消息在上下文里的文字：我方发的附件用标签（[文件] 文件名）加上说明文字 */
  const contextText = (r) => {
    const label = attachmentLabel(r.attachment);
    return label ? `${label}${r.text ? ` ${r.text}` : ''}` : r.text;
  };

  /** seq 之前的最近 12 条消息（自动回复、草稿、推荐回复共用的上下文） */
  function historyBefore(convId, seq) {
    return db
      .prepare('SELECT direction, text, attachment FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT 12')
      .all(convId, seq)
      .reverse()
      .map((r) => ({ role: r.direction === 'in' ? 'customer' : 'bot', text: contextText(r) }));
  }

  // ---------------- 推荐回复（只能手动要：会话页「推荐回复」「换一条」；客户来消息时不会自动起草） ----------------
  /**
   * 推荐回复的输入，分两种情况：
   * - 客户在我方最后一条之后还有新消息：「客户这次的消息」= 这些新消息（合并，最多最近 20 条），history 是它们之前的最近对话
   *   （包括再之前我方说的话）；followUp 为 false。
   * - 跟进（我方说的是最后一条，客户没再发）：message 是客户最后那段连续的消息（我方已经回过），history 一直取到会话最新一条
   *   （包括我方最后发的那几条：人工、手机上回的、机器人、外联都算，附件用标签）；followUp 为 true，ourMessages 是客户那段消息
   *   之后我方发的消息（最多最近 MAX_FOLLOWUP_MESSAGES 条），单独列给模型看，也参与检索。
   * 会话里一条客户消息都没有时为 null（外联发出去客户没回之类，现状如此，不起草）。
   * @returns {{message:string, history:any[], followUp:boolean, ourMessages:string[]}|null}
   */
  function suggestInput(convId) {
    const lastOut = db.prepare("SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ? AND direction = 'out'").get(convId).n;
    const inSince = (after, upTo) =>
      db
        .prepare("SELECT seq, text FROM messages WHERE conversation_id = ? AND direction = 'in' AND seq > ? AND seq <= ? ORDER BY seq")
        .all(convId, after, upTo);
    let rows = inSince(lastOut, Number.MAX_SAFE_INTEGER);
    if (rows.length) {
      rows = rows.slice(-MAX_SUGGEST_MESSAGES);
      return { message: rows.map((r) => r.text).join('\n'), history: historyBefore(convId, rows[0].seq), followUp: false, ourMessages: [] };
    }
    const lastIn = db.prepare("SELECT MAX(seq) n FROM messages WHERE conversation_id = ? AND direction = 'in'").get(convId).n;
    if (lastIn == null) return null;
    const outBefore = db
      .prepare("SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ? AND direction = 'out' AND seq < ?")
      .get(convId, lastIn).n;
    rows = inSince(outBefore, lastIn).slice(-MAX_SUGGEST_MESSAGES);
    if (!rows.length) return null;
    const ours = db
      .prepare("SELECT text, attachment FROM messages WHERE conversation_id = ? AND direction = 'out' AND seq > ? ORDER BY seq DESC LIMIT ?")
      .all(convId, lastIn, MAX_FOLLOWUP_MESSAGES)
      .reverse()
      .map(contextText);
    return {
      message: rows.map((r) => r.text).join('\n'),
      history: historyBefore(convId, Number.MAX_SAFE_INTEGER),
      followUp: true,
      ourMessages: ours,
    };
  }

  /** 「我的资料」里 AI 要用的字段；全没填时为 null（提示词里就不放【业务员信息】） */
  const agentProfileOfRow = (u) => {
    const p = {
      displayName: u.display_name ?? '',
      jobTitle: u.job_title ?? '',
      contactPhone: u.contact_phone ?? '',
      contactEmail: u.contact_email ?? '',
      bio: u.bio ?? '',
    };
    return Object.values(p).some((v) => String(v).trim()) ? p : null;
  };

  /**
   * 成员的个人话术和「我的资料」（起草推荐回复、转人工草稿用）。没有这个人时都是空的；activeOnly 时停用的成员也按没有算。
   * @returns {{stylePrompt:string, agentProfile:any}}
   */
  function memberAiInfo(userId, { activeOnly = false } = {}) {
    const u = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
    if (!u || (activeOnly && u.disabled)) return { stylePrompt: '', agentProfile: null };
    return { stylePrompt: u.style_prompt ?? '', agentProfile: agentProfileOfRow(u) };
  }

  /**
   * 调一次模型起草推荐回复（计入会话每日模型次数），返回 {draft, startSeq}，不存。生成失败、结果为空时抛错。
   * startSeq 是开始生成时会话里最大的消息序号，调用方用它判断生成期间我方是不是已经回了。
   * 跟进时我方最后那几条（ourMessages）也参与检索（buildReplyContext 的 extraQuery）。
   * @param {{message:string, history:any[], followUp?:boolean, ourMessages?:string[]}} input suggestInput 的结果
   * @param {{stylePrompt?:string, agentProfile?:any, previous?:string}} o agentProfile 是点按钮那个人的「我的资料」
   */
  async function generateSuggestion(acc, convId, input, { stylePrompt = '', agentProfile = null, previous = '' }) {
    const today = localDay();
    const before = getConvRow(convId);
    const startSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ?').get(convId).n;
    db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(
      today,
      (before.llm_day === today ? before.llm_calls : 0) + 1,
      convId,
    );
    const s = settings();
    const followUp = !!input.followUp;
    const c = buildReplyContext(ctx, { message: input.message, history: input.history, extraQuery: followUp ? input.ourMessages || [] : [] });
    const out = await ctx.ai.suggest({
      message: c.msg,
      history: c.hist,
      entries: c.entries,
      files: c.files,
      filesTruncated: c.filesTruncated,
      profile: c.profile,
      persona: acc.persona && acc.persona.trim() ? acc.persona : s.reply.persona,
      companyPrompt: s.suggest.companyPrompt,
      stylePrompt,
      agentProfile,
      previous,
      followUp,
      ourMessages: c.extra,
    });
    const active = new Set(c.activeFiles.map((f) => f.id));
    const fileIds = normalizeFileIds(out?.fileIds)
      .filter((id) => active.has(id))
      .slice(0, MAX_FILES_PER_REPLY);
    const text = clip(String(out?.text ?? '').trim(), MAX_DRAFT_TEXT);
    if (!text && !fileIds.length) throw new Error('推荐回复是空的');
    return { draft: { kind: 'suggest', text, fileIds, createdAt: nowIso() }, startSeq };
  }

  /** 从 startSeq 之后我方有没有发过消息（后台、手机、机器人、外联都算） */
  const repliedSince = (convId, startSeq) =>
    !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'out' AND seq > ? LIMIT 1").get(convId, startSeq);

  /**
   * F2a：转人工时给人工起草一条回复（不自动发送）。当天 LLM 次数不够、生成失败时不带草稿；
   * 生成期间人工已经回了或机器人已恢复的，丢掉这份草稿。
   * 带会话负责人的「我的资料」（草稿是给他发的）；没分配、负责人已停用或没填资料时不带。检索只用客户的话（不传 extraQuery）。
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
        agentProfile: memberAiInfo(before.assignee_id, { activeOnly: true }).agentProfile,
        reason,
      });
      const active = new Set(c.activeFiles.map((f) => f.id));
      const fileIds = normalizeFileIds(out?.fileIds)
        .filter((id) => active.has(id))
        .slice(0, MAX_FILES_PER_REPLY);
      const text = clip(String(out?.text ?? '').trim(), MAX_DRAFT_TEXT);
      if (!text && !fileIds.length) throw new Error('草稿是空的');
      draft = { kind: 'handoff', text, fileIds, createdAt: nowIso() };
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

  // ---------------- 关联后导入已有聊天 ----------------
  // 关联时手机同步过来的旧聊天 WAHA 存着但不推 webhook，所以号进入 WORKING 后主动拉一次，存成"静默"的历史消息：
  // 不回复、不调模型、不记缺口、不通知、不标待处理、不占每日额度。只收早于 cutoffMs 的消息（正是 webhook 当成旧消息
  // 忽略的那部分），之后的照常交给 webhook，两边不会抢同一条，客户刚发来的消息不会被当成历史吞掉。

  /** 号进入 WORKING 时调用：historyDelayMs 后在后台导入。已经在等或正在跑的不重复安排（同一个号同时只跑一次） */
  function scheduleHistoryImport(accountId) {
    if (closed || historyTimers.has(accountId) || historyRunning.has(accountId)) return;
    const t = setTimeout(() => {
      historyTimers.delete(accountId);
      importWahaHistory(accountId).catch((err) => log.error(`[waha] 号 ${accountId} 导入已有聊天出错：${err?.stack || err}`));
    }, historyDelayMs);
    t.unref?.();
    historyTimers.set(accountId, t);
  }

  function cancelHistoryImport(accountId) {
    const t = historyTimers.get(accountId);
    if (t) clearTimeout(t);
    historyTimers.delete(accountId);
  }

  /**
   * 拉 WAHA 里已有的聊天（最多 HISTORY_CHAT_LIMIT 个，每个最多 HISTORY_MESSAGES_PER_CHAT 条，不下载媒体）导入会话。
   * 哪些聊天收沿用 webhook 入站的规则：群、广播、频道不收，通知号码不收，黑白名单按号判断。按 external id 去重，可以重复跑。
   * 日志只记一行汇总，不记号码和内容。
   */
  async function importWahaHistory(accountId) {
    let acc = accounts.get(accountId);
    if (closed || !acc || acc.channel !== 'waha' || historyRunning.has(accountId)) return;
    if (state(accountId).lastWahaStatus !== 'WORKING') return;
    historyRunning.add(accountId);
    try {
      const cutoff = cutoffMs(acc);
      let chats;
      try {
        chats = await waha.listChats(acc.sessionName, HISTORY_CHAT_LIMIT);
      } catch (err) {
        log.warn(`[waha] 号 ${accountId} 导入已有聊天失败：读聊天列表出错（${err?.message || err}）`);
        return;
      }
      const n = { chats: 0, messages: 0, skipped: 0, outOfScope: 0, failed: 0 };
      for (const chat of chats.slice(0, HISTORY_CHAT_LIMIT)) {
        acc = accounts.get(accountId);
        if (closed || !acc) return;
        // 聊天对象只看 chat id（历史消息的 to 是 null），和入站一样把 @s.whatsapp.net 记成 @c.us
        const rawId = typeof chat?.id === 'string' ? chat.id : chat?.id?._serialized || '';
        const chatId = rawId.replace(/@s\.whatsapp\.net$/i, '@c.us');
        if (!chatId || isNonPrivateChat(chatId)) {
          n.outOfScope++;
          continue;
        }
        const number = await resolveNumber(acc, { channel: 'waha', chatId });
        if (isNotifyNumber(acc, number) || !inScope(acc, number, chatId)) {
          n.outOfScope++;
          continue;
        }
        let list;
        try {
          list = await waha.listChatMessages(acc.sessionName, rawId, HISTORY_MESSAGES_PER_CHAT);
        } catch {
          // 报错里可能带着 chat id（号码），只计数
          n.failed++;
          continue;
        }
        if (closed) return;
        // /chats 的 name 是字符串；/chats/overview 的顶层 name 是 null，名字在 _chat.name
        const name = String(chat.name || chat._chat?.name || '').trim();
        const r = saveHistory(acc, chatId, number, name, list.slice(0, HISTORY_MESSAGES_PER_CHAT), cutoff);
        if (r.inserted) n.chats++;
        n.messages += r.inserted;
        n.skipped += r.skipped;
      }
      log.info(
        `[waha] 号 ${accountId} 导入已有聊天：${n.chats} 个聊天、${n.messages} 条消息，跳过 ${n.skipped} 条（已有、太新或缺 id/时间）；` +
          `范围外的聊天 ${n.outOfScope} 个${n.failed ? `，读取失败 ${n.failed} 个` : ''}`,
      );
    } finally {
      historyRunning.delete(accountId);
    }
  }

  /**
   * 一个聊天的历史消息写进会话（一个事务，会话不存在就新建，已存在就并进去）。只收早于 cutoff、带 id 和时间的消息；
   * 已有的按 external id 跳过，短 id 也比一次（WAHA 两处给的 id 前缀可能不同，免得把机器人发过的消息又导成手机回复）。
   * fromMe 的是机主在手机上发的（author=owner，F12 的表示），其余是客户消息（handled=1，记 skipped）；都标 via=import，
   * ts 用原始时间。新会话的 created_at 取最早一条；updated_at 只往后推到最新一条导入消息的时间，不用"现在"。
   * 名字和号码只补空的，不覆盖 webhook 写进去的。
   * @returns {{inserted:number, skipped:number}}
   */
  function saveHistory(acc, chatId, number, name, list, cutoff) {
    const convId = conversationIdOf(acc.id, chatId);
    const known = new Set();
    for (const r of db.prepare('SELECT external_id FROM messages WHERE conversation_id = ? AND external_id IS NOT NULL').all(convId)) {
      known.add(r.external_id);
      known.add(shortMessageId(r.external_id));
    }
    const items = [];
    let skipped = 0;
    for (const p of list) {
      const m = parseWahaMessage(p || {});
      const short = m.externalId ? shortMessageId(m.externalId) : null;
      // parseWahaMessage 在没有时间时退回"现在"，历史消息不能这样，直接跳过
      if (!m.externalId || !(Number(p?.timestamp) > 0) || m.timestampMs >= cutoff || known.has(m.externalId) || known.has(short)) {
        skipped++;
        continue;
      }
      known.add(m.externalId);
      known.add(short);
      items.push(m);
    }
    if (!items.length) return { inserted: 0, skipped };
    items.sort((a, b) => a.timestampMs - b.timestampMs);
    const iso = (m) => new Date(m.timestampMs).toISOString();
    let inserted = 0;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
         VALUES(?, ?, ?, 'waha', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.updated_at ELSE conversations.updated_at END,
           contact_name = CASE WHEN conversations.contact_name = '' THEN excluded.contact_name ELSE conversations.contact_name END,
           contact_number = CASE WHEN conversations.contact_number = '' THEN excluded.contact_number ELSE conversations.contact_number END`,
      ).run(convId, acc.id, chatId, clip(name, 100), number || '', iso(items[0]), iso(items[items.length - 1]));
      const insert = db.prepare(
        `INSERT OR IGNORE INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, bot_decision, decision_reason,
                                        status, handled, via, media)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'import', ?)`,
      );
      for (const m of items) {
        const isText = !!m.text;
        inserted += insert.run(
          newId(),
          convId,
          m.externalId,
          m.fromMe ? 'out' : 'in',
          m.fromMe ? 'owner' : 'customer',
          isText ? 'text' : 'media',
          // 媒体不下载：和没开识别时的入站一样，只存标签（有说明文字时存文字）
          isText ? clip(m.text, MAX_STORED_TEXT) : m.mediaLabel || '[非文字消息]',
          iso(m),
          m.fromMe ? null : 'skipped',
          m.fromMe ? null : HISTORY_SKIP_REASON,
          m.fromMe ? 'sent' : 'received',
          m.media ? JSON.stringify({ type: m.media.type, mime: m.media.mime || null }) : null,
        ).changes;
      }
    })();
    return { inserted, skipped: skipped + items.length - inserted };
  }

  // ---------------- 状态 ----------------
  function observeWahaStatus(accountId, status) {
    if (!status) return;
    const st = state(accountId);
    if (status === 'WORKING' && st.lastWahaStatus && st.lastWahaStatus !== 'WORKING') st.connectedAt = Date.now();
    // 进入 WORKING（包括服务启动后第一次看到它是 WORKING）时导入已有聊天
    if (status === 'WORKING' && st.lastWahaStatus !== 'WORKING') scheduleHistoryImport(accountId);
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
   * WAHA session 的代理配置（4.5 / F13）。http 上游直接交给 WAHA；https / socks 上游指向 inkdove 的中继。
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

  /**
   * inkdove 管理的那部分 session 配置：webhook 和代理。
   * F12：订阅 message.any（收到的和自己发的消息都推，自己发的带 fromMe），用来记下机主在手机上发的消息。
   * 改了这里指纹就变，已有的号在服务启动时（init）或下次 start 时会把新配置 PUT 过去。
   */
  function wahaManagedConfig(acc) {
    const cfg = {
      webhooks: [
        {
          url: config.wahaWebhookUrl,
          events: ['message.any', 'session.status'],
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

  /** WAHA 的 404、422（session 不存在、不在可操作的状态）当作已完成 */
  const ignoreGone = (err) => {
    if (err instanceof WahaError && (err.status === 404 || err.status === 422)) return;
    throw err;
  };

  /**
   * 登出再启动，清掉 session 里残留的半截登录凭证。申请过配对码却没输入时会留下这种凭证，之后再启动
   * 会去"登录"然后 FAILED（Connection Failure），永远回不到 SCAN_QR_CODE。
   * GOWS 实测：登出后 session 自己重启，1 秒内到 SCAN_QR_CODE；这时再 start 什么也不做。start 留着是防登出后停在
   * STOPPED 的版本；别的版本对运行中的 session 可能返回 422，忽略。
   */
  async function logoutThenStart(acc) {
    log.info(`[waha] 号 ${acc.id} 的会话重启后还是 FAILED：先登出清掉残留的登录凭证，再重新启动`);
    await waha.logoutSession(acc.sessionName).catch(ignoreGone);
    await waha.startSession(acc.sessionName).catch((err) => {
      if (!(err instanceof WahaError && err.status === 422)) throw err;
    });
    const st = state(acc.id);
    st.connectedAt = 0;
    st.statusCache = null;
  }

  /**
   * 确保 session 存在并已启动，webhook 和代理配置同步到 WAHA。FAILED 的先普通重启（不登出），WORKING 的不动。
   * 返回 failed：进来时 session 是不是 FAILED（要等重启结果，见 settleOrRelogin）。
   */
  async function ensureWahaSession(acc) {
    const r = await relays.ensure(acc);
    if (r === 'failed') throw new HttpError(502, 'relay_failed', relays.error(acc.id) || '代理中继启动失败');
    const managed = wahaManagedConfig(acc);
    const hash = configHash(managed);
    let failed = false;
    try {
      const sess = await waha.getSession(acc.sessionName, 10_000);
      if (!sess) {
        await waha.createSession(acc.sessionName, managed);
        accounts.setWahaConfigHash(acc.id, hash);
      } else {
        const update = acc.wahaConfigHash !== hash || r === 'started' || r === 'restarted';
        failed = sess.status === 'FAILED';
        // 文档：session 不在 STOPPED 状态时，PUT 会用新配置自动 stop 再 start；stop 不会登出
        if (update) {
          await waha.updateSession(acc.sessionName, mergeConfig(sess.config, managed));
          accounts.setWahaConfigHash(acc.id, hash);
        }
        if (sess.status === 'STOPPED') await waha.startSession(acc.sessionName);
        else if (failed && !update) {
          // 普通重启：GOWS 对运行中的 session 调 start 什么也不做，FAILED 算不算"运行中"没核实过，所以先 stop（不登出）再 start
          log.info(`[waha] 号 ${acc.id} 的会话是 FAILED：先不登出，重启一次`);
          await waha.stopSession(acc.sessionName).catch(ignoreGone);
          await waha.startSession(acc.sessionName);
        }
      }
    } catch (err) {
      throw wahaFail(err);
    }
    state(acc.id).statusCache = null;
    return { failed };
  }

  /**
   * 等重启的结果：回到 WORKING 是恢复了（网络或代理抖动掉线的号不会被白白登出），到 SCAN_QR_CODE 就接着关联；
   * 重启后又落回 FAILED，多半是之前申请过配对码没输入、留下了半截登录凭证，这时才登出再启动一次。
   * 返回最后看到的 WAHA 状态。
   */
  async function settleOrRelogin(acc) {
    let status = await waitWahaSettled(acc);
    if (status === 'FAILED') {
      await logoutThenStart(acc);
      status = await waitWahaSettled(acc);
    }
    return status;
  }

  async function wahaStart(acc) {
    assertWaha(acc);
    const { failed } = await ensureWahaSession(acc);
    // 只有进来时是 FAILED 才等重启结果；正常启动直接返回，前端会轮询状态
    if (failed) {
      try {
        await settleOrRelogin(acc);
      } catch (err) {
        throw wahaFail(err);
      }
    }
    return getStatus(accounts.get(acc.id) || acc);
  }

  /** 等 session 离开 STOPPED / STARTING（最多 pairWaitMs），返回最后看到的 WAHA 状态 */
  async function waitWahaSettled(acc) {
    const deadline = Date.now() + pairWaitMs;
    for (;;) {
      const sess = await waha.getSession(acc.sessionName, 5000);
      const status = sess?.status || 'STOPPED';
      if (sess) observeWahaStatus(acc.id, status);
      if ((status !== 'STARTING' && status !== 'STOPPED') || Date.now() >= deadline) return status;
      await sleep(wahaPollMs);
    }
  }

  const statusLabel = (s) => WAHA_STATUS_LABEL[s] || s;

  /** request-code 的报错转成可读的中文。422 是会话不在 SCAN_QR_CODE（比如没人关联、刚好被 WAHA 停掉） */
  function requestCodeFail(err) {
    if (!(err instanceof WahaError)) return err;
    const m = /current status is (\w+)/i.exec(err.message);
    if (err.status === 422 && (m || err.message.includes('SCAN_QR_CODE'))) {
      const now = m ? `（当前：${statusLabel(m[1])}）` : '';
      return new HttpError(409, 'not_scan_qr', `现在不能获取配对码：会话不在等待关联状态${now}，请稍后重新获取`);
    }
    return new HttpError(502, 'waha_error', `获取配对码失败：${err.message}`);
  }

  /**
   * 手机号配对码（规格外新增，见 docs/deviations.md 第 34 条）。和扫码共用同一轮等待关联的 session：确保 session 已启动、
   * 进入 SCAN_QR_CODE，再向 WAHA 申请配对码。已连接的号直接拒绝，不会把在线的号登出。
   * @returns {Promise<{code:string}>}
   */
  async function wahaRequestCode(acc, rawPhone) {
    assertWaha(acc);
    const phone = parsePairingPhone(rawPhone);
    if (!phone) throw badRequest('请填带国家码的完整号码，例如 +86 138 0000 0000', 'bad_phone');
    const st = state(acc.id);
    const checkInterval = () => {
      const left = st.pairCodeAt + PAIR_CODE_INTERVAL_MS - Date.now();
      if (left > 0) throw new HttpError(429, 'too_frequent', `获取配对码太频繁，请 ${Math.ceil(left / 1000)} 秒后再试`);
    };
    const connected = () => new HttpError(409, 'already_connected', '这个号已经连接，不用再关联；要换号请先退出登录');
    checkInterval();
    try {
      const sess = await waha.getSession(acc.sessionName, 10_000);
      if (sess?.status === 'WORKING') throw connected();
      await ensureWahaSession(acc);
      // 不管进来时是什么状态，都等到能关联；启动后落到 FAILED 的登出再启动一次
      const status = await settleOrRelogin(acc);
      // FAILED 的号重启后连回来了，不用再关联
      if (status === 'WORKING') throw connected();
      if (status !== 'SCAN_QR_CODE') {
        throw new HttpError(502, 'waha_error', `会话没能进入等待关联状态（当前：${statusLabel(status)}），请稍后再试`);
      }
      // 等会话的这段时间里可能有另一个申请先发出去了：真正找 WhatsApp 要码之前再判一次间隔，判完立刻记下时间
      checkInterval();
      st.pairCodeAt = Date.now();
      let code;
      try {
        code = await waha.requestCode(acc.sessionName, phone);
      } catch (err) {
        throw requestCodeFail(err);
      }
      log.info(`[waha] 号 ${acc.id} 获取了配对码（手机号 ${maskPhone(phone)}）`);
      return { code };
    } catch (err) {
      throw wahaFail(err);
    } finally {
      st.statusCache = null;
    }
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

  /**
   * DELETE /api/accounts/:id：扫码号先登出、再删 WAHA session；会话和消息保留。
   * agent 在这个号上负责的会话变成未分配（见 accounts.js 的 delete），by 是删号的人
   */
  async function deleteAccount(acc, by = null) {
    if (acc.channel === 'waha') {
      const warn = (err) => {
        if (err instanceof WahaError && (err.status === 404 || err.status === 422)) return;
        log.warn(`[waha] 删除号 ${acc.id} 时 WAHA 出错（号照常删除）：${err?.message || err}`);
      };
      await waha.logoutSession(acc.sessionName).catch(warn);
      await waha.deleteSession(acc.sessionName).catch(warn);
    }
    await relays.stop(acc.id);
    cancelHistoryImport(acc.id);
    for (const r of db.prepare('SELECT id FROM conversations WHERE account_id = ?').all(acc.id)) {
      cancelTimer(r.id);
      abortSending(r.id, 'account_deleted');
    }
    accounts.delete(acc.id, by);
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
    // message.any 是现在订阅的；message 是老配置还没更新时推的（只有收到的消息），两种都按同一条路处理，按 id 去重
    if (body.event !== 'message.any' && body.event !== 'message') return 'ignored_event';
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
    wahaRequestCode,
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
      // 启动时已经连着的扫码号：查一次状态，第一次看到 WORKING 就会导入已有聊天。不等结果，WAHA 连不上也不耽误启动
      for (const acc of accounts.list()) {
        if (acc.channel === 'waha') getStatus(acc).catch(() => {});
      }
      // inkdove 管理的 session 配置变了（比如 F12 把 webhook 事件改成 message.any）：已有的号把新配置 PUT 过去，
      // 运行中的 session 由 WAHA 自动重启一次，登录态保留。指纹没变的、从没推过配置的（还没建 session，start 时按新配置建）
      // 不动；WAHA 连不上时只记日志，下次 start 时再同步
      for (const acc of accounts.list()) {
        if (acc.channel !== 'waha' || !acc.wahaConfigHash || acc.wahaConfigHash === configHash(wahaManagedConfig(acc))) continue;
        applyWahaConfig(acc)
          .then((r) => {
            if (r === 'updated') log.info(`[waha] 号 ${acc.id} 的 session 配置已更新（webhook 事件或代理有变化）`);
          })
          .catch((err) => log.warn(`[waha] 号 ${acc.id} 同步 session 配置失败，下次连接时再试：${err?.message || err}`));
      }
    },

    /**
     * @param {{accountIds?: string[]|null, accountId?: string|null, assignee?: string|null}} f accountIds=null 表示不限（admin）；
     *   assignee：null 不限，'none' 只要未分配的，其他是负责人的用户 id。agent 的可见范围见 auth.js 的 conversationScope
     */
    listConversations({ accountIds = null, accountId = null, assignee = null } = {}) {
      const where = [];
      const params = [];
      if (accountId) {
        where.push('c.account_id = ?');
        params.push(accountId);
      }
      if (assignee === 'none') {
        where.push('c.assignee_id IS NULL');
      } else if (assignee) {
        where.push('c.assignee_id = ?');
        params.push(assignee);
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
        out = await llmScope({ accountId: conv.account_id ?? null, conversationId: convId }, () =>
          ctx.ai.kbDraft({ question: clip(asked.join('\n'), 2000), answer: clip(answer, 4000) }),
        );
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

    /**
     * 手动要一条推荐回复（会话页「推荐回复」「换一条」）：号是什么回复方式都可以。用点按钮的人（user）的个人话术和「我的资料」，
     * 当前草稿的文字作为【上一条推荐】要求换个写法。成功后存进 draft 并返回；生成期间我方已经回了的照样返回、但不存。
     * 我方说的是最后一条时按跟进起草（见 suggestInput）。不改消息的处理结果，不动防抖。
     * @returns {Promise<{draft:any}>}
     */
    async suggestReply(convId, user) {
      const conv = getConvRow(convId);
      if (!conv) throw notFound('会话不存在');
      const acc = conv.account_id ? accounts.get(conv.account_id) : null;
      if (!acc) throw badRequest('这个会话所属的号已删除', 'account_deleted');
      if (!llmConfigured(settings(), config)) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
      const input = suggestInput(convId);
      if (!input) throw badRequest('这个会话里还没有客户消息', 'no_customer_message');
      const today = localDay();
      const usedToday = conv.llm_day === today ? conv.llm_calls : 0;
      if (usedToday + 1 > DAILY_LLM_LIMIT) {
        throw new HttpError(429, 'llm_daily_limit', `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次），明天再试`);
      }
      const previous = parseDraft(conv.draft)?.text ?? '';
      let r;
      try {
        r = await llmScope({ accountId: acc.id, conversationId: convId }, () =>
          generateSuggestion(acc, convId, input, { ...memberAiInfo(user?.id), previous }),
        );
      } catch (err) {
        throw new HttpError(502, 'llm_error', `生成推荐回复失败：${err?.message || err}`);
      }
      if (getConvRow(convId) && !repliedSince(convId, r.startSeq)) {
        db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(r.draft), convId);
      }
      return { draft: parseDraft(JSON.stringify(r.draft)) };
    },

    /**
     * 客户发来的一条媒体消息存下的文件（GET …/messages/:messageId/media 用）。没有这条消息、不是这个会话的、
     * 没存成功的、文件不在了，都是 404。
     * @returns {{path:string, mime:string, downloadName:string}}
     */
    mediaFile(convId, messageId) {
      const row = db.prepare('SELECT id, media FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, convId);
      const media = safeJsonParse(row?.media, null);
      if (!row || !media || media.stored !== 'ok') throw notFound('这条消息没有存下的文件');
      const p = mediaStore.pathOf(media.fileKey);
      if (!p || !fs.existsSync(p)) throw notFound('文件不存在');
      return { path: p, mime: baseMime(media.mime) || 'application/octet-stream', downloadName: downloadName(media, row.id) };
    },

    /**
     * 标为已处理（人工回复的号的会话页用）：只清待处理和待处理原因，还开着的转人工记录填上 resumedAt（F12：这次转人工结束了）。
     * 不动暂停状态和草稿（恢复机器人会清草稿，人工回复的号正靠草稿干活）
     */
    resolvePending(id) {
      if (!getConvRow(id)) throw notFound('会话不存在');
      db.prepare('UPDATE conversations SET needs_human = 0, pending_reason = NULL WHERE id = ?').run(id);
      ctx.records.handoffResume({ conversationId: id });
      return conversationById(id);
    },

    /** 关掉推荐回复 / 草稿卡片：清掉这个会话当前的草稿（suggest 和 handoff 都清）。没有草稿也照常返回 */
    clearDraft(id) {
      if (!getConvRow(id)) throw notFound('会话不存在');
      db.prepare('UPDATE conversations SET draft = NULL WHERE id = ?').run(id);
      return conversationById(id);
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
    /**
     * F11：发一条外联开场消息并落库（outreach/store.js 的发送循环调）。WAHA 用 sendText 发 text；Meta 发审核过的模板
     * （type:"template"），text 只存档。和其他经 API 发出的消息一样先登记回声，手机那边推回来的 fromMe 消息会被剔除。
     * 会话不存在就新建、已有就复用；消息记 author=bot、via=campaign，推荐回复作废。发送失败直接抛错，不落库。
     * 会话还没有负责人、发起人（createdById）是有这个号权限的启用中 agent 时，分给发起人（见 assign.js 的 assignCampaignConversation）。
     * @param {any} acc
     * @param {{chatId:string, number:string, text:string, template?:{name:string, languageCode:string}|null, createdById?:string|null}} p
     * @returns {Promise<{conversationId:string, messageId:string, externalId:string|null}>}
     */
    async sendCampaignMessage(acc, { chatId, number, text, template = null, createdById = null }) {
      if (!acc) throw new Error('这个号已删除');
      const entry = rememberSent(acc.id, chatId, text);
      let externalId;
      if (acc.channel === 'waha') externalId = await waha.sendText(acc.sessionName, chatId, text);
      else if (acc.channel === 'meta') externalId = await metaSendTemplate(config.metaGraphUrl, acc.meta, chatId, template);
      else throw new Error('未知的接入方式');
      entry.id = externalId || null;
      entry.short = externalId ? shortMessageId(externalId) : null;
      const convId = conversationIdOf(acc.id, chatId);
      const ts = nowIso();
      const messageId = newId();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
           VALUES(?, ?, ?, ?, '', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at,
             contact_number = CASE WHEN conversations.contact_number = '' THEN excluded.contact_number ELSE conversations.contact_number END`,
        ).run(convId, acc.id, chatId, acc.channel, number || '', ts, ts);
        const dup = externalId && db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?').get(convId, externalId);
        db.prepare(
          `INSERT INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, status, handled, via)
           VALUES(?, ?, ?, 'out', 'bot', 'text', ?, ?, 'sent', 1, 'campaign')`,
        ).run(messageId, convId, dup ? null : externalId || null, text, ts);
        assignCampaignConversation(db, convId, createdById);
      })();
      clearSuggestion(convId);
      return { conversationId: convId, messageId, externalId: externalId || null };
    },
    /** 测试用：防抖和处理都结束了 */
    idle() {
      return timers.size === 0 && processing.size === 0 && converting.size === 0 && mediaJobs.size === 0;
    },
    async close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const t of historyTimers.values()) clearTimeout(t);
      historyTimers.clear();
      for (const ac of sending.values()) ac.abort(new Error('closing'));
      // 正在下载的媒体中止掉（消息留在 pending，下次启动时记为中断），等它们收尾再关数据库
      const jobs = [...mediaJobs];
      for (const j of jobs) j.ac.abort(new Error('closing'));
      await Promise.allSettled(jobs.map((j) => j.promise));
      await relays.closeAll();
    },
  };
}
