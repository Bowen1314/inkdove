import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useAnchoredPosition, useDismiss } from './overlay.js';

/**
 * 可自由输入的下拉框：能手打，也能从 options 里挑。不用原生的 select 和 datalist。
 * options: [{value, label?}]；label 和 value 不同时，选项里 label 后面跟一行等宽小字的 value。
 * onChange(string) 直接给值。没有 options 时就是一个普通输入框，不显示箭头。
 * 面板复用 Select 的 .popover.listbox 样式，最高 280，可滚动。
 */
export function Combobox({
  id,
  value,
  onChange,
  options = [],
  placeholder,
  invalid,
  mono = false,
  disabled,
  className = '',
  emptyText = '无匹配项',
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
}) {
  const [open, setOpen] = useState(false);
  // 打开后用户输入的过滤词；点开、按箭头打开时清空，显示全部
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const hasOptions = options.length > 0;
  const isOpen = open && hasOptions && !disabled;
  const pos = useAnchoredPosition(isOpen, wrapRef, listRef, 'bottom-start', 4);
  useDismiss(isOpen, [wrapRef, listRef], () => setOpen(false));

  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => `${o.value} ${o.label || ''}`.toLowerCase().includes(q))
    : options;

  // 列表被清空（比如改了接口地址）时面板跟着关，列表回来也不会自己弹出
  useEffect(() => {
    if (!hasOptions) setOpen(false);
  }, [hasOptions]);

  useEffect(() => {
    if (!isOpen || active < 0) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, active]);

  /** 显示全部选项，当前值高亮；fallback 是没有当前值时停在哪一项（-1 = 不选） */
  const openAll = (fallback = -1) => {
    const i = options.findIndex((o) => o.value === value);
    setQuery('');
    setActive(i >= 0 ? i : fallback);
    setOpen(true);
  };

  const choose = (i) => {
    const o = shown[i];
    if (!o) return;
    setOpen(false);
    setQuery('');
    inputRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  };

  const onInput = (e) => {
    onChange(e.target.value);
    if (!hasOptions) return;
    // 打字时不自动选中第一项，回车保留手打的值
    setQuery(e.target.value);
    setActive(-1);
    setOpen(true);
  };

  const onKeyDown = (e) => {
    if (!hasOptions || disabled) return;
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openAll(e.key === 'ArrowDown' ? 0 : options.length - 1);
      }
      // 面板关着时回车照常提交表单
      return;
    }
    const n = shown.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActive((a) => (a + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((a) => (a <= 0 ? n - 1 : a - 1));
    } else if (e.key === 'Enter') {
      // 面板开着时回车只选中或收起，不提交表单
      e.preventDefault();
      if (active >= 0) choose(active);
      else setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
    // Esc 由 useDismiss 处理
  };

  // 面板翻到输入框上方时改用 bottom 定位：输入过滤让列表变矮后，面板仍贴着输入框
  const rect = isOpen ? wrapRef.current?.getBoundingClientRect() : null;
  const listStyle =
    rect && pos.top >= 0 && pos.top < rect.top
      ? { left: pos.left, bottom: window.innerHeight - rect.top + 4, width: rect.width }
      : { ...pos, width: rect?.width };

  return (
    <div ref={wrapRef} className={`combobox${hasOptions ? ' combobox--has-options' : ''} ${className}`}>
      <input
        ref={inputRef}
        id={id}
        className={`input${mono ? ' input--mono' : ''}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup={hasOptions ? 'listbox' : undefined}
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        aria-invalid={invalid || undefined}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onClick={() => hasOptions && !isOpen && openAll()}
      />
      {hasOptions && (
        <button
          type="button"
          className="combobox__toggle"
          tabIndex={-1}
          aria-label="显示全部选项"
          aria-expanded={isOpen}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (isOpen) setOpen(false);
            else openAll();
            inputRef.current?.focus();
          }}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      )}
      {isOpen &&
        createPortal(
          <div ref={listRef} id={listId} role="listbox" className="popover listbox combobox__list" aria-label={ariaLabel} style={listStyle}>
            {shown.length === 0 && <div className="combobox__empty">{emptyText}</div>}
            {shown.map((o, i) => {
              const extra = o.label && o.label !== o.value;
              return (
                <div
                  key={o.value}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === value}
                  className={`listbox__option${i === active ? ' is-active' : ''}`}
                  title={extra ? `${o.label}（${o.value}）` : o.value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span className="combobox__option-text">
                    <span className={`listbox__label${mono && !extra ? ' mono' : ''}`}>{extra ? o.label : o.value}</span>
                    {extra && <span className="combobox__option-id">{o.value}</span>}
                  </span>
                  {o.value === value && <Check className="listbox__check" aria-hidden="true" />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
