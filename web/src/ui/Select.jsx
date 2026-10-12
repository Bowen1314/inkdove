import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useAnchoredPosition, useDismiss } from './overlay.js';

/**
 * 下拉选择。不用原生 <select>。
 * options: [{value, label, desc?, disabled?}]；value 可以是字符串或数字。
 * onChange(value) 直接给值，不是事件。
 * size: 'md'（32）| 'sm'（28）；invalid 时红框；placeholder 在没选中时显示。
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  size = 'md',
  id,
  disabled,
  invalid,
  className = '',
  style,
  placement = 'bottom-start',
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const typeahead = useRef({ text: '', t: 0 });
  const listId = useId();
  const pos = useAnchoredPosition(open, triggerRef, listRef, placement, 4);
  useDismiss(open, [triggerRef, listRef], () => setOpen(false));

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const enabledIndex = (from, step) => {
    for (let i = 1; i <= options.length; i += 1) {
      const k = (from + step * i + options.length * 2) % options.length;
      if (!options[k].disabled) return k;
    }
    return -1;
  };

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : enabledIndex(-1, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const choose = (i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => enabledIndex(a, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => enabledIndex(a < 0 ? 0 : a, -1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(enabledIndex(-1, 1));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(enabledIndex(options.length, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key.length === 1) {
      // 按字母跳到对应选项
      const now = Date.now();
      const ta = typeahead.current;
      ta.text = now - ta.t > 600 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
      ta.t = now;
      const hit = options.findIndex((o) => !o.disabled && String(o.label).toLowerCase().startsWith(ta.text));
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`select${size === 'sm' ? ' input--sm' : ''} ${className}`}
        style={style}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className={`select__value${selected ? '' : ' select__value--placeholder'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="select__chevron" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="popover listbox"
            aria-label={ariaLabel}
            style={{ ...pos, minWidth: triggerRef.current?.offsetWidth }}
          >
            {options.map((o, i) => (
              <div
                key={String(o.value)}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={`listbox__option${i === active ? ' is-active' : ''}`}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <span className="listbox__text">
                  <span className="listbox__label">{o.label}</span>
                  {o.desc && <span className="listbox__desc">{o.desc}</span>}
                </span>
                {o.value === value && <Check className="listbox__check" aria-hidden="true" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
