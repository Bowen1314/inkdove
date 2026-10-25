import { StatusDot } from './StatusDot.jsx';
import { CHANNEL_LABEL, waState } from '../lib/labels.js';

/**
 * 号码多选（复选框列表）。成员页"负责的号"在用；外联"选号"也可以直接用。
 * @param {{accounts: any[], value: string[], onChange: (ids:string[])=>void, showState?: boolean, disabled?: boolean, empty?: any}} props
 */
export function AccountPicker({ accounts, value, onChange, showState = true, disabled = false, empty }) {
  const selected = new Set(value || []);
  if (accounts == null) return <div className="muted text-sm">正在加载号码…</div>;
  if (!accounts.length) {
    return <div className="muted text-sm">{empty || '暂无号码，请先在「号码」页添加。'}</div>;
  }
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // 保持和 accounts 相同的顺序
    onChange(accounts.map((a) => a.id).filter((x) => next.has(x)));
  };
  return (
    <div className="choice-list" style={{ gap: 'var(--sp-2)' }}>
      {accounts.map((a) => {
        const st = waState(a.status?.state);
        return (
          <label key={a.id} className="choice" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              className="checkbox"
              style={{ marginTop: 0 }}
              checked={selected.has(a.id)}
              onChange={() => toggle(a.id)}
              disabled={disabled}
            />
            <span className="ellipsis" style={{ flex: 1 }}>
              {a.name || '未命名号码'}
              <span className="muted text-sm"> · {CHANNEL_LABEL[a.channel] || a.channel}</span>
            </span>
            {showState && (
              <StatusDot tone={st.tone} pulse={st.pulse} size="sm" muted>
                {st.label}
              </StatusDot>
            )}
          </label>
        );
      })}
    </div>
  );
}
