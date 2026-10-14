// 可选的重排（rerank）。规则见 docs/features.md 的「知识库怎么带进回复」：
// - 只在检索这一档（kb/retrieve.js 的 selectEntries 走到检索时）用：关键词（和按意思搜，开了的话）合并出来的候选，取前
//   RERANK_CANDIDATES 条，连同查询那段话（和查询向量、改写用的同一段）发给重排接口，按分数重新排，剩下的接在后面原样不动，
//   再交回去按总字数截断。只改顺序，不按分数去掉条目（各家模型的分数不能互相比，也没有通用的门槛）；
// - 发过去的条目文字是「标题 + 内容 + 标签」，每条最多 RERANK_DOC_CHARS 字（常见重排模型一条的上限是 512 到几千 token）；
// - 失败（没配好、超时 8 秒、HTTP 出错、返回格式不对）时返回 null，调用方照原来的顺序走，日志同一类问题 5 分钟最多记一行 warn；
// - 缓存：同一段话 + 同一批候选（条目 id 和更新时间）30 分钟内直接用上次排好的顺序，存在内存里，最多 RERANK_CACHE_MAX 份，
//   重排的设置一变就清空。
// 重排接口的调用不计入会话每天的模型次数（llm_calls 照记，purpose 是 rerank）。
import crypto from 'node:crypto';
import { resolveRerankConfig } from '../settings.js';

/** 最多拿前几条候选去重排（检索最多带 20 条，多给一倍的余地；候选越多越贵越慢） */
export const RERANK_CANDIDATES = 40;
/** 每条发过去的文字最多多少字 */
export const RERANK_DOC_CHARS = 2000;
/** 排好的顺序缓存多久、最多几份 */
export const RERANK_CACHE_MS = 30 * 60_000;
const RERANK_CACHE_MAX = 200;
/** 同一类错误多久最多记一行 warn */
const WARN_EVERY_MS = 5 * 60_000;

/**
 * 发给重排接口的条目文字：标题、内容、标签（不带提示词里的 [id:…] 和类型，对重排模型是噪声），最多 RERANK_DOC_CHARS 字
 * @param {{title?:string, content?:string, tags?:string[]}} e
 */
export function rerankDocText(e) {
  const tags = e.tags?.length ? `标签：${e.tags.join('、')}` : '';
  const text = [String(e.title ?? '').trim(), String(e.content ?? '').trim(), tags].filter(Boolean).join('\n');
  if (text.length <= RERANK_DOC_CHARS) return text;
  // 不在一个 emoji（代理对）中间切开
  let cut = RERANK_DOC_CHARS;
  if (/[\uDC00-\uDFFF]/.test(text[cut] || '')) cut--;
  return text.slice(0, cut);
}

/**
 * ctx 要 getSettings、ai（ai.rerank）、log、config。
 * @param {any} ctx
 * @param {{now?:() => number}} [opts] now：时钟（测试用，算缓存和日志的间隔）
 */
export function createReranker(ctx, { now = Date.now } = {}) {
  const log = ctx.log || console;
  let sig = null;
  let enabled = false;
  /** @type {any} resolveRerankConfig 的结果（mock 下是假的） */
  let cfg = null;
  /** @type {Map<string, {ids:string[], at:number}>} */
  const cache = new Map();
  const warnedAt = new Map();

  function warnThrottled(kind, msg) {
    const t = now();
    const last = warnedAt.get(kind);
    if (last !== undefined && t - last < WARN_EVERY_MS) return;
    warnedAt.set(kind, t);
    log.warn(msg);
  }

  /** 读设置。重排的设置（含密钥）变了就清掉缓存。返回变没变 */
  function applyConfig() {
    const s = ctx.getSettings();
    const r = s.rerank || {};
    const on = !!r.enabled;
    const c = ctx.config?.llmMock ? { ok: true, baseUrl: '', apiKey: '', model: r.model || 'mock' } : resolveRerankConfig(s);
    const keyHash = c.ok && c.apiKey ? crypto.createHash('sha256').update(c.apiKey).digest('hex') : '';
    const next = JSON.stringify([on, c.ok ? [c.baseUrl, c.model, keyHash] : c.error]);
    if (next === sig) return false;
    sig = next;
    enabled = on;
    cfg = c;
    cache.clear();
    return true;
  }

  return {
    /** 设置改了（ctx.setSettings 调）：重排的配置变了就清掉缓存 */
    onSettingsChanged() {
      applyConfig();
    },

    /**
     * 按和 query 的相关度把前 RERANK_CANDIDATES 条候选重新排，后面的接在后面原样不动。
     * 没开、没配好、候选不到 2 条、接口出错时返回 null（调用方照原来的顺序）。
     * @param {string} query 查询那段话（kb/retrieve.js 截好的）
     * @param {any[]} entries 候选条目（按原来的相关度排好）
     * @returns {Promise<any[]|null>}
     */
    async rerank(query, entries) {
      applyConfig();
      if (!enabled) return null;
      if (!cfg.ok) {
        warnThrottled('config', `[rerank] 重排开着但没配好，这次按原来的顺序：${cfg.error}`);
        return null;
      }
      const q = String(query ?? '').trim();
      if (!q || entries.length < 2 || typeof ctx.ai?.rerank !== 'function') return null;
      const head = entries.slice(0, RERANK_CANDIDATES);
      const tail = entries.slice(RERANK_CANDIDATES);
      const mySig = sig;
      const ck = crypto
        .createHash('sha256')
        .update(`${mySig}\n${q}\n${head.map((e) => `${e.id}@${e.updatedAt ?? ''}`).sort().join(',')}`)
        .digest('hex');
      let ids = null;
      const hit = cache.get(ck);
      if (hit && now() - hit.at < RERANK_CACHE_MS) ids = hit.ids;
      else {
        let r;
        try {
          r = await ctx.ai.rerank({ query: q, documents: head.map(rerankDocText) });
          if (!Array.isArray(r?.results)) throw Object.assign(new Error('重排接口没有返回结果'), { kind: 'bad_response' });
        } catch (err) {
          const kind = typeof err?.kind === 'string' ? err.kind : 'error';
          warnThrottled(kind, `[rerank] 重排没成功，这次按原来的顺序：${err?.message || err}`);
          return null;
        }
        const seen = new Set();
        ids = [];
        for (const x of r.results) {
          const e = head[x?.index];
          if (!e || seen.has(x.index)) continue;
          seen.add(x.index);
          ids.push(e.id);
        }
        if (!ids.length) {
          warnThrottled('bad_response', '[rerank] 重排接口返回的序号都对不上，这次按原来的顺序');
          return null;
        }
        // 算的时候设置变了就不存（缓存已经清过了）
        if (mySig === sig) {
          if (cache.size >= RERANK_CACHE_MAX) cache.delete(cache.keys().next().value);
          cache.set(ck, { ids, at: now() });
        }
      }
      // 排好的在前；接口没返回的（有的服务只回一部分）按原来的顺序接在后面
      const pos = new Map(ids.map((id, i) => [id, i]));
      const ordered = head
        .map((e, i) => ({ e, i, p: pos.has(e.id) ? pos.get(e.id) : Infinity }))
        .sort((a, b) => a.p - b.p || a.i - b.i)
        .map((x) => x.e);
      return [...ordered, ...tail];
    },

    /** 缓存了几份（测试用） */
    cacheSize: () => cache.size,
  };
}
