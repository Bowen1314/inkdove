// 屏蔽词匹配：纯函数，不读设置、不写库。规则（docs/features.md 的「屏蔽词」写给管理员看的版本）：
// 1. 先规范化：逐字做 NFKC（全角字母数字和标点变半角、①变 1、ﬁ 拆开）再转小写；零宽空格、零宽连接符、软连字符这类
//    看不见的格式字符当作不存在。重音不去掉（año 和 ano 是两个词）。
// 2. 只拿「字」（字母、数字和跟在它们后面的组合符号）去比，字和字之间的东西记成一种间隔：
//    无（紧挨着）< 符号（. * - _ emoji 等）< 空格 < 断句标点（，。、！？；：和撇号）< 换行。
// 3. 中日韩泰等不用空格分词的文字按子串匹配：「坏词」在「这个坏词啊」里算命中；拉丁、西里尔、阿拉伯等用空格分词的文字
//    按整词匹配：前后紧挨着同类字母或数字的不算（cat 不命中 category、concat），夹着符号接数字的也不算（sb 不命中 SB-200、
//    SB200），中间隔着空格、符号或者挨着汉字的算词的边界（「你sb了」算命中）。
// 4. 防故意拆开：词中间夹符号的照样算命中（b.a.d、b*a*d、坏.词、坏*词）；夹空格的，中日韩的照样算（坏 词），拉丁字母只认
//    一个字母一个字母拆开的写法（b a d、b. a. d.），「is hit」「s hit」不算 shit 这类词。夹着断句标点或换行的不算
//    （「我很坏，词穷了」不算「坏词」，「he'll」不算「hell」）。
// 5. 管理员填的词自己带空格或符号的（son of a gun 这类短语），那几处可以是空格、符号或者紧挨着。
// 命中返回原文里的位置（UTF-16 下标，前端直接用来标红），一个词最多记 MAX_RANGES_PER_WORD 处。
import { badRequest } from '../util.js';

/** 屏蔽词最多几个 */
export const MAX_BLOCKWORDS = 500;
/** 每个屏蔽词最多几个字（按码点数，去掉首尾空白之后） */
export const MAX_BLOCKWORD_CHARS = 40;
/** 一个词在一条消息里最多记几处位置 */
export const MAX_RANGES_PER_WORD = 20;

const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
const COMBINING = /\p{M}/u;
/** 零宽空格、零宽连接符、软连字符、BOM 这类格式字符：当作不存在 */
const FORMAT = /\p{Cf}/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;
const SPACE = /\s/u;
/** 断句标点和撇号（NFKC 之后，全角的已经变成半角） */
const HARD = /[,;:!?、。'‘’‛ʼ]/u;
/** 不用空格分词的文字：按子串匹配，不查词的边界 */
const NO_SPACE_SCRIPT =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Bopomofo}\p{scx=Tibetan}]/u;
/** 拉丁字母（判断 AI 扩充的词是不是太短，见 expand.js） */
export const LATIN = /\p{sc=Latin}/u;
export const HAN = /\p{sc=Han}/u;

// 间隔种类，数越大隔得越开
const NONE = 0;
const MARK = 1;
const GAP_SPACE = 2;
const GAP_HARD = 3;
const GAP_BREAK = 4;

function gapKind(c) {
  if (LINE_BREAK.test(c)) return GAP_BREAK;
  if (SPACE.test(c)) return GAP_SPACE;
  if (HARD.test(c)) return GAP_HARD;
  return MARK;
}

const cpLen = (cp) => (cp > 0xffff ? 2 : 1);

/**
 * 把一段文字拆成「字」的序列：chars[i] 是规范化后的一个码点，starts/ends 是它在原文里对应的范围（UTF-16 下标，
 * 一个原文字符规范化成几个字时，这几个字对应同一个范围），gaps[i] 是它和前一个字之间的间隔，cjk[i] 是不是不用空格分词的文字。
 * @param {string} text
 */
export function analyze(text) {
  const s = String(text ?? '');
  const chars = [];
  const starts = [];
  const ends = [];
  const gaps = [];
  const cjk = [];
  let gap = NONE;
  let i = 0;
  while (i < s.length) {
    let j = i + cpLen(s.codePointAt(i));
    if (FORMAT.test(s.slice(i, j))) {
      i = j;
      continue;
    }
    // 后面跟着的组合符号（重音、泰文元音等）和这个字一起规范化，对应同一个原文范围
    while (j < s.length) {
      const k = j + cpLen(s.codePointAt(j));
      if (!COMBINING.test(s.slice(j, k))) break;
      j = k;
    }
    let lastWord = false;
    let lastCjk = false;
    for (const c of s.slice(i, j).normalize('NFKC').toLowerCase()) {
      const word = WORD.test(c);
      if (word || (lastWord && COMBINING.test(c))) {
        chars.push(c);
        starts.push(i);
        ends.push(j);
        gaps.push(gap);
        // 组合符号跟着前面的字走
        lastCjk = word ? NO_SPACE_SCRIPT.test(c) : lastCjk;
        cjk.push(lastCjk);
        gap = NONE;
        lastWord = true;
      } else if (COMBINING.test(c) || FORMAT.test(c)) {
        // 不跟在字后面的组合符号（比如 ´ 规范化出来的）忽略
      } else {
        gap = Math.max(gap, gapKind(c));
        lastWord = false;
      }
    }
    i = j;
  }
  return { chars, starts, ends, gaps, cjk };
}

/** 去重用的键：规范化后只留字（大小写、全角半角、中间的空格和符号都不算区别） */
export function wordKey(word) {
  return analyze(word).chars.join('');
}

/** 一个屏蔽词编译成 {word（管理员填的原样）, key, len, sep（词自己带分隔的位置）}；里面没有字的返回 null */
function compileWord(word) {
  const a = analyze(word);
  if (!a.chars.length) return null;
  const sep = new Set();
  for (let k = 1; k < a.chars.length; k++) if (a.gaps[k] !== NONE) sep.add(k);
  return { word, key: a.chars.join(''), len: a.chars.length, sep };
}

let cache = { sig: '', list: null };

/**
 * 编译一组屏蔽词。按词表内容缓存最近一份（设置没改时每次发送不用重新编译）。
 * @param {string[]} words
 */
export function compileList(words) {
  const sig = JSON.stringify(words);
  if (cache.sig === sig && cache.list) return cache.list;
  const list = [];
  for (const w of words) {
    const c = compileWord(w);
    if (c) list.push(c);
  }
  cache = { sig, list };
  return list;
}

/** 两个字隔着这个间隔算不算连在一起（同一个词里）：紧挨着算；夹着符号、一边是数字的也算（SB-200、x.1） */
function connected(a, left, right) {
  const g = a.gaps[right];
  if (g === NONE) return true;
  return g === MARK && (DIGIT.test(a.chars[left]) || DIGIT.test(a.chars[right]));
}

/** 在 [p, end) 里，从 q 往一个方向数紧挨着（间隔为无）的字有几个 */
function runLength(a, p, end, q, dir) {
  let n = 1;
  if (dir < 0) {
    for (let x = q; x > p && a.gaps[x] === NONE; x--) n++;
  } else {
    for (let x = q + 1; x < end && a.gaps[x] === NONE; x++) n++;
  }
  return n;
}

/** 文字里从第 p 个字开始的这一处，按规则算不算命中词 w */
function accept(a, p, w) {
  const end = p + w.len;
  for (let k = 1; k < w.len; k++) {
    const g = a.gaps[p + k];
    if (g === NONE || g === MARK) continue;
    // 夹着断句标点或换行：不是一句话里的，不算
    if (g >= GAP_HARD) return false;
    // 空格：词自己在这里带分隔、或者挨着中日韩文字的算；拉丁等文字只认一个字母一个字母拆开的写法
    if (w.sep.has(k) || a.cjk[p + k - 1] || a.cjk[p + k]) continue;
    if (runLength(a, p, end, p + k - 1, -1) !== 1 || runLength(a, p, end, p + k, 1) !== 1) return false;
  }
  // 用空格分词的文字查词的边界：前后挨着的也是这类文字（字母、数字）就是别的词的一部分
  const first = p;
  const last = end - 1;
  if (!a.cjk[first] && first > 0 && !a.cjk[first - 1] && connected(a, first - 1, first)) return false;
  if (!a.cjk[last] && last + 1 < a.chars.length && !a.cjk[last + 1] && connected(a, last, last + 1)) return false;
  return true;
}

/**
 * 找出文字里命中的屏蔽词。没命中返回空数组。
 * @param {ReturnType<typeof compileList>} list
 * @param {string} text
 * @returns {{word:string, ranges:[number, number][]}[]} 按第一次出现的位置排；ranges 是原文里的 [开始, 结束)
 */
export function findHits(list, text) {
  if (!list.length || !text) return [];
  const a = analyze(text);
  if (!a.chars.length) return [];
  const joined = a.chars.join('');
  // joined 里每个字的起点（UTF-16 下标）→ 第几个字
  const indexAt = new Int32Array(joined.length).fill(-1);
  for (let i = 0, off = 0; i < a.chars.length; off += a.chars[i].length, i++) indexAt[off] = i;
  const hits = [];
  for (const w of list) {
    const ranges = [];
    for (let off = joined.indexOf(w.key); off >= 0 && ranges.length < MAX_RANGES_PER_WORD; off = joined.indexOf(w.key, off + 1)) {
      const p = indexAt[off];
      if (p >= 0 && accept(a, p, w)) ranges.push([a.starts[p], a.ends[p + w.len - 1]]);
    }
    if (ranges.length) hits.push({ word: w.word, ranges });
  }
  return hits.sort((x, y) => x.ranges[0][0] - y.ranges[0][0]);
}

/**
 * 校验并整理管理员提交的词表：每行一个词，去掉首尾空白、连续空白合成一个空格，空行跳过，重复的（按 wordKey）只留第一个。
 * 错误信息以 blockwords.words 开头（前端靠它把错误放到输入框下面），「第 N 行」按提交的数组下标算（前端按行拆分，空行也带上）。
 * @param {unknown} v
 * @returns {string[]}
 */
export function normalizeWordList(v) {
  if (!Array.isArray(v)) throw badRequest('blockwords.words 必须是数组');
  const out = [];
  const seen = new Set();
  v.forEach((raw, i) => {
    if (typeof raw !== 'string') throw badRequest(`blockwords.words 第 ${i + 1} 行必须是字符串`);
    const w = raw.trim().replace(/\s+/g, ' ');
    if (!w) return;
    if ([...w].length > MAX_BLOCKWORD_CHARS) {
      throw badRequest(`blockwords.words 第 ${i + 1} 行过长，每个词最多 ${MAX_BLOCKWORD_CHARS} 个字`);
    }
    const key = wordKey(w);
    if (!key) throw badRequest(`blockwords.words 第 ${i + 1} 行「${w}」不含文字或数字，无法匹配任何内容`);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  });
  if (out.length > MAX_BLOCKWORDS) throw badRequest(`blockwords.words 最多 ${MAX_BLOCKWORDS} 个词，当前 ${out.length} 个`);
  return out;
}
