// 中文按字二元组切词，英文/数字按词。知识库的检索走 SQLite FTS5 全文索引（kb/store.js 的 searchEntries，挑条目的流程在
// kb/retrieve.js），索引里存的就是这里切好的词；bm25Rank 是内存里的版本，留给小集合用（mock.js、文件挑选）。

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'do', 'you', 'i', 'it', 'what', 'how']);

/** @param {string} text */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = [];
  let run = '';
  let word = '';
  const flushRun = () => {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    run = '';
  };
  const flushWord = () => {
    if (word && !STOP.has(word)) tokens.push(word);
    word = '';
  };
  for (const ch of s) {
    if (CJK.test(ch)) {
      flushWord();
      run += ch;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      flushRun();
      word += ch;
    } else {
      flushRun();
      flushWord();
    }
  }
  flushRun();
  flushWord();
  return tokens;
}

/**
 * BM25 打分。
 * @template T
 * @param {string} query
 * @param {T[]} docs
 * @param {(d: T) => string} getText
 * @param {{k1?:number, b?:number, tokenCache?:{get:(text:string) => string[]}|null}} [opts]
 *   tokenCache：文档切词的缓存（见 createTokenCache），同一批文档每次都要排时不用重新切
 * @returns {{doc: T, score: number}[]} 按分数降序（只含 score>0）
 */
export function bm25Rank(query, docs, getText, { k1 = 1.2, b = 0.75, tokenCache = null } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !docs.length) return [];
  const docTokens = docs.map((d) => (tokenCache ? tokenCache.get(getText(d)) : tokenize(getText(d))));
  const N = docs.length;
  const avgdl = docTokens.reduce((a, t) => a + t.length, 0) / N || 1;
  const df = new Map();
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const results = [];
  docTokens.forEach((toks, i) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qTokens) {
      const f = tf.get(q);
      if (!f) continue;
      const n = df.get(q) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * toks.length) / avgdl));
    }
    if (score > 0) results.push({ doc: docs[i], score });
  });
  results.sort((a, b2) => b2.score - a.score);
  return results;
}

/** 条目用于检索和上下文的文本 */
export const entrySearchText = (e) => `${e.title}\n${e.content}\n${(e.tags || []).join(' ')}`;

/** 条目在 prompt 里的格式（带 id） */
export const formatEntryForContext = (e) =>
  `[id:${e.id}] (${e.type}) ${e.title}\n${e.content}${e.tags?.length ? `\n标签：${e.tags.join('、')}` : ''}`;

/** 一条条目在提示词里占的字数：formatEntryForContext 的长度，另加 2（条目之间的空行） */
export const contextLength = (e) => formatEntryForContext(e).length + 2;

/** 带进提示词的条目总字数上限（全带和检索两条路都按它） */
export const CONTEXT_CHAR_LIMIT = 40000;

/** 条目在全文索引里的文本：标题、内容、标签切好的词用空格连起来（见 db.js 的 entries_fts） */
export const entryIndexText = (e) => tokenize(entrySearchText(e)).join(' ');

/** 一次检索最多用几个词。客户消息很长时会切出几千个词，全用上又慢、排序也被稀释 */
export const MAX_QUERY_TERMS = 64;

/**
 * 检索词：texts 按优先级从高到低排，每段切词、去重后依次放，前面的段先放满。一段放不下时在这段里均匀地挑
 * （开头、中间、结尾都有），不只取开头。
 * @param {string[]} texts
 * @param {number} [max]
 * @param {Iterable<string>} [skip] 已经有了、不用再放的词
 * @returns {string[]}
 */
export function pickQueryTerms(texts, max = MAX_QUERY_TERMS, skip = []) {
  const seen = new Set(skip);
  const out = [];
  for (const text of texts) {
    const room = max - out.length;
    if (room <= 0) break;
    const fresh = [];
    for (const t of tokenize(text)) {
      if (seen.has(t)) continue;
      seen.add(t);
      fresh.push(t);
    }
    if (fresh.length <= room) out.push(...fresh);
    else for (let i = 0; i < room; i++) out.push(fresh[Math.floor((i * fresh.length) / room)]);
  }
  return out;
}

/**
 * FTS5 的 MATCH 串：每个词用双引号包起来（词里的双引号写两遍），用 OR 连起来。这样 AND、OR、NOT、NEAR、* 这些
 * 在引号里都只是普通文字，客户消息里有什么都不会变成查询语法。
 * @param {string[]} terms
 */
export const ftsMatchQuery = (terms) => terms.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ');

/**
 * 按总字数截断：按排名从前往后放整条，放不下的跳过、接着看后面更短的，直到放满 topK 条或者字数用完。
 * 字数按 contextLength 算。
 * @template T
 * @param {T[]} ranked 按相关度从高到低
 * @returns {T[]}
 */
export function fitToBudget(ranked, limitChars = CONTEXT_CHAR_LIMIT, topK = 20) {
  const out = [];
  let used = 0;
  for (const e of ranked) {
    if (out.length >= topK || used >= limitChars) break;
    const n = contextLength(e);
    if (used + n > limitChars) continue;
    out.push(e);
    used += n;
  }
  return out;
}

/**
 * 切词缓存（按原文缓存切好的词），给 bm25Rank 的 tokenCache 用。超过 max 条就整个清空重来。
 * @param {number} [max]
 */
export function createTokenCache(max = 2000) {
  const map = new Map();
  return {
    get(text) {
      let tokens = map.get(text);
      if (!tokens) {
        if (map.size >= max) map.clear();
        tokens = tokenize(text);
        map.set(text, tokens);
      }
      return tokens;
    },
  };
}

/** 二元组 Jaccard 相似度（用于缺口去重） */
export function similarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** 标准化文本（去标点空白，小写），用于精确去重 */
export const normKey = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
