// 模块级的 toast 事件总线：API 客户端等非组件代码也能弹提示。
const listeners = new Set();
let seq = 0;

function emit(type, message, duration) {
  if (!message) return;
  const item = { id: ++seq, type, message: String(message), duration };
  listeners.forEach((fn) => fn(item));
}

export const toast = {
  error: (msg, duration = 6000) => emit('error', msg, duration),
  success: (msg, duration = 4000) => emit('success', msg, duration),
  info: (msg, duration = 4000) => emit('info', msg, duration),
};

export function subscribeToasts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
