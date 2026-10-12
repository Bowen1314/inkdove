import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { useAnchoredPosition, useDismiss } from './overlay.js';

/** 把自己的 ref 和子元素原有的 ref 合在一起，Tooltip 套在 Menu/Popover 的触发按钮外面时两边都能拿到元素 */
function mergeRefs(...refs) {
  return (el) => {
    for (const r of refs) {
      if (typeof r === 'function') r(el);
      else if (r) r.current = el;
    }
  };
}

/**
 * 下拉菜单。trigger 是一个元素（通常是按钮），会被注入 onClick 和 aria 属性。
 * items: [{label, icon, onClick, danger, disabled, href}] ，用 'sep' 表示分隔线，{heading} 表示一行灰字。
 * tooltip：给触发按钮加悬停提示（图标按钮用）。
 */
export function Menu({ trigger, items, placement = 'bottom-end', minWidth, tooltip }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const floatRef = useRef(null);
  const id = useId();
  const pos = useAnchoredPosition(open, anchorRef, floatRef, placement);
  useDismiss(open, [anchorRef, floatRef], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => floatRef.current?.querySelector('.menu__item:not(:disabled)')?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const onKeyDown = (e) => {
    const list = Array.from(floatRef.current?.querySelectorAll('.menu__item:not(:disabled)') || []);
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const triggerEl = cloneElement(trigger, {
    ref: mergeRefs(anchorRef, trigger.ref),
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: (e) => {
      trigger.props.onClick?.(e);
      setOpen((v) => !v);
    },
  });

  return (
    <>
      {tooltip ? <Tooltip content={tooltip}>{triggerEl}</Tooltip> : triggerEl}
      {open &&
        createPortal(
          <div
            id={id}
            ref={floatRef}
            className="popover"
            role="menu"
            style={{ ...pos, minWidth }}
            onKeyDown={onKeyDown}
          >
            {items.filter(Boolean).map((it, idx) => {
              if (it === 'sep') return <div key={`s${idx}`} className="menu__sep" role="separator" />;
              if (it.heading) {
                return (
                  <div key={`h${idx}`} className="menu__label">
                    {it.heading}
                  </div>
                );
              }
              const Icon = it.icon;
              return (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  className={`menu__item${it.danger ? ' menu__item--danger' : ''}`}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick?.();
                  }}
                >
                  {Icon && <Icon />}
                  {it.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 点开的内容浮层（例如"依据 N 条知识"）。用法和 Menu 一样传 trigger，children 是浮层内容。
 */
export function Popover({ trigger, children, placement = 'bottom-start', label, tooltip }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const floatRef = useRef(null);
  const id = useId();
  const pos = useAnchoredPosition(open, anchorRef, floatRef, placement);
  useDismiss(open, [anchorRef, floatRef], () => setOpen(false));

  const triggerEl = cloneElement(trigger, {
    ref: mergeRefs(anchorRef, trigger.ref),
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: (e) => {
      trigger.props.onClick?.(e);
      setOpen((v) => !v);
    },
  });

  return (
    <>
      {tooltip ? <Tooltip content={tooltip}>{triggerEl}</Tooltip> : triggerEl}
      {open &&
        createPortal(
          <div id={id} ref={floatRef} className="popover popover--content" role="dialog" aria-label={label} style={pos}>
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 悬停或键盘聚焦 300ms 后显示的提示。children 必须是单个能接收 ref 的元素。
 */
export function Tooltip({ content, children, placement = 'top' }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const floatRef = useRef(null);
  const timer = useRef(null);
  const id = useId();
  const pos = useAnchoredPosition(open, anchorRef, floatRef, placement, 8);

  useEffect(() => () => clearTimeout(timer.current), []);
  if (!content) return children;

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 300);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  const child = cloneElement(children, {
    ref: mergeRefs(anchorRef, children.ref),
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (e) => {
      children.props.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e) => {
      children.props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e) => {
      children.props.onFocus?.(e);
      if (e.target.matches?.(':focus-visible')) show();
    },
    onBlur: (e) => {
      children.props.onBlur?.(e);
      hide();
    },
    // 点击后收起提示，免得盖住打开的菜单
    onClick: (e) => {
      children.props.onClick?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {open &&
        createPortal(
          <div id={id} ref={floatRef} role="tooltip" className="tooltip" style={pos}>
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 标签后面的小问号，悬停或聚焦时显示说明 */
export function HintIcon({ children, label = '说明' }) {
  return (
    <Tooltip content={children}>
      <button type="button" className="hint-icon" aria-label={label}>
        <HelpCircle />
      </button>
    </Tooltip>
  );
}
