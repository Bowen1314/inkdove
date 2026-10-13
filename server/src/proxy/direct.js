// 全局代理：哪些地址不走代理（直连）。
// 永远直连：localhost、内网和保留地址（和网址抓取的 SSRF 防护用同一张表）、不带点的主机名（compose 里的 waha、inkdove、updater）、
// .localhost / .local / .internal / .home.arpa 这几个保留后缀（含 host.docker.internal），以及 WAHA 等内部服务的主机名。
// 管理员还能加自己的（bypass.js 的格式）。
// 只按名字判断，不在本地解析域名：解析会把要访问的域名先泄露给本地 DNS，也多一次等待。用域名指向内网服务的，加到列表里。
import net from 'node:net';
import { isBlockedIp } from '../sources/fetch-url.js';
import { bareHost, parseBypassRule } from './bypass.js';

const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** 不管怎么配都直连的地址：本机、内网和保留地址、不带点的主机名、保留后缀 */
export function alwaysDirect(host) {
  const h = bareHost(host);
  if (!h) return true;
  if (net.isIP(h)) return isBlockedIp(h);
  if (h === 'localhost' || !h.includes('.')) return true;
  return RESERVED_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * 判断一个主机名要不要直连。
 * @param {{rules?: string[], internalHosts?: string[]}} o rules：管理员加的规则（checkBypassList 的结果）；
 *   internalHosts：WAHA、更新助手这些内部服务的主机名（从它们的地址里取）
 * @returns {(host: string) => boolean}
 */
export function createDirectMatcher({ rules = [], internalHosts = [] } = {}) {
  const exact = new Set(internalHosts.map(bareHost).filter(Boolean));
  const suffixes = [];
  const list = new net.BlockList();
  for (const line of rules) {
    const r = parseBypassRule(line);
    if (!r) continue;
    if (r.kind === 'domain') exact.add(r.domain);
    else if (r.kind === 'suffix') suffixes.push(r.domain);
    else if (r.kind === 'ip') list.addAddress(r.ip, r.family);
    else list.addSubnet(r.ip, r.prefix, r.family);
  }
  return (host) => {
    const h = bareHost(host);
    if (alwaysDirect(h)) return true;
    if (exact.has(h)) return true;
    const v = net.isIP(h);
    if (v) return list.check(h, v === 4 ? 'ipv4' : 'ipv6');
    return suffixes.some((d) => h === d || h.endsWith(`.${d}`));
  };
}
