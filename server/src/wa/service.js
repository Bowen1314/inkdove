// WhatsApp 业务层（第二期：按号）。每个号（Account）有自己的接入方式（扫码、Meta 官方接口、LINE 官方帐号、Telegram 机器人和私人号）、
// 回复方式（人工回复 / 自动回复）、回复范围、通知和代理；
// 会话 id 是 <accountId>:<chatId>。四层防滥用的第 4 层（会话级闸门）在这里，回复拟真（F1/F14）和
// 在 WhatsApp 里处理转人工（F3）也在这里。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderSVG } from 'uqr';
import {
  CHANNEL_NAMES,
  conversationIdOf,
  DELETED_ACCOUNT_NAME,
  isTelegram,
  isWhatsapp,
  lineConfigured,
  metaConfigured,
  NO_NUMBER_NAMES,
  tgUserConfigured,
} from '../accounts.js';
import { kvGet, kvSet } from '../db.js';
import { hitMessage, quoteWords } from '../blockwords/store.js';
import { internalFileUrl, publicFileUrl } from '../files/signed.js';
import { MAX_FILES_PER_REPLY } from '../files/store.js';
import { ENTRY_TYPES, normalizeTags } from '../kb/store.js';
import { llmScope } from '../records.js';
import { buildReplyContext, decideReply, normalizeEntryIds, normalizeFileIds } from '../reply/engine.js';
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
import { createDocExtractor, DOC_CONTEXT_CHARS, DOC_CONTEXT_FILES, DOC_EXTRACT_MAX_BYTES, DOC_TEXT_MAX_CHARS, docKindOf, DocExtractError, EXTRACT_ERRORS } from './doc-extract.js';
import {
  isInvalidReplyToken,
  isLineQuotaError,
  LineError,
  lineDownloadContent,
  lineGetProfile,
  lineMarkAsRead,
  lineOpenContent,
  lineOpenExternal,
  linePush,
  lineReply,
  lineStartLoading,
} from './line.js';
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
import {
  botIdOf,
  convLogId,
  TG_CAPTION_MAX,
  TG_DELETE_LIMIT_MS,
  TG_PHOTO_MAX_BYTES,
  TG_TEXT_MAX,
  TG_UPLOAD_MAX_BYTES,
  TgError,
  tgDeleteMessage,
  tgDownloadFile,
  tgOpenFile,
  tgReadBusinessMessage,
  tgSendFile,
  tgSendText,
  tgSendTyping,
  tgUserName,
} from './telegram.js';
import { startTgPoller } from './telegram-poll.js';
import { createMtcuteClient, TGU_LOGIN_TIMEOUT_MS, TGU_NO_LIMIT_MS, tgUserSkip, TgUserError } from './tguser.js';
import { needsRelay } from './relay.js';
import { fixDraftPlaceholders, storedTranslation } from './translate.js';
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
/** 草稿（推荐回复、转人工草稿）最多记几条依据的知识条目 */
export const MAX_DRAFT_ENTRIES = 10;
/** 推荐回复：「客户这次的消息」最多合并最近几条 */
const MAX_SUGGEST_MESSAGES = 20;
/** 推荐回复跟进时：客户最后那段消息之后我方发的消息，最多单独列出（并参与检索）最近几条 */
const MAX_FOLLOWUP_MESSAGES = 8;
/** 推荐回复前最多识别「客户这次的消息」里最近几条语音、图片（见 recognizeForSuggest） */
export const SUGGEST_RECOGNIZE_MAX = 3;
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
/**
 * 消息撤回（对所有人删除）的时限。WhatsApp 官方只说「两天多一点」，广泛报道的是 2 天 12 小时（60 小时，2022-08 起）；
 * 这里少算 1 小时：我方发的消息 ts 记的是发送接口返回之后的时间，比 WhatsApp 那边略晚，服务器时钟也可能有偏差
 */
export const WHATSAPP_REVOKE_LIMIT_MS = 60 * 3600 * 1000;
export const REVOKE_WINDOW_MS = WHATSAPP_REVOKE_LIMIT_MS - 3600 * 1000;
/** 客户撤回了还没处理的消息时记的处理原因 */
export const REVOKED_SKIP_REASON = '客户撤回了这条消息';

/**
 * LINE 官方帐号：reply token 在收到 webhook 后 1 分钟内有效、只能用一次（回复不算每月额度）。留 10 秒余量：
 * 客户的消息 50 秒内的 token 拿来回复，再晚就推送（算每月额度）
 */
export const LINE_REPLY_WINDOW_MS = 50 * 1000;
/** LINE 图片消息的预览图最大 1MB（原图 10MB）。墨鸽不缩图、预览图就用原图，所以只有 1MB 以内的 jpeg/png 按图片发，更大的按链接发 */
export const LINE_IMAGE_MAX_BYTES = 1024 * 1024;
/** 推送超出每月额度时消息上记的原因（号的状态里也显示） */
export const LINE_QUOTA_TEXT = 'LINE 本月可推送的消息数用完了，升级套餐或等下个月；1 分钟内的回复不受影响';
/** 处理过的 LINE webhookEventId、取过的客户名字留多久 */
const LINE_EVENT_KEEP_MS = 3600 * 1000;
const LINE_NAME_CACHE_MS = 3600 * 1000;
/** handleInbound 的这些结果表示客户消息存下了（LINE 这时才记它的 reply token 和 markAsReadToken） */
const LINE_STORED = new Set(['scheduled', 'archived', 'archived_media', 'converting']);

/** Telegram：机器人能删自己发的消息 48 小时，和扫码号一样少算 1 小时 */
export const TG_REVOKE_WINDOW_MS = TG_DELETE_LIMIT_MS - 3600 * 1000;
/** Telegram 的「正在输入」只显示 5 秒，拟真等待时隔这么久再发一次 */
const TG_TYPING_REFRESH_MS = 4000;
/** 两种 Telegram 号各自要收的 update（getUpdates 的 allowed_updates） */
const TG_BOT_UPDATES = ['message', 'edited_message', 'my_chat_member'];
const TG_BIZ_UPDATES = ['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'];
/** 一条消息最多留几个改前的版本（再多的丢掉最早的） */
export const EDIT_HISTORY_MAX = 10;

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

/** 语音、图片识别不了：code 是 media_unsupported（格式、大小、时长超出识别范围）或 media_failed（取不到文件、模型出错） */
class RecognizeError extends Error {
  constructor(code, why) {
    super(why);
    this.code = code;
  }
}

/** 存下的 media 列 → 能识别的类型（voice / image），不能的返回 null。老数据没有 f4Type，按显示类型算 */
function recognizeTypeOf(media) {
  if (!media) return null;
  if ('f4Type' in media) return media.f4Type === 'voice' || media.f4Type === 'image' ? media.f4Type : null;
  return media.type === 'voice' || media.type === 'image' ? media.type : null;
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

/**
 * 消息撤回用的消息 ID（WhatsApp 协议里的 key.ID）：WAHA 的序列化 id 是 `<true|false>_<chat>_<ID>`，群里再接 `_<participant>`，
 * 取第 3 段；不带 `_` 的本来就是 ID。只给撤回用：shortMessageId 取最后一段，碰到带 participant 的群消息会取成发送人
 */
export function messageKeyId(id) {
  const s = String(id || '');
  const parts = s.split('_');
  if ((parts.length === 3 || parts.length === 4) && (parts[0] === 'true' || parts[0] === 'false')) return parts[2];
  return parts[parts.length - 1];
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

const LINE_MEDIA_KIND = { image: 'image', video: 'video', audio: 'voice', file: 'document' };

/**
 * LINE webhook 的 message 事件 → 统一的入站结构，chatId 是客户的 userId（LINE 不给手机号）。
 * 图片、视频、语音、文件按消息 id 走 content 接口下载（别的服务器托管的图片、视频、语音带 originalContentUrl，直接取它），
 * mime 下载时才知道；F4 只识别图片和语音。贴图不下载，只记「[贴纸]」；位置记成「[位置] 名称（地址）」
 * https://developers.line.biz/en/reference/messaging-api/#message-event
 */
export function parseLineMessage(ev) {
  const msg = ev?.message;
  if (!msg || typeof msg !== 'object') return null;
  const type = msg.type;
  let text = '';
  let label = null;
  let media = null;
  switch (type) {
    case 'text':
      text = String(msg.text || '');
      break;
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      const kind = LINE_MEDIA_KIND[type];
      label = MEDIA_LABELS[kind];
      const external = msg.contentProvider?.type === 'external' ? msg.contentProvider.originalContentUrl : null;
      const ms = Number(msg.duration);
      if (msg.id) {
        media = {
          type: kind,
          f4Type: type === 'image' ? 'image' : type === 'audio' ? 'voice' : null,
          mime: '',
          id: String(msg.id),
          url: typeof external === 'string' && external ? external : null,
          filename: type === 'file' ? cleanFilename(msg.fileName) : null,
          seconds: type === 'audio' && Number.isFinite(ms) && ms > 0 ? ms / 1000 : null,
        };
      }
      break;
    }
    case 'sticker':
      label = MEDIA_LABELS.sticker;
      break;
    case 'location': {
      const title = String(msg.title || '').trim();
      const address = String(msg.address || '').trim();
      const lat = Number(msg.latitude);
      const lng = Number(msg.longitude);
      const where = title && address && title !== address ? `${title}（${address}）` : title || address;
      label = where ? `[位置] ${clip(where, 300)}` : Number.isFinite(lat) && Number.isFinite(lng) ? `[位置] ${lat}, ${lng}` : '[位置]';
      break;
    }
    default:
      label = '[非文字消息]';
  }
  text = text.trim();
  const ts = Number(ev.timestamp);
  return {
    channel: 'line',
    externalId: msg.id ? String(msg.id) : null,
    chatId: String(ev.source?.userId || ''),
    fromMe: false,
    timestampMs: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    text,
    mediaLabel: text ? null : label || '[非文字消息]',
    media,
    contactName: '',
    // 客户引用了某条消息回复：quotedMessageId 是被引用消息的 id
    replyToId: msg.quotedMessageId ? String(msg.quotedMessageId) : null,
  };
}

const tgSeconds = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/**
 * Telegram 的一条私聊消息（机器人收到的 message、私人号的 business_message）→ 统一的入站结构，chatId 是私聊的 chat id
 * （就是客户的用户 id，Telegram 不给手机号），客户名字取 chat 上的名字（私人号自己发的消息 chat 也是客户）。群、频道返回 null。
 * 图片取最大的那张（photo 是同一张图的几种尺寸，最后一个最大）；语音、视频、圆形视频、动图、音频、文件按 file_id 下载（getFile，20MB 以内），
 * F4 只识别图片和语音。贴纸、位置、联系人、投票这些不下载，记成标签。说明文字（caption）当正文。时间 date 是秒
 * https://core.telegram.org/bots/api#message
 * @param {any} msg
 * @param {{fromMe?: boolean, source?: string|null}} [o] 私人号自己发的：fromMe；source 为 api 是墨鸽经机器人代发的，app 是在 Telegram 里发的
 */
export function parseTelegramMessage(msg, { fromMe = false, source = null } = {}) {
  if (!msg || typeof msg !== 'object' || msg.chat?.type !== 'private' || msg.chat.id == null) return null;
  const text = String(msg.text ?? msg.caption ?? '').trim();
  let label = null;
  let media = null;
  const file = (kind, f, extra = {}) => {
    label = MEDIA_LABELS[kind];
    if (!f?.file_id) return;
    media = {
      type: kind,
      f4Type: null,
      mime: f.mime_type ? baseMime(f.mime_type) : '',
      id: String(f.file_id),
      url: null,
      filename: null,
      seconds: null,
      size: Number.isFinite(f.file_size) ? f.file_size : null,
      ...extra,
    };
  };
  if (Array.isArray(msg.photo) && msg.photo.length) file('image', msg.photo[msg.photo.length - 1], { f4Type: 'image', mime: 'image/jpeg' });
  else if (msg.voice) file('voice', msg.voice, { f4Type: 'voice', seconds: tgSeconds(msg.voice.duration) });
  else if (msg.video_note) file('video', msg.video_note, { mime: 'video/mp4' });
  else if (msg.video) file('video', msg.video);
  // 动图同时带 animation 和 document，按视频存
  else if (msg.animation) file('video', msg.animation);
  else if (msg.audio) file('voice', msg.audio, { filename: cleanFilename(msg.audio.file_name), seconds: tgSeconds(msg.audio.duration) });
  else if (msg.document) file('document', msg.document, { filename: cleanFilename(msg.document.file_name) });
  else if (msg.sticker) label = MEDIA_LABELS.sticker;
  else if (msg.venue || msg.location) {
    const v = msg.venue || {};
    const loc = v.location || msg.location || {};
    const title = String(v.title || '').trim();
    const address = String(v.address || '').trim();
    const where = title && address && title !== address ? `${title}（${address}）` : title || address;
    const lat = Number(loc.latitude);
    const lng = Number(loc.longitude);
    label = where ? `[位置] ${clip(where, 300)}` : Number.isFinite(lat) && Number.isFinite(lng) ? `[位置] ${lat}, ${lng}` : '[位置]';
  } else if (msg.contact) {
    const c = msg.contact;
    const who = [tgUserName(c), c.phone_number ? `+${String(c.phone_number).replace(/^\+/, '')}` : ''].filter(Boolean).join(' ');
    label = who ? `[联系人] ${clip(who, 200)}` : '[联系人]';
  } else if (msg.poll) {
    label = `[投票] ${clip(String(msg.poll.question || '').trim(), 200)}`.trim();
  }
  const ts = Number(msg.date);
  return {
    channel: 'telegram',
    externalId: String(msg.message_id),
    chatId: String(msg.chat.id),
    fromMe,
    source,
    timestampMs: Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now(),
    text,
    mediaLabel: text ? null : label || '[非文字消息]',
    media,
    contactName: clip(tgUserName(msg.chat), 100),
    replyToId: msg.reply_to_message?.message_id != null ? String(msg.reply_to_message.message_id) : null,
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
 * 会话草稿 {kind, text, fileIds, entryIds, createdAt}（F2a / F15 / 推荐回复）。kind：handoff 是转人工时起草的，suggest 是推荐回复；
 * 老数据没有 kind，当 handoff。A 段存的 {text, createdAt} 也认，fileIds 记 []；文字和文件都没有时视为没有草稿。
 * entryIds 是起草所依据的知识条目（模型给的、这次确实放进了提示词的），会话页的草稿卡片下面列出来；老数据没有，记 []。
 * 库里还可能有两个只在服务端用的字段，这里不往外给：
 * - agentUserId：草稿用了谁的「我的资料」（转人工草稿是负责人的，推荐回复是点按钮那个人的）。负责人换成别人时作废
 *   （assign.js 的 writeAssignee），这个人被停用、删除时也作废（routes/users.js）；
 * - followUp：推荐回复是按跟进起草的（值为 true，不是跟进的不写）。客户来了新消息就作废（archive），「换一条」时据此挑上一条
 * 正文译过中文的还有 zh {text, via, createdAt}（「中文意思」，见 translate.js 的 translateDraft），没译过的不带这一项。
 */
export const parseDraft = (raw) => {
  const d = safeJsonParse(raw, null);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const text = typeof d.text === 'string' ? d.text : '';
  const fileIds = normalizeFileIds(d.fileIds).slice(0, MAX_FILES_PER_REPLY);
  if (!text.trim() && !fileIds.length) return null;
  const zh = text.trim() ? storedTranslation(d.zh) : null;
  return {
    kind: d.kind === 'suggest' ? 'suggest' : 'handoff',
    text,
    fileIds,
    entryIds: normalizeEntryIds(d.entryIds).slice(0, MAX_DRAFT_ENTRIES),
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : null,
    ...(zh ? { zh } : {}),
  };
};

/**
 * 起草结果里的依据条目：模型给的 used_entry_ids 去掉抄来的 "id:" 前缀和方括号、去重，只留这次确实放进提示词的条目
 * （entries，buildReplyContext 挑的），别的直接丢掉、不报错；最多 MAX_DRAFT_ENTRIES 条
 * @param {unknown} raw
 * @param {{id:string}[]} entries
 */
export const draftEntryIds = (raw, entries) => {
  const inPrompt = new Set(entries.map((e) => e.id));
  return normalizeEntryIds(raw)
    .filter((id) => inPrompt.has(id))
    .slice(0, MAX_DRAFT_ENTRIES);
};

/**
 * @param {any} ctx  需要 ctx.accounts（accounts.js 的存储）、ctx.mailer、ctx.relays
 * @param {{
 *   humanize?: Partial<typeof DEFAULT_HUMANIZE>,
 *   notifyRetryDelayMs?: number,
 *   onDecision?: (row:any) => void,
 *   onDeclined?: (p:{accountId:string, conversationId:string, ts:string}) => void,
 *   wahaInlineMaxBytes?: number,
 *   lineReplyWindowMs?: number,
 *   lineContentRetryMs?: number,
 *   tgPollTimeoutSec?: number,
 *   tgRetryMs?: number,
 *   wahaPairWaitMs?: number,
 *   wahaPollMs?: number,
 *   historyImportDelayMs?: number,
 *   tgUserClientFactory?: typeof createMtcuteClient,
 *   tgUserLoginTimeoutMs?: number,
 * }} [opts]
 *   onDecision：每写一行处理记录调一次（测试用）；onDeclined：会话被判 declined 时调（测试用；外联对象记 declinedAt 走 ctx.outreach）；
 *   lineReplyWindowMs：LINE 的 reply token 多久以内拿来回复；lineContentRetryMs：下载 LINE 客户文件返回 202 后隔多久再取（测试里调小）；
 *   tgPollTimeoutSec：Telegram 长轮询每次等多久；tgRetryMs：Telegram 收消息出错后第一次等多久再试（测试里调小）；
 *   tgUserClientFactory：Telegram 扫码登录的客户端（测试里换成假的）；tgUserLoginTimeoutMs：扫码登录多久没完成就放弃
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
  /** @type {Set<string>} 正在识别的消息 id（自动回复的识别和点「推荐回复」时的识别共用，同一条不识别两次） */
  const recognizing = new Set();
  /**
   * @type {Map<string, {user:{id:string, name:string}|null, at:number}>} `<号 id>|<消息 ID>` → 业务员在墨鸽里点的撤回（保留 10 分钟）。
   * 经 WAHA 撤回后 WhatsApp 会推回一条 message.revoked（fromMe、source=api），可能比接口响应先到，也可能接口超时了撤回其实成了：
   * 收到时按这里记的人标上，不当成手机上撤回的
   */
  const revokeAttempts = new Map();
  /** @type {Set<string>} 正在撤回的消息（墨鸽的消息 id），同一条不同时撤两次 */
  const revoking = new Set();
  /** @type {Map<string, {token:string, at:number}>} LINE：会话 id → 客户最近一条消息的 reply token 和收到的时间（用一次就删） */
  const lineReplyTokens = new Map();
  /** @type {Map<string, string>} LINE：会话 id → 客户最近一条消息的 markAsReadToken（标过已读就删） */
  const lineReadTokens = new Map();
  /** @type {Map<string, number>} LINE：处理过的 `<号 id>|<webhookEventId>`（重发的事件 id 不变） */
  const seenLineEvents = new Map();
  /** @type {Map<string, {name:string, at:number}>} LINE：`<号 id>|<userId>` → 客户资料里的名字（取不到记空，免得每条消息都去取） */
  const lineNames = new Map();
  const lineReplyWindowMs = opts.lineReplyWindowMs ?? LINE_REPLY_WINDOW_MS;
  const lineContentRetryMs = opts.lineContentRetryMs ?? 2000;
  /**
   * @type {Map<string, {token:string, channel:string, ready:boolean, error:string|null, fatal:boolean, me:any, poller:{stop:() => Promise<void>}}>}
   * Telegram：号 id → 正在收消息的长轮询（token 改了就换一个）
   */
  const tgPollers = new Map();
  /** @type {Map<string, any>} Telegram：号 id → kv 里记的状态（见 tgKv），读一次留在内存 */
  const tgKvCache = new Map();
  /** @type {Map<string, NodeJS.Timeout>} Telegram：会话 id → 隔几秒再发一次「正在输入」的定时器 */
  const tgTypingTimers = new Map();
  const tgPollTimeoutSec = opts.tgPollTimeoutSec ?? 50;
  const tgRetryMs = opts.tgRetryMs ?? 2000;
  /** 改号以后同步 Telegram 收消息，一次只跑一个 */
  let tgSyncChain = Promise.resolve();
  /** 日志里写的会话 id（Telegram 的不带客户的用户 id，见 telegram.js 的 convLogId） */
  const logConv = (convId) => convLogId(db, convId);
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
  /** 客户发来的文件提取文字（worker 线程里解析） */
  const docs = createDocExtractor({ timeoutMs: opts.docExtractTimeoutMs, workerUrl: opts.docExtractWorkerUrl });
  /** @type {Set<Promise<void>>} 正在提取文字的文件（关闭时等它们收尾） */
  const docJobs = new Set();
  // 上次进程退出时没下完的：半截文件删掉，消息记为下载失败
  try {
    mediaStore.cleanTmp();
    db.prepare(
      `UPDATE messages SET media = json_set(media, '$.stored', 'failed', '$.error', '下载被中断（服务重启），请在手机上查看')
       WHERE media IS NOT NULL AND json_valid(media) AND json_extract(media, '$.stored') = 'pending'`,
    ).run();
    // 提取文字到一半进程退出了的：记为失败（文件还在，业务员可以下载了看）
    db.prepare(
      `UPDATE messages SET media = json_set(media, '$.extract', json(?))
       WHERE media IS NOT NULL AND json_valid(media) AND json_extract(media, '$.extract.status') = 'pending'`,
    ).run(JSON.stringify({ status: 'failed', error: '提取被中断（服务重启）' }));
  } catch (err) {
    log.warn(`[wa] 清理没下完的媒体出错：${err?.message || err}`);
  }

  const settings = () => ctx.getSettings();

  function state(accountId) {
    let s = accState.get(accountId);
    if (!s) {
      // linePushError：LINE 官方帐号最近一次推送失败、而且是整个号的问题（每月额度用完、token 不对）{at, message}，推送成功后清掉
      s = { lastWahaStatus: null, connectedAt: 0, lastWebhookAt: null, statusCache: null, replies: [], usageHintAt: 0, pairCodeAt: 0, linePushError: null };
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
  function rememberSent(accountId, chatId, text, chatScoped = false) {
    const now = Date.now();
    const list = (recentSent.get(accountId) || []).filter((e) => now - e.at < ECHO_ID_KEEP_MS);
    // chatScoped：消息 id 只在这个聊天里唯一（Telegram），按 id 比时还要聊天对得上
    const entry = { id: null, short: null, chatId, text: String(text ?? '').trim(), at: now, chatScoped };
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
        (externalId && (e.id === externalId || (short && e.short === short)) && (!e.chatScoped || e.chatId === chatId)) ||
        (byText && e.chatId === chatId && e.text === body && now - e.at <= ECHO_TEXT_WINDOW_MS),
    );
  }

  /** 发文本（不落库）。号被删了、未配置时抛错 */
  async function sendRaw(acc, chatId, text) {
    if (!acc) throw new Error('这个号已删除');
    const entry = rememberSent(acc.id, chatId, text, isTelegram(acc.channel));
    let id;
    if (acc.channel === 'waha') id = await waha.sendText(acc.sessionName, chatId, text);
    else if (acc.channel === 'meta') id = await metaSendText(config.metaGraphUrl, acc.meta, chatId, text);
    else if (acc.channel === 'line') id = await lineSend(acc, chatId, [{ type: 'text', text }]);
    else if (acc.channel === 'tguser') {
      if (text.length > TG_TEXT_MAX) throw new Error(`Telegram 一条消息最多 ${TG_TEXT_MAX} 个字，这条有 ${text.length} 个字，请分开发`);
      id = await tgUserClient(acc).sendText(chatId, text);
    } else if (isTelegram(acc.channel)) {
      if (text.length > TG_TEXT_MAX) throw new Error(`Telegram 一条消息最多 ${TG_TEXT_MAX} 个字，这条有 ${text.length} 个字，请分开发`);
      const t = tgTarget(acc);
      id = await tgSendText(config.telegramApiUrl, t.token, chatId, text, { businessConnectionId: t.businessConnectionId });
    } else throw new Error('未知的接入方式');
    entry.id = id || null;
    entry.short = id ? shortMessageId(id) : null;
    return id;
  }

  /**
   * LINE：发一组消息（最多 5 个）。这个客户的消息 50 秒内、reply token 还没用过时用回复（不算每月额度），否则推送（算额度）。
   * token 只能用一次：发请求之前就删掉；回复报 token 无效（过期、用过了）时改推送一次，别的错直接抛。
   * 推送超出每月额度、token 不对（401、403）这种整个号的问题记到号的状态上（号详情页显示），之后推送成功就清掉
   * @returns {Promise<string|null>} 发出的第一个消息的 id
   */
  async function lineSend(acc, chatId, messages) {
    const convId = conversationIdOf(acc.id, chatId);
    const t = lineReplyTokens.get(convId);
    lineReplyTokens.delete(convId);
    if (t && Date.now() - t.at < lineReplyWindowMs) {
      try {
        return await lineReply(config.lineApiUrl, acc.line, t.token, messages);
      } catch (err) {
        if (!isInvalidReplyToken(err)) throw err;
        log.warn(`[line] 号 ${acc.id} 的 reply token 已失效，改用推送：${err.message}`);
      }
    }
    const st = state(acc.id);
    try {
      const id = await linePush(config.lineApiUrl, acc.line, chatId, messages);
      if (st.linePushError) {
        st.linePushError = null;
        st.statusCache = null;
      }
      return id;
    } catch (err) {
      const quota = isLineQuotaError(err);
      if (quota || (err instanceof LineError && (err.status === 401 || err.status === 403))) {
        st.linePushError = { at: nowIso(), message: quota ? LINE_QUOTA_TEXT : `推送失败：${err.message}` };
        st.statusCache = null;
      }
      if (quota) throw new Error(LINE_QUOTA_TEXT);
      throw err;
    }
  }

  /**
   * LINE 发文件：没有文件消息、也没有上传接口，只能给 LINE 一个公网 HTTPS 地址（30 天有效的签名地址，见 files/signed.js）。
   * 1MB 以内的 jpeg/png 发图片消息，预览图用同一个地址（LINE 的预览图不能超过 1MB，墨鸽不缩图），有说明文字时同一次再带一条文字；
   * 其他文件和更大的图片发一条文字：说明文字、文件名、下载链接（是发给客户的，不加中文）。
   * INKDOVE_PUBLIC_BASE_URL 不是 https 时 LINE 取不到，直接报错，不发打不开的地址
   */
  function lineFileMessages(file, caption) {
    if (!/^https:\/\//i.test(config.publicBaseUrl)) {
      throw new Error('LINE 发图片和文件要用公网 HTTPS 地址：INKDOVE_PUBLIC_BASE_URL 现在不是 https://，没有发送');
    }
    const url = publicFileUrl(config, file.id);
    if ((file.mime === 'image/jpeg' || file.mime === 'image/png') && file.size <= LINE_IMAGE_MAX_BYTES) {
      const msgs = [{ type: 'image', originalContentUrl: url, previewImageUrl: url }];
      if (caption) msgs.push({ type: 'text', text: caption });
      return msgs;
    }
    return [{ type: 'text', text: `${caption ? `${caption}\n\n` : ''}${file.filename}\n${url}` }];
  }

  /**
   * F15：发一个文件（不落库）。WAHA：jpeg/png 用 sendImage，其余用 sendFile；15MB 以内传 base64，更大的给签名下载地址。
   * Meta：先上传拿 media id（按号码缓存 25 天），jpeg/png 且不超过 5MB 的发 image，其余发 document；缓存的 id 失效时重传一次。
   * LINE：图片给签名地址，其他文件发下载链接（见 lineFileMessages）。
   * Telegram：直接上传，10MB 以内的 jpeg/png 发图片（Telegram 会压缩），其余发文件（原样），最大 50MB；说明文字最多 1024 字。
   * 扫码登录的号限制一样（用户帐号其实能发更大的文件，和机器人保持一致）。
   */
  async function sendFileRaw(acc, chatId, file, caption = '') {
    if (!acc) throw new Error('这个号已删除');
    const entry = rememberSent(acc.id, chatId, caption, isTelegram(acc.channel));
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
    } else if (acc.channel === 'line') {
      id = await lineSend(acc, chatId, lineFileMessages(file, caption));
    } else if (acc.channel === 'tguser') {
      if (caption.length > TG_CAPTION_MAX) throw new Error(`Telegram 文件的说明文字最多 ${TG_CAPTION_MAX} 个字，请缩短，或者把文字单独发`);
      if (file.size > TG_UPLOAD_MAX_BYTES) throw new Error('Telegram 发文件不能超过 50MB');
      id = await tgUserClient(acc).sendFile(
        chatId,
        { buffer: await fs.promises.readFile(diskPath), filename: file.filename, mime: file.mime },
        { asPhoto: asImage && file.size <= TG_PHOTO_MAX_BYTES, caption },
      );
    } else if (isTelegram(acc.channel)) {
      if (caption.length > TG_CAPTION_MAX) throw new Error(`Telegram 文件的说明文字最多 ${TG_CAPTION_MAX} 个字，请缩短，或者把文字单独发`);
      if (file.size > TG_UPLOAD_MAX_BYTES) throw new Error('Telegram 机器人发文件不能超过 50MB');
      const t = tgTarget(acc);
      id = await tgSendFile(
        config.telegramApiUrl,
        t.token,
        chatId,
        { buffer: await fs.promises.readFile(diskPath), filename: file.filename, mime: file.mime },
        { asPhoto: asImage && file.size <= TG_PHOTO_MAX_BYTES, caption, businessConnectionId: t.businessConnectionId },
      );
    } else {
      throw new Error('未知的接入方式');
    }
    entry.id = id || null;
    entry.short = id ? shortMessageId(id) : null;
    return id;
  }

  /** 给某个号码发文本（通知、F3 回执用）。LINE 官方帐号、Telegram 号只能给聊过的人发，没有号码可发 */
  const sendToNumber = async (acc, number, text) => {
    if (acc && !isWhatsapp(acc.channel)) throw new Error(`${CHANNEL_NAMES[acc.channel] || '这个号'}不能给手机号发消息`);
    return sendRaw(acc, acc?.channel === 'waha' ? `${number}@c.us` : number, text);
  };

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
      // 接入方式（waha / meta / line）：LINE 的客户没有手机号，前端据此显示「LINE 用户」
      channel: r.channel,
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

  /**
   * 我方这条消息最晚能撤回到什么时候（ISO），不能撤回时为 null：扫码号发送成功、有 WhatsApp 消息 id、还没撤回、
   * 没超过时限的我方消息（机器人、人工、手机上发的、外联都算）。Meta 号、LINE 官方帐号没有撤回接口。
   * Telegram 机器人删自己发的，48 小时内；私人号要有删除的权限（经机器人发的要「删除机器人发的消息」，
   * 在 Telegram 里自己发的要「删除所有消息」），时限按 48 小时算。扫码登录的号删私聊里的消息没有时限（给一个很远的时间）
   */
  function revocableUntil(r, acc) {
    if (r.direction !== 'out' || r.status !== 'sent' || !r.external_id || r.revoked_at) return null;
    if (acc?.channel === 'tguser') return new Date(Date.parse(r.ts) + TGU_NO_LIMIT_MS).toISOString();
    let windowMs = 0;
    if (acc?.channel === 'waha') windowMs = REVOKE_WINDOW_MS;
    else if (acc?.channel === 'tgbot' && r.via !== 'phone') windowMs = TG_REVOKE_WINDOW_MS;
    else if (acc?.channel === 'tgbiz' && tgCanDelete(acc, r)) windowMs = TG_REVOKE_WINDOW_MS;
    if (!windowMs) return null;
    const until = Date.parse(r.ts) + windowMs;
    return Number.isFinite(until) && until > Date.now() ? new Date(until).toISOString() : null;
  }

  /**
   * @param {any} r 消息行
   * @param {any} [acc] 会话所属的号（算 revocableUntil 用；不给时按不能撤回）
   */
  function rowToMessage(r, acc = null) {
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
      // 会话里点「翻译」译成的中文 {text, via, createdAt, truncated?}，没译过的为 null
      translation: storedTranslation(r.translation),
      // 撤回：{at, by: member|customer|phone, userId, name}（member 时是点撤回的成员和当时的名字），没撤回过的为 null。原文照样在 text 里
      revoked: r.revoked_at
        ? { at: r.revoked_at, by: r.revoked_by || 'phone', userId: r.revoked_by_user_id ?? null, name: r.revoked_by_name ?? null }
        : null,
      revocableUntil: revocableUntil(r, acc),
      // 编辑：{at: 最近一次编辑的时间, history: 改前的各个版本 [{text, at}]（最早的在前）}，没编辑过的为 null。text 是改后的
      edited: r.edited_at ? { at: r.edited_at, history: safeJsonParse(r.edit_history, []) } : null,
    };
  }

  function conversationById(id) {
    const r = db.prepare(`${CONV_SQL} WHERE c.id = ?`).get(id);
    return r ? rowToConversation(r) : null;
  }

  /** 客户的称呼：名字，没有就是 +号码；LINE、Telegram 的客户没有号码，叫「LINE 用户」「Telegram 用户」（不露用户 id） */
  const displayName = (conv) =>
    conv.contact_name || (conv.contact_number ? `+${conv.contact_number}` : NO_NUMBER_NAMES[conv.channel] || conv.chat_id || conv.id);

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
      log.warn(`[wa] 发送到 ${logConv(conv.id)} 失败：${error}`);
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
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id), acc);
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
      log.warn(`[wa] 发文件到 ${logConv(conv.id)} 失败：${error}`);
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
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id), acc);
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
    const n = db
      .prepare("UPDATE conversations SET draft = NULL WHERE id = ? AND json_valid(draft) AND json_extract(draft, '$.kind') = 'suggest'")
      .run(convId).changes;
    // 人工发的走 operatorDeliver（先接管、草稿已经清了，这里清不到），清到的是机器人、手机、外联发的：推荐记没发
    if (n) noteDraft('没发', (d) => d.unsent(convId));
  }

  /**
   * 客户发来了新消息（实时收到的，导入的历史不算）：清掉跟进推荐（kind=suggest、followUp 为 true）。
   * 跟进是按「客户没再发」写的，客户说话了它就不对了。不是跟进的推荐回的仍是客户还没回的那些消息，不清；转人工草稿也不动。
   * JSON 里的 true 用 json_extract 取出来是 1
   */
  function clearFollowUpSuggestion(convId) {
    const n = db
      .prepare(
        "UPDATE conversations SET draft = NULL WHERE id = ? AND json_valid(draft) AND json_extract(draft, '$.kind') = 'suggest' AND json_extract(draft, '$.followUp') = 1",
      )
      .run(convId).changes;
    if (n) noteDraft('没发', (d) => d.unsent(convId));
  }

  /**
   * 推荐回复采纳统计（reply/draft-outcomes.js）：记一份草稿的去向。出错只记 warn，从不影响发送、清草稿
   * @param {string} what 日志里的说明
   * @param {(d:any) => any} fn
   */
  function noteDraft(what, fn) {
    if (!ctx.draftOutcomes) return;
    try {
      fn(ctx.draftOutcomes);
    } catch (err) {
      log.warn(`[wa] 记录推荐回复结果（${what}）失败：${err?.message || err}`);
    }
  }

  /** 草稿里记的那个人（draft.agentUserId）已经停用或删除了：起草期间被停用、删除的，草稿不存（存下之后的由 routes/users.js 清） */
  const memberGone = (userId) => {
    const u = db.prepare('SELECT disabled FROM users WHERE id = ?').get(userId);
    return !u || !!u.disabled;
  };

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
    // 推荐回复采纳统计：拿发出的文字和这个会话还没定的草稿比（发送失败的不比）
    noteDraft('比较', (d) => d.operatorSent(convId, msg));
    return msg;
  }

  /** 人工发文件（后台或 F3 的 /d）：和人工发消息一样，会话进入 botPaused */
  async function operatorDeliverFile(acc, convId, file, { via, sentBy, caption = '' }) {
    operatorTakeover(convId);
    const msg = await sendFileAndRecord(acc, getConvRow(convId), file, { author: 'operator', via, sentBy, caption: clip(caption, MAX_CAPTION) });
    noteOperatorResponse(convId, msg, { via, sentBy });
    // 推荐回复采纳统计：发的是草稿建议的文件就记上
    noteDraft('发文件', (d) => d.fileSent(convId, file.id, msg));
    return msg;
  }

  /** 恢复机器人：清掉暂停、待处理和草稿；还开着的转人工记录填上 resumedAt（F12） */
  function resumeBot(convId) {
    db.prepare('UPDATE conversations SET bot_paused = 0, needs_human = 0, pending_reason = NULL, draft = NULL WHERE id = ?').run(convId);
    ctx.records.handoffResume({ conversationId: convId });
    // 推荐回复采纳统计：恢复机器人时还没定的草稿（包括填进输入框没发的）记没发
    noteDraft('没发', (d) => d.unsent(convId));
  }

  // ---------------- 入站 ----------------
  /**
   * 早于这个时间的消息不处理（服务刚启动、扫码号刚连上时 WhatsApp 推来的旧消息）。Telegram 不限：停机期间客户发的消息
   * 重启后才取到，时间都在启动之前，按 offset 确认过的不会再给，第一次接入时之前积压的也已经跳过（见 telegram-poll.js）
   */
  function cutoffMs(acc) {
    if (isTelegram(acc.channel)) return 0;
    return Math.max(startedAt, acc.channel === 'waha' ? state(acc.id).connectedAt : 0) - OLD_MESSAGE_GRACE_MS;
  }

  async function resolveNumber(acc, m) {
    if (m.channel === 'meta') return m.chatId.replace(/\D+/g, '') || null;
    // LINE 只给 userId、Telegram 只给用户 id，没有手机号
    if (m.channel === 'line' || m.channel === 'telegram') return null;
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
    // LINE、Telegram 的客户只有用户 id、没有手机号，按号码的白名单、黑名单用不上，都算在范围内
    // （LINE 发得进来的本来就是加了好友的人，Telegram 是主动来找机器人或私人号的人）
    if (!isWhatsapp(acc.channel)) return true;
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
    // F12：只有扫码号（WAHA message.any）、Telegram 私人号（business_message）和扫码登录的号会推自己发的消息；Meta、LINE 没有这一项
    if (m.fromMe && acc.channel !== 'waha' && acc.channel !== 'tgbiz' && acc.channel !== 'tguser') return 'ignored_from_me';
    const chatId = m.chatId;
    if (!chatId || isNonPrivateChat(chatId)) return 'ignored_non_private';
    // F12：本服务经 API 发出去的消息（机器人、人工、F3 转发和回执、通知）推回来的回声，剔除
    if (m.fromMe && (m.source === 'api' || isOwnEcho(acc.id, chatId, m.externalId, m.text, m.source !== 'app'))) return 'ignored_echo';
    const convId = conversationIdOf(acc.id, chatId);
    // Telegram 的消息 id 只在一个聊天里唯一，不同客户的消息 id 会撞，要带上聊天
    const key = m.externalId ? (isTelegram(acc.channel) ? `${acc.id}|${chatId}|${m.externalId}` : `${acc.id}|${m.externalId}`) : null;
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
    // 屏蔽词：手机上发的已经发出去了，拦不住，只记下来提醒管理员
    if (m.text) ctx.blockwords.check(m.text, { source: 'phone', blocked: false, accountId: acc.id, conversationId: convId });
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
      clearFollowUpSuggestion(convId);
      abortSending(convId, 'new_message');
      // 存盘和识别共用一次下载：识别等存盘的结果，存成了就读文件
      const saved = startMediaStore(acc, msgId, m.media);
      startConversion(acc, convId, msgId, m, saved);
      return 'converting';
    }
    const willProcess = isText && botOn;
    // 人工回复的号先判：没配文字的媒体也和文字一样只存下来（媒体照常存盘，会话里直接看），不标待处理、不通知、不记转人工。
    // 自动回复的号不变：非文字消息先于会话暂停判，暂停中收到媒体也照旧标待处理
    let skipReason = null;
    if (acc.replyMode !== 'auto') skipReason = '这个号没开自动回复';
    else if (!isText) skipReason = `非文字消息${m.mediaLabel ? `${m.mediaLabel}` : ''}，已通知人工`;
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
    // 客户又说话了：跟进推荐作废（文字和媒体都算）
    clearFollowUpSuggestion(convId);
    // 客户发来的媒体：后台下载存盘，不等结果
    if (m.media) startMediaStore(acc, msgId, m.media);
    // F1 / F14：正在拟真发送时客户又来了消息，没发出去的取消，新消息合进去重新走
    abortSending(convId, 'new_message');
    if (!isText) {
      // 自动回复的号没开识别时机器人处理不了这条：转人工记录的 code 记 media_unsupported（F12 的表里没有非文字消息这一项）。
      // 人工回复的号本来就是人来看，不转人工
      if (acc.replyMode === 'auto') {
        flagNeedsHuman(acc, convId, 'non_text', m.mediaLabel || '', { pause: false, code: 'media_unsupported', pendingReason: skipReason });
      }
      return 'archived_media';
    }
    if (willProcess) {
      scheduleFlush(convId);
      return 'scheduled';
    }
    return 'archived';
  }

  // ---------------- 客户媒体存盘 ----------------
  /**
   * 新消息里 media 列的初始值：stored=pending，下载完改成 ok / too_large / failed。
   * f4Type、seconds 留给点「推荐回复」时识别语音、图片用（见 recognizeForSuggest；老数据没有这两项）
   */
  function storedMediaJson(media) {
    return JSON.stringify({
      type: media.type,
      f4Type: media.f4Type || null,
      seconds: Number.isFinite(media.seconds) ? media.seconds : null,
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
   * WAHA 用事件里的 media.url（WAHA 默认只留 180 秒，所以收到就下）；Meta 用 media id 走 Graph API（下载地址 5 分钟有效）；
   * LINE 用消息 id 走 content 接口（过一段时间就删，返回 202 时等一会儿再取），别的服务器托管的直接取 originalContentUrl。
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
      } else if (acc.channel === 'meta') {
        if (!media.id) throw new Error('消息里没有 media id');
        const opened = await metaOpenMedia(config.metaGraphUrl, acc.meta, media.id, {
          maxBytes: mediaMaxBytes,
          timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
          signal,
        });
        res = opened.res;
        mime = mime || opened.mime;
      } else if (acc.channel === 'line') {
        const o = { maxBytes: mediaMaxBytes, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS, signal };
        let opened;
        if (media.url) opened = await lineOpenExternal(media.url, o);
        else if (media.id) opened = await lineOpenContent(config.lineDataApiUrl, acc.line, media.id, { ...o, retryDelayMs: lineContentRetryMs });
        else throw new Error('消息里没有消息 id');
        res = opened.res;
        mime = mime || opened.mime;
      } else if (acc.channel === 'tguser') {
        if (!media.id) throw new Error('消息里没有文件 id');
        res = tgUserClient(acc).openFile(media.id, { fileSize: media.size ?? null, maxBytes: mediaMaxBytes, signal });
        // mtcute 给的是普通的 Readable，没有响应头；类型用消息里的
        res.headers = {};
      } else if (isTelegram(acc.channel)) {
        if (!media.id) throw new Error('消息里没有文件 id');
        const opened = await tgOpenFile(config.telegramApiUrl, acc.telegram.botToken, media.id, {
          maxBytes: mediaMaxBytes,
          knownSize: media.size ?? null,
          timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
          signal,
        });
        res = opened.res;
        mime = mime || opened.mime;
      } else {
        throw new Error('未知的接入方式');
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
      .then((result) => {
        if (result.stored === 'ok' && media.type === 'document' && !closed) startDocExtract(msgId, media, result);
        return result;
      })
      .finally(() => mediaJobs.delete(job));
    mediaJobs.add(job);
    return job.promise;
  }

  // ---------------- 客户发来的文件提取文字 ----------------
  // 文件存下以后在 worker 线程里解析（doc-extract.js），不调模型，回复方式是什么都提取。文字存进 doc_text（最多 DOC_TEXT_MAX_CHARS 字），
  // 结果记在 media.extract：{status: pending | ok | no_text | failed | too_large | unsupported | skipped, chars?, truncated?, error?}。
  // 给业务员在会话里看，也放进推荐回复和转人工草稿（见 customerFilesFor）；自动回复不看，客户发文件照旧转人工。
  // 日志里不写文件名和文件内容

  function patchExtract(msgId, extract) {
    db.prepare("UPDATE messages SET media = json_set(media, '$.extract', json(?)) WHERE id = ? AND media IS NOT NULL AND json_valid(media)").run(
      JSON.stringify(extract),
      msgId,
    );
  }

  function startDocExtract(msgId, media, saved) {
    const kind = docKindOf(media.filename, saved.mime || media.mime);
    if (!kind) return void patchExtract(msgId, { status: 'unsupported' });
    if ((saved.size ?? 0) > DOC_EXTRACT_MAX_BYTES) return void patchExtract(msgId, { status: 'too_large' });
    patchExtract(msgId, { status: 'pending' });
    const job = (async () => {
      let extract;
      let text = null;
      try {
        // 客户在下载期间撤回了的，不再提取
        if (db.prepare('SELECT revoked_at FROM messages WHERE id = ?').get(msgId)?.revoked_at) {
          extract = { status: 'skipped' };
        } else {
          const full = await docs.extract(await mediaStore.read(saved.fileKey), kind);
          text = clip(full, DOC_TEXT_MAX_CHARS);
          extract = { status: 'ok', chars: text.length, truncated: full.length > text.length };
        }
      } catch (err) {
        const known = err instanceof DocExtractError;
        extract = known && err.status === 'no_text' ? { status: 'no_text' } : { status: 'failed', error: known ? err.message : EXTRACT_ERRORS.failed };
        if (!known) log.warn(`[wa] 消息 ${msgId} 的文件提取文字出错：${err?.message || err}`);
      }
      // 关闭时被杀掉的：留在 pending，下次启动时记为中断
      if (closed) return;
      if (extract.status !== 'ok') log.info(`[wa] 消息 ${msgId} 的文件没有提取到文字（${extract.status}）`);
      db.prepare("UPDATE messages SET doc_text = ?, media = json_set(media, '$.extract', json(?)) WHERE id = ? AND media IS NOT NULL AND json_valid(media)").run(
        text,
        JSON.stringify(extract),
        msgId,
      );
    })()
      .catch((err) => log.warn(`[wa] 记录消息 ${msgId} 的文件提取结果出错：${err?.message || err}`))
      .finally(() => docJobs.delete(job));
    docJobs.add(job);
  }

  /**
   * 推荐回复、转人工草稿带上的客户文件：会话最近 30 条消息里提取到文字、没撤回的客户文件，最多最近 DOC_CONTEXT_FILES 个，
   * 每个最多 DOC_CONTEXT_CHARS 字。按时间先后，[{name, text, truncated}]
   */
  function customerFilesFor(convId) {
    return db
      .prepare(
        `SELECT media, doc_text FROM (SELECT seq, media, doc_text, revoked_at FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 30)
         WHERE doc_text IS NOT NULL AND revoked_at IS NULL ORDER BY seq DESC LIMIT ?`,
      )
      .all(convId, DOC_CONTEXT_FILES)
      .reverse()
      .map((r) => {
        const media = safeJsonParse(r.media, null) || {};
        const text = clip(r.doc_text, DOC_CONTEXT_CHARS);
        return { name: media.filename || '未命名文件', text, truncated: text.length < r.doc_text.length || !!media.extract?.truncated };
      });
  }

  // ---------------- F4：语音、图片转文字 ----------------
  // 结果记在 media.recognize：{status: ok | failed | unsupported, error?}。failed、unsupported 的不再重试（点「推荐回复」时也不再识别）；
  // 今天的模型调用到上限、没识别的不记，之后还能识别

  function patchRecognize(msgId, recognize) {
    db.prepare("UPDATE messages SET media = json_set(media, '$.recognize', json(?)) WHERE id = ? AND media IS NOT NULL AND json_valid(media)").run(
      JSON.stringify(recognize),
      msgId,
    );
  }

  const recognizeFailure = (err) => ({ status: err.code === 'media_unsupported' ? 'unsupported' : 'failed', error: err.message });

  function startConversion(acc, convId, msgId, m, saved) {
    converting.set(convId, (converting.get(convId) || 0) + 1);
    recognizing.add(msgId);
    // F12：识别用的模型调用记到这个号和会话上
    llmScope({ accountId: acc.id, conversationId: convId }, () => convertMedia(acc, convId, msgId, m, saved))
      .catch((err) => log.error(`[wa] 识别会话 ${logConv(convId)} 的${m.media.f4Type === 'voice' ? '语音' : '图片'}出错：${err?.stack || err}`))
      .finally(() => {
        recognizing.delete(msgId);
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
    if (acc.channel === 'meta') return metaDownloadMedia(config.metaGraphUrl, acc.meta, media.id, { maxBytes });
    if (acc.channel === 'line') return lineDownloadContent(config.lineDataApiUrl, acc.line, media, { maxBytes, retryDelayMs: lineContentRetryMs });
    if (acc.channel === 'tguser') {
      const buffer = await tgUserClient(acc).download(media.id, { fileSize: media.size ?? null, maxBytes });
      return { buffer, mime: media.mime || '' };
    }
    if (isTelegram(acc.channel)) return tgDownloadFile(config.telegramApiUrl, acc.telegram.botToken, media, { maxBytes });
    throw new Error('未知的接入方式');
  }

  /**
   * 识别前取文件并检查格式、大小、时长（自动回复的识别和点「推荐回复」时的识别共用）。
   * 优先用存下的文件（saved 是存盘的结果，可以是还没完成的 promise），不重复下载；没存成、读不出来时用 download 再下载一次，
   * 没给 download 的算取不到。超出识别范围抛 RecognizeError('media_unsupported')，取不到抛 RecognizeError('media_failed')。
   * 服务正在关闭时返回 null
   * @param {'voice'|'image'} type
   * @param {{mime?:string|null, seconds?:number|null}} media
   * @param {(() => Promise<{buffer:Buffer, mime?:string}>)|null} download
   * @returns {Promise<{buffer:Buffer, mime:string}|null>}
   */
  async function loadForRecognition(type, media, saved, download) {
    const limits = MEDIA_LIMITS[type];
    if (type === 'image' && media.mime && !limits.mimes.includes(media.mime)) {
      throw new RecognizeError('media_unsupported', `格式 ${media.mime} 不支持，只支持 jpeg、png、webp`);
    }
    if (type === 'voice' && media.seconds && media.seconds > limits.maxSeconds) {
      throw new RecognizeError('media_unsupported', `语音 ${Math.round(media.seconds)} 秒，超过 3 分钟`);
    }
    let buffer = null;
    let mime;
    const tooBig = () => new RecognizeError('media_unsupported', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB`);
    const stored = saved ? await saved : null;
    // 服务正在关闭：存盘是被关闭中止的（返回失败），不要再用下面不受关闭控制的方式重新下载，也不写库（数据库马上要关）。
    // 存盘状态留在 pending，下次启动时记为下载中断
    if (closed) return null;
    if (stored?.stored === 'too_large') throw tooBig();
    if (stored?.stored === 'ok' && stored.fileKey) {
      if (Number(stored.size) > limits.maxBytes) throw tooBig();
      try {
        buffer = await mediaStore.read(stored.fileKey);
        mime = stored.mime;
      } catch (err) {
        log.warn(`[wa] 读存下的媒体文件失败${download ? '，改为重新下载' : ''}：${err?.message || err}`);
        buffer = null;
      }
    }
    if (!buffer) {
      if (!download) throw new RecognizeError('media_failed', '存下的文件读不出来');
      try {
        ({ buffer, mime } = await download());
      } catch (err) {
        if (err instanceof TooLargeError || /文件太大/.test(String(err?.message))) throw tooBig();
        throw new RecognizeError('media_failed', `下载失败：${err?.message || err}`);
      }
    }
    mime = media.mime || baseMime(mime);
    if (type === 'image' && !limits.mimes.includes(mime)) throw new RecognizeError('media_unsupported', `格式 ${mime || '未知'} 不支持，只支持 jpeg、png、webp`);
    if (type === 'voice') {
      const secs = media.seconds || oggDurationSeconds(buffer);
      if (secs && secs > limits.maxSeconds) throw new RecognizeError('media_unsupported', `语音 ${Math.round(secs)} 秒，超过 3 分钟`);
    }
    return { buffer, mime };
  }

  /** 调模型转写语音或描述图片，返回文字（去掉首尾空白，截到存得下的长度）。模型出错、没返回内容时抛 RecognizeError('media_failed') */
  async function recognizeText(type, { buffer, mime }) {
    let text;
    try {
      text =
        type === 'voice'
          ? await ctx.ai.transcribe({ audio: buffer, mime: mime || 'audio/ogg', filename: `voice.${/mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : 'ogg'}` })
          : await ctx.ai.describeImage({ mime, data: buffer.toString('base64') });
    } catch (err) {
      throw new RecognizeError('media_failed', err?.message || String(err));
    }
    text = clip(String(text || '').trim(), MAX_STORED_TEXT - 200);
    if (!text) throw new RecognizeError('media_failed', '模型没有返回内容');
    return text;
  }

  /**
   * 下载 → 检查大小、格式、时长 → 转写或描述 → 把占位消息改成文字（kind=text，等下一轮处理）。
   * 失败或超限：这条消息记为 handoff（media_failed / media_unsupported），needsHuman 并通知，不暂停（和原来的非文字消息一样）。
   */
  async function convertMedia(acc, convId, msgId, m, saved) {
    const started = Date.now();
    const type = m.media.f4Type;
    const what = type === 'voice' ? '语音' : '图片';
    // mark：把结果记进 media.recognize（今天的次数到上限的不记）
    const fail = (code, why, { mark = true } = {}) => {
      if (closed) return;
      if (mark) patchRecognize(msgId, recognizeFailure({ code, message: why }));
      const row = db.prepare('SELECT handled FROM messages WHERE id = ?').get(msgId);
      if (!row || row.handled) return;
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
    if (used + 1 > DAILY_LLM_LIMIT) return fail('media_failed', `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次）`, { mark: false });
    let loaded;
    try {
      loaded = await loadForRecognition(type, m.media, saved, () => downloadMedia(acc, m.media, MEDIA_LIMITS[type].maxBytes));
    } catch (err) {
      if (err instanceof RecognizeError) return fail(err.code, err.message);
      throw err;
    }
    if (!loaded) return;
    // 下载期间客户撤回了这条：不再拿去识别（撤回过的消息不进模型），handleRevoked 已经记为跳过
    if (db.prepare('SELECT revoked_at FROM messages WHERE id = ?').get(msgId)?.revoked_at) return;
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
      text = await recognizeText(type, loaded);
    } catch (err) {
      if (err instanceof RecognizeError) return fail(err.code, err.message);
      throw err;
    }
    if (closed) return;
    const caption = type === 'image' && m.text ? `\n${clip(m.text, MAX_STORED_TEXT - 200)}` : '';
    const full = `[${what}] ${text}${caption}`;
    // 识别期间人工接管了的：占位消息已记为 skipped，只把文字补上给人看
    db.prepare("UPDATE messages SET kind = 'text', text = ?, media = json_set(media, '$.recognize', json(?)) WHERE id = ?").run(
      full,
      JSON.stringify({ status: 'ok' }),
      msgId,
    );
  }

  // ---------------- 推荐回复前识别语音、图片 ----------------
  /** 说明文字：没开识别时带说明文字的媒体存成文字消息（text 就是说明文字）；媒体消息的 text 是 [图片] 这样的标签，自动回复识别的占位消息是标签换行再加说明文字 */
  const captionOf = (r) => (r.kind === 'text' ? r.text : r.text.includes('\n') ? r.text.slice(r.text.indexOf('\n') + 1) : '');

  /**
   * 点「推荐回复」「换一条」时，先把客户这次的消息（rows，见 suggestWindow）里还没识别的语音、图片识别成文字，起草时就能看到。
   * 和自动回复的识别共用设置里的开关和模型：开了「识别语音」才识别语音，开了「识别图片」才识别图片。只识别存下了文件的，
   * 最多最近 SUGGEST_RECOGNIZE_MAX 条，同时进行；每条计一次模型调用，今天剩下的次数先给起草留一次，不够的不识别（不记，之后还能识别）。
   * 识别成了把消息改成文字（同自动回复：[语音] 转写的文字、[图片] 描述，后面接说明文字），存下的译文作废；
   * 失败或超出识别范围记在 media.recognize，之后不再重试。不改消息的处理结果，不通知、不转人工；出错也不影响起草。
   */
  async function recognizeForSuggest(convId, rows, usedToday) {
    const s = settings();
    const on = { voice: !!s.media.voice, image: !!s.media.image };
    if (!on.voice && !on.image) return;
    const todo = [];
    for (const row of rows) {
      const media = safeJsonParse(row.media, null);
      const type = recognizeTypeOf(media);
      if (!type || !on[type] || media.stored !== 'ok' || media.recognize || recognizing.has(row.id)) continue;
      // 老数据：自动回复识别过的没有 media.recognize，看文字
      if (/^\[(语音|图片)\] /.test(row.text)) continue;
      todo.push({ row, media, type });
    }
    const room = Math.min(SUGGEST_RECOGNIZE_MAX, DAILY_LLM_LIMIT - usedToday - 1);
    if (room <= 0 || !todo.length) return;
    await Promise.all(todo.slice(-room).map((t) => recognizeOne(convId, t)));
  }

  async function recognizeOne(convId, { row, media, type }) {
    const what = type === 'voice' ? '语音' : '图片';
    recognizing.add(row.id);
    try {
      const saved = { stored: 'ok', fileKey: media.fileKey, size: media.size, mime: media.mime };
      const loaded = await loadForRecognition(type, { mime: baseMime(media.mime) || null, seconds: media.seconds ?? null }, saved, null);
      if (!loaded) return;
      // 取文件期间客户撤回了：不进模型
      if (db.prepare('SELECT revoked_at FROM messages WHERE id = ?').get(row.id)?.revoked_at) return;
      addLlmCalls(convId, 1);
      const text = await recognizeText(type, loaded);
      if (closed) return;
      const caption = captionOf(row);
      const full = `[${what}] ${text}${caption ? `\n${clip(caption, MAX_STORED_TEXT - 200)}` : ''}`;
      // 识别期间客户撤回了、或者改了说明文字的不写（也不记结果，下次点的时候按改后的再识别）
      const changed = db
        .prepare(
          "UPDATE messages SET kind = 'text', text = ?, translation = NULL, media = json_set(media, '$.recognize', json(?)) WHERE id = ? AND revoked_at IS NULL AND text = ?",
        )
        .run(full, JSON.stringify({ status: 'ok' }), row.id, row.text).changes;
      // 一键翻译按客户最近的消息判断语言，文字变了就重新判断
      if (changed) ctx.translationLanguages?.delete(convId);
    } catch (err) {
      if (closed) return;
      if (!(err instanceof RecognizeError)) {
        log.error(`[wa] 推荐回复前识别会话 ${logConv(convId)} 的${what}出错：${err?.stack || err}`);
        return;
      }
      patchRecognize(row.id, recognizeFailure(err));
      log.info(`[wa] 推荐回复前识别会话 ${logConv(convId)} 的${what}没有成功（${err.code}）`);
    } finally {
      recognizing.delete(row.id);
    }
  }

  function scheduleFlush(convId, delayMs) {
    if (closed) return;
    cancelTimer(convId);
    const ms = delayMs ?? Math.round(settings().reply.debounceSeconds * 1000);
    const t = setTimeout(() => {
      timers.delete(convId);
      flush(convId).catch((err) => log.error(`[wa] 处理会话 ${logConv(convId)} 出错：${err?.stack || err}`));
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
        "SELECT seq, text, external_id FROM messages WHERE conversation_id = ? AND direction = 'in' AND kind = 'text' AND handled = 0 AND revoked_at IS NULL ORDER BY seq",
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
    // 第 4 层：每会话每天 LLM 调用上限（一轮至少 2 次：生成 + 审核；知识库大、命中不足时可能多 1 次检索改写，
    // 命中套话时再加 1 次重写。剩下的次数够不够做这两次由 decideReply 按 llmBudget 判断）
    const today = localDay();
    const usedToday = conv.llm_day === today ? conv.llm_calls : 0;
    if (usedToday + 2 > DAILY_LLM_LIMIT) {
      log.warn(`[wa] 会话 ${logConv(convId)} 今天的模型调用已达上限（${usedToday}/${DAILY_LLM_LIMIT}）`);
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

    const genStartedAt = nowIso();
    let result = await decideReply(ctx, {
      message,
      history,
      persona: acc.persona,
      llmBudget: DAILY_LLM_LIMIT - usedToday,
      fileQuota: Math.max(0, DAILY_FILE_LIMIT - filesToday),
      // AI 发言检查：审核那一次顺带看回复，不多调模型、不多算次数（结果在 deliverReply 发完后处理）
      conductCheck: ctx.conduct.enabled(),
    });

    conv = getConvRow(convId);
    if (!conv) return;
    const used = (conv.llm_day === today ? conv.llm_calls : 0) + result.llmCalls;
    db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(today, used, convId);
    const accNow = accounts.get(acc.id);
    if (!accNow) return void settle('skipped', '这个号已删除');
    if (conv.bot_paused || closed) return void settle('skipped', '生成回复期间人工接管了这个会话');
    // 生成期间客户撤回了这一轮里的消息：这份回复是照着撤回的话写的，不发；撤回的那条已经记为 skipped，剩下的重新走一轮
    const revokedNow = db
      .prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND revoked_at IS NOT NULL AND seq IN (${pending.map(() => '?').join(', ')}) LIMIT 1`)
      .get(convId, ...pending.map((p) => p.seq));
    if (revokedNow) {
      log.info(`[wa] 会话 ${logConv(convId)} 生成回复期间客户撤回了消息，这次的回复不发，重新处理`);
      scheduleFlush(convId);
      return;
    }
    // 生成期间客户改了这一轮里的消息：这份回复是照着改前的话写的，不发，按改后的重新走一轮
    const editedNow = db
      .prepare(
        `SELECT 1 FROM messages WHERE conversation_id = ? AND edited_at IS NOT NULL AND edited_at >= ? AND seq IN (${pending.map(() => '?').join(', ')}) LIMIT 1`,
      )
      .get(convId, genStartedAt, ...pending.map((p) => p.seq));
    if (editedNow) {
      log.info(`[wa] 会话 ${logConv(convId)} 生成回复期间客户改了消息，这次的回复不发，重新处理`);
      scheduleFlush(convId);
      return;
    }
    // 屏蔽词：自动回复里有就不发，按「回复被拦截」转人工（和规则拦截一样暂停、起草、通知），管理员另外会收到提醒
    if (result.decision === 'replied') {
      const hit = ctx.blockwords.check(result.reply, { source: 'bot', accountId: acc.id, conversationId: convId });
      if (hit) result = { ...result, decision: 'blocked', code: 'blockword', reason: `回复里有屏蔽词${quoteWords(hit.words)}，没有发出，已转人工` };
    }

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
          log.info(`[wa] 会话 ${logConv(convId)} 24 小时内离题 ${strikes} 次，静默到 ${until}`);
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

  /**
   * seq 之前的最近 12 条消息（自动回复、草稿、推荐回复共用的上下文）。撤回过的消息（客户撤回的、我方撤回的）不算。
   * sentOnly 只有推荐回复传：我方发送失败的消息（客户没收到）不算，不当成我方说过的话；自动回复和转人工草稿照旧都带上。
   */
  function historyBefore(convId, seq, { sentOnly = false } = {}) {
    return db
      .prepare(
        `SELECT direction, text, attachment FROM messages WHERE conversation_id = ? AND seq < ? AND revoked_at IS NULL${sentOnly ? " AND (direction = 'in' OR status = 'sent')" : ''}
         ORDER BY seq DESC LIMIT 12`,
      )
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
   * 「我方的消息」只认发送成功的（status=sent，和清推荐、F12 首次回复一样）：发送失败的客户没收到，不算我方回过，
   * 也不进最近对话和 ourMessages——客户问了、业务员回的那条没发出去时，照旧按「客户这次的消息」起草，不当成跟进。
   * 撤回过的消息两边都当没有：客户撤回的不算客户说过的话，我方撤回的客户看不到了，也不算我方回过。
   * customerFiles 是客户最近发来、提取到文字的文件（见 customerFilesFor）。
   * @returns {{message:string, history:any[], followUp:boolean, ourMessages:string[], customerFiles:any[]}|null}
   */
  function suggestInput(convId) {
    const w = suggestWindow(convId);
    if (!w) return null;
    const message = w.rows.map((r) => r.text).join('\n');
    if (!w.followUp) {
      return {
        message,
        history: historyBefore(convId, w.rows[0].seq, { sentOnly: true }),
        followUp: false,
        ourMessages: [],
        customerFiles: customerFilesFor(convId),
      };
    }
    const ours = db
      .prepare(
        "SELECT text, attachment FROM messages WHERE conversation_id = ? AND direction = 'out' AND status = 'sent' AND revoked_at IS NULL AND seq > ? ORDER BY seq DESC LIMIT ?",
      )
      .all(convId, w.lastIn, MAX_FOLLOWUP_MESSAGES)
      .reverse()
      .map(contextText);
    return {
      message,
      history: historyBefore(convId, Number.MAX_SAFE_INTEGER, { sentOnly: true }),
      followUp: true,
      ourMessages: ours,
      customerFiles: customerFilesFor(convId),
    };
  }

  /**
   * 推荐回复的「客户这次的消息」是哪几条（规则见 suggestInput）：{rows, followUp, lastIn}，rows 带 id、seq、kind、text、media。
   * 会话里一条客户消息都没有时为 null
   */
  function suggestWindow(convId) {
    const lastOut = db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ? AND direction = 'out' AND status = 'sent' AND revoked_at IS NULL",
      )
      .get(convId).n;
    const inSince = (after, upTo) =>
      db
        .prepare(
          "SELECT id, seq, kind, text, media FROM messages WHERE conversation_id = ? AND direction = 'in' AND revoked_at IS NULL AND seq > ? AND seq <= ? ORDER BY seq",
        )
        .all(convId, after, upTo);
    let rows = inSince(lastOut, Number.MAX_SAFE_INTEGER);
    if (rows.length) return { rows: rows.slice(-MAX_SUGGEST_MESSAGES), followUp: false, lastIn: null };
    const lastIn = db
      .prepare("SELECT MAX(seq) n FROM messages WHERE conversation_id = ? AND direction = 'in' AND revoked_at IS NULL")
      .get(convId).n;
    if (lastIn == null) return null;
    const outBefore = db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ? AND direction = 'out' AND status = 'sent' AND revoked_at IS NULL AND seq < ?",
      )
      .get(convId, lastIn).n;
    rows = inSince(outBefore, lastIn).slice(-MAX_SUGGEST_MESSAGES);
    if (!rows.length) return null;
    return { rows, followUp: true, lastIn };
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
   * 会话今天的模型调用次数加 n（按服务器本地日期，跨天从 0 算）。返回加之前今天已经用了几次
   */
  function addLlmCalls(convId, n) {
    const today = localDay();
    const conv = getConvRow(convId);
    if (!conv) return 0;
    const used = conv.llm_day === today ? conv.llm_calls : 0;
    db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(today, used + n, convId);
    return used;
  }

  /**
   * 调一次模型起草推荐回复（计入会话每日模型次数），返回 {draft, startSeq}，不存。生成失败、结果为空时抛错。
   * startSeq 是开始生成时会话里最大的消息序号，调用方用它判断生成期间我方是不是已经回了。
   * 跟进时我方最后那几条（ourMessages）也参与检索（buildReplyContext 的 extraQuery）。
   * @param {{message:string, history:any[], followUp?:boolean, ourMessages?:string[]}} input suggestInput 的结果
   * @param {{stylePrompt?:string, agentProfile?:any, previous?:string}} o agentProfile 是点按钮那个人的「我的资料」
   */
  async function generateSuggestion(acc, convId, input, { stylePrompt = '', agentProfile = null, previous = '' }) {
    const usedToday = addLlmCalls(convId, 1);
    const startSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ?').get(convId).n;
    const s = settings();
    const followUp = !!input.followUp;
    // 检索改写也算一次，今天剩下的次数够起草 + 改写（2 次）才改写（起草那次上面已经记了）
    const c = await buildReplyContext(ctx, {
      message: input.message,
      history: input.history,
      extraQuery: followUp ? input.ourMessages || [] : [],
      searchRewrite: usedToday + 2 <= DAILY_LLM_LIMIT,
    });
    if (c.searchCalls) addLlmCalls(convId, c.searchCalls);
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
      customerFiles: input.customerFiles || [],
    });
    const active = new Set(c.activeFiles.map((f) => f.id));
    const fileIds = normalizeFileIds(out?.fileIds)
      .filter((id) => active.has(id))
      .slice(0, MAX_FILES_PER_REPLY);
    // 括号里写成外文的【待你确认：…】译成中文（只在有的时候调一次翻译，失败、超时照原样）
    const text = clip(await fixDraftPlaceholders(ctx, { id: convId, accountId: acc.id }, String(out?.text ?? '').trim()), MAX_DRAFT_TEXT);
    if (!text && !fileIds.length) throw new Error('推荐回复是空的');
    const entryIds = draftEntryIds(out?.entryIds, c.entries);
    return { draft: { kind: 'suggest', text, fileIds, entryIds, createdAt: nowIso() }, startSeq };
  }

  /** 从 startSeq 之后我方有没有发过消息（后台、手机、机器人、外联都算；发送失败的也算，见 deviations.md 第 48 条） */
  const repliedSince = (convId, startSeq) =>
    !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'out' AND seq > ? LIMIT 1").get(convId, startSeq);

  /** 从 startSeq 之后客户有没有发过新消息（推荐回复跟进用：客户又说话了，「客户没再发、接着再发一条」就不成立了） */
  const customerSince = (convId, startSeq) =>
    !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'in' AND seq > ? LIMIT 1").get(convId, startSeq);

  /**
   * F2a：转人工时给人工起草一条回复（不自动发送）。当天 LLM 次数不够、生成失败时不带草稿；
   * 生成期间人工已经回了或机器人已恢复的，丢掉这份草稿。
   * 带会话负责人的「我的资料」（草稿是给他发的）；没分配、负责人已停用或没填资料时不带。检索只用客户的话（不传 extraQuery）。
   * 用了负责人的资料时草稿里记下 agentUserId（只在库里，parseDraft 不往外给）：改派、批量分配、转交、收回让负责人变成别人时
   * 清掉这份草稿（assign.js 的 writeAssignee），这个人被停用、删除时也清（routes/users.js）；生成期间负责人变成了别人、
   * 或者这个人被停用、删除了的，按同样的规则不存。
   */
  async function prepareDraft(acc, convId, { message, history, reason, usedToday }) {
    if (closed || usedToday + 1 > DAILY_LLM_LIMIT || !ctx.ai.draft) return;
    const before = getConvRow(convId);
    if (!before) return;
    const startSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ?').get(convId).n;
    addLlmCalls(convId, 1);
    let draft;
    try {
      // 检索改写也算一次，今天剩下的次数够起草 + 改写（2 次）才改写。同一段话刚在生成回复时改写过的，直接用那次的结果，
      // 不再调模型（kb/retrieve.js 的缓存），也就不计数
      const c = await buildReplyContext(ctx, { message, history, searchRewrite: usedToday + 2 <= DAILY_LLM_LIMIT });
      if (c.searchCalls) addLlmCalls(convId, c.searchCalls);
      const { agentProfile } = memberAiInfo(before.assignee_id, { activeOnly: true });
      const out = await ctx.ai.draft({
        message: c.msg,
        history: c.hist,
        entries: c.entries,
        files: c.files,
        filesTruncated: c.filesTruncated,
        profile: c.profile,
        persona: acc.persona && acc.persona.trim() ? acc.persona : settings().reply.persona,
        agentProfile,
        reason,
        customerFiles: customerFilesFor(convId),
      });
      const active = new Set(c.activeFiles.map((f) => f.id));
      const fileIds = normalizeFileIds(out?.fileIds)
        .filter((id) => active.has(id))
        .slice(0, MAX_FILES_PER_REPLY);
      // 同推荐回复：括号里写成外文的【待你确认：…】译成中文
      const text = clip(await fixDraftPlaceholders(ctx, { id: convId, accountId: acc.id }, String(out?.text ?? '').trim()), MAX_DRAFT_TEXT);
      if (!text && !fileIds.length) throw new Error('草稿是空的');
      draft = { kind: 'handoff', text, fileIds, entryIds: draftEntryIds(out?.entryIds, c.entries), createdAt: nowIso() };
      // 草稿里写了负责人的名字、电话这些，记下是谁的（没用资料就不记，改派也不清）
      if (agentProfile) draft.agentUserId = before.assignee_id;
    } catch (err) {
      log.warn(`[wa] 会话 ${logConv(convId)} 生成草稿失败，不带草稿通知：${err?.message || err}`);
      return;
    }
    if (closed) return;
    const conv = getConvRow(convId);
    const operatorSince = db
      .prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND author = 'operator' AND seq > ? LIMIT 1")
      .get(convId, startSeq);
    if (!conv || !conv.needs_human || operatorSince) return;
    // 生成期间改派给了别人：草稿里是前一个负责人的资料，和存下之后再改派一样作废（没用资料的草稿照存）
    if (draft.agentUserId && draft.agentUserId !== (conv.assignee_id ?? null)) {
      log.info(`[wa] 会话 ${logConv(convId)} 起草期间换了负责人，草稿里是前一个负责人的资料，不存`);
      return;
    }
    // 生成期间负责人被停用了（删除的话上面已经因为会话变成未分配不存了）：和存下之后再停用一样作废
    if (draft.agentUserId && memberGone(draft.agentUserId)) {
      log.info(`[wa] 会话 ${logConv(convId)} 起草期间负责人被停用或删除了，草稿里是他的资料，不存`);
      return;
    }
    db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(draft), convId);
    noteDraft('记录', (d) => d.recorded(conv, draft, { question: message }));
  }

  // ---------------- F1 / F14：拟真发送 ----------------
  async function markRead(acc, chatId, ids) {
    // Meta 的标已读和"正在输入"是同一个请求，在 typing() 里一起发
    if (acc.channel === 'line') return lineMarkRead(acc, chatId);
    // Telegram 机器人不能标已读；私人号用 readBusinessMessage
    if (acc.channel === 'tgbiz') return tgMarkRead(acc, chatId, ids);
    if (acc.channel === 'tguser') return tgUserMarkRead(acc, chatId, ids);
    if (acc.channel !== 'waha') return;
    try {
      await waha.sendSeen(acc.sessionName, chatId, ids);
    } catch (err) {
      log.warn(`[wa] 标已读失败（${chatId}）：${err?.message || err}`);
    }
  }

  /**
   * LINE：用客户最近一条消息的 markAsReadToken 标已读（标到这条为止的都算已读）。
   * 有的帐号没有这个权限（403），只记警告
   */
  async function lineMarkRead(acc, chatId) {
    const convId = conversationIdOf(acc.id, chatId);
    const token = lineReadTokens.get(convId);
    if (!token) return;
    lineReadTokens.delete(convId);
    try {
      await lineMarkAsRead(config.lineApiUrl, acc.line, token);
    } catch (err) {
      log.warn(`[line] 标已读失败（号 ${acc.id}）${err?.status === 403 ? '，这个 LINE 官方帐号可能没有标已读的权限' : ''}：${err?.message || err}`);
    }
  }

  async function typing(acc, chatId, lastInboundId, on) {
    try {
      if (acc.channel === 'waha') await waha.setPresence(acc.sessionName, chatId, on ? 'typing' : 'paused');
      else if (acc.channel === 'meta' && on && lastInboundId) {
        // Meta 没有单独的停止接口：发出回复或 25 秒后自动消失
        await metaMarkRead(config.metaGraphUrl, acc.meta, lastInboundId, { typing: true });
      } else if (acc.channel === 'line' && on) {
        // LINE 的「正在输入」也没有停止接口：我方发出消息时消失，最长显示 20 秒
        await lineStartLoading(config.lineApiUrl, acc.line, chatId, 20);
      } else if (isTelegram(acc.channel)) {
        await tgTyping(acc, chatId, on);
      }
    } catch (err) {
      // Telegram 的 chat id 是客户的用户 id，日志里不记
      log.warn(`[wa] "正在输入"${on ? '开启' : '关闭'}失败（${isTelegram(acc.channel) ? `号 ${acc.id}` : chatId}）：${err?.message || err}`);
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
    /** 发出去了的几段（AI 发言检查标已查用） */
    const sentMessageIds = [];
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
        const msg = await sendAndRecord(acc, conv, parts[i], { ...opts, partIndex: parts.length > 1 ? i : null });
        if (msg.status === 'sent') sentMessageIds.push(msg.id);
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
    // AI 发言检查：审核时顺带查过、几段全发出去了的，标成已查，有问题的记一条（只提醒）；只发了一部分的留给发出后的检查一段一段查
    if (result.conduct !== undefined && sent === parts.length) {
      try {
        ctx.conduct.afterBotReply({ conversationId: convId, accountId: acc.id, reply: result.reply, parts, messageIds: sentMessageIds, raw: result.conduct });
      } catch (err) {
        log.warn(`[conduct] 记录自动回复的发言检查结果失败：${err?.message || err}`);
      }
    }
    if (sent < parts.length) {
      log.info(`[wa] 会话 ${logConv(convId)} 拟真发送被取消：已发 ${sent}/${parts.length} 条`);
      // 一条都没发出：客户消息还没处理，重新从防抖开始（新消息已在库里，会一起合并）
      if (sent === 0 && !closed) scheduleFlush(convId);
    } else if (sentFileIds.length < files.length) {
      log.info(`[wa] 会话 ${logConv(convId)} 文件没有全部发出：已发 ${sentFileIds.length}/${files.length} 个`);
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
      // 屏蔽词：草稿文字里有就整份不发（文件也不发），草稿留着
      const hit = draft.text.trim() ? ctx.blockwords.check(draft.text, { source: 'relay', accountId: acc.id, conversationId: convId }) : null;
      if (hit) {
        await replyAdmin(`❌ 草稿里有屏蔽词${quoteWords(hit.words)}，没有发出去，管理员会收到提醒`);
        return 'command_blocked';
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
    // 屏蔽词：转发的话里有就不发
    const hit = ctx.blockwords.check(m.text, { source: 'relay', accountId: acc.id, conversationId: convId });
    if (hit) {
      await replyAdmin(`❌ ${hitMessage('relay', hit.words)}`);
      return 'command_blocked';
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
    // LINE 没有查连接状态的接口：三项都填了就是已配置；最近一次推送失败（额度用完、token 不对）放在 error 里
    if (acc.channel === 'line') {
      return { ...base, state: lineConfigured(acc) ? 'configured' : 'not_configured', error: st.linePushError?.message ?? null };
    }
    if (acc.channel === 'tguser') return tgUserStatus(acc, base);
    if (isTelegram(acc.channel)) return tgStatus(acc, base);
    if (acc.channel !== 'waha') return { ...base, error: '未知的接入方式' };
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
   * 「用全局代理」的号指向 inkdove 上 mihomo 的混合端口（和中继一样经 INKDOVE_PROXY_RELAY_HOST 连，账号密码是随机生成的、只有字母数字和 -_）。
   * server 按文档不带协议头；WAHA 把账号密码原样拼进代理 URL，所以先做 URL 编码。
   */
  function wahaProxyFor(acc) {
    const px = acc.waha?.proxy;
    if (px?.enabled && px.useGlobal) return ctx.globalProxy.wahaProxy();
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
   * 消息撤回：订阅 message.revoked（客户撤回、在手机上撤回我方消息都推）。
   * 消息编辑：订阅 message.edited（客户改了他的消息、在手机上改了我方消息都推）。
   * 改了这里指纹就变，已有的号在服务启动时（init）或下次 start 时会把新配置 PUT 过去。
   */
  function wahaManagedConfig(acc) {
    const cfg = {
      webhooks: [
        {
          url: config.wahaWebhookUrl,
          events: ['message.any', 'message.revoked', 'message.edited', 'session.status'],
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
    await tgStop(acc.id);
    // 扫码登录的号：从 Telegram 退出（这个设备从帐号的设备列表里消失），删掉登录态
    if (acc.channel === 'tguser') await tgUserLogout(acc, { quiet: true });
    for (const r of db.prepare('SELECT id FROM conversations WHERE account_id = ?').all(acc.id)) {
      cancelTimer(r.id);
      abortSending(r.id, 'account_deleted');
      lineReplyTokens.delete(r.id);
      lineReadTokens.delete(r.id);
      clearInterval(tgTypingTimers.get(r.id));
      tgTypingTimers.delete(r.id);
    }
    accounts.delete(acc.id, by);
    accState.delete(acc.id);
    recentSent.delete(acc.id);
    db.prepare('DELETE FROM kv WHERE key = ?').run(tgKvKey(acc.id));
    tgKvCache.delete(acc.id);
    for (const map of [seenLineEvents, lineNames]) {
      for (const k of map.keys()) if (k.startsWith(`${acc.id}|`)) map.delete(k);
    }
  }

  // ---------------- 消息撤回 ----------------
  // 两个方向：业务员在墨鸽里撤回我方消息（revokeMessage，经 WAHA 对所有人删除）；WAHA 推来 message.revoked（handleRevoked：
  // 客户撤回了他的消息，或者在同一个号的手机上撤回了我方消息）。都只标上撤回，原文保留给业务员看；撤回过的消息不再进模型的上下文。

  /** 清掉 10 分钟前记下的撤回尝试 */
  function pruneRevokeAttempts() {
    const now = Date.now();
    for (const [k, v] of revokeAttempts) if (now - v.at > ECHO_ID_KEEP_MS) revokeAttempts.delete(k);
  }

  /** 把一条消息标成撤回；已经标过的不动。返回这次有没有标上 */
  function markRevoked(msgId, by, user, at) {
    return (
      db
        .prepare('UPDATE messages SET revoked_at = ?, revoked_by = ?, revoked_by_user_id = ?, revoked_by_name = ? WHERE id = ? AND revoked_at IS NULL')
        .run(at, by, user?.id ?? null, user ? clip(String(user.name ?? ''), 100) : null, msgId).changes > 0
    );
  }

  /**
   * 撤回事件对应的消息。先在这个聊天的会话里找，找不到再在这个号的所有会话里找（同一个客户的 chat id 可能一会儿是
   * <号码>@c.us、一会儿是 <lid>@lid）。按 WhatsApp 消息 ID 比：库里的 external_id 是 WAHA 的序列化 id `<true|false>_<chat>_<ID>`
   * （群里再接 `_<participant>`，墨鸽不收群消息，这里照样认），ID 是随机的，同一个号里撞不上。fromMe 的只找我方消息，否则只找客户消息
   */
  function findRevokeTarget(acc, chatId, keyId, fromMe) {
    const match = (col) =>
      `${col} IS NOT NULL AND (${col} = ? OR substr(${col}, -length(?) - 1) = '_' || ? OR instr(${col}, '_' || ? || '_') > 0)`;
    const keys = [keyId, keyId, keyId, keyId];
    const direction = fromMe ? 'out' : 'in';
    const inChat = db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND direction = ? AND ${match('external_id')} LIMIT 1`)
      .get(conversationIdOf(acc.id, chatId), direction, ...keys);
    if (inChat) return inChat;
    return (
      db
        .prepare(
          `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.account_id = ? AND m.direction = ? AND ${match('m.external_id')} LIMIT 1`,
        )
        .get(acc.id, direction, ...keys) || null
    );
  }

  /**
   * WAHA 的 message.revoked。GOWS 的载荷（镜像 2026.9.2 的 dist 代码）：{after: 撤回那条协议消息转成的 WAMessage（from 是聊天对象，
   * fromMe 是不是自己撤回的，source 是 api / app）, before: null, revokedMessageId: 被撤回消息的 ID（key.ID，不带前缀）, _data: 原始消息}。
   * - 客户撤回（fromMe=false）：对上客户消息，标「客户已撤回」。还没处理的（在防抖、识别中）记为 skipped，正在拟真等待的发送取消，
   *   剩下的消息重新走一轮；
   * - 自己撤回（fromMe=true）：墨鸽里点过撤回的（revokeAttempts 里有）按那个成员标；source=api 但没记录的（比如接口返回前服务重启了）
   *   按墨鸽里撤回、不知道是谁；其余是在手机等其他设备上撤回的，标「已在手机上撤回」。
   * 群聊、对不上的忽略；可以重复推，标过的不再动。返回处理结果（测试用）
   */
  function handleRevoked(acc, p) {
    if (closed) return 'closed';
    const after = p.after && typeof p.after === 'object' ? p.after : {};
    const idOf = (x) => (typeof x === 'string' ? x : x?._serialized || x?.id || null);
    const rawId = [p.revokedMessageId, p._data?.Message?.protocolMessage?.key?.ID, p.before?.id].map(idOf).find((x) => typeof x === 'string' && x);
    // 聊天对象和是不是自己撤回的按入站消息的规则取（after 就是一条 WAMessage）；没有 after 时从原始消息的 Info 取
    const info = after._data?.Info || p._data?.Info || {};
    const fromMe = !!(after.fromMe ?? info.IsFromMe);
    const { chatId } = parseWahaMessage({ fromMe, from: after.from ?? info.Chat, to: after.to ?? null, _data: after._data || p._data || {} });
    if (!rawId) return 'ignored_revoke';
    if (!chatId || isNonPrivateChat(chatId)) return 'ignored_non_private';
    // ID 只防明显不对的值（空的、带 @ 的）；对不对得上靠下面按整段比 external_id
    const keyId = messageKeyId(rawId);
    if (!/^[^_@\s]{3,}$/.test(keyId)) return 'ignored_revoke';
    const row = findRevokeTarget(acc, chatId, keyId, fromMe);
    if (!row) return 'ignored_revoke_unknown';
    if (row.revoked_at) return 'ignored_duplicate';
    // 撤回时间用协议消息的时间（秒），没有时用收到的时间
    const sec = Number(after.timestamp);
    const at = Number.isFinite(sec) && sec > 0 ? new Date(sec < 1e12 ? sec * 1000 : sec).toISOString() : nowIso();
    if (fromMe) {
      pruneRevokeAttempts();
      const attempt = revokeAttempts.get(`${acc.id}|${keyId}`);
      if (attempt || after.source === 'api') {
        markRevoked(row.id, 'member', attempt?.user ?? null, at);
        return 'revoked_member';
      }
      markRevoked(row.id, 'phone', null, at);
      return 'revoked_phone';
    }
    return customerRevoked(row, at);
  }

  /**
   * 客户撤回了他的一条消息（扫码号的 message.revoked、LINE 的 unsend 共用）：标「客户已撤回」。
   * 还没处理的（在防抖、识别中）记为 skipped，正在拟真等待的发送取消
   */
  function customerRevoked(row, at) {
    db.transaction(() => {
      markRevoked(row.id, 'customer', null, at);
      if (!row.handled) {
        db.prepare("UPDATE messages SET handled = 1, bot_decision = 'skipped', decision_reason = ? WHERE id = ? AND handled = 0").run(
          REVOKED_SKIP_REASON,
          row.id,
        );
      }
    })();
    if (!row.handled) abortSending(row.conversation_id, 'revoked');
    return 'revoked_customer';
  }

  // ---------------- 消息编辑 ----------------
  // 扫码号的 message.edited、Telegram 的 edited_message（机器人）和 edited_business_message（私人号）：客户改了他的消息，
  // 或者在同一个号的手机上改了我方消息。text 换成改后的内容，改前的版本留在 edit_history 给业务员看；AI 只看改后的。

  /**
   * 把一条消息改成新内容，返回处理结果（测试用）：
   * - 撤回过的、内容没变的（重复推送）不改；
   * - 正在识别的语音、图片（占位消息，识别完会整条重写）和识别过的（描述和说明文字拼在一起，分不开）不改；
   * - 媒体消息改的是说明文字，改成空的就只剩 [图片] 这样的标签；
   * - 改前的版本按出现的时间记进 edit_history，最早那个（原文）一直留着，中间的超过 EDIT_HISTORY_MAX 个丢掉最早的；
   * - 客户的消息还没处理完（防抖、生成、拟真等待中）：拟真等待的发送取消，按改后的内容重新走一轮（生成中的见 processPending）；
   *   已经处理过的只标「已编辑」，不再回复一次（多是改错字）。存下的译文作废
   */
  function applyEdit(row, rawText) {
    if (row.revoked_at) return 'ignored_revoked';
    const media = safeJsonParse(row.media, null);
    if (media && ((row.kind === 'media' && !row.handled) || /^\[(图片|语音)\] /.test(row.text))) return 'ignored_edit_media';
    let text = clip(String(rawText ?? '').trim(), MAX_STORED_TEXT);
    let kind = row.kind;
    if (!text) {
      if (media) {
        text = MEDIA_LABELS[media.type] || '[非文字消息]';
        kind = 'media';
      } else if (!row.attachment) return 'ignored_edit_empty';
    } else if (media) kind = 'text';
    if (text === row.text) return 'ignored_duplicate';
    const parsed = safeJsonParse(row.edit_history, []);
    const history = Array.isArray(parsed) ? parsed : [];
    history.push({ text: row.text, at: row.edited_at || row.ts });
    if (history.length > EDIT_HISTORY_MAX) history.splice(1, history.length - EDIT_HISTORY_MAX);
    const changed = db
      .prepare('UPDATE messages SET text = ?, kind = ?, edited_at = ?, edit_history = ?, translation = NULL WHERE id = ? AND revoked_at IS NULL')
      .run(text, kind, nowIso(), JSON.stringify(history), row.id).changes;
    if (!changed) return 'ignored_revoked';
    if (row.direction === 'in') {
      // 一键翻译按客户最近的消息判断语言，改了就重新判断
      ctx.translationLanguages?.delete(row.conversation_id);
      if (!row.handled) {
        abortSending(row.conversation_id, 'edited');
        scheduleFlush(row.conversation_id);
      }
    }
    return 'edited';
  }

  /**
   * WAHA 的 message.edited（按 WAHA 文档写的，没在真机上核实）：payload 是一条 WAMessage，另带 editedMessageId（被改消息的 ID，
   * 不带 `<true|false>_<chat>_` 前缀）和 body（改后的内容）。聊天对象、是不是自己改的按入站消息的规则取，没有时从原始消息的 Info 取；
   * ID 没给时从原始消息的 protocolMessage 取。message.any 万一把编辑的协议消息也推来，也走这里（见 handleWahaWebhook），
   * 两边都推时第二次内容没变、不再改。对消息的规则同撤回（findRevokeTarget）；群聊、对不上的忽略
   */
  function handleWahaEdited(acc, p) {
    if (closed) return 'closed';
    const info = p._data?.Info || {};
    const proto = p._data?.Message?.protocolMessage || p._data?.Message?.editedMessage?.message?.protocolMessage || {};
    const fromMe = !!(p.fromMe ?? info.IsFromMe);
    const { chatId } = parseWahaMessage({ fromMe, from: p.from ?? info.Chat, to: p.to ?? null, _data: p._data || {} });
    const rawId = [p.editedMessageId, proto.key?.ID].find((x) => typeof x === 'string' && x);
    if (!rawId) return 'ignored_edit';
    if (!chatId || isNonPrivateChat(chatId)) return 'ignored_non_private';
    const keyId = messageKeyId(rawId);
    if (!/^[^_@\s]{3,}$/.test(keyId)) return 'ignored_edit';
    // 改后的内容先从原始消息取（message.any 推来的协议消息，body 可能是空的），没有再用 body
    const e = proto.editedMessage || {};
    const fromProto =
      e.conversation ?? e.extendedTextMessage?.text ?? e.imageMessage?.caption ?? e.videoMessage?.caption ?? e.documentMessage?.caption;
    const body = typeof fromProto === 'string' ? fromProto : p.body;
    if (typeof body !== 'string') return 'ignored_edit';
    const row = findRevokeTarget(acc, chatId, keyId, fromMe);
    if (!row) return 'ignored_edit_unknown';
    return applyEdit(row, body);
  }

  /**
   * Telegram 的 edited_message / edited_business_message：改后的整条消息（message_id 不变，文字在 text 或 caption 里）。
   * 消息 id 只在一个聊天里唯一，按会话和 id 找；私人号的双方消息都可能被改（号主改的是我方消息）
   */
  function tgEdited(acc, msg) {
    if (msg?.chat?.type !== 'private' || msg.chat.id == null || msg.message_id == null) return 'ignored_non_private';
    const row = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND external_id = ?')
      .get(conversationIdOf(acc.id, String(msg.chat.id)), String(msg.message_id));
    if (!row) return 'ignored_edit_unknown';
    return applyEdit(row, msg.text ?? msg.caption ?? '');
  }

  /** 撤回接口的报错转成中文原因。超时的撤回可能其实成了：之后收到 WhatsApp 的撤回通知会按这个成员标上（见 handleRevoked） */
  function revokeFail(err) {
    if (!(err instanceof WahaError)) return err;
    if (!err.status && /超时/.test(err.message)) {
      return new HttpError(
        502,
        'waha_timeout',
        '撤回没有确认：WAHA 超时没有响应。客户那边可能已经撤回了，收到 WhatsApp 的撤回通知后这里会自动标上；没有的话可以再试一次',
      );
    }
    // WAHA 等会话进入 WORKING 等不到时回 422
    if (err.status === 422) return new HttpError(409, 'not_connected', `这个号现在没连上 WhatsApp，连上后再撤回（${err.message}）`);
    return new HttpError(502, 'waha_error', `撤回失败：${err.message}`);
  }

  /**
   * 业务员在墨鸽里撤回我方的一条消息（对所有人删除，客户那边显示「此消息已删除」）。权限同手动发消息（路由里 loadConv 判）。
   * 只有扫码号上发送成功、有 WhatsApp 消息 id、还没撤回、没超过时限（REVOKE_WINDOW_MS）的我方消息能撤回（机器人、人工、手机上发的、
   * 外联、文件都算），按这个顺序判，判不过的不调 WAHA。WAHA 报错、超时时消息不变，报中文原因。
   * 成功后原文保留，记上撤回时间和成员（id、当时的名字）；不暂停机器人、不清草稿。返回更新后的消息
   */
  async function revokeMessage(convId, messageId, user) {
    const conv = getConvRow(convId);
    if (!conv) throw notFound('会话不存在');
    const row = typeof messageId === 'string' ? db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, convId) : null;
    if (!row) throw notFound('消息不存在');
    if (row.direction !== 'out') throw badRequest('只能撤回我方发出的消息', 'not_own_message');
    if (row.revoked_at) throw new HttpError(409, 'already_revoked', '这条消息已经撤回了');
    if (row.status !== 'sent') throw badRequest('这条消息没有发出去，客户没收到，不用撤回', 'not_sent');
    const acc = conv.account_id ? accounts.get(conv.account_id) : null;
    if (!acc) throw badRequest('这个会话所属的号已删除，不能再撤回', 'account_deleted');
    if (acc.channel === 'meta') throw badRequest('Meta 官方接口的号不能撤回消息（WhatsApp Cloud API 没有撤回功能）', 'revoke_unsupported');
    if (acc.channel === 'line') throw badRequest('LINE 官方帐号不能撤回已发出的消息（LINE Messaging API 没有撤回功能）', 'revoke_unsupported');
    if (isTelegram(acc.channel)) return revokeTelegram(acc, conv, row, user);
    if (acc.channel !== 'waha') throw badRequest('这个号不能撤回消息', 'revoke_unsupported');
    if (!row.external_id) throw badRequest('这条消息没有记下 WhatsApp 的消息 id，不能撤回', 'no_message_id');
    if (!revocableUntil(row, acc)) throw badRequest('已经超过 WhatsApp 允许撤回的时间（发出后约两天半），不能再撤回', 'revoke_expired');
    if (revoking.has(row.id)) throw new HttpError(409, 'revoking', '正在撤回这条消息，请稍等');
    const chatId = conv.chat_id || conv.id;
    const keyId = messageKeyId(row.external_id);
    // WAHA 要完整的序列化 id：库里存的就是 true_<chat>_<ID> 的直接用，否则按这个会话的 chat id 拼
    const serialized = /^true_[^_]+_[^_]+$/.test(row.external_id) ? row.external_id : `true_${chatId}_${keyId}`;
    const who = user ? { id: user.id, name: user.name ?? '' } : null;
    const attemptKey = `${acc.id}|${keyId}`;
    pruneRevokeAttempts();
    revokeAttempts.set(attemptKey, { user: who, at: Date.now() });
    revoking.add(row.id);
    try {
      await waha.deleteMessage(acc.sessionName, chatId, serialized);
    } catch (err) {
      // WAHA 明确报错的没撤成，不会再有撤回通知；超时、连不上的可能其实成了，留着记录等通知
      if (err instanceof WahaError && err.status) revokeAttempts.delete(attemptKey);
      log.warn(`[wa] 撤回会话 ${logConv(convId)} 的消息 ${row.id} 失败：${err?.message || err}`);
      throw revokeFail(err);
    } finally {
      revoking.delete(row.id);
    }
    // 撤回通知可能比接口响应先到、已经按这个成员标上了，这里不再改
    markRevoked(row.id, 'member', who, nowIso());
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id), accounts.get(acc.id) || acc);
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
    if (body.event === 'message.revoked') return handleRevoked(acc, body.payload || {});
    if (body.event === 'message.edited') return handleWahaEdited(acc, body.payload || {});
    // message.any 是现在订阅的；message 是老配置还没更新时推的（只有收到的消息），两种都按同一条路处理，按 id 去重
    if (body.event !== 'message.any' && body.event !== 'message') return 'ignored_event';
    // 编辑是一条协议消息，不是新消息：万一也推成 message.any，按编辑处理，不存成一条新消息
    const raw = body.payload?._data?.Message;
    if (raw?.protocolMessage?.editedMessage || raw?.editedMessage?.message?.protocolMessage) return handleWahaEdited(acc, body.payload);
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

  /**
   * LINE 官方帐号的 webhook（routes/webhooks.js 验过签名、已经回了 200）：{destination, events:[…]}。
   * - mode 为 standby（这个帐号的聊天交给了别的模块）的事件不处理；只处理一对一聊天（source.type 为 user），群、多人聊天忽略；
   * - 没收到 200 时 LINE 可能重发（开了 Webhook redelivery 的话），重发的 webhookEventId 不变：处理过的跳过，消息再按消息 id 去重；
   * - message：客户名字从资料接口取（缓存 1 小时）；存下以后记住这条的 reply token 和 markAsReadToken，回复、标已读时用；
   * - follow（加好友、解除封锁）：取一次资料，已有的会话更新名字，没聊过的不建空会话；unfollow 只记日志；
   * - unsend：客户撤回了消息，和扫码号的客户撤回一样标上
   * 返回每个事件的处理结果（测试用）
   */
  async function handleLineWebhook(accountId, body) {
    const acc = accounts.get(accountId);
    if (!acc || acc.channel !== 'line') return [];
    const st = state(acc.id);
    st.lastWebhookAt = nowIso();
    st.statusCache = null;
    const now = Date.now();
    for (const [k, t] of seenLineEvents) if (now - t > LINE_EVENT_KEEP_MS) seenLineEvents.delete(k);
    for (const [k, v] of lineNames) if (now - v.at > LINE_NAME_CACHE_MS) lineNames.delete(k);
    const results = [];
    for (const ev of Array.isArray(body?.events) ? body.events : []) {
      try {
        results.push(await handleLineEvent(accounts.get(acc.id), ev));
      } catch (err) {
        log.error(`[line] 处理号 ${acc.id} 的事件出错：${err?.stack || err}`);
        // 没处理完的事件不算处理过：LINE 重发（开了 Webhook redelivery 时）还能再处理一次，存过的消息照样按消息 id 去重
        if (ev?.webhookEventId) seenLineEvents.delete(`${acc.id}|${ev.webhookEventId}`);
        results.push('error');
      }
    }
    return results;
  }

  async function handleLineEvent(acc, ev) {
    if (closed) return 'closed';
    if (!acc) return 'ignored_account';
    if (!ev || typeof ev !== 'object') return 'ignored_event';
    if (ev.mode === 'standby') return 'ignored_standby';
    if (ev.source?.type !== 'user' || !ev.source.userId) return 'ignored_non_private';
    const userId = String(ev.source.userId);
    const eventKey = ev.webhookEventId ? `${acc.id}|${ev.webhookEventId}` : null;
    if (eventKey && seenLineEvents.has(eventKey)) return 'ignored_duplicate';
    if (eventKey) seenLineEvents.set(eventKey, Date.now());
    switch (ev.type) {
      case 'message': {
        const receivedAt = Date.now();
        const m = parseLineMessage(ev);
        if (!m) return 'ignored_event';
        m.contactName = await lineName(acc, userId);
        const r = await handleInbound(acc, m);
        if (LINE_STORED.has(r)) {
          const convId = conversationIdOf(acc.id, userId);
          if (ev.replyToken) lineReplyTokens.set(convId, { token: String(ev.replyToken), at: receivedAt });
          if (ev.message.markAsReadToken) lineReadTokens.set(convId, String(ev.message.markAsReadToken));
        }
        return r;
      }
      case 'follow': {
        lineNames.delete(`${acc.id}|${userId}`);
        const name = await lineName(acc, userId);
        const convId = conversationIdOf(acc.id, userId);
        if (name && getConvRow(convId)) db.prepare('UPDATE conversations SET contact_name = ? WHERE id = ?').run(name, convId);
        return 'follow';
      }
      case 'unfollow':
        log.info(`[line] 号 ${acc.id} 有客户取消了好友或封锁了这个帐号，之后发不到他了`);
        return 'unfollow';
      case 'unsend': {
        const mid = ev.unsend?.messageId ? String(ev.unsend.messageId) : '';
        if (!mid) return 'ignored_revoke';
        const row = db
          .prepare("SELECT * FROM messages WHERE conversation_id = ? AND direction = 'in' AND external_id = ?")
          .get(conversationIdOf(acc.id, userId), mid);
        if (!row) return 'ignored_revoke_unknown';
        if (row.revoked_at) return 'ignored_duplicate';
        const ts = Number(ev.timestamp);
        return customerRevoked(row, Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : nowIso());
      }
      default:
        return 'ignored_event';
    }
  }

  // ---------------- Telegram（机器人、私人号） ----------------
  // 收消息是每个号一个长轮询（telegram-poll.js），改号以后由 routes/accounts.js 调 syncTelegram。
  // 私人号（tgbiz）：号主先点绑定链接（t.me/<机器人>?start=bind_<code>），机器人收到 /start bind_<code> 记下号主；
  // 再在 Telegram 的「聊天自动化」里添加这个机器人，机器人收到 business_connection。只收号主自己连上的连接的消息：
  // 谁都能在自己的 Telegram 里添加这个机器人，不绑定的话别人的私聊也会进墨鸽。

  const tgKvKey = (accountId) => `telegram:${accountId}`;

  /**
   * kv 里记的 Telegram 状态：{botId, botUsername, offset, bindCode, owner:{id, name}|null,
   * connection:{id, userId, name, enabled, canReply, canRead, canDelete, canDeleteAll, at}|null}。
   * 换了机器人（token 前面的数字 id 变了）就重来：offset、绑定、连接都作废，换一个新的绑定 code
   */
  function tgKv(acc) {
    const botId = botIdOf(acc.telegram?.botToken);
    // 还没填 token（或者暂时清掉了）：给个空的，不动 kv 里记的，填回同一个机器人时绑定和连接还在
    if (!botId) return { botId: '', botUsername: '', offset: null, bindCode: '', owner: null, connection: null };
    let cur = tgKvCache.get(acc.id);
    if (cur === undefined) {
      cur = kvGet(db, tgKvKey(acc.id), null);
      tgKvCache.set(acc.id, cur);
    }
    if (cur && cur.botId === botId) return cur;
    const fresh = { botId, botUsername: '', offset: null, bindCode: crypto.randomBytes(12).toString('base64url'), owner: null, connection: null };
    kvSet(db, tgKvKey(acc.id), fresh);
    tgKvCache.set(acc.id, fresh);
    return fresh;
  }

  function tgKvUpdate(acc, patch) {
    if (!botIdOf(acc.telegram?.botToken)) return tgKv(acc);
    const next = { ...tgKv(acc), ...patch };
    kvSet(db, tgKvKey(acc.id), next);
    tgKvCache.set(acc.id, next);
    state(acc.id).statusCache = null;
    return next;
  }

  /** 私人号连好了：绑定了号主，「聊天自动化」里连着的就是号主本人 */
  const tgLinked = (t) => !!(t.owner && t.connection && t.connection.enabled && t.connection.userId === t.owner.id);

  /** 发消息要的：机器人 token，私人号再加连接 id。私人号没连好、没有回复权限时报错，不发 */
  function tgTarget(acc) {
    const token = acc.telegram?.botToken;
    if (!token) throw new Error('还没有填 Telegram 机器人的 token');
    if (acc.channel !== 'tgbiz') return { token, businessConnectionId: undefined };
    const t = tgKv(acc);
    if (!tgLinked(t)) throw new Error('Telegram 私人号还没有连上机器人（先绑定号主，再在「聊天自动化」里添加机器人），没有发送');
    if (!t.connection.canReply) throw new Error('机器人没有代你回复消息的权限：请在 Telegram 的「聊天自动化」里打开回复消息的权限');
    return { token, businessConnectionId: t.connection.id };
  }

  /** 私人号能不能删这条：经墨鸽（机器人）发的要「删除机器人发的消息」或「删除所有消息」，在 Telegram 里自己发的要「删除所有消息」 */
  function tgCanDelete(acc, r) {
    const t = tgKv(acc);
    if (!tgLinked(t)) return false;
    return r.via === 'phone' ? !!t.connection.canDeleteAll : !!(t.connection.canDelete || t.connection.canDeleteAll);
  }

  /** 私人号：标已读到客户最后一条消息（要有读消息的权限；只能是 24 小时内活跃过的聊天）。失败只记警告 */
  async function tgMarkRead(acc, chatId, ids) {
    const t = tgKv(acc);
    const last = ids[ids.length - 1];
    if (!last || !tgLinked(t) || !t.connection.canRead) return;
    try {
      await tgReadBusinessMessage(config.telegramApiUrl, acc.telegram.botToken, t.connection.id, chatId, last);
    } catch (err) {
      log.warn(`[telegram] 标已读失败（号 ${acc.id}）：${err?.message || err}`);
    }
  }

  /** 「正在输入」只显示 5 秒：开着时每 4 秒再发一次，关掉时停（没有停止接口，我方发出消息时 Telegram 自己去掉） */
  async function tgTyping(acc, chatId, on) {
    const key = conversationIdOf(acc.id, chatId);
    clearInterval(tgTypingTimers.get(key));
    tgTypingTimers.delete(key);
    if (!on) return;
    let send;
    if (acc.channel === 'tguser') {
      const c = tgUserClient(acc);
      send = () => c.sendTyping(chatId);
    } else {
      const t = tgTarget(acc);
      send = () => tgSendTyping(config.telegramApiUrl, t.token, chatId, { businessConnectionId: t.businessConnectionId });
    }
    await send();
    const timer = setInterval(() => send().catch(() => {}), TG_TYPING_REFRESH_MS);
    timer.unref?.();
    tgTypingTimers.set(key, timer);
  }

  /**
   * 号的连接状态。机器人：在收消息就是 working；token 不对、连不上 Telegram 是 failed。
   * 私人号：还没绑定号主、还没在「聊天自动化」里连上（或者连上的不是号主）是 waiting，连好了是 working；
   * 机器人没开 Business Mode、没有回复权限这些放在 error 里。telegram 里是给连接页面看的：机器人用户名、绑定链接（还没绑定时）、号主、连接
   */
  function tgStatus(acc, base) {
    if (!acc.telegram?.botToken) return base;
    const p = tgPollers.get(acc.id);
    const t = tgKv(acc);
    const isBiz = acc.channel === 'tgbiz';
    const c = t.connection;
    const byOwner = !!(t.owner && c && c.userId === t.owner.id);
    const telegram = {
      botUsername: t.botUsername || null,
      bindLink: isBiz && !t.owner && t.botUsername && t.bindCode ? `https://t.me/${t.botUsername}?start=bind_${t.bindCode}` : null,
      owner: isBiz && t.owner ? { name: t.owner.name } : null,
      connection:
        isBiz && c
          ? { enabled: c.enabled, byOwner, name: c.name, canReply: c.canReply, canRead: c.canRead, canDelete: c.canDelete || c.canDeleteAll, at: c.at }
          : null,
    };
    const out = { ...base, telegram };
    if (!p) return { ...out, state: 'stopped' };
    if (p.error) return { ...out, state: 'failed', error: p.error };
    if (!p.ready) return { ...out, state: 'starting' };
    if (!isBiz) return { ...out, state: 'working' };
    if (tgLinked(t)) {
      return { ...out, state: 'working', error: c.canReply ? null : '机器人没有代你回复消息的权限，墨鸽收得到消息但发不出去：请在 Telegram 的「聊天自动化」里打开回复消息的权限' };
    }
    let error = null;
    if (p.me && p.me.can_connect_to_business === false) {
      error = '这个机器人还没打开 Business Mode，「聊天自动化」里加不了它：在 @BotFather 里选这个机器人 → Bot Settings → Business Mode，打开';
    } else if (t.owner && c && c.enabled && !byOwner) {
      error = `在「聊天自动化」里连接这个机器人的是「${c.name || '另一个帐号'}」，不是绑定的号主「${t.owner.name || '号主'}」，墨鸽不收它的消息`;
    }
    return { ...out, state: 'waiting', error };
  }

  /**
   * 让每个填了机器人 token 的 Telegram 号都在收消息：token 改了的重新开始，删了的、清了 token 的停掉。
   * 扫码登录的号一起同步（syncTgUsers）
   */
  function syncTelegram() {
    tgSyncChain = tgSyncChain
      .then(async () => {
        if (closed) return;
        const want = new Map();
        for (const acc of accounts.list()) if (isTelegram(acc.channel) && acc.telegram?.botToken) want.set(acc.id, acc);
        for (const [id, p] of [...tgPollers]) {
          const acc = want.get(id);
          // token 不对停下了的（fatal），再保存一次号就重新试
          if (acc && acc.telegram.botToken === p.token && acc.channel === p.channel && !p.fatal) continue;
          await tgStop(id);
        }
        for (const [id, acc] of want) if (!tgPollers.has(id) && !closed) startTelegram(acc);
        await syncTgUsers();
      })
      .catch((err) => log.error(`[telegram] 同步收消息出错：${err?.stack || err}`));
    return tgSyncChain;
  }

  async function tgStop(accountId) {
    const p = tgPollers.get(accountId);
    if (!p) return;
    tgPollers.delete(accountId);
    await p.poller.stop();
    const st = accState.get(accountId);
    if (st) st.statusCache = null;
  }

  function startTelegram(acc) {
    const entry = { token: acc.telegram.botToken, channel: acc.channel, ready: false, error: null, fatal: false, me: null, poller: null };
    tgPollers.set(acc.id, entry);
    const touch = () => {
      state(acc.id).statusCache = null;
    };
    /** 号还在、token 没换时才读写 kv（停下的旧轮询可能还在收尾） */
    const live = () => {
      const a = accounts.get(acc.id);
      return a && tgPollers.get(acc.id) === entry && a.telegram?.botToken === entry.token ? a : null;
    };
    entry.poller = startTgPoller({
      apiBase: config.telegramApiUrl,
      token: entry.token,
      allowedUpdates: acc.channel === 'tgbiz' ? TG_BIZ_UPDATES : TG_BOT_UPDATES,
      timeoutSec: tgPollTimeoutSec,
      retryMs: tgRetryMs,
      loadOffset: () => {
        const a = live();
        return a ? tgKv(a).offset ?? null : null;
      },
      saveOffset: (offset) => {
        const a = live();
        if (a) tgKvUpdate(a, { offset });
      },
      onReady: (me) => {
        entry.ready = true;
        entry.error = null;
        entry.me = me;
        const a = live();
        if (a) tgKvUpdate(a, { botUsername: String(me?.username || '') });
        log.info(`[telegram] 号 ${acc.id} 开始收消息`);
        touch();
      },
      onOk: () => {
        if (!entry.error) return;
        entry.error = null;
        log.info(`[telegram] 号 ${acc.id} 恢复收消息`);
        touch();
      },
      onError: (err, fatal) => {
        const msg = err instanceof TgError ? err.message : `收消息出错：${err?.message || err}`;
        if (entry.error !== msg) log.warn(`[telegram] 号 ${acc.id} 收消息出错${fatal ? '，停下了，改了 token 后重新开始' : '，稍后重试'}：${msg}`);
        entry.error = msg;
        entry.fatal = fatal;
        touch();
      },
      onUpdate: (u) => handleTelegramUpdate(acc.id, u),
      onUpdateError: (err) => log.error(`[telegram] 处理号 ${acc.id} 的消息出错：${err?.stack || err}`),
    });
  }

  /**
   * 处理一条 update，返回处理结果（测试用）。
   * 机器人：私聊里客户发的 message、改了的 edited_message；客户停用机器人（my_chat_member）只记日志。
   * 私人号：给机器人发的 message 只认绑定口令；business_connection 记连接；business_message 是私聊里双方的消息
   * （号主发的按 fromMe，墨鸽经机器人代发的回来时带 sender_business_bot、当回声剔除）；edited_business_message 是改了的消息；
   * deleted_business_messages 是删除
   */
  async function handleTelegramUpdate(accountId, u) {
    if (closed) return 'closed';
    const acc = accounts.get(accountId);
    if (!acc || !isTelegram(acc.channel) || acc.channel === 'tguser') return 'ignored_account';
    if (!u || typeof u !== 'object') return 'ignored_event';
    const st = state(acc.id);
    st.lastWebhookAt = nowIso();
    st.statusCache = null;
    if (acc.channel === 'tgbot') {
      if (u.message) {
        if (u.message.from?.is_bot) return 'ignored_bot';
        const m = parseTelegramMessage(u.message);
        return m ? handleInbound(acc, m) : 'ignored_non_private';
      }
      if (u.edited_message) return tgEdited(acc, u.edited_message);
      if (u.my_chat_member?.chat?.type === 'private' && u.my_chat_member.new_chat_member?.status === 'kicked') {
        log.info(`[telegram] 号 ${acc.id} 有客户停用了机器人，之后发不到他了`);
        return 'blocked';
      }
      return 'ignored_event';
    }
    if (u.message) return tgBind(acc, u.message);
    if (u.business_connection) return tgConnection(acc, u.business_connection);
    if (u.business_message) {
      const msg = u.business_message;
      const t = tgKv(acc);
      if (!tgLinked(t) || msg.business_connection_id !== t.connection.id) return 'ignored_connection';
      const fromMe = msg.from?.id != null && String(msg.from.id) === t.owner.id;
      const bot = msg.sender_business_bot;
      const ours = bot?.id != null && String(bot.id) === t.botId;
      const m = parseTelegramMessage(msg, { fromMe, source: fromMe ? (ours ? 'api' : 'app') : null });
      return m ? handleInbound(acc, m) : 'ignored_non_private';
    }
    if (u.edited_business_message) {
      const t = tgKv(acc);
      if (!tgLinked(t) || u.edited_business_message.business_connection_id !== t.connection.id) return 'ignored_connection';
      return tgEdited(acc, u.edited_business_message);
    }
    if (u.deleted_business_messages) return tgDeleted(acc, u.deleted_business_messages);
    return 'ignored_event';
  }

  /**
   * 私人号的绑定：号主点开绑定链接后，机器人收到他发的 /start bind_<code>，记下号主，回一句下一步怎么做。
   * 只有还没绑定、code 对得上时才绑（绑定后 code 作废）；别人给机器人发的消息一律不理：这个机器人只给私人号代收代发
   */
  async function tgBind(acc, msg) {
    if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return 'ignored_bot_chat';
    const mm = /^\/start\s+bind_([A-Za-z0-9_-]{1,64})$/.exec(String(msg.text || '').trim());
    if (!mm) return 'ignored_bot_chat';
    const t = tgKv(acc);
    const got = Buffer.from(mm[1]);
    const want = Buffer.from(t.bindCode || '');
    if (t.owner || !want.length || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'ignored_bind';
    const owner = { id: String(msg.from.id), name: clip(tgUserName(msg.from), 100) };
    const next = tgKvUpdate(acc, { owner, bindCode: '' });
    log.info(`[telegram] 号 ${acc.id} 绑定了号主`);
    const tip = tgLinked(next)
      ? '「聊天自动化」里已经连好了，客户发给你的私聊消息会出现在墨鸽里。'
      : `下一步：打开 Telegram 的「设置 → 聊天自动化」（英文界面是 Settings → Chat Automation），添加 @${next.botUsername}，并打开回复消息的权限。`;
    try {
      await tgSendText(config.telegramApiUrl, acc.telegram.botToken, msg.chat.id, `已绑定到墨鸽。${tip}`);
    } catch (err) {
      log.warn(`[telegram] 号 ${acc.id} 回复绑定结果失败：${err?.message || err}`);
    }
    return 'bound';
  }

  /**
   * business_connection：有人在「聊天自动化」里连上、断开这个机器人，或者改了权限。号主已经连好时，别人连上来的不理（只记日志）；
   * 否则记下最近一次的：号主还没绑定就先连了的，绑定后直接生效；不是号主连的，状态里提示
   */
  function tgConnection(acc, bc) {
    const rights = bc.rights && typeof bc.rights === 'object' ? bc.rights : {};
    const connection = {
      id: String(bc.id || ''),
      userId: String(bc.user?.id ?? ''),
      name: clip(tgUserName(bc.user), 100),
      enabled: bc.is_enabled !== false,
      // 老版本 Bot API 只有 can_reply，没有 rights
      canReply: !!(rights.can_reply ?? bc.can_reply),
      canRead: !!rights.can_read_messages,
      canDelete: !!rights.can_delete_sent_messages,
      canDeleteAll: !!rights.can_delete_all_messages,
      at: nowIso(),
    };
    if (!connection.id) return 'ignored_connection';
    const t = tgKv(acc);
    if (tgLinked(t) && connection.userId !== t.owner.id) {
      log.warn(`[telegram] 号 ${acc.id}：有别的帐号在「聊天自动化」里连了这个机器人，不是绑定的号主，不理`);
      return 'ignored_connection';
    }
    tgKvUpdate(acc, { connection });
    log.info(`[telegram] 号 ${acc.id} 的「聊天自动化」连接${connection.enabled ? '已连上或改了权限' : '已断开'}`);
    return connection.enabled ? 'connected' : 'disconnected';
  }

  /**
   * deleted_business_messages：私聊里有消息被删了（Telegram 不说是谁删的，私聊里双方都能删任何一条）。
   * 客户的消息按「客户撤回」标；我方的消息，墨鸽里点过撤回的按那个成员标，其余按「已在手机上撤回」
   */
  function tgDeleted(acc, d) {
    const t = tgKv(acc);
    if (!tgLinked(t) || d.business_connection_id !== t.connection.id) return ['ignored_connection'];
    if (d.chat?.type !== 'private' || d.chat.id == null) return ['ignored_non_private'];
    const convId = conversationIdOf(acc.id, String(d.chat.id));
    const at = nowIso();
    pruneRevokeAttempts();
    return (Array.isArray(d.message_ids) ? d.message_ids : []).map((mid) =>
      tgRowDeleted(acc, db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND external_id = ?').get(convId, String(mid)), at),
    );
  }

  /** Telegram 删了一条消息：客户的按「客户撤回」标；我方的，墨鸽里点过撤回的按那个成员标，其余按「已在手机上撤回」 */
  function tgRowDeleted(acc, row, at) {
    if (!row) return 'ignored_revoke_unknown';
    if (row.revoked_at) return 'ignored_duplicate';
    if (row.direction === 'in') return customerRevoked(row, at);
    const attempt = revokeAttempts.get(`${acc.id}|${row.conversation_id}|${row.external_id}`);
    markRevoked(row.id, attempt ? 'member' : 'phone', attempt?.user ?? null, at);
    return attempt ? 'revoked_member' : 'revoked_phone';
  }

  /**
   * 业务员在墨鸽里撤回 Telegram 号发出的消息（revokeMessage 已经查过方向、状态、号）：机器人 deleteMessage，私人号 deleteBusinessMessages，
   * 扫码登录的号 messages.deleteMessages（对双方删除，没有时限）
   */
  async function revokeTelegram(acc, conv, row, user) {
    if (!row.external_id) throw badRequest('这条消息没有记下 Telegram 的消息 id，不能撤回', 'no_message_id');
    if (acc.channel === 'tgbiz' && !tgCanDelete(acc, row)) {
      throw badRequest(
        row.via === 'phone'
          ? '在 Telegram 里自己发的消息，要机器人有「删除所有消息」的权限才能撤回：请在「聊天自动化」里打开'
          : '机器人没有删除消息的权限：请在 Telegram 的「聊天自动化」里打开',
        'revoke_no_right',
      );
    }
    if (!revocableUntil(row, acc)) throw badRequest('已经超过 Telegram 允许撤回的时间（发出后 48 小时），不能再撤回', 'revoke_expired');
    if (revoking.has(row.id)) throw new HttpError(409, 'revoking', '正在撤回这条消息，请稍等');
    const who = user ? { id: user.id, name: user.name ?? '' } : null;
    const attemptKey = `${acc.id}|${conv.id}|${row.external_id}`;
    pruneRevokeAttempts();
    revokeAttempts.set(attemptKey, { user: who, at: Date.now() });
    revoking.add(row.id);
    try {
      if (acc.channel === 'tguser') {
        await tgUserClient(acc).deleteMessages(conv.chat_id, [row.external_id]);
      } else {
        const connId = acc.channel === 'tgbiz' ? tgKv(acc).connection.id : undefined;
        await tgDeleteMessage(config.telegramApiUrl, acc.telegram.botToken, conv.chat_id, row.external_id, { businessConnectionId: connId });
      }
    } catch (err) {
      // Telegram 明确报错的没撤成；连不上、超时的可能其实成了，私人号、扫码登录的号留着记录等删除通知
      if ((err instanceof TgError && err.status) || (err instanceof TgUserError && err.code)) revokeAttempts.delete(attemptKey);
      log.warn(`[telegram] 撤回消息 ${row.id} 失败（号 ${acc.id}）：${err?.message || err}`);
      if (err instanceof TgUserError && err.code === 'NOT_LOGGED_IN') throw new HttpError(409, 'not_connected', err.message);
      throw err instanceof TgError || err instanceof TgUserError ? new HttpError(502, 'telegram_error', `撤回失败：${err.message}`) : err;
    } finally {
      revoking.delete(row.id);
    }
    markRevoked(row.id, 'member', who, nowIso());
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id), accounts.get(acc.id) || acc);
  }

  /** 私人号换号主：清掉绑定，换一个新的绑定链接（连接留着，同一个人重新绑定后直接生效） */
  function telegramRebind(acc) {
    if (acc.channel !== 'tgbiz') throw badRequest('只有 Telegram 私人号要绑定号主', 'wrong_channel');
    tgKvUpdate(acc, { owner: null, bindCode: crypto.randomBytes(12).toString('base64url') });
    log.info(`[telegram] 号 ${acc.id} 清掉了绑定的号主`);
  }

  // ---------------- Telegram 扫码登录（tguser） ----------------
  // 每个号一个 mtcute 客户端（tguser.js）。有登录态文件的号在启动时、改号以后（syncTelegram）自动用登录态连上；
  // 没有的停在 logged_out，等管理员点「扫码登录」（tgUserLogin）：scan_qr（二维码 30 秒左右换一次）→ 扫了以后开了两步验证的
  // 进 password（管理员在页面上输密码，只拿来登录，不存）→ working。二维码、两步验证超过 5 分钟没完成就停下、删掉半截的登录态。
  // 登录态文件在：没登录完的、退出登录的、登录失效的都删掉，所以有文件就是登录过的。

  const tgUserFactory = opts.tgUserClientFactory ?? createMtcuteClient;
  const tgUserLoginTimeoutMs = opts.tgUserLoginTimeoutMs ?? TGU_LOGIN_TIMEOUT_MS;
  const tgUserDir = path.join(config.dataDir, 'telegram');
  const tgUserSessionPath = (accountId) => path.join(tgUserDir, `${accountId}.session`);
  const tgUserHasSession = (accountId) => fs.existsSync(tgUserSessionPath(accountId));
  /** api_id、api_hash 改了就要换客户端 */
  const tgUserKey = (acc) => `${acc.telegram?.apiId}|${acc.telegram?.apiHash}`;
  const TGU_LOST_TEXT = '墨鸽在这个 Telegram 帐号上的登录已经失效（可能在手机的「设置 → 设备」里结束了墨鸽），请重新扫码登录';
  /**
   * @type {Map<string, {
   *   key: string, client: any, state: string, me: {id:string, name:string, username:string}|null, error: string|null,
   *   qr: {url: string, expiresAt: number}|null, qrVersion: number, ac: AbortController, timer: NodeJS.Timeout|null,
   *   password: {resolve: (pw: string) => void}|null, attempt: {resolve: (r: string) => void}|null, run: Promise<void>|null,
   * }>}
   * 号 id → 扫码登录的客户端和登录状态。state：starting、scan_qr、password、working、logged_out、failed
   */
  const tgUsers = new Map();

  /** 等 p，最多等 ms 毫秒，超时时取 onTimeout() 的结果（抛错就是报错）。定时器用完就清，不挂住进程 */
  function tgUserWithin(p, ms, onTimeout) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }).then(onTimeout);
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }

  /** 删掉登录态文件（SQLite 的 -wal、-shm 一起） */
  async function tgUserWipe(accountId) {
    const p = tgUserSessionPath(accountId);
    await Promise.all(['', '-wal', '-shm', '-journal'].map((x) => fs.promises.rm(p + x, { force: true })));
  }

  /** 发消息、下载等要的客户端：没登录好时报错，不发 */
  function tgUserClient(acc) {
    const e = tgUsers.get(acc.id);
    if (e?.state === 'working' && e.client) return e.client;
    throw new TgUserError('这个 Telegram 帐号还没有登录（或者登录已经失效），请先在号的「连接」里扫码登录', { code: 'NOT_LOGGED_IN' });
  }

  /**
   * 给号起一个客户端。login=false：用存着的登录态；login=true：扫码登录（之前的登录态先删掉）
   * @param {any} acc
   * @param {{login: boolean}} o
   */
  function tgUserStart(acc, { login }) {
    const entry = {
      key: tgUserKey(acc),
      client: null,
      state: 'starting',
      me: null,
      error: null,
      qr: null,
      qrVersion: 0,
      ac: new AbortController(),
      timer: null,
      password: null,
      attempt: null,
      run: null,
    };
    tgUsers.set(acc.id, entry);
    const { signal } = entry.ac;
    const live = () => !closed && tgUsers.get(acc.id) === entry && !signal.aborted;
    const set = (patch) => {
      Object.assign(entry, patch);
      const st = accState.get(acc.id);
      if (st) st.statusCache = null;
    };
    /** 二维码、两步验证等太久就停下 */
    const armTimeout = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (!live() || (entry.state !== 'scan_qr' && entry.state !== 'password')) return;
        log.info(`[tguser] 号 ${acc.id} 的扫码登录 ${Math.round(tgUserLoginTimeoutMs / 60000)} 分钟没有完成，停下了`);
        entry.ac.abort(new TgUserError('timeout', { code: 'LOGIN_TIMEOUT' }));
      }, tgUserLoginTimeoutMs);
      entry.timer.unref?.();
    };
    /** 两步验证密码：等管理员在页面上输（tgUserPassword）；中止时一起放弃 */
    const askPassword = () =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (entry.state !== 'password') armTimeout();
        set({ state: 'password', qr: null, password: { resolve } });
      });
    const onPasswordInvalid = () => {
      entry.attempt?.resolve('invalid');
      entry.attempt = null;
    };
    // 用登录态重连时，补收停机期间的消息可能比这边切到 working 早一点到：starting 时也收
    const ready = () => live() && (entry.state === 'working' || entry.state === 'starting');
    const handlers = {
      onMessage: (p) => (ready() ? tgUserInbound(acc.id, p) : Promise.resolve('ignored_not_ready')),
      onEdit: (p) => (ready() ? tgUserEdited(acc.id, p) : 'ignored_not_ready'),
      onDelete: (ids) => (ready() ? tgUserDeleted(acc.id, ids) : ['ignored_not_ready']),
      onAuthLost: () => {
        if (!live()) return;
        log.warn(`[tguser] 号 ${acc.id} 的登录失效了，需要重新扫码`);
        set({ state: 'logged_out', error: TGU_LOST_TEXT, me: null });
        tgUserRelease(acc.id, entry, { wipe: true }).catch(() => {});
      },
    };
    const loggedIn = (me) => {
      clearTimeout(entry.timer);
      entry.attempt?.resolve('ok');
      entry.attempt = null;
      set({ state: 'working', me, error: null, qr: null, password: null });
      log.info(`[tguser] 号 ${acc.id} 已登录 Telegram`);
    };
    entry.run = (async () => {
      try {
        if (login) await tgUserWipe(acc.id);
        const hadSession = !login && tgUserHasSession(acc.id);
        // 登录态等于这个帐号的钥匙：目录只给自己（0700），文件 0600（SQLite 的 -wal、-shm 跟主文件的权限一样）
        await fs.promises.mkdir(tgUserDir, { recursive: true, mode: 0o700 });
        await fs.promises.chmod(tgUserDir, 0o700).catch(() => {});
        await (await fs.promises.open(tgUserSessionPath(acc.id), 'a', 0o600)).close();
        await fs.promises.chmod(tgUserSessionPath(acc.id), 0o600).catch(() => {});
        const client = await tgUserFactory({
          apiId: Number(acc.telegram.apiId),
          apiHash: acc.telegram.apiHash,
          storagePath: tgUserSessionPath(acc.id),
          // 第一次登录不拉以前的消息；用登录态重连时补上停机期间的
          catchUp: hadSession,
          proxyPort: config.globalProxyPort,
          log,
          logTag: `号 ${acc.id}`,
          ...handlers,
        });
        entry.client = client;
        if (!live()) return;
        if (!login) {
          const r = hadSession ? await client.restore() : null;
          if (!live()) return;
          if (!r) {
            set({ state: 'logged_out', error: hadSession ? TGU_LOST_TEXT : null });
            await tgUserRelease(acc.id, entry, { wipe: true });
            return;
          }
          if (r.needPassword) {
            loggedIn(await client.checkPassword({ password: askPassword, onPasswordInvalid, signal }));
            return;
          }
          loggedIn(r);
          return;
        }
        const me = await client.loginQr({
          onQr: (url, expiresAt) => {
            if (!live()) return;
            if (entry.state !== 'scan_qr') armTimeout();
            set({ state: 'scan_qr', qr: { url, expiresAt }, qrVersion: entry.qrVersion + 1 });
          },
          onScanned: () => {
            if (live()) set({ state: 'starting', qr: null });
          },
          password: askPassword,
          onPasswordInvalid,
          signal,
        });
        if (live()) loggedIn(me);
      } catch (err) {
        clearTimeout(entry.timer);
        entry.attempt?.resolve('failed');
        entry.attempt = null;
        const timedOut = signal.reason?.code === 'LOGIN_TIMEOUT';
        // 被 tgUserStop 停掉的不动状态（那边会收尾）；超时的、出错的：半截的登录态删掉
        if (signal.aborted && !timedOut) return;
        if (tgUsers.get(acc.id) !== entry || closed) return;
        const msg = timedOut
          ? `扫码登录 ${Math.round(tgUserLoginTimeoutMs / 60000)} 分钟没有完成，已经停下：要登录时再点「扫码登录」`
          : err instanceof TgUserError
            ? err.message
            : `连接 Telegram 出错：${err?.message || err}`;
        if (!timedOut) log.warn(`[tguser] 号 ${acc.id} ${login ? '扫码登录' : '连接'}失败：${msg}`);
        set({ state: login || err?.authLost ? 'logged_out' : 'failed', error: msg, qr: null, password: null, me: null });
        await tgUserRelease(acc.id, entry, { wipe: login || !!err?.authLost });
      }
    })();
    return entry;
  }

  /** 关掉一个客户端（号的状态留着给页面看）；wipe 时再删登录态 */
  async function tgUserRelease(accountId, entry, { wipe = false } = {}) {
    clearTimeout(entry.timer);
    const c = entry.client;
    entry.client = null;
    if (c) await c.close().catch((err) => log.warn(`[tguser] 号 ${accountId} 断开出错：${err?.message || err}`));
    if (wipe && (tgUsers.get(accountId) === entry || !tgUsers.has(accountId))) await tgUserWipe(accountId);
  }

  /** 停掉一个号的客户端（登录态留着）。正在登录的中止 */
  async function tgUserStop(accountId) {
    const entry = tgUsers.get(accountId);
    if (!entry) return;
    tgUsers.delete(accountId);
    entry.ac.abort(new Error('stopped'));
    // 中止后 run 很快结束；客户端卡住时也不一直等
    await tgUserWithin(entry.run?.catch(() => {}), 10_000, () => {});
    await tgUserRelease(accountId, entry);
    const st = accState.get(accountId);
    if (st) st.statusCache = null;
  }

  /**
   * 改号以后：删了的、清了 api_id / api_hash 的停掉；api_id / api_hash 改了的换客户端；
   * 有登录态、还没起客户端的起来（启动时也走这里）
   */
  async function syncTgUsers() {
    if (closed) return;
    const want = new Map(accounts.list().filter((a) => a.channel === 'tguser' && tgUserConfigured(a)).map((a) => [a.id, a]));
    for (const [id, e] of [...tgUsers]) {
      const acc = want.get(id);
      if (!acc || e.key !== tgUserKey(acc)) await tgUserStop(id);
    }
    for (const [id, acc] of want) if (!tgUsers.has(id) && tgUserHasSession(id) && !closed) tgUserStart(acc, { login: false });
  }

  /** 开始扫码登录（管理员点「扫码登录」）。已经在登录的原样返回；已经登录好的不重来 */
  async function tgUserLogin(acc) {
    if (acc.channel !== 'tguser') throw badRequest('这个号不是 Telegram 扫码登录', 'wrong_channel');
    if (!tgUserConfigured(acc)) throw badRequest('请先填 api_id 和 api_hash（在 my.telegram.org 申请）', 'not_configured');
    const e = tgUsers.get(acc.id);
    if (e && e.key === tgUserKey(acc) && ['starting', 'scan_qr', 'password'].includes(e.state)) return;
    if (e?.state === 'working' && e.key === tgUserKey(acc)) throw new HttpError(409, 'already_logged_in', '这个号已经登录了；要换帐号请先退出登录');
    await tgUserStop(acc.id);
    tgUserStart(acc, { login: true });
    log.info(`[tguser] 号 ${acc.id} 开始扫码登录`);
  }

  /** 扫码登录的二维码（SVG）。现在不在等扫码时 404 */
  function tgUserQr(acc) {
    const e = tgUsers.get(acc.id);
    if (acc.channel !== 'tguser' || e?.state !== 'scan_qr' || !e.qr) throw new HttpError(404, 'no_qr', '现在没有要扫的二维码');
    return renderSVG(e.qr.url, { border: 2 });
  }

  /**
   * 两步验证密码：交给正在登录的客户端，等 Telegram 的结果。密码不对 400（还停在 password，可以再输）；
   * 只拿来登录，不存、不进日志
   */
  async function tgUserPassword(acc, password) {
    if (typeof password !== 'string' || !password) throw badRequest('请输入两步验证密码');
    if (password.length > 256) throw badRequest('密码太长了');
    let e = tgUsers.get(acc.id);
    // 上一次输错后，客户端要稍等一下才会再来要密码
    for (let i = 0; i < 40 && e?.state === 'password' && !e.password; i++) {
      await sleep(50);
      e = tgUsers.get(acc.id);
    }
    if (e?.state !== 'password' || !e.password) throw new HttpError(409, 'not_waiting_password', '现在不需要输两步验证密码');
    const waiter = e.password;
    e.password = null;
    const result = new Promise((resolve) => {
      e.attempt = { resolve };
    });
    waiter.resolve(password);
    const r = await tgUserWithin(result, 60_000, () => 'timeout');
    if (r === 'invalid') throw new HttpError(400, 'wrong_password', '两步验证密码不对，请再输一次');
    if (r === 'timeout') throw new HttpError(504, 'telegram_timeout', 'Telegram 没有及时回复，请稍后看看号的状态');
    if (r === 'failed') throw new HttpError(502, 'telegram_error', tgUsers.get(acc.id)?.error || '登录失败');
  }

  /**
   * 退出登录：从 Telegram 退出（这个设备从帐号的设备列表里消失），断开，删掉登录态。正在扫码的直接停下。
   * quiet：删号时用，Telegram 那边退出失败只记日志
   */
  async function tgUserLogout(acc, { quiet = false } = {}) {
    const e = tgUsers.get(acc.id);
    if (e?.state === 'working' && e.client) {
      try {
        await tgUserWithin(e.client.logOut(), 15_000, () => {
          throw new Error('超时');
        });
      } catch (err) {
        log.warn(`[tguser] 号 ${acc.id} 从 Telegram 退出失败（本地的登录态照样删掉）：${err?.message || err}`);
        if (!quiet && !(err instanceof TgUserError && err.authLost)) {
          // 本地照样删掉，提示去手机上把这个设备结束掉
          await tgUserStop(acc.id);
          await tgUserWipe(acc.id);
          throw new HttpError(502, 'telegram_error', `墨鸽这边已经退出，但没能通知 Telegram（${err?.message || err}）：请在手机的「设置 → 设备」里结束墨鸽`);
        }
      }
    }
    await tgUserStop(acc.id);
    await tgUserWipe(acc.id);
    log.info(`[tguser] 号 ${acc.id} 退出了 Telegram 登录`);
  }

  /** 全局代理开关变了：连着的客户端重连一次（新的连接按新的设置走） */
  async function tgUserProxyChanged() {
    for (const [id, e] of [...tgUsers]) {
      if (e.state !== 'working' && e.state !== 'starting') continue;
      await tgUserStop(id);
      const acc = accounts.get(id);
      if (acc && tgUserConfigured(acc) && tgUserHasSession(id) && !closed) tgUserStart(acc, { login: false });
    }
  }

  /**
   * 号的连接状态：没填 api_id / api_hash 是 not_configured；没登录是 logged_out（error 里是为什么，比如登录失效了）；
   * 其余是 starting、scan_qr、password、working、failed。telegram 里给连接页面看：登录的是谁（名字、用户名）、二维码的版本和过期时间
   * （二维码本身只经 tgUserQr 给）
   */
  function tgUserStatus(acc, base) {
    if (!tgUserConfigured(acc)) return base;
    const e = tgUsers.get(acc.id);
    const telegram = {
      me: e?.state === 'working' && e.me ? { name: e.me.name, username: e.me.username || null } : null,
      qrVersion: e?.state === 'scan_qr' && e.qr ? e.qrVersion : null,
      qrExpiresAt: e?.state === 'scan_qr' && e.qr ? new Date(e.qr.expiresAt).toISOString() : null,
    };
    if (!e) return { ...base, state: tgUserHasSession(acc.id) ? 'starting' : 'logged_out', telegram };
    return { ...base, state: e.state, error: e.error, telegram };
  }

  /** 收到一条消息（客户发的，或者在手机等其他设备上发的） */
  async function tgUserInbound(accountId, p) {
    if (closed) return 'closed';
    const acc = accounts.get(accountId);
    if (!acc || acc.channel !== 'tguser') return 'ignored_account';
    const skip = tgUserSkip(p);
    if (skip) return skip;
    const st = state(acc.id);
    st.lastWebhookAt = nowIso();
    st.statusCache = null;
    const m = parseTelegramMessage(p, { fromMe: !!p.out, source: p.out ? 'app' : null });
    return m ? handleInbound(acc, m) : 'ignored_non_private';
  }

  function tgUserEdited(accountId, p) {
    if (closed) return 'closed';
    const acc = accounts.get(accountId);
    if (!acc || acc.channel !== 'tguser') return 'ignored_account';
    const skip = tgUserSkip(p);
    return skip || tgEdited(acc, p);
  }

  /** 删除通知只有消息 id：用户帐号的消息 id 在所有私聊里是同一个序列，按号 + 消息 id 找 */
  function tgUserDeleted(accountId, ids) {
    if (closed) return ['closed'];
    const acc = accounts.get(accountId);
    if (!acc || acc.channel !== 'tguser') return ['ignored_account'];
    const at = nowIso();
    pruneRevokeAttempts();
    const find = db.prepare(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = ? AND m.external_id = ? LIMIT 1`,
    );
    return ids.map((id) => tgRowDeleted(acc, find.get(acc.id, String(id)), at));
  }

  /** 标已读到客户最后一条消息。失败只记警告 */
  async function tgUserMarkRead(acc, chatId, ids) {
    const last = ids[ids.length - 1];
    if (!last) return;
    try {
      await tgUserClient(acc).readHistory(chatId, last);
    } catch (err) {
      log.warn(`[tguser] 标已读失败（号 ${acc.id}）：${err?.message || err}`);
    }
  }

  /** LINE 客户资料里的名字（缓存 1 小时；不是好友时为空）。取失败的不缓存，下条消息再取 */
  async function lineName(acc, userId) {
    const key = `${acc.id}|${userId}`;
    const hit = lineNames.get(key);
    if (hit && Date.now() - hit.at < LINE_NAME_CACHE_MS) return hit.name;
    try {
      const p = await lineGetProfile(config.lineApiUrl, acc.line, userId);
      const name = clip(String(p?.displayName || '').trim(), 100);
      lineNames.set(key, { name, at: Date.now() });
      return name;
    } catch (err) {
      log.warn(`[line] 取客户资料失败（号 ${acc.id}）：${err?.message || err}`);
      return '';
    }
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
    handleLineWebhook,
    handleTelegramUpdate,
    syncTelegram,
    telegramRebind,
    tgUserLogin,
    tgUserQr,
    tgUserPassword,
    tgUserLogout,
    tgUserProxyChanged,
    handleInbound,
    revokeMessage,
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
      // Telegram 号开始收消息（长轮询，不等第一批结果）
      syncTelegram();
      // inkdove 管理的 session 配置变了（比如 F12 把 webhook 事件改成 message.any、消息撤回加订 message.revoked）：已有的号把新配置 PUT 过去，
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
      const conv = getConvRow(id);
      if (!conv) throw notFound('会话不存在');
      // 号算每条消息能不能撤回（revocableUntil）用
      const acc = conv.account_id ? accounts.get(conv.account_id) : null;
      return db
        .prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 200) ORDER BY seq')
        .all(id)
        .map((r) => rowToMessage(r, acc));
    },
    /** 后台人工发送：via=admin，记下发送人 */
    async operatorSend(id, text, user) {
      const conv = getConvRow(id);
      if (!conv) throw notFound('会话不存在');
      if (typeof text !== 'string' || !text.trim()) throw badRequest('消息不能为空');
      const acc = conv.account_id ? accounts.get(conv.account_id) : null;
      if (!acc) throw badRequest('这个会话所属的号已删除，不能再发送', 'account_deleted');
      // 屏蔽词：命中了不发，400（blockword_hit），会话状态不变
      ctx.blockwords.guard(text.trim(), { source: 'operator', accountId: acc.id, conversationId: id, user });
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
      // 屏蔽词：说明文字命中了，文件也不发
      if (caption.trim()) ctx.blockwords.guard(caption.trim(), { source: 'file', accountId: acc.id, conversationId: id, user });
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
      // 撤回过的人工回复多半是说错了，不拿去改写（撤回过的消息不进模型）
      if (msg.revoked_at) throw badRequest('这条消息已经撤回了，不能存进知识库', 'message_revoked');
      const answer = String(msg.text || '').trim();
      if (!answer) throw badRequest('这条人工消息没有文字', 'empty_message');
      if (!llmConfigured(settings(), config)) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
      // 它前面的客户提问：往前找，跳过紧挨着的我方消息，取连续的客户消息（最多 3 条）；撤回过的消息当没有
      const before = db
        .prepare('SELECT author, text FROM messages WHERE conversation_id = ? AND seq < ? AND revoked_at IS NULL ORDER BY seq DESC LIMIT 30')
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
     * 当前草稿的文字作为【上一条推荐】要求换个写法，只拿同一种的：跟进时只认跟进推荐（转人工草稿回的是客户那条已经回过的消息，
     * 不能拿来"换个写法"）；不是跟进时认非跟进的推荐和转人工草稿，不认跟进推荐。
     * 成功后存进 draft 并返回；生成期间我方已经回了的照样返回、但不存。
     * 我方说的是最后一条时按跟进起草（见 suggestInput）；跟进起草期间客户又发了消息的，同样照样返回、但不存。
     * 存库时多记两项（只在库里，parseDraft 不往外给）：用了点按钮那个人的资料时记 agentUserId（负责人换成别人、这个人被停用或删除时作废），
     * 跟进时记 followUp: true（客户来了新消息就作废，见 clearFollowUpSuggestion）。
     * 用了资料的，起草期间负责人变了、又不是点按钮的那个人，或者这个人被停用、删除了，照样返回、但不存
     * （点按钮的人本来就可能不是负责人，比如管理员替业务员的会话点，负责人没变时照存）。
     * 起草前先识别客户这次的消息里还没识别的语音、图片（见 recognizeForSuggest）。
     * 不改消息的处理结果，不动防抖。
     * @returns {Promise<{draft:any}>}
     */
    async suggestReply(convId, user) {
      const conv = getConvRow(convId);
      if (!conv) throw notFound('会话不存在');
      const acc = conv.account_id ? accounts.get(conv.account_id) : null;
      if (!acc) throw badRequest('这个会话所属的号已删除', 'account_deleted');
      if (!llmConfigured(settings(), config)) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
      const win = suggestWindow(convId);
      if (!win) throw badRequest('这个会话里还没有客户消息', 'no_customer_message');
      const today = localDay();
      const usedToday = conv.llm_day === today ? conv.llm_calls : 0;
      if (usedToday + 1 > DAILY_LLM_LIMIT) {
        throw new HttpError(429, 'llm_daily_limit', `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次），明天再试`);
      }
      // 识别的模型调用也记到这个号和会话上
      await llmScope({ accountId: acc.id, conversationId: convId }, () => recognizeForSuggest(convId, win.rows, usedToday));
      // 识别期间客户把消息都撤回了之类
      const input = suggestInput(convId);
      if (!input) throw badRequest('这个会话里还没有客户消息', 'no_customer_message');
      const current = parseDraft(conv.draft);
      // 当前草稿是不是跟进推荐：followUp 只在库里，parseDraft 去掉了，读原始 JSON（老数据的推荐没有这一项，当不是跟进）
      const currentFollowUp = current?.kind === 'suggest' && safeJsonParse(conv.draft, null)?.followUp === true;
      const previous = (input.followUp ? currentFollowUp : !currentFollowUp) ? current?.text ?? '' : '';
      const assigneeBefore = conv.assignee_id ?? null;
      const info = memberAiInfo(user?.id);
      let r;
      try {
        r = await llmScope({ accountId: acc.id, conversationId: convId }, () =>
          generateSuggestion(acc, convId, input, { ...info, previous }),
        );
      } catch (err) {
        throw new HttpError(502, 'llm_error', `生成推荐回复失败：${err?.message || err}`);
      }
      const draft = { ...r.draft };
      // 草稿里写了点按钮那个人的名字、电话这些，记下是谁的（没用资料就不记）
      if (info.agentProfile) draft.agentUserId = user.id;
      if (input.followUp) draft.followUp = true;
      // 不存的两种：生成期间我方已经回了；跟进时客户又发了消息（这条跟进没看到客户的新消息）。
      // 不是跟进时客户又发的照存：推荐回的仍是客户还没回的那些消息（客户来消息只清跟进推荐），「换一条」会把新消息一起合进来
      const stale = repliedSince(convId, r.startSeq) || (input.followUp && customerSince(convId, r.startSeq));
      const now = getConvRow(convId);
      // 用了资料的：起草期间负责人换了、新负责人又不是点按钮的人（和存下之后再改派一样作废），或者这个人被停用、删除了，不存
      const assigneeNow = now?.assignee_id ?? null;
      const foreign =
        !!draft.agentUserId && ((assigneeNow !== assigneeBefore && draft.agentUserId !== assigneeNow) || memberGone(draft.agentUserId));
      if (now && !stale && foreign) {
        log.info(`[wa] 会话 ${logConv(convId)} 起草推荐回复期间换了负责人，或者点按钮的人被停用、删除了，推荐里是他的资料，不存`);
      } else if (now && !stale) {
        db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(draft), convId);
        noteDraft('记录', (d) => d.recorded(now, draft, { question: input.message, requestedBy: user }));
      }
      return { draft: parseDraft(JSON.stringify(draft)) };
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
     * 客户发来的文件提取出的文字（GET …/messages/:messageId/doc-text 用）→ {text, chars, truncated}。没有这条消息、不是这个会话的、
     * 没提取到文字的 404
     */
    docText(convId, messageId) {
      const row = db.prepare('SELECT media, doc_text FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, convId);
      if (!row || row.doc_text == null) throw notFound('这条消息没有提取到的文字');
      const extract = safeJsonParse(row.media, null)?.extract || {};
      return { text: row.doc_text, chars: row.doc_text.length, truncated: !!extract.truncated };
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

    /**
     * 关掉推荐回复 / 草稿卡片：清掉这个会话当前的草稿（suggest 和 handoff 都清）。没有草稿也照常返回。
     * filled 为 true 是「填入输入框」清的：采纳统计里不算关掉，等人工发出去再比；否则是点 × 关掉的，记关掉
     */
    clearDraft(id, { filled = false } = {}) {
      const row = getConvRow(id);
      if (!row) throw notFound('会话不存在');
      db.prepare('UPDATE conversations SET draft = NULL WHERE id = ?').run(id);
      if (row.draft && !filled) noteDraft('关掉', (d) => d.dismissed(id));
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
      // LINE 只能给加了好友的人发，手里只有手机号找不到人（创建外联时已经拦下，这里兜底）
      else if (acc.channel === 'line') throw new Error('LINE 官方帐号不能外联群发');
      else if (isTelegram(acc.channel)) throw new Error('Telegram 号不能外联群发');
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
      return timers.size === 0 && processing.size === 0 && converting.size === 0 && mediaJobs.size === 0 && docJobs.size === 0;
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
      // 正在提取文字的 worker 杀掉（留在 pending，下次启动时记为中断）
      await docs.close();
      await Promise.allSettled([...docJobs]);
      await tgSyncChain;
      await Promise.allSettled([...tgPollers.keys()].map((id) => tgStop(id)));
      await Promise.allSettled([...tgUsers.keys()].map((id) => tgUserStop(id)));
      for (const t of tgTypingTimers.values()) clearInterval(t);
      tgTypingTimers.clear();
      await relays.closeAll();
    },
  };
}
