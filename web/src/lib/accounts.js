import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';

/**
 * WhatsApp 号码列表（GET /api/accounts，服务端已按权限过滤）。
 * 模块级缓存 15 秒，多个组件同时要时只发一次请求。号码增删改后调 invalidateAccounts()。
 */
let cache = null;
let cachedAt = 0;
let inflight = null;
const TTL = 15 * 1000;
const listeners = new Set();

export function invalidateAccounts() {
  cache = null;
  cachedAt = 0;
}

/** 把一个号的最新数据写进缓存并通知所有 useAccounts（比如开关自动回复后） */
export function patchAccountCache(account) {
  if (!account?.id || !cache) return;
  cache = cache.map((a) => (a.id === account.id ? { ...a, ...account } : a));
  listeners.forEach((fn) => fn(cache));
}

export async function fetchAccounts({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = api
    .listAccounts({ silent: true })
    .then((list) => {
      cache = Array.isArray(list) ? list : [];
      cachedAt = Date.now();
      listeners.forEach((fn) => fn(cache));
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * @returns {{accounts: any[]|null, error: any, reload: (force?:boolean)=>Promise<any>}}
 * accounts 为 null 表示加载中。
 */
export function useAccounts() {
  const [accounts, setAccounts] = useState(cache);
  const [error, setError] = useState(null);

  const reload = useCallback(async (force = true) => {
    try {
      const list = await fetchAccounts({ force });
      setAccounts(list);
      setError(null);
      return list;
    } catch (e) {
      setError(e);
      setAccounts((prev) => prev || []);
      return null;
    }
  }, []);

  useEffect(() => {
    listeners.add(setAccounts);
    reload(false);
    return () => listeners.delete(setAccounts);
  }, [reload]);

  return { accounts, error, reload };
}

/** 号是否已连上（waha 为 working，meta 为 configured） */
export const isConnected = (a) => a?.status?.state === 'working' || a?.status?.state === 'configured';

export const accountName = (accounts, id) => accounts?.find((a) => a.id === id)?.name || null;
