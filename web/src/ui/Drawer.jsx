import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogFocus } from './overlay.js';

/**
 * 右侧抽屉。size: 'md'（480，默认）| 'wide'（640）| 'narrow'（420）。
 * footer 放操作按钮（靠右）；headerExtra 放标题右边、关闭按钮左边的小操作。
 */
export function Drawer({ open, title, onClose, children, footer, size = 'md', headerExtra, className = '' }) {
  const ref = useDialogFocus(open, onClose);
  if (!open) return null;
  const sizeClass = size === 'wide' ? ' drawer--wide' : size === 'narrow' ? ' drawer--narrow' : '';
  return createPortal(
    <div className="drawer-layer">
      <div className="backdrop" onMouseDown={() => onClose?.()} />
      <aside
        className={`drawer${sizeClass} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        ref={ref}
        tabIndex={-1}
      >
        <div className="drawer__head">
          <div className="drawer__title">{title}</div>
          {headerExtra}
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer && <div className="drawer__foot">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}
