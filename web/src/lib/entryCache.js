import { api } from '../api/client.js';

// 没有"按 id 取单条"的接口，查看引用条目时拉一次全量列表并短暂缓存。
let cache = null;
let cachedAt = 0;
let inflight = null;
const TTL = 30 * 1000;

export function clearEntryCache() {
  cache = null;
  cachedAt = 0;
}

export async function getEntryMap({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = api
    .listEntries({}, { silent: true })
    .then((list) => {
      cache = new Map((list || []).map((e) => [e.id, e]));
      cachedAt = Date.now();
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
