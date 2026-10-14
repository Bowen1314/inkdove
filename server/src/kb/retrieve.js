// 回复（自动回复、转人工草稿、推荐回复、/api/kb/ask、红线体检）带进提示词的知识条目怎么挑。规则见 docs/features.md 的
// 「知识库怎么带进回复」：
// 1. 全带：全部 active 条目按提示词里的字数加起来不超过 CONTEXT_CHAR_LIMIT（40000 字符）就全带，顺序按创建时间；
// 2. 检索：超过时用全文索引（kb/store.js 的 searchEntries）按 bm25 排，再按总字数截断（kb/search.js 的 fitToBudget），
//    最多 topK 条；
// 3. 按意思搜（可选，设置里开了向量检索才有，见 kb/vectors.js）：同一段话算一个查询向量，取意思最近的 50 条，
//    和关键词的前 50 条按排名融合（RRF，k=60）后再按总字数截断。查询向量失败、超时、没开时只用关键词，照第 4 步；
// 4. 跨语言改写：关键词命中的条目不到 topK 条、调用方又允许时，调一次模型（ctx.ai.searchTerms）把客户的话改写成
//    知识库语言的检索词，用「改写出来的词 + 原话的词」再查一次。失败、超时、解析不了都退回只用原话的结果。
//    第 3 步用上了、而且当前模型的向量已经覆盖 90% 以上的 active 条目时不改写（按意思搜已经能跨语言找到）；
// 5. 重排（可选，设置里开了重排才有，见 kb/rerank.js）：上面得出的候选（截断之前）取前 40 条发给重排接口按相关度重新排，
//    再按总字数截断。只改顺序，不影响要不要改写（改写多找回来的条目也一起重排）。失败、超时、没开时照原来的顺序。
import { COVERAGE_FOR_NO_REWRITE, VECTOR_TOP_K } from './vectors.js';
import { CONTEXT_CHAR_LIMIT, fitToBudget, MAX_QUERY_TERMS, pickQueryTerms } from './search.js';

/** 改写出来的词最多占多少个检索词的位置（排在原话的词前面，剩下的位置给原话） */
export const REWRITE_MAX_TERMS = 32;
/** 给模型看几个条目标题，让它知道知识库是什么语言 */
export const REWRITE_SAMPLE_TITLES = 15;
/** 同一段话多久之内再检索直接用上次改写的结果（比如转人工后紧接着起草草稿、「换一条」），不再调模型 */
export const REWRITE_CACHE_MS = 30 * 60_000;
const REWRITE_CACHE_MAX = 200;
/** 发给模型改写、算查询向量、重排的话最多多少字（从最近的往前取） */
export const QUERY_TEXT_CHARS = 1500;
/** 检索时多取几倍的候选，按总字数截断时放不下的跳过、还有后面的可选 */
const CANDIDATES_PER_SLOT = 3;
/** 排名融合（Reciprocal Rank Fusion）的常数：分数 = Σ 1 / (RRF_K + 名次) */
export const RRF_K = 60;

/** @type {WeakMap<object, Map<string, {terms:string[], at:number}>>} 每个知识库（kb store）一份改写缓存 */
const rewriteCaches = new WeakMap();

function cacheOf(kb) {
  let m = rewriteCaches.get(kb);
  if (!m) rewriteCaches.set(kb, (m = new Map()));
  return m;
}

/** 模型给的检索词：字符串、去空白、去重，最多 30 个，每个最多 60 字 */
function normalizeTerms(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const t of list) {
    if (typeof t !== 'string' && typeof t !== 'number') continue;
    const v = String(t).trim().slice(0, 60);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 30);
}

/**
 * 发给模型改写、算查询向量、重排用的那段话：按说话的先后排（texts 里越靠后越早），从最近的往前取，最多 QUERY_TEXT_CHARS 字
 * @param {string[]} texts 按优先级从高到低
 * @param {number} [max]
 */
export function queryTextOf(texts, max = QUERY_TEXT_CHARS) {
  let query = '';
  for (const t of texts) {
    const s = String(t ?? '').trim();
    if (!s) continue;
    const next = query ? `${s}\n${query}` : s;
    if (next.length > max) {
      if (!query) query = s.slice(0, max);
      break;
    }
    query = next;
  }
  return query;
}

/**
 * 关键词和向量两路结果按排名融合（RRF）：每条的分数是它在每一路里 1 / (RRF_K + 名次) 的和，名次从 1 开始；
 * 分数一样的关键词那一路在前。只在向量那一路出现的条目按 id 读出来（只要 active 的）。
 * @param {any[]} keywordEntries 关键词检索的结果（条目，按相关度排好）
 * @param {{id:string}[]} vectorHits 向量检索的结果（按相似度排好）
 * @param {any} kb
 * @returns {any[]}
 */
export function rrfMerge(keywordEntries, vectorHits, kb) {
  /** @type {Map<string, {score:number, order:number}>} */
  const scores = new Map();
  const add = (id, rank, order) => {
    const cur = scores.get(id);
    const s = 1 / (RRF_K + rank);
    if (cur) cur.score += s;
    else scores.set(id, { score: s, order });
  };
  keywordEntries.forEach((e, i) => add(e.id, i + 1, i));
  vectorHits.forEach((h, i) => add(h.id, i + 1, keywordEntries.length + i));
  const byId = new Map(keywordEntries.map((e) => [e.id, e]));
  const missing = [...scores.keys()].filter((id) => !byId.has(id));
  for (const e of kb.entriesByIds(missing)) byId.set(e.id, e);
  return [...scores.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
    .map(([id]) => byId.get(id));
}

/**
 * 调模型改写（带缓存）。返回改写出来的词和这次是不是真的调了模型（调了就要计数，失败也算）。
 * @param {any} ctx
 * @param {string[]} texts 检索用的几段话，按优先级从高到低
 * @returns {Promise<{terms:string[], called:boolean}>}
 */
async function rewriteQuery(ctx, texts) {
  const query = queryTextOf(texts);
  const cache = cacheOf(ctx.kb);
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < REWRITE_CACHE_MS) return { terms: hit.terms, called: false };
  try {
    const out = await ctx.ai.searchTerms({ query, sampleTitles: ctx.kb.sampleTitles(REWRITE_SAMPLE_TITLES, 60) });
    const terms = normalizeTerms(out?.terms);
    if (!terms) throw new Error('改写结果里没有 terms 数组');
    if (cache.size >= REWRITE_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(query, { terms, at: Date.now() });
    return { terms, called: true };
  } catch (err) {
    ctx.log?.warn?.(`[kb] 检索词改写失败，只用原话检索：${err?.message || err}`);
    return { terms: [], called: true };
  }
}

/**
 * 挑这一轮带进提示词的条目。
 * @param {any} ctx 要 kb；允许改写时还要 ai.searchTerms 和 log；开了向量检索时用 vectors（kb/vectors.js），开了重排时用 reranker（kb/rerank.js）
 * @param {{texts:string[], limitChars?:number, topK?:number, rewrite?:boolean}} o
 *   texts：检索用的几段话，按优先级从高到低（检索词按 pickQueryTerms 的规则取）；
 *   rewrite：命中不足时允不允许调模型改写（调用方按当天剩下的模型次数决定）
 * @returns {Promise<{entries:any[], mode:'all'|'search', rewriteTerms:string[], llmCalls:number, vector:boolean, rerank:boolean}>}
 *   mode：all 是全带，search 是检索；rewriteTerms：模型改写出来的词（没改写是空数组）；
 *   llmCalls：这次调了几次模型（0 或 1，只算改写；算查询向量、重排不算，不计入会话每天的模型次数）；
 *   vector：这次有没有用上按意思搜；rerank：这次有没有用上重排
 */
export async function selectEntries(ctx, { texts, limitChars = CONTEXT_CHAR_LIMIT, topK = 20, rewrite = false }) {
  const all = ctx.kb.activeEntriesWithin(limitChars);
  if (all) return { entries: all, mode: 'all', rewriteTerms: [], llmCalls: 0, vector: false, rerank: false };
  const query = queryTextOf(texts);
  const vec = ctx.vectors ? await ctx.vectors.search(query) : null;
  const limit = vec ? VECTOR_TOP_K : topK * CANDIDATES_PER_SLOT;
  const terms = pickQueryTerms(texts);
  let ranked = ctx.kb.searchEntries(terms, { limit });
  let rewriteTerms = [];
  let llmCalls = 0;
  const vectorsCover = !!vec && vec.coverage >= COVERAGE_FOR_NO_REWRITE;
  if (rewrite && !vectorsCover && terms.length && ranked.length < topK && typeof ctx.ai?.searchTerms === 'function') {
    const r = await rewriteQuery(ctx, texts);
    llmCalls = r.called ? 1 : 0;
    rewriteTerms = r.terms;
    const extra = pickQueryTerms(rewriteTerms, REWRITE_MAX_TERMS);
    const added = extra.filter((t) => !terms.includes(t));
    if (added.length) {
      const combined = [...extra, ...pickQueryTerms(texts, MAX_QUERY_TERMS - extra.length, extra)];
      ranked = ctx.kb.searchEntries(combined, { limit });
    }
  }
  if (vec?.hits.length) ranked = rrfMerge(ranked, vec.hits, ctx.kb);
  const reranked = ctx.reranker ? await ctx.reranker.rerank(query, ranked) : null;
  if (reranked) ranked = reranked;
  return {
    entries: fitToBudget(ranked, limitChars, topK),
    mode: 'search',
    rewriteTerms,
    llmCalls,
    vector: !!vec?.hits.length,
    rerank: !!reranked,
  };
}
