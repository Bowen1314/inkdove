// 翻译接口（设置里「翻译方式」选「翻译 API」时用，见 docs/features.md 的「一键翻译」）的公共部分：
// 错误类型、发请求（10 秒超时）、按 HTTP 状态分类、抹掉密钥、只露出协议和主机的地址。
// 每家服务一个文件（deepl.js、azure.js ……），都只用这里的 request 发请求，信息里一律不带密钥和带密钥的地址路径。
import { CONNECT_ERRORS, providerMessage } from '../ai/models.js';

/** 每次请求最多等多久 */
export const TRANSLATE_TIMEOUT_MS = 10_000;
/** 错误信息里对方原话最多留多少字 */
const DETAIL_MAX_CHARS = 160;

/**
 * 翻译接口的错误。kind：
 * - config：没配好（缺密钥、地址格式不对），没发请求；
 * - network：连不上；timeout：超时；
 * - auth：密钥不对、没开通、没权限；
 * - quota：额度用完、欠费；rate_limit：请求太频繁；
 * - unsupported_language：这家服务不支持这个语言；
 * - bad_request：对方说请求不对（比如太长）；server：对方出错（5xx）；
 * - bad_response：返回的不是预期的格式。
 */
export class TranslateError extends Error {
  /**
   * @param {string} message 中文，可以直接给人看（已经抹掉密钥）
   * @param {string} kind
   * @param {{status?:number}} [o]
   */
  constructor(message, kind, { status = 0 } = {}) {
    super(message);
    this.name = 'TranslateError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * 地址只露出协议和主机（带端口），路径、查询串、用户名密码都不露。路径不是空的用 /*** 表示。
 * 解析不了返回空串。
 * @param {string} url
 */
export function maskUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';
  const hidden = (u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password;
  return hidden ? `${u.origin}/***` : u.origin;
}

/**
 * 把文字里出现的密钥（原样、URL 编码后的）换成 ***。secretUrls 里的地址：整个地址、去掉末尾斜杠的地址、路径部分都换掉。
 * @param {unknown} text
 * @param {{secrets?: string[], secretUrls?: string[]}} o
 */
export function redact(text, { secrets = [], secretUrls = [] } = {}) {
  let s = String(text ?? '');
  const parts = new Set();
  for (const k of secrets) {
    if (typeof k !== 'string' || k.length < 3) continue;
    parts.add(k);
    parts.add(encodeURIComponent(k));
  }
  for (const raw of secretUrls) {
    const v = String(raw || '').trim();
    if (!v) continue;
    parts.add(v);
    parts.add(v.replace(/\/+$/, ''));
    try {
      const u = new URL(v);
      const p = u.pathname.replace(/\/+$/, '');
      // 路径里的每一段（比如公共 DeepLX 地址里的令牌）也单独抹，免得对方只回显了其中一段
      if (p && p !== '/') {
        parts.add(p);
        for (const seg of p.split('/')) if (seg.length >= 6) parts.add(seg);
      }
      if (u.search) parts.add(u.search.slice(1));
      if (u.username) parts.add(u.username);
      if (u.password) parts.add(u.password);
    } catch {
      /* 不是合法地址：上面已经按原样抹过 */
    }
  }
  // 长的先换，免得短的把长的切碎后长的就找不到了
  for (const p of [...parts].filter((x) => x && x.length >= 3).sort((a, b) => b.length - a.length)) s = s.split(p).join('***');
  return s;
}

/** 密钥只能是可见 ASCII，否则 fetch 拼请求头时会报错，而且报错信息里带着密钥 */
export const visibleAscii = (v) => /^[\x21-\x7e]+$/.test(v);

/**
 * 发一次请求（不重试），返回状态码、响应头和解析好的 JSON（不是 JSON 时 data 为 undefined）。
 * 连不上、超时抛 TranslateError；HTTP 错误码不抛，由各家按自己的格式分类。
 * @param {{
 *   label: string,
 *   url: string,
 *   method?: string,
 *   headers?: Record<string,string>,
 *   body?: string,
 *   timeoutMs?: number,
 *   redactOpts?: {secrets?: string[], secretUrls?: string[]},
 *   onAttempt?: () => void,
 * }} p onAttempt：真的要发请求时调（调用记录只记发出去了的）
 * @returns {Promise<{status:number, ok:boolean, statusText:string, headers:Headers, text:string, data:any}>}
 */
export async function request({ label, url, method = 'POST', headers = {}, body, timeoutMs = TRANSLATE_TIMEOUT_MS, redactOpts = {}, onAttempt }) {
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('protocol');
  } catch {
    throw new TranslateError(`${label} 的地址格式不对，要以 http:// 或 https:// 开头`, 'config');
  }
  onAttempt?.();
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  let text;
  try {
    // 不跟随重定向：密钥在请求头里，不能被带到别的地方去
    res = await fetch(url, { method, headers, body, signal: timeout, redirect: 'manual' });
    text = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError' || timeout.aborted) {
      throw new TranslateError(`${label} 请求超时（${Number((timeoutMs / 1000).toFixed(1))} 秒）`, 'timeout');
    }
    const code = err?.cause?.code || err?.code || '';
    const reason = CONNECT_ERRORS[code] ? `${CONNECT_ERRORS[code]}（${code}）` : code || err?.cause?.message || err?.message || String(err);
    throw new TranslateError(`连不上 ${label}：${redact(reason, redactOpts)}`, 'network');
  }
  if (res.status >= 300 && res.status < 400) {
    throw new TranslateError(`${label} 的地址被重定向到别处了（${res.status}），请直接填写最终的地址（比如 https:// 开头的）`, 'config', {
      status: res.status,
    });
  }
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: res.status, ok: res.ok, statusText: res.statusText, headers: res.headers, text, data };
}

/**
 * 对方的原话（抹掉密钥、压成一行、截短），用在错误信息里。
 * @param {string} raw
 * @param {{secrets?: string[], secretUrls?: string[]}} redactOpts
 */
export function detailOf(raw, redactOpts) {
  const s = redact(String(raw ?? ''), redactOpts).replace(/\s+/g, ' ').trim();
  return s.length > DETAIL_MAX_CHARS ? `${s.slice(0, DETAIL_MAX_CHARS)}…` : s;
}

/**
 * 按 HTTP 状态码分类的通用错误（各家先按自己的错误码判断，判断不了的再交给这里）。
 * @param {string} label
 * @param {{status:number, text:string, statusText:string}} res
 * @param {{secrets?: string[], secretUrls?: string[]}} redactOpts
 * @param {string} [message] 对方的原话；不给就从响应体里找
 */
export function httpError(label, res, redactOpts, message) {
  const { status } = res;
  const detail = detailOf(message ?? providerMessage(res.text, res.statusText), redactOpts);
  const tail = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) return new TranslateError(`${label} 鉴权失败（${status}）${tail}。请检查密钥，或这个服务有没有开通`, 'auth', { status });
  if (status === 404) return new TranslateError(`${label} 返回 404${tail}。请检查接口地址`, 'config', { status });
  if (status === 429) return new TranslateError(`${label} 请求太频繁，被限流了（429）${tail}`, 'rate_limit', { status });
  if (status === 408 || status >= 500) return new TranslateError(`${label} 出错了（${status}）${tail}`, 'server', { status });
  return new TranslateError(`${label} 返回 ${status}${tail}`, 'bad_request', { status });
}

/** 返回格式不对 */
export const badResponse = (label, what) => new TranslateError(`${label} 返回的结果格式不对（${what}）`, 'bad_response');

/** 地址末尾去掉斜杠 */
export const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');
