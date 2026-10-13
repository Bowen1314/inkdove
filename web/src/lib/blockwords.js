// 屏蔽词的前端小件：命中位置切段（标红用），以及「知道了」之后的通知（弹窗和设置页的命中记录互相刷新）。

const ackListeners = new Set();

/** 有人在这个页面点了「知道了」：弹窗和命中记录各自重新取一遍 */
export function notifyBlockwordAck() {
  ackListeners.forEach((fn) => fn());
}

/** 订阅「知道了」，返回取消订阅的函数（直接给 useEffect 当清理函数用） */
export function onBlockwordAck(fn) {
  ackListeners.add(fn);
  return () => ackListeners.delete(fn);
}

/**
 * 把原文按命中位置切成段：[{text, hit}]。ranges 是服务端给的 [开始, 结束)（UTF-16 下标），
 * 先排序、合并重叠的（几个词叠在一起时只标一段），越界的截掉。
 * @param {string} text
 * @param {[number, number][]} ranges
 */
export function hitSegments(text, ranges) {
  const s = String(text ?? '');
  const rs = (Array.isArray(ranges) ? ranges : [])
    .filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]))
    .map(([a, b]) => [Math.max(0, a), Math.min(s.length, b)])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: s.slice(pos, a), hit: false });
    out.push({ text: s.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), hit: false });
  return out;
}
