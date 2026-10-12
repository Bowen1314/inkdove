import { createContext, useContext } from 'react';

/**
 * 当前登录用户（GET /api/auth/me 的 user）。由 App 里的 RequireAuth 提供。
 * 权限一律在服务端判断；前端只用它来隐藏没权限的导航和按钮（直接不渲染，不是置灰）。
 */
export const AuthContext = createContext({ user: null, setUser: () => {} });

/** @returns {{user: any, isAdmin: boolean, setUser: (u:any)=>void}} */
export function useAuth() {
  const ctx = useContext(AuthContext);
  const user = ctx?.user || null;
  return { user, isAdmin: user?.role === 'admin', setUser: ctx?.setUser || (() => {}) };
}

/** agent 能否操作某个号：admin 全部可以；agent 只看 accountIds */
export function canUseAccount(user, accountId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.accountIds) && user.accountIds.includes(accountId);
}
