import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useAnchoredPosition, useDismiss } from './overlay.js';
import { countryName, countryOf, formatNational, maxDigits, sortedCountries, splitInternational } from '../lib/phone.js';

/** 区号按钮和下拉：下拉里能按中文名、英文代码或区号搜 */
function CountryPicker({ iso, onPick, disabled, invalid, listId }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const listRef = useRef(null);
  const pos = useAnchoredPosition(open, btnRef, popRef, 'bottom-start', 4);
  useDismiss(open, [btnRef, popRef], () => setOpen(false));

  const all = useMemo(() => sortedCountries().map((c) => ({ ...c, name: countryName(c.iso) })), []);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/^\+/, '');
    if (!s) return all;
    return all.filter((c) => c.name.toLowerCase().includes(s) || c.iso.toLowerCase() === s || c.dial.startsWith(s));
  }, [all, q]);
  const cur = countryOf(iso);

  const toggle = () => {
    if (open) return setOpen(false);
    setQ('');
    setActive(Math.max(0, all.findIndex((c) => c.iso === iso)));
    setOpen(true);
  };
  const choose = (c) => {
    if (!c) return;
    setOpen(false);
    onPick(c.iso);
  };

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(list.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(list[active]);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="select phone-input__cc"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`国家/地区：${countryName(cur.iso)} +${cur.dial}`}
        aria-invalid={invalid || undefined}
        title={countryName(cur.iso)}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="select__value">+{cur.dial}</span>
        <ChevronDown className="select__chevron" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div ref={popRef} className="popover phone-input__pop" style={pos || { visibility: 'hidden' }}>
            <div className="phone-input__search">
              <input
                className="input input--sm"
                placeholder="搜索国家、地区或区号"
                value={q}
                autoFocus
                aria-controls={listId}
                aria-activedescendant={list[active] ? `${listId}-${list[active].iso}` : undefined}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            <div ref={listRef} id={listId} role="listbox" aria-label="国家/地区" className="phone-input__list">
              {list.length === 0 && <div className="phone-input__empty">无匹配结果</div>}
              {list.map((c, i) => (
                <div
                  key={c.iso}
                  id={`${listId}-${c.iso}`}
                  data-index={i}
                  role="option"
                  aria-selected={c.iso === iso}
                  className={`listbox__option${i === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(c)}
                >
                  <span className="listbox__text">
                    <span className="listbox__label">{c.name}</span>
                  </span>
                  <span className="phone-input__dial">+{c.dial}</span>
                  {c.iso === iso ? <Check className="listbox__check" aria-hidden="true" /> : <span className="listbox__check" />}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 国际手机号输入：左边选国家/地区（按钮上是区号），右边只填本地号码，输入时只留数字、自动分组；
 * 输入或粘贴「+86 …」「0086 …」这样的完整号码时自动换成对应的国家。
 * value: {iso, digits}；onChange(next)；onEnter：在号码框里回车时调（这个框常放在别的表单里，回车不提交外层）。
 * 交给服务端的完整号码用 lib/phone.js 的 toE164
 */
export function PhoneInput({ id, value, onChange, onEnter, invalid, describedBy, disabled }) {
  const inputRef = useRef(null);
  // 还没认出区号的「+8」「00」先原样显示
  const [draft, setDraft] = useState(null);
  // 改完以后光标放回第几个数字后面
  const caret = useRef(null);
  const shown = draft ?? formatNational(value.iso, value.digits);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (caret.current == null || !el || document.activeElement !== el) return;
    const want = caret.current;
    caret.current = null;
    let pos = 0;
    for (let seen = 0; pos < el.value.length && seen < want; pos += 1) if (/\d/.test(el.value[pos])) seen += 1;
    el.setSelectionRange(pos, pos);
  });

  const handle = (e) => {
    const raw = e.target.value;
    if (/^\s*(\+|00)/.test(raw)) {
      const intl = splitInternational(raw);
      if (!intl) {
        setDraft(raw.replace(/[^\d+]/g, ''));
        return;
      }
      setDraft(null);
      caret.current = Infinity;
      onChange({ iso: intl.iso, digits: intl.digits.slice(0, maxDigits(intl.iso)) });
      return;
    }
    setDraft(null);
    let at = raw.slice(0, e.target.selectionStart ?? raw.length).replace(/\D/g, '').length;
    let digits = raw.replace(/\D/g, '');
    // 只删掉了分组的空格：当成删掉它前面那个数字
    if (digits === value.digits && raw.length < shown.length && at > 0) {
      digits = digits.slice(0, at - 1) + digits.slice(at);
      at -= 1;
    }
    caret.current = at;
    onChange({ ...value, digits: digits.slice(0, maxDigits(value.iso)) });
  };

  return (
    <div className="phone-input">
      <CountryPicker
        iso={value.iso}
        listId={`${id}-cc`}
        disabled={disabled}
        invalid={invalid}
        onPick={(iso) => {
          setDraft(null);
          onChange({ iso, digits: value.digits.slice(0, maxDigits(iso)) });
          inputRef.current?.focus();
        }}
      />
      <input
        ref={inputRef}
        id={id}
        className="input input--mono"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder={value.iso === 'US' ? '201 555 0123' : value.iso === 'CN' ? '138 0000 0000' : '手机号码'}
        value={shown}
        disabled={disabled}
        onChange={handle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.(e);
          }
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    </div>
  );
}
