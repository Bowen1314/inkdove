const pad = (n) => String(n).padStart(2, '0');

function toDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 今天：14:30；今年：10月12日 14:30；更早：2025-03-01 */
export function fmtTime(iso) {
  const d = toDate(iso);
  if (!d) return '—';
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 会话列表用的短时间 */
export function fmtShortTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtClock(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtHm(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 完整时间：2026年10月12日 14:30（悬停提示用） */
export function fmtFull(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDay(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtChars(n) {
  if (n == null) return '—';
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万字`;
  return `${n.toLocaleString('zh-CN')} 字`;
}

export function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('zh-CN');
}

/** 支持中英文逗号、顿号、换行分隔 */
export function parseTags(str) {
  return String(str || '')
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

export function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (/^[+\d\s-]+$/.test(s)) return s.replace(/\D/g, '').slice(-2) || '#';
  const first = Array.from(s)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** 0–1 的小数 → "45.3%"（保留一位小数）；null → "—" */
export function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `${(Number(v) * 100).toFixed(1)}%`;
}

/** 分钟数 → "<1 分钟" / "12 分钟" / "2 小时 5 分"；null → "—" */
export function fmtMinutes(m) {
  if (m == null || !Number.isFinite(Number(m))) return '—';
  const n = Number(m);
  if (n < 1) return '<1 分钟';
  if (n < 60) return `${Math.round(n)} 分钟`;
  const h = Math.floor(n / 60);
  const rest = Math.round(n - h * 60);
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/** token 数 → 980 / 12.3k / 4.56M；null → "—" */
export function fmtTokens(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (Math.abs(v) < 1000) return String(Math.round(v));
  if (Math.abs(v) < 999950) return `${trim((v / 1e3).toFixed(1))}k`;
  return `${trim((v / 1e6).toFixed(2))}M`;
}

/** 美元 → "$1.23"（两位小数），大于 0 但不到一分钱时 "<$0.01"；null → "—" */
export function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v > 0 && v < 0.005) return '<$0.01';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
