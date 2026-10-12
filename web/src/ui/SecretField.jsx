import { KeyRound } from 'lucide-react';
import { StatusDot } from './StatusDot.jsx';
import { Field } from './common.jsx';

/**
 * 密钥输入：从不回显已保存的值。
 * - 已设置：显示"已设置 · 后四位 xxxx"（有 last4 时）或"已设置"
 * - 输入框留空 = 不修改；输入新值 = 保存时替换
 * - "清除"：由父组件立即提交空字符串
 * - 不传 label 时只渲染控件（放进 SettingsRow 用，标签在左列），状态显示在输入框下面
 */
export function SecretField({ id, label, hint, error, isSet, last4, value, onChange, onClear, clearing, disabled }) {
  const status = isSet ? (
    <StatusDot tone="success" size="sm">
      已设置{last4 ? <> · 后四位 <span className="mono">{last4}</span></> : null}
    </StatusDot>
  ) : (
    <StatusDot tone="neutral" size="sm">
      未设置
    </StatusDot>
  );

  const control = (
    <div className="hstack">
      <div className="input-group" style={{ flex: 1 }}>
        <KeyRound className="input-group__icon" aria-hidden="true" />
        <input
          id={id}
          className="input input--mono"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error && id ? `${id}-err` : undefined}
          placeholder={isSet ? '留空表示不修改' : '请输入'}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {isSet && onClear && (
        <button type="button" className="btn btn--ghost btn--danger" onClick={onClear} disabled={clearing || disabled}>
          {clearing ? '清除中…' : '清除'}
        </button>
      )}
    </div>
  );

  if (!label) {
    return (
      <div className="vstack" style={{ gap: 6, alignItems: 'stretch' }}>
        {control}
        {error ? (
          <div className="field__error" id={id ? `${id}-err` : undefined}>
            {error}
          </div>
        ) : (
          <div className="field__hint">
            {status}
            {hint && <div style={{ marginTop: 4 }}>{hint}</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} aside={status}>
      {control}
    </Field>
  );
}
