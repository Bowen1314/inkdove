import { Fragment, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Check, ChevronRight, Copy, Info, RefreshCw } from 'lucide-react';
import { toast } from './toastBus.js';

/**
 * 页面头部：H1 标题（可带灰色数量）+ 右侧操作。
 * crumbs: [{label, to}] 详情页的面包屑，最后一项是当前页（不带 to）。
 * tabs: 传给 <Tabs>，标签栏紧贴在头部下面。
 */
export function PageHeader({ title, count, crumbs, meta, actions, tabs }) {
  return (
    <>
      <header className={`page-header${tabs ? ' page-header--with-tabs' : ''}`}>
        {crumbs ? (
          <nav className="page-header__crumbs" aria-label="面包屑">
            {crumbs.map((c, i) => (
              <Fragment key={c.label}>
                {i > 0 && <ChevronRight aria-hidden="true" />}
                {c.to ? (
                  <Link to={c.to}>{c.label}</Link>
                ) : (
                  <h1 className="ellipsis" style={{ color: 'var(--text)' }}>
                    {c.label}
                  </h1>
                )}
              </Fragment>
            ))}
          </nav>
        ) : (
          <div className="page-header__title">
            <h1>{title}</h1>
            {count != null && <span className="page-header__count">{count}</span>}
          </div>
        )}
        {meta && <div className="page-header__meta">{meta}</div>}
        {actions && <div className="page-header__actions">{actions}</div>}
      </header>
      {tabs && <Tabs tabs={tabs} />}
    </>
  );
}

/** 基于路由的下划线标签栏。tabs: [{to, label, count, alert}] */
export function Tabs({ tabs }) {
  return (
    <nav className="tabs" aria-label="页面标签">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} replace className={({ isActive }) => `tabs__item${isActive ? ' is-active' : ''}`}>
          {t.label}
          {t.count != null && t.count !== 0 && (
            <span className={`tabs__count${t.alert ? ' tabs__count--alert' : ''}`}>{t.count}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** 兼容旧名 */
export const TabBar = Tabs;

/** 分段切换（同一份数据换视图或范围）。options: [{value, label, icon}]；disabled 时整组不能点（比如正在保存） */
export function Segmented({ options, value, onChange, label, disabled = false }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className="segmented__item"
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <o.icon />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 14, className = '' }) {
  return <span className={`spinner ${className}`} style={{ width: size, height: size }} aria-hidden="true" />;
}

/** 骨架行，加载列表、表格时用 */
export function SkeletonRows({ rows = 5, avatar = false }) {
  return (
    <div aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="hstack" style={{ padding: '12px var(--gutter)', borderBottom: '1px solid var(--border)', gap: 12 }}>
          {avatar && <span className="skeleton skeleton--circle" style={{ width: 32, height: 32, flex: 'none' }} />}
          <div style={{ flex: 1 }}>
            <span className="skeleton skeleton--text" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
            <span className="skeleton skeleton--text" style={{ width: `${25 + ((i * 23) % 30)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 局部加载。compact 时只占一小块。 */
export function Loading({ text = '加载中…', compact = false }) {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}`} aria-busy="true">
      <Spinner size={20} className="muted" />
      <div className="empty__text">{text}</div>
    </div>
  );
}

/** 空状态：可选 20px 灰色图标 + 一行标题 + 可选说明 + 可选按钮 */
export function EmptyState({ icon: Icon, title, desc, action, compact = false, fill = false }) {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}${fill ? ' empty--fill' : ''}`}>
      {Icon && <Icon className="empty__icon" aria-hidden="true" />}
      {title && <div className="empty__title">{title}</div>}
      {desc && <div className="empty__text">{desc}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = '加载失败', error, onRetry, compact = false }) {
  return (
    <div className={`empty empty--error${compact ? ' empty--compact' : ''}`} role="alert">
      <AlertCircle className="empty__icon" aria-hidden="true" />
      <div className="empty__title">{title}</div>
      {error && <div className="empty__text">{error.message || String(error)}</div>}
      {onRetry && (
        <div className="empty__action">
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            <RefreshCw /> 重新加载
          </button>
        </div>
      )}
    </div>
  );
}

/** 行内提示框：只用于挡住操作的错误或警告。tone: danger | warning | info */
export function Callout({ tone = 'warning', children, action }) {
  const Icon = tone === 'danger' ? AlertCircle : tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={`callout callout--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon aria-hidden="true" />
      <div className="callout__body">{children}</div>
      {action}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label, size = 'md', id }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${size === 'sm' ? ' switch--sm' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  );
}

/**
 * 表单字段：标签在上，说明和错误在下。
 * error 有值时显示红字；控件自己设置 aria-invalid（或用 fieldProps 帮忙生成）。
 */
export function Field({ label, htmlFor, hint, error, optional, aside, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {(label || aside) && (
        <div className="field__label-row">
          {label && (
            <label className="field__label" htmlFor={htmlFor}>
              {label}
              {optional && <span className="field__optional">（可选）</span>}
            </label>
          )}
          {aside}
        </div>
      )}
      {children}
      {error ? (
        <div className="field__error" id={htmlFor ? `${htmlFor}-err` : undefined}>
          {error}
        </div>
      ) : (
        hint && <div className="field__hint">{hint}</div>
      )}
    </div>
  );
}

/** 给输入框补 aria-invalid / aria-describedby：<input {...fieldProps('name', errors.name)} /> */
export function fieldProps(id, error) {
  return { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-err` : undefined };
}

/** 指标：Caption 标签 + Metric 数字。to 有值时整块可点；tone（danger/warning/success）给数字上色。 */
export function Metric({ label, value, unit, foot, to, dot, tone, className = '' }) {
  const cls = `card${to ? ' card--interactive' : ''}${className ? ` ${className}` : ''}`;
  const body = (
    <>
      <div className="metric__label">
        {dot}
        {label}
      </div>
      <div className={`metric__value${tone ? ` text-${tone}` : ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {foot && <div className="metric__foot">{foot}</div>}
    </>
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function CopyButton({ text, label = '复制', size = 'sm' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        toast.error('复制失败，请手动复制');
        ta.remove();
        return;
      }
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" className={`btn${size === 'sm' ? ' btn--sm' : ''}`} onClick={copy}>
      {done ? <Check /> : <Copy />}
      {done ? '已复制' : label}
    </button>
  );
}
