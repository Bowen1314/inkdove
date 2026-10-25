// LINE 官方帐号（LINE Messaging API）。所有请求带 Authorization: Bearer <长期 Channel access token>。
// 回复：POST {api}/v2/bot/message/reply {replyToken, messages:[≤5]}。reply token 在收到 webhook 后 1 分钟内用、只能用一次；
//   回复不算进每月的消息额度  https://developers.line.biz/en/reference/messaging-api/#send-reply-message
// 推送：POST {api}/v2/bot/message/push {to, messages:[≤5]}。算进每月额度，用完返回 429（message 里说 monthly limit），一条都不发
//   https://developers.line.biz/en/reference/messaging-api/#send-push-message
//   两个接口成功都返回 {sentMessages:[{id, quoteToken}]}，id 是发出的消息的 id
// 客户资料：GET {api}/v2/bot/profile/{userId} → {displayName, userId, pictureUrl?, statusMessage?, language?}；
//   没加好友、拉黑了、没同意时 404  https://developers.line.biz/en/reference/messaging-api/#get-profile
// 「正在输入」：POST {api}/v2/bot/chat/loading/start {chatId, loadingSeconds: 5–60 的 5 的倍数}，只能一对一聊天，
//   我方发出消息时自动消失，没有停止接口  https://developers.line.biz/en/reference/messaging-api/#display-a-loading-indicator
// 标已读：POST {api}/v2/bot/chat/markAsRead {markAsReadToken}（token 在消息事件里，不过期）。有的帐号没有这个权限（403）
// 客户发来的图片、视频、语音、文件：GET {data}/v2/bot/message/{messageId}/content（二进制）。视频、语音还没准备好时返回 202，
//   过一会儿再取；内容过一段时间（没说多久）就删了，所以收到就下  https://developers.line.biz/en/reference/messaging-api/#get-content
// 下载文件本身用 media-download.js 的 httpGet（node:http），不用 fetch，原因见那个文件开头的注释；发消息这些小 JSON 还用 fetch。
// 没有发文件（document）的消息类型，也没有上传接口：图片只能给 LINE 一个公网 HTTPS 地址让它自己来取；没有撤回接口。
import { HttpGetError, httpGet } from './media-download.js';
import { baseMime } from './media.js';
import { readLimited, TooLargeError } from './waha.js';
import { sleep } from '../util.js';

/** status：LINE 返回的 HTTP 状态码（连不上、超时为 0）；apiMessage：LINE 错误正文里的 message */
export class LineError extends Error {
  constructor(message, { status = 0, apiMessage = '' } = {}) {
    super(message);
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

/** 推送超出每月额度（429，message 是 "You have reached your monthly limit."）。同样是 429 的频率限制不算 */
export const isLineQuotaError = (err) => err instanceof LineError && err.status === 429 && /monthly limit/i.test(err.apiMessage);
/** reply token 无效（过期、用过了）：400 "Invalid reply token" */
export const isInvalidReplyToken = (err) => err instanceof LineError && err.status === 400 && /invalid reply token/i.test(err.apiMessage);

const auth = (line) => ({ authorization: `Bearer ${line.accessToken}` });

async function lineFetch(url, line, init = {}, timeoutMs = 20_000) {
  if (!line?.accessToken) throw new LineError('LINE 官方帐号未填写 Channel access token');
  const { signal, headers, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { ...auth(line), ...(headers || {}) },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    throw new LineError(`无法连接 LINE Messaging API：${err?.cause?.code || err?.message || err}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const apiMessage = String(data?.message || '');
    const detail = Array.isArray(data?.details) && data.details[0]?.message ? `（${data.details[0].message}）` : '';
    throw new LineError(`LINE 返回 ${res.status}：${apiMessage || text.slice(0, 200)}${detail}`, { status: res.status, apiMessage });
  }
  return data;
}

const postJson = (url, line, body) =>
  lineFetch(url, line, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const sentId = (data) => {
  const id = data?.sentMessages?.[0]?.id;
  return id ? String(id) : null;
};

/**
 * 用 reply token 回复（免费，1 分钟内、只能用一次）。
 * @param {string} apiBase 默认 https://api.line.me（测试可用 INKDOVE_LINE_API_URL 覆盖）
 * @param {{accessToken:string}} line
 * @param {any[]} messages 消息对象，最多 5 个
 * @returns {Promise<string|null>} 第一个发出的消息的 id
 */
export async function lineReply(apiBase, line, replyToken, messages) {
  return sentId(await postJson(`${apiBase}/v2/bot/message/reply`, line, { replyToken, messages }));
}

/**
 * 推送（算进每月额度）。
 * @param {string} to 客户的 userId
 * @returns {Promise<string|null>}
 */
export async function linePush(apiBase, line, to, messages) {
  return sentId(await postJson(`${apiBase}/v2/bot/message/push`, line, { to, messages }));
}

/** 客户资料；不是好友、拉黑了（404）时返回 null */
export async function lineGetProfile(apiBase, line, userId, { timeoutMs = 10_000 } = {}) {
  try {
    return await lineFetch(`${apiBase}/v2/bot/profile/${encodeURIComponent(userId)}`, line, {}, timeoutMs);
  } catch (err) {
    if (err instanceof LineError && err.status === 404) return null;
    throw err;
  }
}

/** 「正在输入」动画（loadingSeconds：5–60，5 的倍数） */
export async function lineStartLoading(apiBase, line, chatId, loadingSeconds = 20) {
  await postJson(`${apiBase}/v2/bot/chat/loading/start`, line, { chatId, loadingSeconds });
}

/** 标已读（用消息事件里的 markAsReadToken） */
export async function lineMarkAsRead(apiBase, line, markAsReadToken) {
  await postJson(`${apiBase}/v2/bot/chat/markAsRead`, line, { markAsReadToken });
}

/** 下载出错转成 LineError（被中止的原样抛出） */
function downloadFail(err) {
  if (!(err instanceof HttpGetError)) return err;
  if (err.status) return new LineError(`下载媒体失败：LINE 返回 ${err.status}${err.detail ? `（${err.detail}）` : ''}`, { status: err.status });
  return new LineError(`无法连接 LINE：${err.message}`);
}

/**
 * 打开客户发来的一个文件（GET {data}/v2/bot/message/{id}/content）。返回 202（视频、语音还在准备）时等 retryDelayMs 再取，
 * 最多再取 retries 次。content-length 超过 maxBytes 时不读正文，抛 TooLargeError。
 * res 是 node:http 的 IncomingMessage（带 headers），状态码已检查过。
 * @returns {Promise<{res:import('node:http').IncomingMessage, mime:string, size:number|null}>}
 */
export async function lineOpenContent(dataBase, line, messageId, { maxBytes, timeoutMs = 60_000, signal, retries = 5, retryDelayMs = 2000 } = {}) {
  if (!line?.accessToken) throw new LineError('LINE 官方帐号未填写 Channel access token');
  const url = `${dataBase}/v2/bot/message/${encodeURIComponent(messageId)}/content`;
  for (let attempt = 0; ; attempt++) {
    let got;
    try {
      got = await httpGet(url, { headers: auth(line), timeoutMs, signal });
    } catch (err) {
      throw downloadFail(err);
    }
    if (got.status === 202) {
      got.stream.resume();
      if (attempt >= retries) throw new LineError('LINE 文件未就绪（持续返回 202），请在手机上查看');
      await sleep(retryDelayMs, signal);
      continue;
    }
    return opened(got, maxBytes);
  }
}

/**
 * 客户发来的图片、视频、语音由别的服务器托管（contentProvider.type 为 external）时，直接取 originalContentUrl（不带 token）。
 * 只取 https 地址
 */
export async function lineOpenExternal(url, { maxBytes, timeoutMs = 60_000, signal } = {}) {
  if (!/^https:\/\//i.test(String(url || ''))) throw new LineError('外部托管的媒体地址非 https，已跳过下载');
  let got;
  try {
    got = await httpGet(String(url), { timeoutMs, signal });
  } catch (err) {
    throw downloadFail(err);
  }
  return opened(got, maxBytes);
}

function opened(got, maxBytes) {
  const size = Number(got.headers['content-length']);
  const known = got.headers['content-length'] != null && Number.isFinite(size) && size >= 0;
  if (maxBytes && known && size > maxBytes) {
    got.stream.destroy();
    throw new TooLargeError(size, maxBytes);
  }
  return { res: got.stream, mime: baseMime(got.headers['content-type']), size: known ? size : null };
}

/**
 * F4：下载客户发来的语音、图片拿去识别（存盘没成功时再下一次用）。
 * @param {{id?:string, url?:string|null}} media url 是外部托管的地址
 * @returns {Promise<{buffer:Buffer, mime:string}>}
 */
export async function lineDownloadContent(dataBase, line, media, { maxBytes, retryDelayMs } = {}) {
  let o;
  try {
    o = media.url ? await lineOpenExternal(media.url, { maxBytes }) : await lineOpenContent(dataBase, line, media.id, { maxBytes, retryDelayMs });
  } catch (err) {
    // 保持和 Meta 一样的报错（LineError「文件太大（超过 xMB）」）
    if (err instanceof TooLargeError) throw new LineError(err.message);
    throw err;
  }
  const buffer = await readLimited(o.res, maxBytes);
  return { buffer, mime: o.mime };
}
