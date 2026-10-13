// F13 代理协议转换中继。WAHA 的 GOWS 引擎只会走 HTTP 代理（CONNECT），
// 上游是 https / socks4 / socks5 时，inkdove 为这个号起一个本地 HTTP CONNECT 中继，WAHA 连中继，中继再按上游协议连出去。
// - 只放行 CONNECT，其他方法 405；
// - 必须带正确的 Proxy-Authorization（每个号随机生成的账号密码），否则 407；
// - https 上游：先 TLS 连上代理本身，再发 CONNECT；socks4/socks5 上游：用 socks 包建立连接。
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { SocksClient } from 'socks';
import { safeEqual } from '../util.js';

const CONNECT_TIMEOUT_MS = 15_000;

const hostPart = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** 解析 CONNECT 的目标 host:port（支持 [ipv6]:port） */
export function parseTarget(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) || /^([^:]+):(\d+)$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/** 经 https 代理建立到目标的隧道 */
function connectViaHttps(up, target) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: up.host, port: up.port, servername: net.isIP(up.host) ? undefined : up.host });
    const timer = setTimeout(() => sock.destroy(new Error('连接上游代理超时')), CONNECT_TIMEOUT_MS);
    const fail = (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    sock.once('error', fail);
    sock.once('secureConnect', () => {
      const auth =
        up.username || up.password
          ? `Proxy-Authorization: Basic ${Buffer.from(`${up.username || ''}:${up.password || ''}`).toString('base64')}\r\n`
          : '';
      const t = `${hostPart(target.host)}:${target.port}`;
      sock.write(`CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n${auth}\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 16_384) fail(new Error('上游代理的响应头过长'));
          return;
        }
        sock.off('data', onData);
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1]);
        if (status !== 200) return fail(new Error(`上游代理拒绝 CONNECT（HTTP ${status || '?'}）`));
        clearTimeout(timer);
        sock.off('error', fail);
        const rest = buf.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

/** 经 socks4/socks5 代理建立到目标的连接 */
async function connectViaSocks(up, target) {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: up.host,
      port: up.port,
      type: up.protocol === 'socks4' ? 4 : 5,
      userId: up.username || undefined,
      password: up.password || undefined,
    },
    command: 'connect',
    destination: { host: target.host, port: target.port },
    timeout: CONNECT_TIMEOUT_MS,
  });
  return socket;
}

/**
 * 起一个中继。
 * @param {{port:number, bindHost:string, username:string, password:string,
 *          upstream:{protocol:string, host:string, port:number, username?:string, password?:string}, log:any, label?:string}} o
 * @returns {Promise<{server: http.Server, port:number, close: () => Promise<void>}>}
 */
export async function startRelay(o) {
  const expected = `Basic ${Buffer.from(`${o.username}:${o.password}`).toString('base64')}`;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405, { allow: 'CONNECT', 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end('Method Not Allowed');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const deny = (line, extra = '') => client.end(`HTTP/1.1 ${line}\r\n${extra}Connection: close\r\n\r\n`);
    const got = String(req.headers['proxy-authorization'] || '');
    if (!got || !safeEqual(got, expected)) return deny('407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="inkdove"\r\n');
    const target = parseTarget(String(req.url || ''));
    if (!target) return deny('400 Bad Request');
    let upstream;
    try {
      upstream = o.upstream.protocol === 'https' ? await connectViaHttps(o.upstream, target) : await connectViaSocks(o.upstream, target);
    } catch (err) {
      o.log.warn(`[relay] ${o.label || ''} 连上游失败：${err?.message || err}`);
      return deny('502 Bad Gateway');
    }
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.bindHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** 这个号要不要中继：启用了自己的代理（不是「用全局代理」）且协议不是 http */
export const needsRelay = (acc) => {
  const px = acc?.waha?.proxy;
  return !!(acc?.channel === 'waha' && px?.enabled && !px.useGlobal && px.host && px.port && px.protocol !== 'http');
};

/**
 * 管理每个号的中继：配置变了就重启，号删了就关掉。
 * @param {{bindHost:string, log:any}} o
 */
export function createRelayManager(o) {
  /** @type {Map<string, {relay: Awaited<ReturnType<typeof startRelay>>, fingerprint: string}>} */
  const relays = new Map();
  /** @type {Map<string, string>} 号 → 最近一次启动失败的原因 */
  const errors = new Map();

  async function stop(accountId) {
    const r = relays.get(accountId);
    relays.delete(accountId);
    if (r) await r.relay.close();
  }

  return {
    /** 按号的当前配置确保中继状态正确；返回 'started' | 'restarted' | 'unchanged' | 'stopped' | 'none' | 'failed' */
    async ensure(acc) {
      if (!needsRelay(acc) || !acc.relay) {
        const had = relays.has(acc.id);
        await stop(acc.id);
        errors.delete(acc.id);
        return had ? 'stopped' : 'none';
      }
      const px = acc.waha.proxy;
      const fingerprint = JSON.stringify([px, acc.relay]);
      const cur = relays.get(acc.id);
      if (cur && cur.fingerprint === fingerprint) return 'unchanged';
      if (cur) await stop(acc.id);
      try {
        const relay = await startRelay({
          port: acc.relay.port,
          bindHost: o.bindHost,
          username: acc.relay.username,
          password: acc.relay.password,
          upstream: { protocol: px.protocol, host: px.host, port: px.port, username: px.username, password: px.password },
          log: o.log,
          label: acc.id,
        });
        relays.set(acc.id, { relay, fingerprint });
        errors.delete(acc.id);
        o.log.info(`[relay] 号 ${acc.id} 的代理中继已${cur ? '重启' : '启动'}，端口 ${relay.port}，上游 ${px.protocol}`);
        return cur ? 'restarted' : 'started';
      } catch (err) {
        const msg = err?.code === 'EADDRINUSE' ? `端口 ${acc.relay.port} 被占用` : String(err?.message || err);
        errors.set(acc.id, `代理中继启动失败：${msg}`);
        o.log.error(`[relay] 号 ${acc.id} 的代理中继启动失败：${msg}`);
        return 'failed';
      }
    },
    stop,
    error: (accountId) => errors.get(accountId) || null,
    get: (accountId) => relays.get(accountId)?.relay || null,
    async closeAll() {
      await Promise.all([...relays.keys()].map(stop));
    },
  };
}
