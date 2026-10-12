/**
 * 状态：小圆点 + 文字（不用胶囊徽章）。
 * tone: success | danger | warning | info | neutral（旧名 green/red/amber/blue/gray/teal 也认）
 * tinted：文字也用语义色（会话里的"转人工"这类）。size: 'sm' 用 12px 字。wrap：长文字换行，不截断。
 */
const ALIAS = { green: 'success', teal: 'success', red: 'danger', amber: 'warning', blue: 'info', gray: 'neutral' };

export function StatusDot({ tone = 'neutral', pulse = false, tinted = false, muted = false, wrap = false, size, children, className = '', title }) {
  const t = ALIAS[tone] || tone;
  const cls = ['status', `status--${t}`, tinted && 'status--tinted', muted && 'status--muted', size === 'sm' && 'status--sm', wrap && 'status--wrap', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} title={title}>
      <span className={`status__dot${pulse ? ' status__dot--pulse' : ''}`} aria-hidden="true" />
      {children != null && <span className="status__text">{children}</span>}
    </span>
  );
}
