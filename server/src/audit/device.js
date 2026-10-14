// 操作日志里的「设备」：从请求的 User-Agent 认出浏览器和系统，写成一句短话，例如「Chrome 130 · Windows 电脑」。
// 只存这句话，不存 User-Agent 原文。不用第三方库，几条正则：
// - 浏览器带大版本号（微信不带）；系统不带版本号，Chrome 这些浏览器把系统版本冻住了（Windows 都写 10，Mac 都写 10_15_7），写了也不准；
// - curl、python-requests 这类不是浏览器的，取「名字/版本」那段，写成「curl 8.4.0」；认不出的取第一段；
// - 最多 DEVICE_MAX 个字，太长的 User-Agent 只看前 UA_SCAN_MAX 个字。
// 新的 iPad 默认用电脑版网页，User-Agent 和 Mac 一样，会显示成「Mac 电脑」。
import { clipText } from './diff.js';

/** 结果最多多少字（截断时末尾的省略号也算一个） */
export const DEVICE_MAX = 60;
/** User-Agent 只看前面这些字 */
const UA_SCAN_MAX = 512;

/**
 * 浏览器：按顺序找第一个对上的。User-Agent 里常常同时写着好几家（Edge、Opera、三星、微信里都有 Chrome，Chrome 里也有 Safari），
 * 所以先找特殊的，Chrome、Safari 放最后。括号里取到的是大版本号。
 */
const BROWSERS = [
  ['微信', /MicroMessenger\//],
  ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /OPR\/(\d+)/],
  ['Samsung Internet', /SamsungBrowser\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /Version\/(\d+).*Safari\//],
];

function browserOf(ua) {
  for (const [name, re] of BROWSERS) {
    const m = ua.match(re);
    if (m) return m[1] ? `${name} ${m[1]}` : name;
  }
  return '';
}

/** 系统和设备。iPhone、iPad 的 User-Agent 里有「like Mac OS X」，Android 和 ChromeOS 的里有 Linux，所以先找它们 */
function systemOf(ua) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android 手机' : 'Android 平板';
  if (/Windows/.test(ua)) return 'Windows 电脑';
  if (/CrOS/.test(ua)) return 'ChromeOS 电脑';
  if (/Macintosh/.test(ua)) return 'Mac 电脑';
  if (/Linux/.test(ua)) return 'Linux 电脑';
  return '';
}

/** 不是浏览器的客户端：第一个「名字/版本」（跳过开头的 Mozilla/5.0），写成「名字 版本」；没有就取第一段 */
function clientOf(ua) {
  const m = ua.match(/(?:^|[\s(;])(?!Mozilla\/)([A-Za-z][\w.-]*)\/(\d[\w.-]*)/);
  return m ? `${m[1]} ${m[2]}` : ua.split(' ')[0];
}

/**
 * User-Agent → 「浏览器 · 系统」这样的短说明；只认出一边的只写那一边；没有 User-Agent 时为 null。
 * @param {string|undefined|null} ua
 * @returns {string|null}
 */
export function describeDevice(ua) {
  const s = String(ua ?? '')
    .slice(0, UA_SCAN_MAX)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  if (!s) return null;
  const browser = browserOf(s);
  const system = systemOf(s);
  const label = browser || system ? [browser, system].filter(Boolean).join(' · ') : clientOf(s);
  return clipText(label, DEVICE_MAX - 1);
}
