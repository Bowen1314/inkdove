import { useEffect, useState } from 'react';

// 侧栏「会话」旁边的待处理数。会话页每次轮询都会更新它，侧栏自己也低频拉一次。
let count = null;
const listeners = new Set();

export function setPendingCount(list) {
  const n = Array.isArray(list) ? list.filter((c) => c.needsHuman).length : null;
  if (n === count) return;
  count = n;
  listeners.forEach((fn) => fn(n));
}

export function usePendingCount() {
  const [n, setN] = useState(count);
  useEffect(() => {
    listeners.add(setN);
    return () => listeners.delete(setN);
  }, []);
  return n;
}
