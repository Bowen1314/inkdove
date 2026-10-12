// 中文按字二元组切词，英文/数字按词。BM25 排序。

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
 * @returns {{doc: T, score: number}[]} 按分数降序（只含 score>0）
 */
export function bm25Rank(query, docs, getText, { k1 = 1.2, b = 0.75 } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !docs.length) return [];
  const docTokens = docs.map((d) => tokenize(getText(d)));
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

export const CONTEXT_CHAR_LIMIT = 40000;

/**
 * 回复检索：全部 active 条目不超过 40000 字符就全放；否则 BM25 取前 20。
 * @param {any[]} entries active 条目
 * @param {string} query
 */
export function selectContextEntries(entries, query, limitChars = CONTEXT_CHAR_LIMIT, topK = 20) {
  const total = entries.reduce((a, e) => a + formatEntryForContext(e).length + 2, 0);
  if (total <= limitChars) return entries;
  return bm25Rank(query, entries, entrySearchText)
    .slice(0, topK)
    .map((r) => r.doc);
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
