import { useEffect, useRef } from 'react';

/**
 * setTimeout 链式轮询：上一次请求结束后才排下一次，慢请求不会叠加。
 * enabled 变为 false 或组件卸载（离开页面）时立即停止。
 * 浏览器标签页隐藏时跳过请求，回到前台后继续。
 * @param {() => Promise<any> | any} fn
 * @param {number} intervalMs
 * @param {boolean} [enabled]
 * @param {{immediate?: boolean}} [opts] immediate=true 时先立即执行一次
 */
export function usePolling(fn, intervalMs, enabled = true, opts = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const immediate = !!opts.immediate;

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let timer = null;

    const tick = async () => {
      if (stopped) return;
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          await fnRef.current();
        } catch {
          // 轮询的错误由调用方自行展示，这里只保证不中断
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, immediate ? 0 : intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, enabled, immediate]);
}
