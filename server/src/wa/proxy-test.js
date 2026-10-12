// 代理测试（4.5）：经代理请求 ipify，拿到出口 IP。http/https 用 undici ProxyAgent，socks 用 socks-proxy-agent。
import http from 'node:http';
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

export const PROXY_TEST_URL = 'https://api.ipify.org?format=json';

const hostPart = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** 拼代理 URL（含账号密码，只在内存里用，不写日志） */
export function proxyUrl(px) {
  const auth =
    px.username || px.password ? `${encodeURIComponent(px.username || '')}:${encodeURIComponent(px.password || '')}@` : '';
  return `${px.protocol}://${auth}${hostPart(px.host)}:${px.port}`;
}

function getViaAgent(url, agent, timeoutMs) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { agent, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 100_000) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`超时（${Math.round(timeoutMs / 1000)} 秒）`)));
    req.on('error', reject);
  });
}

/**
 * @param {{protocol:string, host:string, port:number, username?:string, password?:string}} px
 * @param {{url?:string, timeoutMs?:number}} [o]
 * @returns {Promise<{ok:true, ip:string, latencyMs:number}|{ok:false, error:string}>}
 */
export async function testProxy(px, { url = PROXY_TEST_URL, timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  try {
    let body;
    if (px.protocol === 'http' || px.protocol === 'https') {
      const dispatcher = new ProxyAgent({ uri: proxyUrl(px) });
      try {
        const res = await undiciFetch(url, { dispatcher, signal: AbortSignal.timeout(timeoutMs) });
        body = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } finally {
        dispatcher.close().catch(() => {});
      }
    } else if (px.protocol === 'socks4' || px.protocol === 'socks5') {
      body = await getViaAgent(url, new SocksProxyAgent(proxyUrl(px), { timeout: timeoutMs }), timeoutMs);
    } else {
      throw new Error(`不支持的协议：${px.protocol}`);
    }
    let ip;
    try {
      ip = JSON.parse(body)?.ip;
    } catch {
      /* 下面统一报错 */
    }
    if (typeof ip !== 'string' || !ip) throw new Error('返回内容里没有 ip');
    return { ok: true, ip, latencyMs: Date.now() - started };
  } catch (err) {
    let msg = String(err?.name === 'TimeoutError' ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : err?.cause?.message || err?.message || err);
    for (const secret of [px.password, px.password && encodeURIComponent(px.password)]) {
      if (secret && secret.length >= 3) msg = msg.split(secret).join('***');
    }
    return { ok: false, error: `代理测试失败：${msg}` };
  }
}
