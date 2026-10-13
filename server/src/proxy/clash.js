// 全局代理：从 Clash 配置（订阅返回的或管理员粘贴的 YAML）里取节点（proxies）。
// 只认 mihomo 支持的出站类型；direct、dns、reject 这类不是节点的去掉（direct 会让「自动选最快」选到直连）；
// 名字重复的、和保留名或墨鸽自己的分组同名的去掉。节点的其他字段原样保留，交给 mihomo。
// 返回的节点里有服务器地址、密码这些机场的凭证：只存在数据库里，接口只给名字。
import YAML from 'yaml';

/** mihomo 支持、这里收的节点类型 */
export const NODE_TYPES = [
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'snell',
  'http',
  'socks5',
  'ssh',
  'mieru',
  'anytls',
];
/** 墨鸽生成的两个分组（mihomo.js）；节点不能和它们或 mihomo 的保留名同名 */
export const AUTO_GROUP = 'inkdove-auto';
export const MAIN_GROUP = 'inkdove';
const RESERVED_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL', AUTO_GROUP, MAIN_GROUP]);
export const MAX_NODES = 2000;
const MAX_NAME = 200;

export const NOT_CLASH_HINT = '请换成机场给的 Clash 订阅链接';
/** 节点链接（v2rayN 那种订阅一行一个） */
const LINK_LINE = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|anytls|wireguard|wg|snell|socks5?|https?):\/\/\S+/im;

/** notClash：内容根本不是 Clash 配置（节点链接列表、解析不了、没有 proxies），提示里要让人换成 Clash 订阅 */
export class ClashFormatError extends Error {
  constructor(message, { notClash = false } = {}) {
    super(message);
    this.notClash = notClash;
  }
}

/** 是不是 base64 的节点链接列表（或者干脆就是明文的链接列表） */
function looksLikeLinkList(text) {
  if (LINK_LINE.test(text)) return true;
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 16 || !/^[A-Za-z0-9+/_-]+=*$/.test(compact)) return false;
  try {
    return LINK_LINE.test(Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return false;
  }
}

/**
 * 按原文还原「看着像数字」的值：YAML 解析会把 0123 变成 123、超长数字丢精度、1.0 变成 1，
 * 这些原样留成字符串（密码、uuid 之类），mihomo 读节点时会按需要的类型转换。
 */
function keepNumericSource(doc) {
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (node.type === 'PLAIN' && typeof node.value === 'number' && typeof node.source === 'string' && String(node.value) !== node.source) {
        node.value = node.source;
      }
    },
  });
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 解析 Clash 配置，取出能用的节点。
 * @param {string} text YAML（JSON 也行）
 * @returns {{proxies: object[], skipped: number}} skipped：类型不支持、缺字段、重名而去掉的个数
 * @throws {ClashFormatError} 不是 Clash 格式、没有节点；信息里不带配置内容
 */
export function parseClashConfig(text) {
  const raw = String(text ?? '').replace(/^﻿/, '');
  if (!raw.trim()) throw new ClashFormatError('内容是空的');
  let data = null;
  try {
    const doc = YAML.parseDocument(raw, { uniqueKeys: false, merge: true, maxAliasCount: 1000 });
    if (!doc.errors.length) {
      keepNumericSource(doc);
      data = doc.toJS({ maxAliasCount: 1000 });
    }
  } catch {
    data = null;
  }
  if (!isPlainObject(data) || !Array.isArray(data.proxies)) {
    // 不是 Clash 配置：常见的是机场默认给的 base64 节点链接列表，单独说明
    if (looksLikeLinkList(raw)) throw new ClashFormatError('内容是节点链接列表，不是 Clash 格式的配置', { notClash: true });
    throw new ClashFormatError(data === null ? '不是 Clash 格式的配置（YAML 解析失败）' : '不是 Clash 格式的配置（没有 proxies 节点列表）', {
      notClash: true,
    });
  }

  const proxies = [];
  const names = new Set();
  let skipped = 0;
  for (const p of data.proxies) {
    const name = isPlainObject(p) && typeof p.name === 'string' ? p.name : null;
    const type = isPlainObject(p) && typeof p.type === 'string' ? p.type.toLowerCase() : null;
    const port = isPlainObject(p) ? Number(p.port) : NaN;
    const ok =
      name &&
      name.trim() &&
      name.length <= MAX_NAME &&
      !RESERVED_NAMES.has(name) &&
      !names.has(name) &&
      NODE_TYPES.includes(type) &&
      typeof p.server === 'string' &&
      p.server.trim() &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535;
    if (!ok || proxies.length >= MAX_NODES) {
      skipped++;
      continue;
    }
    names.add(name);
    proxies.push({ ...p, type });
  }
  // 节点经另一个节点连出去（dialer-proxy）时，引用的必须是留下来的节点，墨鸽不生成机场的分组
  for (const p of proxies) {
    if (p['dialer-proxy'] !== undefined && !names.has(p['dialer-proxy'])) delete p['dialer-proxy'];
  }
  if (!proxies.length) {
    throw new ClashFormatError(skipped ? `没有能用的节点（${skipped} 个节点的类型不支持或缺少字段）` : 'proxies 里没有节点');
  }
  return { proxies, skipped };
}
