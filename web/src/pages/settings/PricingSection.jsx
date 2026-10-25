import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from '../../ui/toastBus.js';
import { Combobox } from '../../ui/Combobox.jsx';
import { EmptyState, fieldProps } from '../../ui/common.jsx';
import { SaveBar, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, putSlice, useRevealInvalid, useSliceDraft } from './shared.jsx';

/**
 * F12 模型单价（admin）：settings.pricing = [{model, inputPerMillion, outputPerMillion}]，单位美元 / 百万 token，看板估算费用用。
 * 表格里单元格直接是输入框（DESIGN 第 5 节「行内编辑」只用在这里），可以增删行，整表一起保存（PUT 整体替换）。
 * 校验和服务端一致：model 去掉首尾空白后非空、不重复；单价是 0–100000 的数。三格都空的行保存时直接丢掉。
 */

const MAX_PRICE = 100000;
const MAX_ROWS = 200;
const PRICE_FIELDS = ['inputPerMillion', 'outputPerMillion'];

// 行的 key 只给 React 列表用：已保存的行按下标生成（保证 base 每次一样），新加的行用递增编号
const toDraft = (list) =>
  (Array.isArray(list) ? list : []).map((p, i) => ({
    key: `s${i}`,
    model: String(p?.model ?? ''),
    inputPerMillion: p?.inputPerMillion == null ? '' : String(p.inputPerMillion),
    outputPerMillion: p?.outputPerMillion == null ? '' : String(p.outputPerMillion),
  }));

const isBlank = (r) => !r.model.trim() && !String(r.inputPerMillion).trim() && !String(r.outputPerMillion).trim();
/** 比较是否有改动时不看 key，也不看三格全空的行 */
const strip = (rows) =>
  rows
    .filter((r) => !isBlank(r))
    .map((r) => [r.model.trim(), String(r.inputPerMillion).trim(), String(r.outputPerMillion).trim()]);

function priceError(s) {
  const t = String(s).trim();
  if (t === '') return '请填写单价';
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return '须为不小于 0 的数字';
  if (n > MAX_PRICE) return `不能超过 ${MAX_PRICE}`;
  return '';
}

/** → {[rowKey]: {model?, inputPerMillion?, outputPerMillion?}} */
function validate(rows) {
  const errs = {};
  const seen = new Set();
  rows.forEach((r) => {
    if (isBlank(r)) return;
    const e = {};
    const m = r.model.trim();
    if (!m) e.model = '请填写模型名';
    else if (seen.has(m)) e.model = '模型重复';
    else seen.add(m);
    PRICE_FIELDS.forEach((f) => {
      const msg = priceError(r[f]);
      if (msg) e[f] = msg;
    });
    if (Object.keys(e).length) errs[r.key] = e;
  });
  return errs;
}

/** 在用的模型名（AI 模型、语音和图片两组里填的），给模型格做候选 */
function modelOptions(settings) {
  const names = [settings?.llm?.model, settings?.llm?.distillModel, settings?.media?.mediaModel, settings?.media?.transcribeModel]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return [...new Set(names)].map((value) => ({ value }));
}

export default function PricingSection({ settings, onSaved }) {
  const [draft, setDraft, base] = useSliceDraft(settings.pricing, toDraft);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState('');
  const [formRef, reveal] = useRevealInvalid();
  const seq = useRef(0);
  const options = modelOptions(settings);

  const dirty = JSON.stringify(strip(base)) !== JSON.stringify(strip(draft));
  const errs = validate(draft);
  const errOf = (key, f) => (touched && errs[key]?.[f]) || '';

  const setCell = (key, f, v) => {
    setServerErr('');
    setDraft((rows) => rows.map((r) => (r.key === key ? { ...r, [f]: v } : r)));
  };
  const addRow = () => {
    seq.current += 1;
    const key = `n${seq.current}`;
    setDraft((rows) => [...rows, { key, model: '', inputPerMillion: '', outputPerMillion: '' }]);
    // 新行出来后把焦点放到模型格
    setTimeout(() => document.getElementById(`pr-${key}-model`)?.focus(), 0);
  };
  const removeRow = (key) => {
    setServerErr('');
    setDraft((rows) => rows.filter((r) => r.key !== key));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setTouched(true);
    const rows = draft.filter((r) => !isBlank(r));
    const firstKey = Object.keys(errs)[0];
    if (firstKey) {
      const i = draft.findIndex((r) => r.key === firstKey);
      const msg = Object.values(errs[firstKey])[0];
      toast.error(`模型单价第 ${i + 1} 行：${msg}`);
      reveal();
      return;
    }
    if (rows.length > MAX_ROWS) {
      toast.error(`最多 ${MAX_ROWS} 行`);
      return;
    }
    setSaving(true);
    setServerErr('');
    const r = await putSlice(
      {
        pricing: rows.map((row) => ({
          model: row.model.trim(),
          inputPerMillion: Number(String(row.inputPerMillion).trim()),
          outputPerMillion: Number(String(row.outputPerMillion).trim()),
        })),
      },
      { fields: { pricing: 'pricing' }, labels: { pricing: '模型单价' } },
    );
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) setServerErr(r.fieldError.text);
      return;
    }
    onSaved(r.res);
    setTouched(false);
    toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    setTouched(false);
    setServerErr('');
  };

  const priceInput = (row, f, label, rowNo) => {
    const id = `pr-${row.key}-${f}`;
    const err = errOf(row.key, f);
    return (
      <>
        <input
          {...fieldProps(id, err)}
          className="input num pricing-table__price"
          type="number"
          inputMode="decimal"
          min={0}
          max={MAX_PRICE}
          step="any"
          placeholder="0.00"
          aria-label={`第 ${rowNo} 行${label}`}
          value={row[f]}
          onChange={(e) => setCell(row.key, f, e.target.value)}
        />
        <FieldError id={id}>{err}</FieldError>
      </>
    );
  };

  return (
    <div ref={formRef}>
      <SettingsSection
        as="form"
        title="模型单价"
        desc="单位：美元 / 百万 token，用于看板费用估算。未设置单价的模型仅统计 token 数。"
        onSubmit={onSubmit}
      >
        {draft.length === 0 ? (
          <EmptyState
            compact
            title="暂无单价"
            desc="模型名须与「AI 模型」中的一致。"
            action={
              <button type="button" className="btn btn--sm" onClick={addRow}>
                <Plus />
                添加模型
              </button>
            }
          />
        ) : (
          <>
            <table className="table pricing-table">
              <thead>
                <tr>
                  <th scope="col">模型</th>
                  <th scope="col" className="is-num">
                    输入（$ / 百万）
                  </th>
                  <th scope="col" className="is-num">
                    输出（$ / 百万）
                  </th>
                  <th scope="col" className="is-shrink">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.map((row, i) => {
                  const modelId = `pr-${row.key}-model`;
                  const modelErr = errOf(row.key, 'model');
                  return (
                    <tr key={row.key}>
                      <td className="pricing-table__model">
                        <span className="pricing-table__cell-label" aria-hidden="true">
                          模型
                        </span>
                        <Combobox
                          id={modelId}
                          value={row.model}
                          onChange={(v) => setCell(row.key, 'model', v)}
                          options={options}
                          mono
                          placeholder="如 gpt-4o-mini"
                          invalid={!!modelErr}
                          aria-label={`第 ${i + 1} 行模型`}
                          aria-describedby={modelErr ? `${modelId}-err` : undefined}
                        />
                        <FieldError id={modelId}>{modelErr}</FieldError>
                      </td>
                      <td className="is-num">
                        <span className="pricing-table__cell-label" aria-hidden="true">
                          输入（$ / 百万）
                        </span>
                        {priceInput(row, 'inputPerMillion', '每百万输入 token 美元', i + 1)}
                      </td>
                      <td className="is-num">
                        <span className="pricing-table__cell-label" aria-hidden="true">
                          输出（$ / 百万）
                        </span>
                        {priceInput(row, 'outputPerMillion', '每百万输出 token 美元', i + 1)}
                      </td>
                      <td className="is-shrink pricing-table__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon"
                          onClick={() => removeRow(row.key)}
                          aria-label={`删除第 ${i + 1} 行${row.model.trim() ? `（${row.model.trim()}）` : ''}`}
                        >
                          <Trash2 />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="pricing-table__foot">
              <button type="button" className="btn btn--sm" onClick={addRow} disabled={draft.length >= MAX_ROWS}>
                <Plus />
                添加模型
              </button>
            </div>
          </>
        )}
        {serverErr && (
          <div className="field__error pricing-table__error" role="alert">
            {serverErr}
          </div>
        )}

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>
    </div>
  );
}
