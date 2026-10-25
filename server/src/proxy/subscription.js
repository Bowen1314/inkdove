// 全局代理：下载机场的订阅。
// - 总是直连（不经全局代理）：节点坏了也要能更新订阅把它换掉；
// - User-Agent 用 Clash 的，机场看到它才返回 Clash 格式（不然多半给 base64 的节点链接列表）；
// - 有超时和大小上限；
// - 订阅地址里通常带着机场账号的 token，是密钥：错误信息里不带地址（主机名、路径、参数都不带），只说哪一步出了什么错。
import { httpGet, HttpGetError } from '../wa/media-download.js';
import { ClashFormatError, NOT_CLASH_HINT, parseClashConfig } from './clash.js';

export const SUBSCRIPTION_TIMEOUT_MS = 30_000;
export const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;
export const SUBSCRIPTION_UA = 'clash.meta';

export class SubscriptionError extends Error {}

/** 把一段文字里的订阅地址和它的各个部分抹掉（兜底：下面的信息本来就不带地址） */
export function redactUrl(text, url) {
  let s = String(text ?? '');
  let u = null;
  try {
    u = new URL(url);
  } catch {
    /* 不是合法地址：只抹整串 */
  }
  const parts = [url, u?.href, u?.host, u?.hostname, u?.pathname !== '/' ? u?.pathname : '', u?.search, ...(u ? [...u.searchParams.values()] : [])];
  for (const p of parts.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(p).join('***');
  return s;
}

/** 内容不对时给人看的说明；不是 Clash 配置时，订阅的后面带上「请换成机场给的 Clash 订阅链接」 */
export function clashErrorMessage(err, { pasted = false } = {}) {
  if (pasted) return `粘贴的配置无效：${err.message}${err.notClash ? '。请粘贴 Clash 格式的配置（YAML，需包含 proxies）' : ''}`;
  return `订阅内容无效：${err.message}${err.notClash ? `。${NOT_CLASH_HINT}` : ''}`;
}

/**
 * 下载订阅并取出节点。
 * @param {string} url
 * @param {{timeoutMs?: number, maxBytes?: number, signal?: AbortSignal}} [o]
 * @returns {Promise<{proxies: object[], skipped: number}>}
 * @throws {SubscriptionError} 信息可以直接给用户看，不带订阅地址
 */
export async function fetchSubscription(url, { timeoutMs = SUBSCRIPTION_TIMEOUT_MS, maxBytes = MAX_SUBSCRIPTION_BYTES, signal } = {}) {
  let text;
  try {
    const { headers, stream } = await httpGet(url, {
      headers: { 'user-agent': SUBSCRIPTION_UA, accept: '*/*' },
      timeoutMs,
      signal,
      maxRedirects: 5,
      direct: true,
    });
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      stream.destroy();
      throw new SubscriptionError(`订阅内容过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    const chunks = [];
    let n = 0;
    for await (const c of stream) {
      n += c.length;
      if (n > maxBytes) {
        stream.destroy();
        throw new SubscriptionError(`订阅内容过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
      }
      chunks.push(c);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    if (err instanceof SubscriptionError) throw err;
    if (err instanceof HttpGetError) {
      const why = err.status ? `机场返回 HTTP ${err.status}` : /超时/.test(err.message) ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : err.message;
      throw new SubscriptionError(redactUrl(`下载订阅失败：${why}`, url));
    }
    if (signal?.aborted) throw new SubscriptionError('下载订阅已中止');
    throw new SubscriptionError(redactUrl(`下载订阅失败：${err?.code || err?.message || err}`, url));
  }
  try {
    return parseClashConfig(text);
  } catch (err) {
    if (err instanceof ClashFormatError) throw new SubscriptionError(clashErrorMessage(err));
    throw err;
  }
}
