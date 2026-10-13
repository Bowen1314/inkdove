// 本地判断语言（不联网）：翻译接口没告诉我们客户用什么语言时的兜底。用 tinyld（MIT 协议、没有依赖、
// 直接给 ISO 639-1 两位代码、短句也比较准；官方基准约 24 个字符时准确率约 95%）。
// 它认得的 62 种语言里没有马来语（马来语一般会判成印尼语），短于十几个字符的话经常判断不出来。
import { detectAll } from 'tinyld';
import { normalizeLang } from './languages.js';

/** 最可能的那种语言的把握低于这个就当判断不出来 */
const MIN_ACCURACY = 0.5;

/**
 * 判断一段文字是什么语言。判断不出来（太短、全是数字符号、把握太低）返回 null。
 * @param {string} text
 * @returns {string|null} 两位小写代码
 */
export function detectLocal(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let top;
  try {
    top = detectAll(s)[0];
  } catch {
    return null;
  }
  if (!top || typeof top.lang !== 'string' || !(top.accuracy >= MIN_ACCURACY)) return null;
  return normalizeLang(top.lang);
}
