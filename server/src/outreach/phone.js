// F11 外联：号码解析（libphonenumber-js）和收件人当地时间（countries-and-timezones 取国家的主时区）。
import ct from 'countries-and-timezones';
import { isSupportedCountry, parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * 跨好几个时区的国家：主时区取首都或人口最多的地区。countries-and-timezones 的时区列表按字母排，不分主次，
 * 比如美国排第一的是 America/Adak，所以这些国家单独指定。其余国家取第一个归属于这个国家的时区。
 */
const MAIN_TIMEZONE = {
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  CA: 'America/Toronto',
  CL: 'America/Santiago',
  CN: 'Asia/Shanghai',
  EC: 'America/Guayaquil',
  ES: 'Europe/Madrid',
  GL: 'America/Nuuk',
  ID: 'Asia/Jakarta',
  KI: 'Pacific/Tarawa',
  MN: 'Asia/Ulaanbaatar',
  MX: 'America/Mexico_City',
  NZ: 'Pacific/Auckland',
  PF: 'Pacific/Tahiti',
  PG: 'Pacific/Port_Moresby',
  PT: 'Europe/Lisbon',
  RU: 'Europe/Moscow',
  US: 'America/New_York',
};

/** 国家代码（ISO 3166-1 两位，大小写都行）是不是 libphonenumber-js 支持的 */
export const supportedCountry = (code) => typeof code === 'string' && isSupportedCountry(code.toUpperCase());

/** 时区名 Node 认不认识（不认识的 Intl 会抛 RangeError） */
function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const zoneCache = new Map();
/**
 * 国家的主时区。不知道国家（比如 +800 这类不属于任何国家的号码）时用 UTC。
 * @param {string|null|undefined} country
 */
export function mainTimezone(country) {
  const c = String(country || '').toUpperCase();
  if (!c) return 'UTC';
  if (zoneCache.has(c)) return zoneCache.get(c);
  const zones = ct.getCountry(c)?.timezones || [];
  const candidates = [MAIN_TIMEZONE[c], zones.find((tz) => ct.getCountryForTimezone(tz)?.id === c), zones[0]];
  const tz = candidates.find((z) => z && validZone(z)) || 'UTC';
  zoneCache.set(c, tz);
  return tz;
}

/**
 * 解析一行号码 → {digits, country} 或 null（解析不了、校验不过）。digits 是不带 + 的国际号码（国家码 + 本国号码），
 * 和会话里的 contact_number 一个格式。
 * - 允许空格、横线、括号，开头可以是 + 或 00（00 当成 +，不管默认国家的国际冠码是什么）；有别的字符算无效。
 * - 带 + / 00 的按国际号码解析；不带的先按 defaultCountry 的本国号码解析，校验不过再把整串数字当成带国家码的号码试一次
 *   （文件里常有 8613800138000 这种省掉 + 的写法）。
 * - 用 libphonenumber-js 的完整元数据（max）校验。
 * @param {string} raw
 * @param {string} defaultCountry
 */
export function parsePhoneLine(raw, defaultCountry) {
  const s = String(raw ?? '').trim();
  // + 只能在最前面（前面可以有个左括号，比如 "(+86) 138 0013 8000"）
  if (!s || !/^\(?\+?[\d\s\-()]+$/.test(s)) return null;
  const compact = s.replace(/[\s\-()]/g, '');
  if (!/^\+?\d{3,20}$/.test(compact)) return null;
  const tryParse = (text, dc) => {
    const p = parsePhoneNumberFromString(text, dc);
    if (!p || !p.isValid()) return null;
    return { digits: p.number.replace(/^\+/, ''), country: p.country || null };
  };
  if (compact.startsWith('+')) return tryParse(compact);
  if (compact.startsWith('00')) return tryParse(`+${compact.slice(2)}`);
  const dc = supportedCountry(defaultCountry) ? defaultCountry.toUpperCase() : undefined;
  return (dc && tryParse(compact, dc)) || tryParse(`+${compact}`);
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hhmmToMinutes = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};

const formatters = new Map();
/** 某时区在某一刻的当地时间，换算成当天的第几分钟（0–1439） */
export function localMinutes(tz, ms) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: validZone(tz) ? tz : 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  let h = 0;
  let m = 0;
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === 'hour') h = Number(p.value) % 24;
    else if (p.type === 'minute') m = Number(p.value);
  }
  return h * 60 + m;
}

/**
 * 收件人当地时间在不在发送窗口内：[start, end)。start 晚于 end 表示跨午夜（比如 20:00–09:00）；两个相同表示全天都行。
 * @param {string} tz
 * @param {number} ms 现在（毫秒时间戳）
 * @param {string} start HH:MM
 * @param {string} end HH:MM
 */
export function inWindow(tz, ms, start, end) {
  const a = hhmmToMinutes(start);
  const b = hhmmToMinutes(end);
  if (a === b) return true;
  const t = localMinutes(tz, ms);
  return a < b ? t >= a && t < b : t >= a || t < b;
}
