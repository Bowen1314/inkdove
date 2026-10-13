import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// 叠在一起的对话框（抽屉上再弹确认框）只让最上面那个响应键盘
const dialogStack = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 对话框、抽屉用：打开时把焦点放进容器并锁住 Tab，Esc 关闭，关闭后焦点回到打开前的元素。
 * 返回要挂到容器上的 ref。
 */
export function useDialogFocus(open, onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    dialogStack.push(token);
    const prev = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const t = setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      const first =
        el.querySelector('[autofocus]') ||
        el.querySelector('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
      (first || el).focus();
    }, 20);

    const onKey = (e) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        // 先让里面的弹出菜单自己处理
        if (e.defaultPrevented) return;
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      clearTimeout(t);
      dialogStack.splice(dialogStack.indexOf(token), 1);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, [open]);

  return ref;
}

/**
 * 浮层定位：贴着 anchor 放，默认在下方左对齐；下方放不下就翻到上方，横向不超出视口。
 * placement: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'top' | 'bottom' | 'right-start'
 * right-start（列表项旁边的预览用，不盖住下面的项）：放在右边、上沿对齐；右边放不下放左边，两边都放不下（窄屏）放到下方。
 */
export function useAnchoredPosition(open, anchorRef, floatRef, placement = 'bottom-start', offset = 6) {
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const update = () => {
      const a = anchorRef.current;
      const f = floatRef.current;
      if (!a || !f) return;
      const r = a.getBoundingClientRect();
      const fw = f.offsetWidth;
      const fh = f.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const [side, align] = placement.split('-');
      if (side === 'right') {
        let left = r.right + offset;
        let top = r.top;
        if (left + fw > vw - 8) {
          if (r.left - fw - offset >= 8) {
            left = r.left - fw - offset;
          } else {
            left = r.left;
            top = r.bottom + offset;
            if (top + fh > vh - 8 && r.top - fh - offset > 8) top = r.top - fh - offset;
          }
        }
        top = Math.max(8, Math.min(top, vh - fh - 8));
        left = Math.max(8, Math.min(left, vw - fw - 8));
        setPos({ top: Math.round(top), left: Math.round(left) });
        return;
      }
      let top = side === 'top' ? r.top - fh - offset : r.bottom + offset;
      if (side !== 'top' && top + fh > vh - 8 && r.top - fh - offset > 8) top = r.top - fh - offset;
      if (side === 'top' && top < 8) top = r.bottom + offset;
      let left;
      if (align === 'start') left = r.left;
      else if (align === 'end') left = r.right - fw;
      else left = r.left + r.width / 2 - fw / 2;
      left = Math.max(8, Math.min(left, vw - fw - 8));
      setPos({ top: Math.round(top), left: Math.round(left) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // 浮层内容晚到（预览里的条目、图片加载完）会变大小，跟着重新定位
    const ro = typeof ResizeObserver !== 'undefined' && floatRef.current ? new ResizeObserver(update) : null;
    ro?.observe(floatRef.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      ro?.disconnect();
    };
  }, [open, placement, offset, anchorRef, floatRef]);

  return pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 };
}

/** 点外面或按 Esc 关闭（弹出菜单、弹出层用）。onClose 收到原因：'outside' 或 'escape' */
export function useDismiss(open, refs, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const inside = (target) => refs.some((r) => r.current && r.current.contains(target));
    const onDown = (e) => {
      if (!inside(e.target)) closeRef.current?.('outside');
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current?.('escape');
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
