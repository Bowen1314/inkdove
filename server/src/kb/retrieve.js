// 回复（自动回复、转人工草稿、推荐回复、/api/kb/ask、红线体检）带进提示词的知识条目怎么挑。规则见 docs/features.md 的
// 「知识库怎么带进回复」：
// 1. 全带：全部 active 条目按提示词里的字数加起来不超过 CONTEXT_CHAR_LIMIT（40000 字符）就全带，顺序按创建时间；
// 2. 检索：超过时用全文索引（kb/store.js 的 searchEntries）按 bm25 排，再按总字数截断（kb/search.js 的 fitToBudget），
//    最多 topK 条；
// 3. 跨语言改写：第 2 步命中的条目不到 topK 条、调用方又允许时，调一次模型（ctx.ai.searchTerms）把客户的话改写成
//    知识库语言的检索词，用「改写出来的词 + 原话的词」再查一次。失败、超时、解析不了都退回只用原话的结果。
import { CONTEXT_CHAR_LIMIT, fitToBudget, MAX_QUERY_TERMS, pickQueryTerms } from './search.js';

/** 改写出来的词最多占多少个检索词的位置（排在原话的词前面，剩下的位置给原话） */
export const REWRITE_MAX_TERMS = 32;
/** 给模型看几个条目标题，让它知道知识库是什么语言 */
export const REWRITE_SAMPLE_TITLES = 15;
/** 同一段话多久之内再检索直接用上次改写的结果（比如转人工后紧接着起草草稿、「换一条」），不再调模型 */
export const REWRITE_CACHE_MS = 30 * 60_000;
const REWRITE_CACHE_MAX = 200;
/** 发给模型改写的话最多多少字（从最近的往前取） */
const REWRITE_INPUT_CHARS = 1500;
/** 检索时多取几倍的候选，按总字数截断时放不下的跳过、还有后面的可选 */
const CANDIDATES_PER_SLOT = 3;

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
 * 调模型改写（带缓存）。返回改写出来的词和这次是不是真的调了模型（调了就要计数，失败也算）。
 * @param {any} ctx
 * @param {string[]} texts 检索用的几段话，按优先级从高到低
 * @returns {Promise<{terms:string[], called:boolean}>}
 */
async function rewriteQuery(ctx, texts) {
  // 发给模型的按说话的先后排（texts 里越靠后越早），从最近的往前取，最多 REWRITE_INPUT_CHARS 字
  let query = '';
  for (const t of texts) {
    const s = String(t ?? '').trim();
    if (!s) continue;
    const next = query ? `${s}\n${query}` : s;
    if (next.length > REWRITE_INPUT_CHARS) {
      if (!query) query = s.slice(0, REWRITE_INPUT_CHARS);
      break;
    }
    query = next;
  }
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
 * @param {any} ctx 要 kb；允许改写时还要 ai.searchTerms 和 log
 * @param {{texts:string[], limitChars?:number, topK?:number, rewrite?:boolean}} o
 *   texts：检索用的几段话，按优先级从高到低（检索词按 pickQueryTerms 的规则取）；
 *   rewrite：命中不足时允不允许调模型改写（调用方按当天剩下的模型次数决定）
 * @returns {Promise<{entries:any[], mode:'all'|'search', rewriteTerms:string[], llmCalls:number}>}
 *   mode：all 是全带，search 是检索；rewriteTerms：模型改写出来的词（没改写是空数组）；llmCalls：这次调了几次模型（0 或 1）
 */
export async function selectEntries(ctx, { texts, limitChars = CONTEXT_CHAR_LIMIT, topK = 20, rewrite = false }) {
  const all = ctx.kb.activeEntriesWithin(limitChars);
  if (all) return { entries: all, mode: 'all', rewriteTerms: [], llmCalls: 0 };
  const limit = topK * CANDIDATES_PER_SLOT;
  const terms = pickQueryTerms(texts);
  let ranked = ctx.kb.searchEntries(terms, { limit });
  let rewriteTerms = [];
  let llmCalls = 0;
  if (rewrite && terms.length && ranked.length < topK && typeof ctx.ai?.searchTerms === 'function') {
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
  return { entries: fitToBudget(ranked, limitChars, topK), mode: 'search', rewriteTerms, llmCalls };
}
