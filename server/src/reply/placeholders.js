// 推荐回复和草稿里的【待你确认：…】占位：业务员看不懂外文，括号里要确认什么必须是中文。提示词已经要求了（prompts.js 起草规则 3），
// 模型偶尔还是写成客户的语言（【待你确认：fecha de envío】），或者把「待你确认」也翻译了（【Por confirmar: …】）。
// 这里是起草之后的兜底（不调模型的部分）：
// - 认得出的外文标签换回「待你确认」：只认全角【】里、开头是 FOREIGN_LABELS 里的说法、后面跟冒号或直接收尾的，
//   外文草稿正文里不会用全角【】，误伤的可能很小；半角 [To confirm: …] 这类不认（客户那边的正文也可能用方括号）；
// - 找出括号里没有汉字的占位（有日文假名的也算），交给 wa/translate.js 的 fixDraftPlaceholders 一次译成中文再放回去。
// 括号里只有数字、型号、符号（【待你确认：500】【待你确认：A100】）的不算，不用翻译。

/** 占位：【待你确认】后面可以跟全角或半角冒号，括号里是要确认的内容（可以为空） */
const PLACEHOLDER_RE = /【待你确认\s*[：:]?\s*([^】]*)】/g;
/** 全角【】里「标签：内容」或只有标签 */
const LABELED_RE = /【\s*([^【】:：\n]{1,40}?)\s*(?:[：:]\s*([^【】]*?)\s*)?】/g;

/**
 * 模型把「待你确认」翻译成的说法，也收繁体和别的中文说法。比对前两边都过一遍 labelKey（大小写、重音符号不论）。
 * 只收意思就是「待确认」的，像 Note、Info 这类不收。
 */
const FOREIGN_LABEL_LIST = [
  // 英语
  'to confirm',
  'to be confirmed',
  'tbc',
  'please confirm',
  'pending confirmation',
  'needs confirmation',
  'awaiting confirmation',
  // 西班牙语、葡萄牙语
  'por confirmar',
  'a confirmar',
  'para confirmar',
  'pendiente de confirmar',
  'pendiente de confirmacion',
  'pendente de confirmacao',
  // 法语、德语、意大利语
  'a confirmer',
  'zu bestatigen',
  'da confermare',
  // 俄语、印尼语、越南语、土耳其语、阿拉伯语、韩语、日语
  'подтвердить',
  'требует подтверждения',
  'perlu dikonfirmasi',
  'can xac nhan',
  'onaylanacak',
  'للتأكيد',
  '확인 필요',
  '要確認',
  '確認待ち',
  // 中文的别的写法（繁体、少字）
  '待你確認',
  '待您确认',
  '待您確認',
  '待确认',
  '待確認',
];

/** 标签比对用：去掉重音符号、转小写、空白合成一个、去掉末尾的标点 */
function labelKey(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!！。]+$/, '')
    .trim();
}

const FOREIGN_LABELS = new Set(FOREIGN_LABEL_LIST.map(labelKey));
const OUR_LABEL = labelKey('待你确认');

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** 连着两个以上汉字以外的字母（拉丁、西里尔、韩文……）：算一个外文词。A100、B2 这类型号只有一个字母，不算 */
const FOREIGN_WORD = /(?:(?!\p{Script=Han})\p{L}){2,}/u;

/**
 * 占位里要确认的内容是不是外文：有日文假名，或者没有汉字、有外文词。只有数字、型号（A100）、符号的不算。
 * @param {string} content
 */
export function isForeignContent(content) {
  const s = String(content ?? '');
  return KANA.test(s) || (!HAN.test(s) && FOREIGN_WORD.test(s));
}

/** 译文能不能用：有汉字、没有假名 */
export const isChineseText = (s) => HAN.test(String(s ?? '')) && !KANA.test(String(s ?? ''));

/**
 * 把认得出的外文标签换回【待你确认：…】（只有标签的换成【待你确认】）。别的原样不动。
 * @param {string} text
 */
export function normalizePlaceholderLabels(text) {
  return String(text ?? '').replace(LABELED_RE, (whole, label, content) => {
    const key = labelKey(label);
    if (key === OUR_LABEL || !FOREIGN_LABELS.has(key)) return whole;
    const c = (content ?? '').trim();
    return c ? `【待你确认：${c}】` : '【待你确认】';
  });
}

/**
 * 括号里是外文的占位要确认的内容（去掉首尾空白、去重，按出现的先后）
 * @param {string} text
 * @returns {string[]}
 */
export function foreignPlaceholderContents(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) {
    const c = m[1].trim();
    if (c && isForeignContent(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 把占位里的外文换成中文：zh 是 {外文内容: 中文}，没给的占位原样不动。换了的占位统一写成【待你确认：中文】。
 * @param {string} text
 * @param {Map<string, string>} zh
 */
export function replacePlaceholderContents(text, zh) {
  return String(text ?? '').replace(PLACEHOLDER_RE, (whole, content) => {
    const t = zh.get(content.trim());
    return t ? `【待你确认：${t}】` : whole;
  });
}
