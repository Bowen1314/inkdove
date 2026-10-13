import { api } from '../api/client.js';

// 按 id 取知识条目（GET /api/kb/entries/by-ids），每条短暂缓存：显示几个引用条目时不用把整个知识库拉下来。
// 同一时刻（同一轮事件循环里）要的 id 合成一次请求，一次最多 50 个，多的分几次；正在取的 id 不重复取。
// 不存在的（已删除）也缓存，记为 null，免得每次渲染都再问一遍。增删改条目后调 clearEntryCache。
const TTL = 30 * 1000;
const MAX_PER_REQUEST = 50;
/** id → {entry: Entry|null, at} */
const cache = new Map();
/** id → 正在取它的那次请求 */
const inflight = new Map();
/** 还没发出去的一批 {ids:Set, promise} */
let batch = null;

export function clearEntryCache() {
  cache.clear();
}

const fresh = (id) => {
  const c = cache.get(id);
  return c && Date.now() - c.at < TTL ? c : null;
};

/** 缓存里现成的条目：有就是 Entry 或 null（已删除），没有（或过期）是 undefined。先显示、再等 getEntries 用 */
export function cachedEntry(id) {
  const c = fresh(id);
  return c ? c.entry : undefined;
}

async function run(ids) {
  try {
    for (let i = 0; i < ids.length; i += MAX_PER_REQUEST) {
      const part = ids.slice(i, i + MAX_PER_REQUEST);
      const list = await api.entriesByIds(part, { silent: true });
      const byId = new Map((list || []).map((e) => [e.id, e]));
      const at = Date.now();
      for (const id of part) cache.set(id, { entry: byId.get(id) || null, at });
    }
  } finally {
    for (const id of ids) inflight.delete(id);
  }
}

function load(ids) {
  const waits = new Set();
  for (const id of ids) {
    let p = inflight.get(id);
    if (!p) {
      if (!batch) {
        const b = { ids: new Set() };
        b.promise = new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
          if (batch === b) batch = null;
          return run([...b.ids]);
        });
        batch = b;
      }
      batch.ids.add(id);
      p = batch.promise;
      inflight.set(id, p);
    }
    waits.add(p);
  }
  return Promise.all(waits);
}

/**
 * 按 id 取条目 → Map<id, Entry|null>（null：已删除或找不到；停用的照样有，看 status）。请求失败时抛错。
 * @param {string[]} ids
 */
export async function getEntries(ids) {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  const missing = list.filter((id) => !fresh(id));
  if (missing.length) await load(missing);
  return new Map(list.map((id) => [id, cache.get(id)?.entry ?? null]));
}

/** 取一条 → Entry 或 null（已删除） */
export async function getEntry(id) {
  return (await getEntries([id])).get(id) ?? null;
}
