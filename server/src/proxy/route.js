// 全局代理的出口：开了全局代理后，墨鸽自己连外网的请求经 mihomo 的混合端口（127.0.0.1，本机免密）出去，
// 内网、本机、WAHA 这些地址照旧直连（bypass.js）。
//
// 全局 fetch（调模型、向量、翻译、Resend、检查更新、Meta、网址抓取）：换掉全局 dispatcher。
//   全局 fetch 故意用 Node 自带的 undici（builtin-fetch.js：npm 里的 undici 7.30 有会让进程崩掉的 bug），
//   所以这里不能用 npm undici 的 ProxyAgent，也不 import 它的任何类来收发。做法：
//   - 直连的请求交给原来那个 Node 自带的 Agent（builtin-fetch.js 抢先占住的那个，原样不动）；
//   - 走代理的请求交给用同一个类（原 Agent 的 constructor，也是 Node 自带的）新建的 Agent，只换掉它的 connect：
//     自己连 127.0.0.1:<混合端口>、发 CONNECT（域名不在本地解析，交给节点）、https 再在隧道里做 TLS；
//   - 按请求的主机名二选一的是一个只有 dispatch 的小对象（Node 自带的 fetch 只调 dispatcher.dispatch）。
//   关掉全局代理时把原来的 Agent 原样放回去。
// node:http 的请求（客户媒体下载）：给 createConnection，用同一个隧道函数。
// SMTP：nodemailer 自带的 HTTP 代理支持（proxy: http://127.0.0.1:<端口>）。
//
// 开着时 mihomo 还没启动好或者挂了：请求失败，不退回直连（不然服务器的 IP 和请求会绕过所选节点出去）。
// 全局 dispatcher 是整个进程共用的，这里也按进程只有一份。
import { builtinDispatcher } from '../builtin-fetch.js';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { Agent as NpmUndiciAgent } from 'undici';

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const CONNECT_TIMEOUT_MS = 15_000;
const READY_WAIT_MS = 15_000;
const MAX_HEADER = 16_384;

/**
 * @type {null | {
 *   port: number, isDirect: (host:string) => boolean, waitReady: () => Promise<void>,
 *   proxied: any, router: any,
 * }}
 */
let active = null;

const hostPart = (h) => (net.isIPv6(h) ? `[${h}]` : h);
const unbracket = (h) => String(h || '').replace(/^\[(.*)\]$/, '$1');

export class ProxyConnectError extends Error {}

/**
 * 经全局代理建立到 host:port 的连接；tls=true 时在隧道里做 TLS（校验证书，SNI 用 servername 或主机名）。
 * @param {{host:string, port:number, tls?:boolean, servername?:string, alpn?: string[], timeoutMs?:number}} t
 * @returns {Promise<net.Socket|tls.TLSSocket>}
 */
export async function connectViaProxy(t) {
  const a = active;
  if (!a) throw new ProxyConnectError('全局代理没有开启');
  await a.waitReady();
  const host = unbracket(t.host);
  const target = `${hostPart(host)}:${t.port}`;
  const sock = await new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: a.port });
    const timer = setTimeout(() => fail(new ProxyConnectError(`经全局代理连 ${target} 超时`)), t.timeoutMs ?? CONNECT_TIMEOUT_MS);
    let buf = Buffer.alloc(0);
    function fail(err) {
      clearTimeout(timer);
      s.off('data', onData);
      s.destroy();
      reject(err);
    }
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEADER) fail(new ProxyConnectError('全局代理的响应头过长'));
        return;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1]);
      if (status !== 200) return fail(new ProxyConnectError(`全局代理拒绝连接 ${target}（HTTP ${status || '?'}）`));
      clearTimeout(timer);
      s.off('data', onData);
      s.off('error', onError);
      s.off('close', onClose);
      const rest = buf.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    }
    const onError = (err) => fail(new ProxyConnectError(`连不上全局代理（mihomo）：${err?.code || err?.message || err}`));
    const onClose = () => fail(new ProxyConnectError(`全局代理在建立到 ${target} 的连接前断开了`));
    s.once('connect', () => {
      s.setNoDelay(true);
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    s.on('data', onData);
    s.once('error', onError);
    s.once('close', onClose);
  });
  if (!t.tls) return sock;
  // mihomo 先回 200 再去连目标：节点连不上时，表现为 TLS 握手前隧道被关掉
  return new Promise((resolve, reject) => {
    const servername = t.servername || (net.isIP(host) ? undefined : host);
    const ts = tls.connect({ socket: sock, servername, ALPNProtocols: t.alpn || ['http/1.1'] });
    const timer = setTimeout(() => ts.destroy(new ProxyConnectError(`经全局代理和 ${target} 握手超时`)), t.timeoutMs ?? CONNECT_TIMEOUT_MS);
    ts.once('secureConnect', () => {
      clearTimeout(timer);
      ts.off('error', onError);
      resolve(ts);
    });
    const onError = (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(
        err instanceof ProxyConnectError || err?.code?.startsWith?.('ERR_TLS') || /certificate|self.signed/i.test(err?.message || '')
          ? err
          : new ProxyConnectError(`经全局代理连 ${target} 失败（节点连不上目标，或者节点不可用）：${err?.code || err?.message || err}`),
      );
    };
    ts.once('error', onError);
  });
}

/** Node 自带 undici 的 connect 接口：(opts, callback) */
function undiciConnect(opts, cb) {
  const https = opts.protocol === 'https:';
  connectViaProxy({
    host: opts.hostname,
    port: Number(opts.port) || (https ? 443 : 80),
    tls: https,
    servername: opts.servername || undefined,
  }).then(
    (s) => {
      s.setKeepAlive?.(true, 60_000);
      cb(null, s);
    },
    (err) => cb(err),
  );
}

const hostOf = (origin) => {
  try {
    return unbracket(new URL(String(origin)).hostname);
  } catch {
    return '';
  }
};

/** 按主机名在直连和代理两个 Agent 之间选。Node 自带的 fetch 只用到 dispatch（和可选的 isMockActive） */
class RoutingDispatcher extends EventEmitter {
  constructor(direct, proxied, isDirect) {
    super();
    this.direct = direct;
    this.proxied = proxied;
    this.isDirect = isDirect;
  }
  dispatch(opts, handler) {
    return (this.isDirect(hostOf(opts.origin)) ? this.direct : this.proxied).dispatch(opts, handler);
  }
  // 原来的 Agent 是进程共用的，只关自己建的那个
  close(...args) {
    return this.proxied.close(...args);
  }
  destroy(...args) {
    return this.proxied.destroy(...args);
  }
}

/**
 * 打开全局代理的路由（换掉全局 dispatcher）。重复调用会换成新的端口和规则。
 * @param {{port: number, isDirect: (host:string) => boolean, waitReady?: () => Promise<void>}} o
 *   waitReady：mihomo 启动好之前，走代理的连接先等它（最多 15 秒），出错时抛出原因
 */
export function enableRouting(o) {
  const direct = builtinDispatcher;
  // 防御：全局 dispatcher 必须是 Node 自带的那个（builtin-fetch.js），不是 npm undici 的
  if (!direct || typeof direct.dispatch !== 'function' || direct instanceof NpmUndiciAgent) {
    throw new Error('全局 fetch 的连接不是 Node 自带的 undici，不能开启全局代理（见 builtin-fetch.js）');
  }
  const BuiltinAgent = direct.constructor;
  const previous = active;
  const proxied = new BuiltinAgent({ connect: undiciConnect });
  const isDirect = (h) => {
    try {
      return o.isDirect(h);
    } catch {
      return false;
    }
  };
  const waitReady = o.waitReady
    ? async () => {
        let timer;
        try {
          return await Promise.race([
            o.waitReady(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new ProxyConnectError('全局代理还没启动好，请稍后再试')), READY_WAIT_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    : () => Promise.resolve();
  const router = new RoutingDispatcher(direct, proxied, isDirect);
  active = { port: o.port, isDirect, waitReady, proxied, router };
  globalThis[GLOBAL_DISPATCHER] = router;
  // 旧的那个 Agent 上可能还有正在进行的请求：让它们自然结束再关
  previous?.proxied.close().catch(() => {});
}

/** 关掉全局代理的路由：把原来那个 Node 自带的 Agent 放回去 */
export async function disableRouting() {
  const a = active;
  active = null;
  if (builtinDispatcher) globalThis[GLOBAL_DISPATCHER] = builtinDispatcher;
  if (a) await a.proxied.destroy().catch(() => {});
}

export const routingActive = () => !!active;

/** 这个主机名现在走不走代理（全局代理关着时都不走） */
export const viaProxy = (host) => !!active && !active.isDirect(unbracket(host));

/** 走代理时用的那个 Agent（测试代理时显式用它，不看规则） */
export const proxiedDispatcher = () => active?.proxied || null;

/**
 * node:http / node:https 的请求要不要经代理：要的话返回给 request 选项用的 createConnection，否则 null（照旧直连）。
 * @param {URL} u
 */
export function createConnectionFor(u) {
  const host = unbracket(u.hostname);
  if (!viaProxy(host)) return null;
  const https = u.protocol === 'https:';
  const port = Number(u.port) || (https ? 443 : 80);
  return (_opts, cb) => {
    connectViaProxy({ host, port, tls: https }).then(
      (s) => cb(null, s),
      (err) => cb(err),
    );
  };
}

/** SMTP 要不要经代理：要的话返回给 nodemailer 的 proxy 地址（本机免密），否则 null */
export function smtpProxyFor(host) {
  if (!viaProxy(host)) return null;
  return `http://127.0.0.1:${active.port}`;
}
