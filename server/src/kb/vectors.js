// 可选的向量检索（按意思搜）。规则见 docs/features.md 的「知识库怎么带进回复」：
// - 后台计算：开着时把 active 条目分段（entrySegments）算成向量，存进 embeddings 表（db.js）。缺的、文字变了的（text_hash）、
//   模型换了的（model_key）分批算，每批最多 BATCH_SEGMENTS 段，一次只跑一批，翻页之间让出事件循环。触发：启动、条目增删改
//   （kb store 的 onChange，防抖）、设置改动、手动「重新计算」（全部清掉重算）、手动「重试」。出错时按种类停下（鉴权、模型
//   不存在、返回格式不对、维度变了……等设置改了或手动重试）或退避后再试（限流按 Retry-After，5xx、连不上、超时指数退避）；
// - 内存：当前模型的向量按 int8 量化（每个向量一个缩放系数）放在 QuantizedIndex 里。库里存的也是这份量化结果（quantize，
//   算完量化一次，读库时直接用），只放 active 而且文字和向量对得上的条目，
//   增量更新（算完一批就加进去，删、停用、改了文字就拿掉）；
// - 检索：search(text) 算一个查询向量（8 秒超时，按文字缓存 30 分钟），暴力点积取前 50 条（同一条目几段取最高分），
//   交给 kb/retrieve.js 和关键词检索的结果合并。失败、没开、还没有向量时返回 null，调用方退回原来的流程。
// 向量接口的调用不计入会话每天的模型次数（llm_calls 照记，purpose 是 embedding）。
import crypto from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { EmbedError, embedModelKey, FATAL_EMBED_KINDS, normalizeVector } from '../ai/embed.js';
import { llmScope } from '../records.js';
import { resolveEmbeddingConfig } from '../settings.js';
import { nowIso } from '../util.js';

/** 一段最多多少字（含每段开头重复的标题）。常见向量模型的输入上限是 2048（Gemini、Ollama 默认）到 8192 token，中文 1 字约 1–1.5 token */
export const SEGMENT_CHARS = 1500;
/** 一个条目最多几段（条目内容最多 20000 字），再长的部分不算 */
export const MAX_SEGMENTS = 12;
/** 一批最多几段（不拆开同一个条目的几段，所以一批最多多出 MAX_SEGMENTS - 1 段） */
export const BATCH_SEGMENTS = 32;
/** 找要算的条目时一次读多少条（只读 id 和更新时间） */
const SCAN_PAGE = 500;
/** 启动时往内存里读向量一次读多少行 */
const LOAD_PAGE = 2000;
/** 条目改动后等多久再算（连着改很多条时攒成一次） */
export const VECTOR_DEBOUNCE_MS = 3000;
/** 限流（没给 Retry-After）、5xx、连不上、超时的退避：5 秒起，每次翻倍，最多 5 分钟 */
export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** 向量那一路取前几条（和关键词那一路各取 50 条再合并） */
export const VECTOR_TOP_K = 50;
/** 当前模型的向量覆盖了多少 active 条目以上，查询向量又算成功了，就不再调模型改写检索词 */
export const COVERAGE_FOR_NO_REWRITE = 0.9;
/** 查询向量缓存：同一段话 30 分钟内不重复算，最多 500 段 */
export const QUERY_CACHE_MS = 30 * 60_000;
const QUERY_CACHE_MAX = 500;
/** 检索时同一类错误多久最多记一行 warn */
const WARN_EVERY_MS = 5 * 60_000;
/** 一条一条算时连着失败这么多条，就当成是配置的问题，停下 */
const MAX_SINGLE_FAILURES = 20;
/** 分段规则的版本，改了分段规则就加 1（text_hash 跟着变，全部重算） */
const SEGMENT_VERSION = 1;

/** 断句的地方，按优先级：空行、换行、中文句末和分号、英文句末后的空白、任意空白 */
const BREAKS = [/\n\s*\n/g, /\n/g, /[。！？!?；;]/g, /[.,，、:：](?=\s)/g, /\s/g];

/**
 * 按长度切段：尽量在 size 的后一半里找断句的地方切，找不到就硬切。最多 max 段，后面的不要。
 * @param {string} text
 * @param {number} size
 * @param {number} max
 */
export function splitText(text, size, max) {
  const out = [];
  let rest = String(text ?? '').trim();
  while (rest && out.length < max) {
    if (rest.length <= size) {
      out.push(rest);
      break;
    }
    const window = rest.slice(0, size);
    let cut = -1;
    for (const re of BREAKS) {
      re.lastIndex = 0;
      let last = -1;
      let m;
      while ((m = re.exec(window))) last = m.index + m[0].length;
      if (last >= size / 2) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = size;
    // 不在一个 emoji（代理对）中间切开
    if (/[\uDC00-\uDFFF]/.test(rest[cut] || '') && cut > 1) cut--;
    const part = rest.slice(0, cut).trim();
    if (part) out.push(part);
    rest = rest.slice(cut).trim();
  }
  return out;
}

/**
 * 条目的分段：标题 + 内容 + 标签，内容长时切成几段（每段不超过 SEGMENT_CHARS 字，最多 MAX_SEGMENTS 段），每段开头都带上标题。
 * 短条目只有一段，文字和全文检索用的 entrySearchText 一样。
 * @param {{title:string, content:string, tags?:string[]}} e
 * @returns {string[]}
 */
export function entrySegments(e) {
  const title = String(e.title ?? '').trim().slice(0, 200);
  const tags = (e.tags || []).join(' ');
  const body = [String(e.content ?? '').trim(), tags].filter(Boolean).join('\n');
  const room = Math.max(300, SEGMENT_CHARS - title.length - 1);
  const parts = splitText(body, room, MAX_SEGMENTS);
  if (!parts.length) return [title || '-'];
  return parts.map((p) => (title ? `${title}\n${p}` : p));
}

/** 分段后文字的哈希（带分段规则的版本） */
export const segmentsHash = (segments) =>
  crypto.createHash('sha1').update(`v${SEGMENT_VERSION}\n${segments.join('\u0000')}`).digest('hex');

/** 库里 embeddings.quant 的值：现在只有 int8（vec 是 dims 个 int8 字节，scale 是缩放系数）。以后换存法改这里，旧格式的行当作没算过 */
export const QUANT = 'int8';

/**
 * int8 量化：缩放系数 = 最大绝对值 / 127，每个数 = round(值 / 缩放系数)。全是 0 的向量缩放系数记 0。
 * 库里和内存里用的是同一份结果：算出来量化一次，存进库，读出来直接用，不再量化
 * @param {Float32Array} v
 * @returns {{q:Int8Array, scale:number}}
 */
export function quantize(v) {
  const d = v.length;
  const q = new Int8Array(d);
  let max = 0;
  for (let i = 0; i < d; i++) {
    const a = Math.abs(v[i]);
    if (a > max) max = a;
  }
  if (!max) return { q, scale: 0 };
  const inv = 127 / max;
  for (let i = 0; i < d; i++) q[i] = Math.round(v[i] * inv);
  return { q, scale: max / 127 };
}

/** 量化后的一段 → 库里存的字节（dims 字节） */
const toBlob = (q) => Buffer.from(q.buffer, q.byteOffset, q.byteLength);
/** 库里一行 → 量化后的一段（不复制，放进索引时才拷进大数组） */
const fromRow = (r) => ({ q: new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength), scale: r.scale });

/**
 * 内存里的向量：int8 量化（quantize，和库里存的一样），每个向量一个缩放系数，一段一个槽位，连续放在一个 Int8Array 里，容量不够时翻倍。
 * 删掉的槽位先空着（缩放系数记 0），空的超过四分之一时整理一次。检索是暴力点积：查询向量不量化，
 * 分数 = 缩放系数 × Σ(int8 × 查询向量)，同一条目几段取最高分。
 * 内存大约是 段数 × (维度 + 8) 字节（容量翻倍时最多再多一倍）。
 */
export class QuantizedIndex {
  /** @param {number} [dims] 0 表示等第一个向量来了再定 */
  constructor(dims = 0) {
    this.dims = dims;
    this.cap = 0;
    /** 用掉的槽位（含删掉的） */
    this.n = 0;
    this.dead = 0;
    this.q = new Int8Array(0);
    this.scale = new Float32Array(0);
    /** 槽位属于哪个条目（条目编号），-1 是删掉的 */
    this.owner = new Int32Array(0);
    /** 条目编号 → id（null 是空出来的编号） */
    this.nums = [];
    this.freeNums = [];
    /** @type {Map<string, {num:number, hash:string, slots:number[]}>} */
    this.byId = new Map();
  }

  /** 有向量的条目数 */
  get entryCount() {
    return this.byId.size;
  }

  /** 有效的段数 */
  get segmentCount() {
    return this.n - this.dead;
  }

  /** 大约占多少字节 */
  get bytes() {
    return this.cap * (this.dims + 8) + this.byId.size * 120;
  }

  has(id) {
    return this.byId.has(id);
  }

  hashOf(id) {
    return this.byId.get(id)?.hash ?? null;
  }

  ids() {
    return [...this.byId.keys()];
  }

  /**
   * 放一个条目的全部段（已有的先拿掉）。段可以是量化好的 {q, scale}（从库里读的、刚算完量化过的，直接拷进来），
   * 也可以是归一化的 Float32Array（这里量化）
   * @param {string} id
   * @param {string} hash
   * @param {({q:Int8Array, scale:number}|Float32Array)[]} vectors 维度都是 dims
   */
  set(id, hash, vectors) {
    const len = (v) => (v instanceof Float32Array ? v.length : v.q.length);
    if (!this.dims && vectors.length) this.dims = len(vectors[0]);
    if (vectors.some((v) => len(v) !== this.dims)) throw new Error(`向量维度不对：要 ${this.dims} 维`);
    this.remove(id);
    let num = this.freeNums.pop();
    if (num === undefined) {
      num = this.nums.length;
      this.nums.push(id);
    } else this.nums[num] = id;
    const slots = [];
    for (const v of vectors) {
      if (this.n === this.cap) this.#grow(Math.max(64, this.cap * 2));
      const s = this.n++;
      this.#write(s, v);
      this.owner[s] = num;
      slots.push(s);
    }
    this.byId.set(id, { num, hash, slots });
  }

  remove(id) {
    const e = this.byId.get(id);
    if (!e) return false;
    for (const s of e.slots) {
      this.owner[s] = -1;
      this.scale[s] = 0;
    }
    this.dead += e.slots.length;
    this.nums[e.num] = null;
    this.freeNums.push(e.num);
    this.byId.delete(id);
    if (this.dead > 256 && this.dead * 4 > this.n) this.compact();
    return true;
  }

  #grow(cap) {
    const q = new Int8Array(cap * this.dims);
    q.set(this.q);
    const scale = new Float32Array(cap);
    scale.set(this.scale);
    const owner = new Int32Array(cap).fill(-1);
    owner.set(this.owner);
    this.q = q;
    this.scale = scale;
    this.owner = owner;
    this.cap = cap;
  }

  #write(s, v) {
    const { q, scale } = v instanceof Float32Array ? quantize(v) : v;
    this.q.set(q, s * this.dims);
    this.scale[s] = scale;
  }

  /** 去掉删掉的槽位，按顺序挪到前面 */
  compact() {
    const d = this.dims;
    const live = this.n - this.dead;
    const cap = Math.max(64, live * 2);
    const q = new Int8Array(cap * d);
    const scale = new Float32Array(cap);
    const owner = new Int32Array(cap).fill(-1);
    const moved = new Int32Array(this.n).fill(-1);
    let j = 0;
    for (let s = 0; s < this.n; s++) {
      if (this.owner[s] < 0) continue;
      q.set(this.q.subarray(s * d, s * d + d), j * d);
      scale[j] = this.scale[s];
      owner[j] = this.owner[s];
      moved[s] = j++;
    }
    for (const e of this.byId.values()) e.slots = e.slots.map((s) => moved[s]);
    Object.assign(this, { q, scale, owner, cap, n: j, dead: 0 });
  }

  /**
   * 暴力检索：和每一段算点积，同一条目取最高分，返回分数最高的 limit 个条目
   * @param {Float32Array} qv 查询向量（已归一化，维度 dims）
   * @param {number} limit
   * @returns {{id:string, score:number}[]}
   */
  search(qv, limit) {
    const d = this.dims;
    const n = this.n;
    const q = this.q;
    const owner = this.owner;
    const scale = this.scale;
    const best = new Float32Array(this.nums.length).fill(-Infinity);
    for (let s = 0, off = 0; s < n; s++, off += d) {
      const o = owner[s];
      if (o < 0) continue;
      // 四路累加比一路快约两成（V8 不会自动向量化）
      let a = 0;
      let b = 0;
      let c = 0;
      let e = 0;
      let i = 0;
      for (; i + 3 < d; i += 4) {
        a += q[off + i] * qv[i];
        b += q[off + i + 1] * qv[i + 1];
        c += q[off + i + 2] * qv[i + 2];
        e += q[off + i + 3] * qv[i + 3];
      }
      for (; i < d; i++) a += q[off + i] * qv[i];
      const score = (a + b + c + e) * scale[s];
      if (score > best[o]) best[o] = score;
    }
    // 取前 limit 个：有序数组，比最后一个大才插进去
    /** @type {{num:number, score:number}[]} */
    const top = [];
    for (let num = 0; num < best.length; num++) {
      const score = best[num];
      if (score === -Infinity || this.nums[num] === null) continue;
      if (top.length >= limit && score <= top[top.length - 1].score) continue;
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (top[mid].score >= score) lo = mid + 1;
        else hi = mid;
      }
      top.splice(lo, 0, { num, score });
      if (top.length > limit) top.pop();
    }
    return top.map((t) => ({ id: this.nums[t.num], score: t.score }));
  }
}

const CANCELLED = 'cancelled';

/**
 * 后台计算 + 内存向量 + 检索。ctx 要 db、kb、log、ai、getSettings、config。
 * @param {any} ctx
 * @param {{debounceMs?:number, now?:() => number}} [opts]
 *   debounceMs：条目改动后等多久再算，0 表示不自动跑（不起任何定时器，测试里手动调 run()）；now：时钟（测试用，算退避的时间）
 */
export function createVectorIndexer(ctx, { debounceMs = VECTOR_DEBOUNCE_MS, now = Date.now } = {}) {
  const { db, kb } = ctx;
  const log = ctx.log || console;
  const auto = debounceMs > 0;
  let closed = false;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {Promise<void>|null} 正在跑的一次计算 */
  let running = null;
  /** 跑的时候又有变动，跑完接着再来一轮 */
  let again = false;
  /** @type {AbortController|null} 在路上的那个请求 */
  let inflight = null;

  // ---- 当前配置 ----
  let sig = null;
  let enabled = false;
  /** @type {any} resolveEmbeddingConfig 的结果（mock 下是假的） */
  let cfg = null;
  let key = null;

  // ---- 内存 ----
  /** @type {QuantizedIndex|null} */
  let mem = null;
  let memKey = null;
  /** 换一份内存（换模型、重新计算）就加 1，读到一半的作废 */
  let memGen = 0;
  /** @type {Promise<QuantizedIndex|null>|null} */
  let loading = null;

  // ---- 状态 ----
  /** idle | running | waiting（退避中） | stopped（出错停下） */
  let state = 'idle';
  /** @type {{message:string, kind:string, at:string}|null} */
  let lastError = null;
  let retryAt = 0;
  let attempt = 0;
  let lastDoneAt = null;
  /** 这个 model_key 有没有成功算过（一次都没成功时单条 4xx 当成配置问题停下） */
  const succeededKeys = new Set();
  /** 一条一条算也算不了的条目：id → 文字哈希（文字没变就不再试） */
  const failed = new Map();
  /** 这些条目要一条一条算（所在的那批被 4xx 拒了，可能是其中一条太长） */
  const splitIds = new Set();
  let singleFailStreak = 0;
  /** @type {number|null} active 条目数的缓存，条目一变就作废 */
  let activeCount = null;
  /** @type {Map<string, {vec:Float32Array, at:number}>} */
  const queryCache = new Map();
  const warnedAt = new Map();

  // scan 按 rowid 翻页：status 前面的 + 让 SQLite 不走 entries(status, …) 索引（走了每页都要把全部 active 条目排一遍序）
  const stmt = {
    scan: db.prepare(
      `SELECT e.rowid AS rid, e.id, e.updated_at AS updatedAt, x.text_hash AS hash, x.source_updated_at AS src
         FROM entries e
         LEFT JOIN embeddings x ON x.kind = 'entry' AND x.ref_id = e.id AND x.chunk = 0 AND x.model_key = ? AND x.quant = '${QUANT}'
        WHERE e.rowid > ? AND +e.status = 'active'
        ORDER BY e.rowid LIMIT ?`,
    ),
    load: db.prepare(
      `SELECT x.ref_id AS id, x.chunk, x.text_hash AS hash, x.scale, x.vec
         FROM embeddings x JOIN entries e ON e.id = x.ref_id
        WHERE x.kind = 'entry' AND +x.model_key = ? AND x.quant = '${QUANT}' AND e.status = 'active' AND x.source_updated_at = e.updated_at
          AND (x.ref_id, x.chunk) > (?, ?)
        ORDER BY x.ref_id, x.chunk LIMIT ?`,
    ),
    loadOne: db.prepare(
      `SELECT chunk, scale, vec FROM embeddings WHERE kind = 'entry' AND ref_id = ? AND model_key = ? AND quant = '${QUANT}' ORDER BY chunk`,
    ),
    dimsOf: db.prepare(`SELECT dims FROM embeddings WHERE model_key = ? AND kind = 'entry' AND quant = '${QUANT}' LIMIT 1`).pluck(),
    touch: db.prepare("UPDATE embeddings SET source_updated_at = ? WHERE kind = 'entry' AND ref_id = ? AND model_key = ?"),
    entryNow: db.prepare('SELECT status, updated_at FROM entries WHERE id = ?'),
    del: db.prepare("DELETE FROM embeddings WHERE kind = 'entry' AND ref_id = ?"),
    ins: db.prepare(
      `INSERT INTO embeddings(kind, ref_id, chunk, model_key, text_hash, source_updated_at, dims, quant, scale, vec, updated_at)
       VALUES('entry', ?, ?, ?, ?, ?, ?, '${QUANT}', ?, ?, ?)`,
    ),
    countFresh: db
      .prepare(
        `SELECT COUNT(*) FROM entries e JOIN embeddings x
            ON x.kind = 'entry' AND x.ref_id = e.id AND x.chunk = 0 AND x.model_key = ? AND x.quant = '${QUANT}'
           AND x.source_updated_at = e.updated_at
          WHERE e.status = 'active'`,
      )
      .pluck(),
  };

  const activeNow = () => {
    if (activeCount === null) activeCount = kb.countActive();
    return activeCount;
  };

  function warnThrottled(kind, msg) {
    const t = now();
    const last = warnedAt.get(kind);
    if (last !== undefined && t - last < WARN_EVERY_MS) return;
    warnedAt.set(kind, t);
    log.warn(msg);
  }

  /** 读设置。配置（含密钥）变了：清掉错误、退避和失败记录；模型或服务变了还要换一份内存、作废查询缓存。返回变没变 */
  function applyConfig() {
    const s = ctx.getSettings();
    const on = !!s.embedding?.enabled;
    const c = ctx.config?.llmMock
      ? { ok: true, format: 'mock', baseUrl: '', apiKey: s.embedding?.apiKey || '', model: s.embedding?.model || 'mock' }
      : resolveEmbeddingConfig(s);
    const keyHash = c.ok && c.apiKey ? crypto.createHash('sha256').update(c.apiKey).digest('hex') : '';
    const next = JSON.stringify([on, c.ok ? [c.format, c.baseUrl, c.model, keyHash] : c.error]);
    if (next === sig) return false;
    sig = next;
    enabled = on;
    cfg = c;
    lastError = null;
    attempt = 0;
    retryAt = 0;
    failed.clear();
    splitIds.clear();
    singleFailStreak = 0;
    if (state !== 'running') state = 'idle';
    const nextKey = c.ok ? embedModelKey(c) : null;
    if (nextKey !== key || !on) {
      inflight?.abort();
      key = nextKey;
      mem = null;
      memKey = null;
      memGen++;
      queryCache.clear();
    }
    if (!on && timer) {
      clearTimeout(timer);
      timer = null;
    }
    return true;
  }

  const usable = () => enabled && !!key && !closed;

  function schedule(ms) {
    if (!auto || closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run().catch((err) => log.error(`[vectors] 后台计算出错：${err?.stack || err}`));
    }, Math.max(0, ms));
    timer.unref?.();
  }

  /** 有变动：在跑就跑完再来一轮；没在跑就防抖后跑。停下、退避中不动（等设置改了、手动重试或退避到点） */
  function kick() {
    if (!usable()) return;
    if (running) {
      again = true;
      return;
    }
    if (state === 'stopped' || state === 'waiting') return;
    schedule(debounceMs);
  }

  /** 把库里当前模型的向量读进内存（翻页之间让出事件循环）。读的时候模型换了就不要了 */
  function ensureLoaded() {
    if (mem && memKey === key) return Promise.resolve(mem);
    if (loading) return loading;
    const k = key;
    const g = memGen;
    loading = (async () => {
      const idx = new QuantizedIndex(stmt.dimsOf.get(k) || 0);
      let lastId = '';
      let lastChunk = -1;
      /** @type {{id:string, hash:string, vecs:{q:Int8Array, scale:number}[]}|null} */
      let group = null;
      const flush = () => {
        if (group && group.vecs.every((v) => v.q.length === idx.dims || !idx.dims)) idx.set(group.id, group.hash, group.vecs);
        group = null;
      };
      for (;;) {
        if (closed || k !== key || g !== memGen) return null;
        const rows = stmt.load.all(k, lastId, lastChunk, LOAD_PAGE);
        if (!rows.length) break;
        for (const r of rows) {
          if (!group || group.id !== r.id) {
            flush();
            group = { id: r.id, hash: r.hash, vecs: [] };
          }
          group.vecs.push(fromRow(r));
        }
        lastId = rows[rows.length - 1].id;
        lastChunk = rows[rows.length - 1].chunk;
        await yieldToLoop();
      }
      flush();
      if (closed || k !== key || g !== memGen) return null;
      mem = idx;
      memKey = k;
      if (idx.entryCount) succeededKeys.add(k);
      return idx;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  /** 库里这个条目当前模型的向量读进内存 */
  function loadOne(idx, id, k, hash) {
    const rows = stmt.loadOne.all(id, k);
    if (!rows.length) return;
    const vecs = rows.map(fromRow);
    if (idx.dims && vecs.some((v) => v.q.length !== idx.dims)) return;
    idx.set(id, hash, vecs);
  }

  /** 出错：返回 again（拆成一条一条再来）、ok（跳过这一条接着算）、stopped 或 waiting */
  function onError(err, items, k) {
    const kind = err instanceof EmbedError || typeof err?.kind === 'string' ? err.kind : 'network';
    const message = String(err?.message || err);
    const at = nowIso();
    if (kind === 'bad_request' && items.length > 1) {
      for (const it of items) splitIds.add(it.id);
      log.warn(`[vectors] 一批 ${items.length} 条被向量接口拒了，改成一条一条算：${message}`);
      return 'again';
    }
    if (kind === 'bad_request' && items.length === 1 && succeededKeys.has(k) && singleFailStreak < MAX_SINGLE_FAILURES) {
      const it = items[0];
      failed.set(it.id, it.hash);
      singleFailStreak++;
      lastError = { message: `有 ${failed.size} 条条目算不了向量，已跳过（文字改了会再试）。最近一条：${message}`, kind, at };
      log.warn(`[vectors] 条目 ${it.id} 算不了向量，先跳过：${message}`);
      return 'ok';
    }
    lastError = { message, kind, at };
    if (FATAL_EMBED_KINDS.has(kind)) {
      state = 'stopped';
      log.warn(`[vectors] 向量计算停下了，等设置改了或手动重试：${message}`);
      return 'stopped';
    }
    const wait =
      kind === 'rate_limit' && Number.isFinite(err?.retryAfterMs) && err.retryAfterMs !== null
        ? Math.max(1000, err.retryAfterMs)
        : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    attempt++;
    retryAt = now() + wait;
    state = 'waiting';
    log.warn(`[vectors] 向量接口暂时不可用，${Math.round(wait / 1000)} 秒后再试：${message}`);
    return 'waiting';
  }

  /** 写库（一个事务）：算的时候条目又改了或删了的不要，下一轮再算。返回写了的 */
  function write(items, vectors, k, dims) {
    const written = [];
    const at = nowIso();
    db.transaction(() => {
      let off = 0;
      for (const it of items) {
        const vecs = vectors.slice(off, off + it.segments.length);
        off += it.segments.length;
        const cur = stmt.entryNow.get(it.id);
        if (!cur || cur.updated_at !== it.updatedAt) continue;
        stmt.del.run(it.id);
        vecs.forEach((v, i) => stmt.ins.run(it.id, i, k, it.hash, it.updatedAt, dims, v.scale, toBlob(v.q), at));
        written.push({ ...it, vecs, active: cur.status === 'active' });
      }
    })();
    return written;
  }

  /** 算一批并写库、放进内存。返回 ok，或者 onError 的结果，或者 cancelled */
  async function embedBatch(items, idx, k) {
    const texts = items.flatMap((it) => it.segments);
    const ac = new AbortController();
    inflight = ac;
    let r;
    try {
      // 后台计算不属于任何号和会话（防抖的定时器可能是在某个会话的处理里起的）
      r = await llmScope({ accountId: null, conversationId: null, purpose: undefined }, () =>
        ctx.ai.embed({ texts, task: 'document', signal: ac.signal }),
      );
    } catch (err) {
      if (ac.signal.aborted || closed || k !== key || idx !== mem) return CANCELLED;
      return onError(err, items, k);
    } finally {
      if (inflight === ac) inflight = null;
    }
    if (closed || k !== key || idx !== mem) return CANCELLED;
    const raw = Array.isArray(r?.vectors) ? r.vectors : null;
    if (!raw || raw.length !== texts.length) {
      return onError(new EmbedError(`向量接口返回了 ${raw?.length ?? 0} 个向量，发过去的是 ${texts.length} 段`, 'bad_response'), items, k);
    }
    const vectors = raw.map((v) => normalizeVector(v instanceof Float32Array ? v : Float32Array.from(v)));
    const dims = vectors[0].length;
    if (!dims || vectors.some((v) => v.length !== dims)) {
      return onError(new EmbedError('向量接口这次返回的几个向量维度不一样', 'bad_response'), items, k);
    }
    const want = idx.dims || stmt.dimsOf.get(k) || 0;
    if (want && want !== dims) {
      return onError(
        new EmbedError(`向量维度和之前算的不一样（之前 ${want} 维，这次 ${dims} 维），可能是服务那边换了模型。点「重新计算」清掉旧向量重算`, 'dims'),
        items,
        k,
      );
    }
    // 量化一次：库里存的和内存里放的是同一份
    for (const w of write(items, vectors.map(quantize), k, dims)) {
      failed.delete(w.id);
      if (w.active) idx.set(w.id, w.hash, w.vecs);
      else idx.remove(w.id);
    }
    succeededKeys.add(k);
    attempt = 0;
    singleFailStreak = 0;
    if (lastError && !failed.size) lastError = null;
    return 'ok';
  }

  /**
   * 一轮：按 rowid 翻页看全部 active 条目，攒够一批就算。一整轮下来没有要算的就收尾（删掉旧模型和已删条目的行，
   * 内存里去掉不再 active 的）。返回 done、again、stopped、waiting 或 cancelled
   */
  async function pass() {
    const k = key;
    const idx = await ensureLoaded();
    if (!idx || closed || k !== key) return CANCELLED;
    const seen = new Set();
    let batch = [];
    let segs = 0;
    let after = 0;
    for (;;) {
      if (closed || k !== key || idx !== mem || !enabled) return CANCELLED;
      const rows = stmt.scan.all(k, after, SCAN_PAGE);
      if (!rows.length) break;
      after = rows[rows.length - 1].rid;
      for (const r of rows) {
        seen.add(r.id);
        if (r.src === r.updatedAt && idx.has(r.id)) continue;
        const e = kb.getEntry(r.id);
        if (!e || e.status !== 'active') continue;
        const segments = entrySegments(e);
        const hash = segmentsHash(segments);
        if (r.hash === hash) {
          // 文字没变（比如只是停用后又启用）：不用重算，记下新的更新时间，读进内存
          if (r.src !== e.updatedAt) stmt.touch.run(e.updatedAt, e.id, k);
          if (idx.hashOf(e.id) !== hash) loadOne(idx, e.id, k, hash);
          continue;
        }
        if (failed.get(e.id) === hash) continue;
        const item = { id: e.id, updatedAt: e.updatedAt, hash, segments };
        if (splitIds.has(e.id)) {
          const res = await embedBatch([item], idx, k);
          if (res !== 'ok') return res;
          continue;
        }
        batch.push(item);
        segs += segments.length;
        if (segs >= BATCH_SEGMENTS) {
          const res = await embedBatch(batch, idx, k);
          if (res !== 'ok') return res;
          batch = [];
          segs = 0;
        }
      }
      await yieldToLoop();
    }
    if (batch.length) {
      const res = await embedBatch(batch, idx, k);
      if (res !== 'ok') return res;
    }
    if (closed || k !== key || idx !== mem) return CANCELLED;
    db.transaction(() => {
      db.prepare("DELETE FROM embeddings WHERE kind = 'entry' AND model_key != ?").run(k);
      db.prepare("DELETE FROM embeddings WHERE kind = 'entry' AND ref_id NOT IN (SELECT id FROM entries)").run();
    })();
    for (const id of idx.ids()) if (!seen.has(id)) idx.remove(id);
    return 'done';
  }

  /**
   * 跑一次（一轮或几轮，直到没有要算的、停下或要退避）。已经在跑就让它跑完再来一轮，返回同一个 Promise。
   * 停下、退避没到点时不跑，force 为 true 时照跑（测试用）
   * @param {{force?:boolean}} [o]
   */
  function run({ force = false } = {}) {
    if (running) {
      again = true;
      return running;
    }
    if (closed) return Promise.resolve();
    applyConfig();
    if (!usable()) return Promise.resolve();
    if (!force && state === 'stopped') return Promise.resolve();
    if (!force && state === 'waiting' && now() < retryAt) {
      // 定时器可能比时钟早一点点到：没到点就按剩下的时间再排一次，免得一直卡在等待里
      schedule(retryAt - now() + 20);
      return Promise.resolve();
    }
    running = (async () => {
      state = 'running';
      let res = CANCELLED;
      try {
        for (;;) {
          again = false;
          res = await pass();
          if (res === 'again') continue;
          if (again && (res === 'done' || res === CANCELLED)) {
            applyConfig();
            if (!usable()) break;
            continue;
          }
          break;
        }
      } catch (err) {
        log.error(`[vectors] 后台计算出错：${err?.stack || err}`);
        res = onError(Object.assign(new Error(`后台计算出错：${err?.message || err}`), { kind: 'internal' }), [], key);
      } finally {
        running = null;
      }
      if (res === 'done') {
        state = 'idle';
        lastDoneAt = nowIso();
        if (!failed.size) lastError = null;
      } else if (res === CANCELLED) {
        state = 'idle';
        if (usable()) schedule(0);
      } else if (res === 'waiting') {
        schedule(retryAt - now());
      }
    })();
    return running;
  }

  // 条目变了：删了、停用了、文字变了的马上从内存拿掉（查不到总比查到旧的好），再防抖后算
  kb.onChange((ev) => {
    activeCount = null;
    if (ev.type === 'delete') {
      mem?.remove(ev.id);
      failed.delete(ev.id);
      splitIds.delete(ev.id);
    } else if ((ev.type === 'update' || ev.type === 'insert') && ev.entry && mem) {
      const e = ev.entry;
      if (e.status !== 'active') mem.remove(e.id);
      else if (mem.has(e.id) && mem.hashOf(e.id) !== segmentsHash(entrySegments(e))) mem.remove(e.id);
    }
    kick();
  });

  return {
    /** 启动：开着就把向量读进内存，防抖后算一轮 */
    start() {
      applyConfig();
      if (!usable()) return;
      if (auto) ensureLoaded().catch((err) => log.error(`[vectors] 读向量出错：${err?.stack || err}`));
      schedule(debounceMs);
    },

    run,

    /** 设置改了（ctx.setSettings 调）：向量检索的配置变了就清掉错误重来，换了模型就换一份内存 */
    onSettingsChanged() {
      if (!applyConfig() || !usable()) return;
      if (running) again = true;
      else schedule(0);
    },

    /** 全部清掉重算（管理员手动「重新计算」） */
    rebuild() {
      applyConfig();
      inflight?.abort();
      db.prepare("DELETE FROM embeddings WHERE kind = 'entry'").run();
      mem = key ? new QuantizedIndex(0) : null;
      memKey = key;
      memGen++;
      lastError = null;
      attempt = 0;
      retryAt = 0;
      failed.clear();
      splitIds.clear();
      singleFailStreak = 0;
      succeededKeys.clear();
      queryCache.clear();
      if (state !== 'running') state = 'idle';
      if (running) again = true;
      else schedule(0);
    },

    /** 停下或退避中时马上再试（不清掉已算的） */
    retry() {
      applyConfig();
      lastError = null;
      attempt = 0;
      retryAt = 0;
      failed.clear();
      splitIds.clear();
      singleFailStreak = 0;
      if (state !== 'running') state = 'idle';
      if (running) again = true;
      else schedule(0);
    },

    /**
     * 按意思检索 active 条目。不能用（没开、没配好、内存还没读好、一条向量都没有）、查询向量失败时返回 null。
     * @param {string} text 查询文字（kb/retrieve.js 截好的）
     * @param {{limit?:number}} [o]
     * @returns {Promise<{hits:{id:string, score:number}[], coverage:number}|null>}
     *   coverage：当前模型的向量覆盖了多少比例的 active 条目
     */
    async search(text, { limit = VECTOR_TOP_K } = {}) {
      applyConfig();
      if (!enabled || closed) return null;
      if (!key) {
        warnThrottled('config', `[vectors] 向量检索开着但没配好，这次只用关键词检索：${cfg?.error || ''}`);
        return null;
      }
      const idx = mem && memKey === key ? mem : null;
      if (!idx) {
        ensureLoaded().catch((err) => log.error(`[vectors] 读向量出错：${err?.stack || err}`));
        return null;
      }
      if (!idx.entryCount) return null;
      const q = String(text ?? '').trim();
      if (!q) return null;
      const k = key;
      const ck = `${k}\n${q}`;
      let qv = queryCache.get(ck);
      if (qv && now() - qv.at < QUERY_CACHE_MS) qv = qv.vec;
      else {
        try {
          const r = await ctx.ai.embed({ texts: [q], task: 'query' });
          const v = r?.vectors?.[0];
          if (!v?.length) throw new EmbedError('向量接口没有返回查询向量', 'bad_response');
          qv = normalizeVector(v instanceof Float32Array ? v : Float32Array.from(v));
        } catch (err) {
          const kind = typeof err?.kind === 'string' ? err.kind : 'error';
          warnThrottled(kind, `[vectors] 查询向量没算出来，这次只用关键词检索：${err?.message || err}`);
          return null;
        }
        if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
        queryCache.set(ck, { vec: qv, at: now() });
      }
      if (k !== key || idx !== mem) return null;
      if (qv.length !== idx.dims) {
        warnThrottled('dims', `[vectors] 查询向量是 ${qv.length} 维，库里的是 ${idx.dims} 维，这次只用关键词检索。可能是服务那边换了模型，点「重新计算」`);
        return null;
      }
      return { hits: idx.search(qv, limit), coverage: Math.min(1, idx.entryCount / Math.max(1, activeNow())) };
    },

    /** 进度和状态（GET /api/kb/vectors） */
    status() {
      applyConfig();
      const active = activeNow();
      const loaded = mem && memKey === key ? mem : null;
      let embedded = 0;
      if (enabled && key) embedded = loaded ? loaded.entryCount : stmt.countFresh.get(key);
      let shown = state;
      if (!enabled) shown = 'disabled';
      else if (!key) shown = 'misconfigured';
      else if (loading && state !== 'running') shown = 'loading';
      return {
        enabled,
        configError: enabled && !key ? cfg?.error || '向量检索没配好' : null,
        format: cfg?.ok ? cfg.format : null,
        model: cfg?.ok ? cfg.model : null,
        state: shown,
        running: shown === 'running' || shown === 'loading',
        activeEntries: active,
        embeddedEntries: Math.min(embedded, active),
        skippedEntries: failed.size,
        segments: loaded?.segmentCount ?? 0,
        dims: loaded?.dims || null,
        memoryBytes: loaded?.bytes ?? 0,
        lastError,
        retryAt: state === 'waiting' && retryAt ? new Date(retryAt).toISOString() : null,
        lastDoneAt,
      };
    },

    /** 内存里的向量（测试用） */
    index: () => (mem && memKey === key ? mem : null),

    /** 关闭：清掉定时器，取消在路上的请求，等正在跑的停下 */
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      inflight?.abort();
      try {
        await running;
      } catch {
        /* 已记日志 */
      }
      try {
        await loading;
      } catch {
        /* 已记日志 */
      }
    },
  };
}
