// Telegram 机器人（Telegram Bot API）。所有请求都是 POST {api}/bot<token>/<方法>，返回 {ok, result} 或
// {ok:false, error_code, description, parameters:{retry_after}}  https://core.telegram.org/bots/api#making-requests
// token 在地址里：报错、日志里不能带地址（fetch 和 httpGet 的报错本身不带地址，这里拼的中文原因也不带）。
//
// 收消息用长轮询 getUpdates（墨鸽主动去取，不需要公网地址）：同一个 token 同时只能有一个取的人，别处也在取、
// 或者这个机器人设了 webhook 时返回 409；开始轮询前先 deleteWebhook。update_id 确认过（下次 offset 比它大）就不再给。
//   https://core.telegram.org/bots/api#getupdates
// 私人号（Telegram 的「聊天自动化」，Bot API 里叫 business connection）：用户在「设置 → 聊天自动化」把机器人连到自己的号后，
// 机器人收到 business_connection（连上、断开、改权限），私聊里双方的消息是 business_message，删除是 deleted_business_messages；
// 代他发消息时带 business_connection_id。只能回 24 小时内客户发过消息的私聊（rights.can_reply）。
//   https://core.telegram.org/bots/api#businessconnection
// 发消息：文字 1–4096 字；上传图片最大 10MB、其他文件 50MB，说明文字最多 1024 字；下载客户发来的文件最大 20MB（getFile）。
// 撤回：机器人能删自己在私聊里发的消息，48 小时以内（deleteMessage）；私人号用 deleteBusinessMessages。
// 「正在输入」（sendChatAction）最多显示 5 秒，我方发出消息时消失。机器人不能把消息标成已读；私人号用 readBusinessMessage。
import { createHmac, randomBytes } from 'node:crypto';
import { HttpGetError, httpGet } from './media-download.js';
import { baseMime } from './media.js';
import { readLimited, TooLargeError } from './waha.js';

export const TG_TEXT_MAX = 4096;
export const TG_CAPTION_MAX = 1024;
export const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TG_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const TG_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** 撤回时限 48 小时（Bot API 的 deleteMessage） */
export const TG_DELETE_LIMIT_MS = 48 * 3600 * 1000;

/** status：Telegram 的 error_code（连不上、超时为 0）；description：Telegram 的原因；retryAfter：429 要等几秒 */
export class TgError extends Error {
  constructor(message, { status = 0, description = '', retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

/** token 不对（被吊销、填错）：401 Unauthorized，或者 404 Not Found（token 格式对但不存在） */
export const isTgAuthError = (err) => err instanceof TgError && (err.status === 401 || err.status === 404);
/** 同一个 token 别处也在 getUpdates，或者设了 webhook */
export const isTgConflict = (err) => err instanceof TgError && err.status === 409;

/** Bot API 的 token 形如 123456789:AAH…（数字 id、冒号、35 位左右的字母数字和 -_） */
export const TG_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
/** token 前面的数字是机器人的 user id */
export const botIdOf = (token) => (TG_TOKEN_RE.test(String(token || '')) ? String(token).split(':')[0] : '');

/** Telegram 原因 → 中文说明（常见的几种），其余原样带上 */
function explain(status, description) {
  const d = String(description || '');
  if (status === 401 || status === 404) return '机器人 token 错误或已失效，请从 @BotFather 重新复制';
  if (status === 409 && /webhook/i.test(d)) return '该机器人已设置 webhook，无法接收消息（开始接收时自动删除 webhook）';
  if (status === 409) return '该机器人 token 正被其他程序使用（同一机器人仅限一个程序接收消息）';
  if (status === 403 && /blocked/i.test(d)) return '客户已拉黑机器人，无法发送';
  if (status === 403 && /deactivated/i.test(d)) return '客户的 Telegram 帐号已注销';
  if (/BUSINESS_PEER_USAGE_MISSING|BUSINESS_PEER_INVALID/i.test(d)) return '客户 24 小时内未发送消息，Telegram 不允许机器人代为回复，请在手机上回复';
  if (/BUSINESS_CONNECTION_INVALID|business connection not found/i.test(d)) return '机器人与该私人帐号的连接已断开，请在 Telegram「设置 → 聊天自动化」中重新连接';
  if (/message can't be deleted|message to delete not found/i.test(d)) return '无法删除该消息（超过 48 小时或已删除）';
  if (/chat not found/i.test(d)) return '会话不存在（客户尚未与机器人对话）';
  return `Telegram 返回 ${status}：${d.slice(0, 200)}`;
}

function parseResponse(status, text) {
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (data?.ok === true) return data.result;
  const code = Number(data?.error_code) || status || 0;
  const description = String(data?.description || text.slice(0, 200));
  const retryAfter = Number(data?.parameters?.retry_after) || 0;
  throw new TgError(explain(code, description), { status: code, description, retryAfter });
}

/**
 * 调一个 Bot API 方法（JSON 参数）
 * @param {string} apiBase 默认 https://api.telegram.org（测试可用 INKDOVE_TELEGRAM_API_URL 覆盖）
 * @param {string} token
 * @param {string} method
 * @param {Record<string, any>} [params]
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [o]
 */
export async function tgCall(apiBase, token, method, params = {}, { timeoutMs = 20_000, signal } = {}) {
  if (!token) throw new TgError('未填写机器人 token');
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    throw new TgError(`无法连接 Telegram：${timeout.aborted ? '超时' : err?.cause?.code || err?.message || err}`);
  }
  return parseResponse(res.status, await res.text());
}

/** 上传一个文件（multipart）。fields 里的值转成字符串，对象转 JSON */
async function tgUpload(apiBase, token, method, fields, file, { timeoutMs = 120_000 } = {}) {
  if (!token) throw new TgError('未填写机器人 token');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append(file.field, new Blob([file.buffer], { type: file.mime || 'application/octet-stream' }), file.filename || 'file');
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${apiBase}/bot${token}/${method}`, { method: 'POST', body: form, signal: timeout });
  } catch (err) {
    throw new TgError(`无法连接 Telegram：${timeout.aborted ? '超时' : err?.cause?.code || err?.message || err}`);
  }
  return parseResponse(res.status, await res.text());
}

/** 机器人自己的资料 {id, username, first_name, can_connect_to_business?} */
export const tgGetMe = (apiBase, token, o) => tgCall(apiBase, token, 'getMe', {}, o);

export const tgDeleteWebhook = (apiBase, token) => tgCall(apiBase, token, 'deleteWebhook', { drop_pending_updates: false });

/** 长轮询：等最多 timeoutSec 秒，有新的 update 就返回 */
export const tgGetUpdates = (apiBase, token, { offset, timeoutSec, allowedUpdates, signal }) =>
  tgCall(
    apiBase,
    token,
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
    { timeoutMs: (timeoutSec + 15) * 1000, signal },
  );

const sentIdOf = (msg) => (msg?.message_id != null ? String(msg.message_id) : null);
/** 私人号代发时带 business_connection_id */
const biz = (businessConnectionId) => (businessConnectionId ? { business_connection_id: businessConnectionId } : {});

/** 发文字，返回消息 id */
export async function tgSendText(apiBase, token, chatId, text, { businessConnectionId } = {}) {
  return sentIdOf(await tgCall(apiBase, token, 'sendMessage', { chat_id: chatId, text, ...biz(businessConnectionId) }));
}

/**
 * 发一个文件：asPhoto 时 sendPhoto（Telegram 会压缩），否则 sendDocument（原样）。返回消息 id
 * @param {{buffer:Buffer, filename:string, mime:string}} file
 */
export async function tgSendFile(apiBase, token, chatId, file, { asPhoto = false, caption = '', businessConnectionId } = {}) {
  const field = asPhoto ? 'photo' : 'document';
  const msg = await tgUpload(
    apiBase,
    token,
    asPhoto ? 'sendPhoto' : 'sendDocument',
    { chat_id: chatId, caption, business_connection_id: businessConnectionId },
    { field, buffer: file.buffer, filename: file.filename, mime: file.mime },
  );
  return sentIdOf(msg);
}

/** 「正在输入」（最多 5 秒） */
export const tgSendTyping = (apiBase, token, chatId, { businessConnectionId } = {}) =>
  tgCall(apiBase, token, 'sendChatAction', { chat_id: chatId, action: 'typing', ...biz(businessConnectionId) }, { timeoutMs: 10_000 });

/** 撤回：机器人删自己的消息（deleteMessage），私人号删代他发的（deleteBusinessMessages） */
export async function tgDeleteMessage(apiBase, token, chatId, messageId, { businessConnectionId } = {}) {
  const id = Number(messageId);
  if (businessConnectionId) {
    await tgCall(apiBase, token, 'deleteBusinessMessages', { business_connection_id: businessConnectionId, message_ids: [id] });
  } else {
    await tgCall(apiBase, token, 'deleteMessage', { chat_id: chatId, message_id: id });
  }
}

/** 私人号：把客户的一条消息标成已读（这条之前的都算已读；聊天要在 24 小时内活跃过） */
export const tgReadBusinessMessage = (apiBase, token, businessConnectionId, chatId, messageId) =>
  tgCall(apiBase, token, 'readBusinessMessage', {
    business_connection_id: businessConnectionId,
    chat_id: Number(chatId),
    message_id: Number(messageId),
  });

/** 下载出错转成 TgError（被中止的原样抛出）。不带地址：地址里有 token */
function downloadFail(err) {
  if (!(err instanceof HttpGetError)) return err;
  if (err.status) return new TgError(`下载文件失败：Telegram 返回 ${err.status}`, { status: err.status });
  return new TgError(`无法连接 Telegram：${err.message}`);
}

/**
 * 打开客户发来的一个文件：先 getFile 换 file_path，再 GET {api}/file/bot<token>/<file_path>（地址 1 小时有效）。
 * 机器人只能下 20MB 以内的；已知大小超过 maxBytes 时不下，抛 TooLargeError。
 * @returns {Promise<{res:import('node:http').IncomingMessage, mime:string, size:number|null}>}
 */
export async function tgOpenFile(apiBase, token, fileId, { maxBytes, knownSize = null, timeoutMs = 60_000, signal } = {}) {
  const limit = Math.min(maxBytes || TG_DOWNLOAD_MAX_BYTES, TG_DOWNLOAD_MAX_BYTES);
  if (Number.isFinite(knownSize) && knownSize > limit) throw new TooLargeError(knownSize, limit);
  let info;
  try {
    info = await tgCall(apiBase, token, 'getFile', { file_id: fileId }, { signal });
  } catch (err) {
    // 超过 20MB 的：Bad Request: file is too big
    if (err instanceof TgError && /file is too big/i.test(err.description)) throw new TooLargeError(knownSize ?? NaN, TG_DOWNLOAD_MAX_BYTES);
    throw err;
  }
  if (!info?.file_path) throw new TgError('Telegram 未返回该文件的下载地址');
  let got;
  try {
    got = await httpGet(`${apiBase}/file/bot${token}/${info.file_path}`, { timeoutMs, signal });
  } catch (err) {
    throw downloadFail(err);
  }
  const size = Number(got.headers['content-length']);
  const known = got.headers['content-length'] != null && Number.isFinite(size) && size >= 0;
  if (known && size > limit) {
    got.stream.destroy();
    throw new TooLargeError(size, limit);
  }
  return { res: got.stream, mime: baseMime(got.headers['content-type']), size: known ? size : null };
}

/**
 * F4：下载客户发来的语音、图片拿去识别。
 * @param {{id:string, size?:number|null}} media
 * @returns {Promise<{buffer:Buffer, mime:string}>}
 */
export async function tgDownloadFile(apiBase, token, media, { maxBytes } = {}) {
  let o;
  try {
    o = await tgOpenFile(apiBase, token, media.id, { maxBytes, knownSize: media.size ?? null });
  } catch (err) {
    if (err instanceof TooLargeError) throw new TgError(err.message);
    throw err;
  }
  return { buffer: await readLimited(o.res, maxBytes), mime: o.mime };
}

const LOG_SALT = randomBytes(16);

/**
 * 日志里写的会话 id（<号 id>:<chat id>）：Telegram 的 chat id 就是客户的用户 id，不写进日志，换成一段带盐的摘要
 * （盐每次启动随机生成：同一次运行里同一个客户每次一样，方便对日志，又反推不出用户 id）。其他接入方式原样。
 * 放在这里而不是 service.js：notify.js、translate.js 也要用，它们被 service.js 引用，反过来引用会绕成一圈
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 */
export function convLogId(db, convId) {
  let channel;
  try {
    channel = db.prepare('SELECT channel FROM conversations WHERE id = ?').get(convId)?.channel;
  } catch {
    // 关闭时数据库已经关了：写日志的地方多在 catch 里，这里再抛错会把原来的错误盖掉
    return `${String(convId).split(':')[0]}:?`;
  }
  if (channel !== 'tgbot' && channel !== 'tgbiz' && channel !== 'tguser') return convId;
  const i = convId.indexOf(':');
  return `${convId.slice(0, i)}:tg-${createHmac('sha256', LOG_SALT).update(convId.slice(i + 1)).digest('hex').slice(0, 8)}`;
}

/** Telegram 用户的称呼：名 + 姓，没有就 @用户名 */
export function tgUserName(u) {
  if (!u || typeof u !== 'object') return '';
  const full = [u.first_name, u.last_name]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
  return full || (u.username ? `@${u.username}` : '');
}
