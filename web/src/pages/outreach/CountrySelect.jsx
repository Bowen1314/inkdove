import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useAnchoredPosition, useDismiss } from '../../ui/overlay.js';
import { getCountries } from '../../lib/countries.js';

/**
 * 可搜索的国家下拉：外观和 ui/Select 一样（按钮 + 弹出列表），弹出层顶部多一个搜索框，
 * 按中文名、英文名、两位代码或区号过滤。选项写成"中国 +86"。onChange(code) 直接给两位代码。
 * 国家有两百多个，Select 只能按首字母跳，所以单独做一个；样式复用 .select / .popover / .listbox。
 */
export function CountrySelect({ id, value, onChange, invalid, 'aria-describedby': describedby }) {
  const countries = getCountries();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const listId = useId();
  const pos = useAnchoredPosition(open, triggerRef, panelRef, 'bottom-start', 4);
  useDismiss(open, [triggerRef, panelRef], () => setOpen(false));

  const selected = countries.find((c) => c.code === value) || null;
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return countries;
    // 区号、国家代码完全对上的排前面（搜 44 时英国在安哥拉 +244 前面）
    const digits = q.replace(/^\+/, '');
    const rank = (c) => (c.dial === digits || c.code.toLowerCase() === q ? 0 : c.dial.startsWith(digits) ? 1 : 2);
    return countries
      .filter((c) => c.search.includes(q))
      .map((c, i) => [rank(c), i, c])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map((x) => x[2]);
  }, [countries, q]);

  // 打开时清空搜索、停在当前选中的那一项，焦点进搜索框
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const i = countries.findIndex((c) => c.code === value);
    setActive(i >= 0 ? i : 0);
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, shown]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (i) => {
    const c = shown[i];
    if (!c) return;
    close();
    if (c.code !== value) onChange(c.code);
  };

  const onSearchKey = (e) => {
    const n = shown.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActive((a) => (a + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((a) => (a <= 0 ? n - 1 : a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
    // Esc 由 useDismiss 关闭
  };

  const onTriggerKey = (e) => {
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const width = Math.max(triggerRef.current?.offsetWidth || 0, 260);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedby}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span className={`select__value${selected ? '' : ' select__value--placeholder'}`}>
          {selected ? selected.label : value || '请选择国家'}
        </span>
        <ChevronDown className="select__chevron" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div ref={panelRef} className="popover outreach-country" style={{ ...pos, width }}>
            <div className="input-group outreach-country__search">
              <Search className="input-group__icon" aria-hidden="true" />
              <input
                ref={searchRef}
                className="input input--sm"
                type="search"
                value={query}
                placeholder="搜索国家或区号"
                aria-label="搜索国家或区号"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
              />
            </div>
            <div id={listId} role="listbox" className="listbox outreach-country__list" aria-label="国家">
              {shown.length === 0 && <div className="combobox__empty">无匹配的国家</div>}
              {shown.map((c, i) => (
                <div
                  key={c.code}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={c.code === value}
                  className={`listbox__option${i === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span className="listbox__text">
                    <span className="listbox__label">
                      {c.name} <span className="muted num">+{c.dial}</span>
                    </span>
                  </span>
                  {c.code === value && <Check className="listbox__check" aria-hidden="true" />}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
