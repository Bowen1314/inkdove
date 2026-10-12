import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';

/**
 * 设置页的公用小件。每组各自保存：PUT /api/settings 只带自己那部分，
 * 返回的完整设置交给页面的 onSaved，再分发给各组。
 */

/**
 * 区块草稿：从 settings 的某一块生成，只有这一块的内容变了才重置。
 * 别的区块保存后拿到新的完整设置，不会冲掉这里没保存的修改。
 */
export function useSliceDraft(slice, toDraft) {
  const key = JSON.stringify(slice ?? null);
  const [draft, setDraft] = useState(() => toDraft(slice));
  const toDraftRef = useRef(toDraft);
  toDraftRef.current = toDraft;
  useEffect(() => {
    setDraft(toDraftRef.current(slice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [draft, setDraft, toDraft(slice)];
}

export const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 服务端校验错误 → 字段。服务端的 400 都是 invalid_input，字段只体现在 message 前缀里
 * （如 "llm.baseUrl 必须以 http:// 或 https:// 开头"）；少数错误有专门的 code。
 * fields: {'llm.baseUrl': 'baseUrl'}；codes: {transcribe_model_required: {field, text}}
 * → {field, text} 或 null
 */
export function mapServerError(err, fields = {}, codes = {}) {
  if (err?.code && codes[err.code]) return codes[err.code];
  const msg = String(err?.message || '');
  const key = Object.keys(fields)
    .sort((a, b) => b.length - a.length)
    .find((k) => msg.startsWith(k));
  if (!key) return null;
  return { field: fields[key], text: msg.slice(key.length).trim() || msg };
}

/**
 * 保存一组设置。出错时自己弹 Toast（带字段名），并把能对上的错误交回给调用方显示在字段下面。
 * → {res} 或 {error, fieldError}
 */
export async function putSlice(patch, { fields, codes, labels = {} } = {}) {
  try {
    return { res: await api.putSettings(patch, { silent: true }) };
  } catch (error) {
    if (error?.status === 401) return { error };
    const fieldError = mapServerError(error, fields, codes);
    if (fieldError) {
      const label = labels[fieldError.field];
      toast.error(label ? `${label}：${fieldError.text}` : fieldError.text);
    } else {
      toast.error(error?.message || '保存失败');
    }
    return { error, fieldError };
  }
}

/**
 * 校验没过或保存失败后，把焦点移到第一个出错的字段；字段在收起的「高级设置」里时先展开。
 * 用法：const [formRef, reveal] = useRevealInvalid(); <div ref={formRef}>…</div>；出错时调 reveal()。
 */
export function useRevealInvalid() {
  const ref = useRef(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!tick) return;
    const el = ref.current?.querySelector('[aria-invalid="true"]');
    if (!el) return;
    const details = el.closest('details');
    if (details && !details.open) details.open = true;
    el.focus();
  }, [tick]);
  return [ref, () => setTick((t) => t + 1)];
}

/** 字段下面的一行红字；id 和 fieldProps(id) 生成的 aria-describedby 对应 */
export function FieldError({ id, children }) {
  if (!children) return null;
  return (
    <div className="field__error" id={`${id}-err`}>
      {children}
    </div>
  );
}

/** 分组标题右边的"恢复默认"：填回默认值，不立即保存 */
export function ResetButton({ onClick, disabled }) {
  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onClick} disabled={disabled}>
      恢复默认
    </button>
  );
}

/**
 * 测试类按钮的结果：按钮下方一行，成功绿点、失败红点加原因。
 * result: {ok, text} | null。不用 StatusDot，因为它的文字是单行截断，失败原因可能很长。
 */
export function TestResult({ result }) {
  if (!result) return null;
  return (
    <div className={`test-result status status--${result.ok ? 'success' : 'danger'} settings-page__result`} role="status">
      <span className="status__dot" aria-hidden="true" />
      <span>{result.text}</span>
    </div>
  );
}
