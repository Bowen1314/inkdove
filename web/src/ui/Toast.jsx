import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { subscribeToasts } from './toastBus.js';

const ICON = { success: CheckCircle2, error: AlertCircle, info: Info };
const MAX = 3;

function ToastItem({ item, onDone }) {
  const timer = useRef(null);
  const left = useRef(item.duration);
  const startedAt = useRef(0);

  const start = () => {
    startedAt.current = Date.now();
    timer.current = setTimeout(onDone, left.current);
  };
  const pause = () => {
    clearTimeout(timer.current);
    left.current = Math.max(800, left.current - (Date.now() - startedAt.current));
  };

  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Icon = ICON[item.type] || Info;
  return (
    <div className={`toast toast--${item.type}`} onMouseEnter={pause} onMouseLeave={start}>
      <Icon className="toast__icon" />
      <div className="toast__msg">{item.message}</div>
      <button type="button" className="toast__close" onClick={onDone} aria-label="关闭">
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const [items, setItems] = useState([]);

  useEffect(
    () =>
      subscribeToasts((item) => {
        // 相同文案不重复堆叠
        setItems((prev) => [...prev.filter((p) => p.message !== item.message), item].slice(-MAX));
      }),
    [],
  );

  const dismiss = (id) => setItems((prev) => prev.filter((p) => p.id !== id));

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <ToastItem key={t.id} item={t} onDone={() => dismiss(t.id)} />
      ))}
    </div>
  );
}
