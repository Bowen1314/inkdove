// 全局代理：「不走代理的地址」这一设置的格式（设置保存时校验用）。哪些地址实际直连见 direct.js。
// 每行一个：域名（example.com 只匹配它自己）、*.example.com（example.com 和它所有子域名）、IP 或网段。
import net from 'node:net';
import { badRequest } from '../util.js';

export const MAX_BYPASS_LINES = 200;
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** 去掉 IPv6 的方括号和末尾的点，转小写 */
export const bareHost = (h) =>
  String(h || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');

const isDomain = (s) => s.length <= 253 && s.split('.').every((l) => LABEL.test(l));

/**
 * 一行规则 → {kind, value}；不认识返回 null。
 * kind：domain（只匹配自己）、suffix（*.example.com：它自己和所有子域名）、ip、cidr
 */
export function parseBypassRule(line) {
  const s = String(line).trim().toLowerCase();
  if (!s) return null;
  const cidr = /^(.+)\/(\d{1,3})$/.exec(s);
  if (cidr) {
    const ip = cidr[1].replace(/^\[(.*)\]$/, '$1');
    const v = net.isIP(ip);
    const prefix = Number(cidr[2]);
    if (!v || prefix > (v === 4 ? 32 : 128)) return null;
    return { kind: 'cidr', value: `${ip}/${prefix}`, ip, prefix, family: v === 4 ? 'ipv4' : 'ipv6' };
  }
  const ip = s.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(ip)) return { kind: 'ip', value: ip, ip, family: net.isIP(ip) === 4 ? 'ipv4' : 'ipv6' };
  if (s.startsWith('*.')) {
    const d = s.slice(2).replace(/\.$/, '');
    return isDomain(d) ? { kind: 'suffix', value: `*.${d}`, domain: d } : null;
  }
  const d = s.replace(/\.$/, '');
  return isDomain(d) ? { kind: 'domain', value: d, domain: d } : null;
}

/**
 * 校验「不走代理的地址」：数组或多行文本，空行忽略、去重。不认识的行 400，信息以 proxy.bypass 开头（前端靠它放到字段下面）。
 * @param {unknown} input
 * @returns {string[]} 规范化后的规则
 */
export function checkBypassList(input) {
  let list = input;
  if (typeof list === 'string') list = list.split(/\r?\n/);
  if (!Array.isArray(list)) throw badRequest('proxy.bypass 须为数组（每项一个地址）');
  const out = [];
  let n = 0;
  for (const item of list) {
    n++;
    if (typeof item !== 'string') throw badRequest(`proxy.bypass 第 ${n} 行须为字符串`);
    if (!item.trim()) continue;
    if (item.length > 300) throw badRequest(`proxy.bypass 第 ${n} 行过长`);
    const r = parseBypassRule(item);
    if (!r) throw badRequest(`proxy.bypass 第 ${n} 行格式无效，应为域名、*.域名、IP 或网段：${item.trim().slice(0, 60)}`);
    if (!out.includes(r.value)) out.push(r.value);
  }
  if (out.length > MAX_BYPASS_LINES) throw badRequest(`proxy.bypass 最多 ${MAX_BYPASS_LINES} 行`);
  return out;
}

