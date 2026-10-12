import dns from 'node:dns';
import net from 'node:net';
import { HttpError } from '../util.js';
import { detectKind, htmlToText, parseBuffer } from './parse.js';

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

/** 展开 IPv6 为 8 组 16 位整数 */
function expandIpv6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  // 末尾是点分 IPv4
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const parts = m[1].split('.').map(Number);
    s = s.slice(0, -m[1].length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
}

/**
 * 是否为内网、回环、链路本地等不允许访问的地址。
 * @param {string} ip
 */
export function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const g = expandIpv6(ip);
    // IPv4 映射 (::ffff:a.b.c.d) 和 IPv4 兼容 (::a.b.c.d)
    const isMapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
    if (isMapped && (g[6] || g[7] || g[5] === 0xffff)) {
      const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
      if (g[5] === 0xffff || g.slice(0, 6).every((x) => x === 0)) return blocked.check(v4, 'ipv4');
    }
    return blocked.check(ip.split('%')[0], 'ipv6');
  }
  return true;
}

/**
 * 校验 URL：只允许 http/https，主机解析出的所有地址都不能是内网/回环。
 * @param {string} raw
 * @returns {Promise<URL>}
 */
export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new HttpError(400, 'invalid_url', '网址格式不正确');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError(400, 'invalid_url', '只支持 http 和 https 网址');
  }
  if (u.username || u.password) throw new HttpError(400, 'invalid_url', '网址里不能带用户名密码');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new HttpError(400, 'url_not_allowed', '不允许访问内网或本机地址');
  }
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new HttpError(400, 'invalid_url', `无法解析域名：${host}`);
    }
  }
  if (!addrs.length || addrs.some(isBlockedIp)) {
    throw new HttpError(400, 'url_not_allowed', '不允许访问内网或本机地址');
  }
  return u;
}

async function readLimited(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`页面超过 ${Math.round(max / 1024 / 1024)}MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 安全抓取单个页面：每一跳重定向都重新校验地址。
 * 注：DNS 解析与实际连接之间存在极短的 rebinding 窗口（见 README 偏离规格）。
 * @param {string} url
 * @returns {Promise<{url: string, contentType: string, body: Buffer}>}
 */
export async function safeFetch(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { 'user-agent': 'KBWA/0.1 (+knowledge-base importer)', accept: 'text/html,text/plain,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      current = new URL(res.headers.get('location'), u).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await readLimited(res, MAX_PAGE_BYTES);
    return { url: u.toString(), contentType: (res.headers.get('content-type') || '').toLowerCase(), body };
  }
  throw new Error('重定向次数过多');
}

const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|zip|rar|7z|gz|mp4|mp3|wav|avi|mov|woff2?|ttf|eot|exe|dmg|apk)$/i;

/**
 * 抓取网址（可选同域爬取），合并为一个文本。
 * @param {string} startUrl
 * @param {{crawl:boolean, maxPages:number, log?:(msg:string)=>void}} opts
 */
export async function fetchSite(startUrl, { crawl, maxPages }) {
  const start = await assertPublicUrl(startUrl); // 不合法直接抛 400
  const origin = start.origin;
  const queue = [start.toString().split('#')[0]];
  const seen = new Set(queue);
  const pages = [];
  let bytes = 0;
  let firstError = null;
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    try {
      const page = await safeFetch(url);
      bytes += page.body.length;
      const isHtml = page.contentType.includes('html') || (!page.contentType && /<html/i.test(page.body.slice(0, 2000).toString()));
      let title = url;
      let text;
      if (isHtml) {
        const html = page.body.toString('utf8');
        const parsed = htmlToText(html);
        title = parsed.title || url;
        text = parsed.text;
        if (crawl) {
          for (const link of extractLinks(html, page.url)) {
            if (link.origin !== origin || seen.has(link.href) || SKIP_EXT.test(link.pathname)) continue;
            seen.add(link.href);
            queue.push(link.href);
          }
        }
      } else {
        const kind = page.contentType.startsWith('text/') ? 'txt' : detectKind(new URL(page.url).pathname, page.contentType);
        if (!kind) throw new Error(`不支持的内容类型：${page.contentType || '未知'}`);
        text = await parseBuffer(page.body, kind);
      }
      if (text) pages.push({ url: page.url, title, text });
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  return { pages, bytes, firstError };
}

function extractLinks(html, base) {
  const out = [];
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      out.push(u);
    } catch {
      /* 忽略坏链接 */
    }
  }
  return out;
}
