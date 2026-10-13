// 客户媒体（WAHA 的 /api/files/…、Meta 的媒体下载地址）用 node:http / node:https 下载，不用 fetch。
//
// 为什么不用 fetch：全局 fetch 原来走的是 npm undici 7.30 的连接——app.js 经 wa/proxy-test.js 加载了 undici 包，
// 它一加载（lib/global.js）就把自己的 Agent 设成全局 dispatcher，Node 自带的 fetch 也就用它收发。
// 现在 src/builtin-fetch.js 让全局 fetch 改回 Node 自带的连接；媒体下载照旧不用 fetch：文件大、要边下边写盘，
// 直接用 node:http 的流最简单，也不受哪个 undici 接管全局 fetch 的影响。下面是当时查到的情况：
// 它有个 bug：响应体还没被读走、解析器因为背压暂停着，这时对方关了连接（HTTP/1.0、Connection: close），socket 的 end
// 事件里 Parser.finish 的 assert(!this.paused) 失败（client-h1.js:374，经 onHttpSocketEnd），在事件回调里抛出、接不住，
// 整个进程崩掉。实测稳定复现的条件：
//   - 对方传完就关连接，16–20MB 的文件用 pipeline 边下边写（异步写盘），连续下两三次就崩；
//   - 消费方改成每块同步写盘，单路下载不崩；但几个 16–20MB 的文件同时下载时，夹在中间的几十 KB 的小图照样崩
//     （test/media.test.js 的并发回归测试：3 轮 16MB 视频 + 16MB PDF + 28KB 图片，同步写盘版 5/5 崩）。
// undici 8 修了，但要 Node ≥ 22.19（本机 Node 20），cheerio 还依赖 undici 7，所以不升级；只把媒体下载挪出 undici。
// 查 Meta 媒体信息那种小 JSON 请求还用 fetch（一次读完，不会卡在暂停状态）。
//
// 全局代理（proxy/route.js）开着时，不在直连名单里的地址经它出去（给 request 一个 createConnection）；direct=true 时总是直连。
import http from 'node:http';
import https from 'node:https';
import { createConnectionFor } from '../proxy/route.js';

/** status 为 0：连不上、超时、重定向太多；否则是对方返回的状态码，detail 是 JSON 正文里的 message / error（没有为 null） */
export class HttpGetError extends Error {
  constructor(message, { status = 0, detail = null } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** 跳到别的主机时不带这些头（WAHA 的 key、Meta 的 token） */
const SECRET_HEADERS = new Set(['authorization', 'x-api-key']);
/** 出错时最多读这么多正文找 message / error */
const ERROR_BODY_MAX = 8 * 1024;

/**
 * GET 一个地址。2xx 返回 {status, headers, stream}：stream 是 IncomingMessage（自带 headers，调用方读完或 destroy），
 * headers 是 Node 的小写响应头（content-type、content-length…）。
 * 最多跟 maxRedirects 次重定向；跳到别的主机（协议、主机名、端口任一不同）后不再带 Authorization / X-Api-Key。
 * 非 2xx：读一小段正文，只有 JSON 里有 message / error 才放进 detail，抛 HttpGetError{status, detail}。
 * timeoutMs 管整个下载（包括读正文）：没拿到响应前超时抛 HttpGetError('超时')，读正文时超时 stream 以 HttpGetError('下载超时') 出错。
 * signal 中止时抛 / 以 signal.reason 出错。direct：不经全局代理（下载机场订阅用）。
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, maxRedirects?: number, direct?: boolean}} [o]
 * @returns {Promise<{status:number, headers:import('node:http').IncomingHttpHeaders, stream:import('node:http').IncomingMessage}>}
 */
export async function httpGet(url, { headers = {}, timeoutMs = 60_000, signal, maxRedirects = 3, direct = false } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let current = new URL(url);
  let reqHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, reqHeaders, abort, timeout, direct);
    const status = res.statusCode || 0;
    if (REDIRECTS.has(status) && res.headers.location) {
      res.resume(); // 正文不要，读掉放掉连接
      if (hop >= maxRedirects) throw new HttpGetError('重定向次数太多');
      const next = new URL(res.headers.location, current);
      if (next.origin !== current.origin) {
        reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => !SECRET_HEADERS.has(k)));
      }
      current = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      const detail = await errorDetail(res);
      throw new HttpGetError(`对方返回 ${status}`, { status, detail });
    }
    return { status, headers: res.headers, stream: res };
  }
}

/** 发一次 GET，拿到响应头就返回 IncomingMessage；abort 时连同响应一起销毁 */
function requestOnce(u, headers, abort, timeout, direct) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new HttpGetError(`不支持的地址：${u.protocol}`));
    const reason = (got) => (timeout.aborted ? new HttpGetError(got ? '下载超时' : '超时') : abort.reason);
    if (abort.aborted) return reject(reason(false));
    let res = null;
    let req = null;
    const onAbort = () => {
      const err = reason(!!res);
      // 先销毁响应：读正文的一方拿到的是这里的原因，不是笼统的 aborted
      if (res) res.destroy(err);
      req.destroy(err);
    };
    const cleanup = () => abort.removeEventListener('abort', onAbort);
    abort.addEventListener('abort', onAbort, { once: true });
    // 每一跳重定向都重新判断走不走代理
    const createConnection = direct ? null : createConnectionFor(u);
    req = mod.get(u, createConnection ? { headers, createConnection } : { headers }, (r) => {
      res = r;
      // 还没人读的时候出错（超时、对方断开）不能让进程崩；之后读它的 pipeline / for await 照样拿得到错误
      r.on('error', () => {});
      r.once('close', cleanup);
      resolve(r);
    });
    req.on('error', (err) => {
      cleanup();
      if (res) return; // 拿到响应以后的错误由响应流自己报
      reject(err instanceof HttpGetError || err === abort.reason ? err : new HttpGetError(err?.code || err?.message || String(err)));
    });
    req.once('close', () => {
      if (!res) cleanup();
    });
  });
}

/** 出错响应：读最多 ERROR_BODY_MAX 字节，是 JSON 且有 message / error 才返回（对象转成 JSON 字符串） */
async function errorDetail(res) {
  const chunks = [];
  let n = 0;
  try {
    for await (const c of res) {
      chunks.push(c);
      n += c.length;
      if (n >= ERROR_BODY_MAX) break;
    }
  } catch {
    /* 读不到就不带 */
  }
  res.destroy();
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
  const msg = data && typeof data === 'object' ? data.message || data.error : null;
  if (!msg) return null;
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
}
