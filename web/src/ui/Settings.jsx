import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Spinner } from './common.jsx';
import { HintIcon } from './Popover.jsx';

/**
 * 设置类页面的骨架：左边分组子导航，右边内容（最大宽 880）。
 * nav: [{to, label, danger}]，每个分组一个子路由。
 */
export function SettingsLayout({ nav, children }) {
  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="设置分组">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            replace
            className={({ isActive }) =>
              `settings__nav-item${n.danger ? ' settings__nav-item--danger' : ''}${isActive ? ' is-active' : ''}`
            }
          >
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="settings__content">{children}</div>
    </div>
  );
}

/** 一个分组：H2 标题，右边可放"恢复默认"等 ghost 按钮。as='form' 时整组是一个表单。 */
export function SettingsSection({ title, desc, actions, children, as: Tag = 'section', onSubmit, id }) {
  return (
    <Tag className="settings-section" id={id} onSubmit={onSubmit} noValidate={Tag === 'form' ? true : undefined}>
      <div className="settings-section__head">
        <div>
          <h2>{title}</h2>
          {desc && <div className="settings-section__desc">{desc}</div>}
        </div>
        {actions && <div className="hstack">{actions}</div>}
      </div>
      {children}
    </Tag>
  );
}

/**
 * 一行设置：左边标签（下面可有一行说明），右边控件。
 * inline：控件很小（开关、按钮）时用，控件靠右且和标签同一行。
 * help：较长的说明收进标签后面的问号提示里。
 */
export function SettingsRow({ label, hint, help, htmlFor, inline = false, children }) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={`settings-row${inline ? ' settings-row--inline' : ''}`}>
      {help ? (
        <div className="settings-row__label">
          <div className="settings-row__label-line">
            <Label htmlFor={htmlFor}>{label}</Label>
            <HintIcon label={`${typeof label === 'string' ? label : ''}说明`}>{help}</HintIcon>
          </div>
          {hint && <div className="settings-row__hint">{hint}</div>}
        </div>
      ) : (
        <Label className="settings-row__label" htmlFor={htmlFor}>
          {label}
          {hint && <div className="settings-row__hint">{hint}</div>}
        </Label>
      )}
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

/** 「高级设置」折叠区，默认收起。传 open 时受控（比如出错时自动展开），onToggle 收到新的开关状态。 */
export function Advanced({ label = '高级设置', defaultOpen = false, open, onToggle, children }) {
  return (
    <details
      className="disclosure"
      open={open ?? (defaultOpen || undefined)}
      onToggle={onToggle ? (e) => onToggle(e.currentTarget.open) : undefined}
    >
      <summary>
        <ChevronRight aria-hidden="true" />
        {label}
      </summary>
      {children}
    </details>
  );
}

/**
 * 吸底保存栏：有改动才出现。表单用 type=submit 的保存按钮，也可以传 onSave。
 * 有未保存的改动时，关闭或刷新浏览器标签页会先提示。
 */
export function SaveBar({ dirty, saving, onDiscard, onSave, text = '有未保存的更改' }) {
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  if (!dirty && !saving) return null;
  return (
    <div className="savebar" role="region" aria-label="保存更改">
      <span className="savebar__text">{text}</span>
      {onDiscard && (
        <button type="button" className="btn btn--ghost" onClick={onDiscard} disabled={saving}>
          放弃
        </button>
      )}
      <button
        type={onSave ? 'button' : 'submit'}
        className="btn btn--primary"
        onClick={onSave}
        disabled={saving}
      >
        {saving && <Spinner />}
        保存
      </button>
    </div>
  );
}
