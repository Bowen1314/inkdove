/** 首字头像，底色按名字哈希在 6 个低饱和色里取 */
function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (/^[+\d\s()-]+$/.test(s)) return s.replace(/\D/g, '').slice(-2) || '#';
  const words = s.split(/\s+/).filter(Boolean);
  if (/^[a-z]/i.test(words[0]) && words.length > 1 && /^[a-z]/i.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const first = Array.from(s)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

function colorOf(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (h % 6) + 1;
}

export function Avatar({ name, size = 'md', className = '' }) {
  return (
    <span
      className={`avatar avatar--c${colorOf(name)}${size === 'sm' ? ' avatar--sm' : ''} ${className}`}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}
