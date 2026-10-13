import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogFocus } from './overlay.js';

/** 对话框。width 只用 440（确认）/ 560（表单，默认）/ 720（预览）。 */
export function Modal({ open, title, onClose, children, footer, width = 560, className = '' }) {
  const ref = useDialogFocus(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="modal-layer">
      <div className="backdrop" onMouseDown={() => onClose?.()} />
      <div
        className={`modal ${className}`}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal__head">
          <div className="modal__title">{title}</div>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

const ConfirmCtx = createContext(null);

/**
 * 用法：const confirm = useConfirm(); if (await confirm({title, message, danger, confirmText, cancelText})) {...}
 * focusCancel：默认焦点放在取消按钮上（比如按 Enter 发消息时弹出的确认，免得连按 Enter 直接确认）
 */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        resolverRef.current = resolve;
        setState(opts);
      }),
    [],
  );

  const close = (result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        width={440}
        title={state?.title || '请确认'}
        onClose={() => close(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => close(false)} autoFocus={!!state?.focusCancel}>
              {state?.cancelText || '取消'}
            </button>
            <button
              type="button"
              className={`btn ${state?.danger ? 'btn--danger-solid' : 'btn--primary'}`}
              onClick={() => close(true)}
              autoFocus={!state?.focusCancel}
            >
              {state?.confirmText || '确定'}
            </button>
          </>
        }
      >
        {state?.message && <div className="muted pre-wrap">{state.message}</div>}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}
