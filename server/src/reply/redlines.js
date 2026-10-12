// 价格、成交和身份红线（SPEC 4.4）的程序硬规则和词表。增补词语只改这个文件。
// 原则：宁可误拦转人工，也不放过。

/** 折扣、优惠类词语：回复里出现时，这个词本身必须出现在本次引用的条目原文里 */
export const DISCOUNT_TERMS = [
  '折扣', '打折', '打个折', '折上折', '优惠', '便宜', '特价', '特惠', '让利', '减价', '降价', '促销',
  '立减', '满减', '返现', '返利', '最低价', '底价', '半价', '买一送一', '优惠券', '代金券', '红包',
  '秒杀', '包邮', '免运费', '免邮', '赠品', '赠送',
  // 单独的 deal 会误伤 "we deal in ..."，只保留短语
  'discount', 'discounts', 'discounted', '% off', 'special price', 'special offer', 'best price',
  'lowest price', 'best deal', 'special deal', 'cheap', 'cheaper', 'cheapest', 'sale price', 'on sale', 'promo',
  'promotion', 'coupon', 'voucher', 'rebate', 'markdown', 'bargain', 'clearance', 'free shipping',
];

/**
 * 成交、承诺、给优惠类措辞：回复里出现直接拦截。
 * 只收"明确表示成交或给优惠"的短语，不收 deal、we can offer you、成交 这类会误伤正常经营描述的单词
 * （"we deal in stainless steel""we can offer you OEM service""月成交量"）。
 */
export const COMMITMENT_TERMS = [
  // 成交
  '就这么成交', '那就成交', '成交了', '可以成交', '同意成交', '可以卖给你', '可以卖给您', '订单已确认', '已确认订单',
  '已确认您的订单', '已确认你的订单', '已为您下单', '已为你下单', '已帮您下单', '已帮你下单', '已经为您下单',
  '一言为定', '就按这个价',
  "it's a deal", 'deal done', 'we have a deal', 'confirmed your order', 'your order is confirmed', 'order confirmed',
  'order has been confirmed', 'we accept your order', 'we have accepted your order',
  // 留货、库存和交期承诺
  '给你留货', '给您留货', '帮你留货', '帮您留货', '给你留着', '给您留着', '帮你留着', '帮您留着', '为你预留',
  '为您预留', '给你预留', '给您预留', '保证有货', '一定有货', '保证交期', '保证发货',
  "i'll reserve", 'i will reserve', "we'll reserve", 'we will reserve', 'reserved for you', "i'll hold", "we'll hold",
  'guaranteed in stock', 'guaranteed delivery',
  // 给优惠
  '给你打折', '给您打折', '给你优惠', '给您优惠', '给你便宜', '给您便宜', '算你便宜', '算您便宜', '给你个优惠价',
  '给您个优惠价', '特价给你', '特价给您',
  'offer you a discount', 'give you a discount', 'special price for you', 'special discount for you',
];

/**
 * 用词表不好表达、按字面又容易误伤的成交措辞，用正则在去掉空白的规范化文本上匹配。
 * "给你留 / 帮您留 100 件"要拦（SPEC 4.4 的例子），"帮您留意""给您留言""留心"不拦。
 */
export const COMMITMENT_PATTERNS = [/[给帮为替][你您]留(?![意言心神])/];

/**
 * 自我身份表述（说自己是 AI、机器人，或者自称真人），以及只有机器才会说的元话语（F14）：回复里出现直接拦截。
 * 元话语只收明确指向"资料库、系统、训练数据"的说法，"根据合同条款""根据我们的政策"不在其列。
 */
export const IDENTITY_TERMS = [
  '我是ai', '我是一个ai', '作为ai', '作为一个ai', '人工智能助手', 'ai助手', 'ai客服', '智能助手', '语言模型',
  '我是机器人', '我是一个机器人', '我不是机器人', '机器人客服', '聊天机器人', '我是真人',
  '我是人工', '真人客服', '我不是ai',
  'as an ai', 'i am an ai', "i'm an ai", "i'm a bot", 'i am a bot', "i'm not a bot", 'i am not a bot',
  "i'm a robot", 'i am a robot', 'ai assistant', 'ai model', 'language model', 'chatbot', 'chat bot',
  'virtual assistant', "i'm human", 'i am human', "i'm a real person", 'i am a real person', 'chatgpt',
  'openai', 'anthropic',
  // F14 元话语
  '知识库', '资料库', '资料显示', '根据资料', '根据我的资料', '根据现有资料', '根据提供的资料', '根据系统', '系统显示',
  '我无法访问', '我没有权限查看', '训练数据',
  'knowledge base', 'according to the information provided', 'according to the provided information',
  'according to my data', 'according to my information', 'based on the provided', 'based on the information provided',
  "i don't have access", 'i do not have access', 'my training',
];

/**
 * F14 套话（客服模板腔）：命中时带提示重写一次，重写后还命中就删掉整句。只管风格，不转人工。
 */
export const CLICHE_TERMS = [
  '感谢您的咨询', '感谢你的咨询', '感谢您的来信', '很高兴为您服务', '很高兴为你服务', '竭诚为您服务',
  '请问还有什么可以帮您', '请问还有什么可以帮你', '还有什么可以帮您', '还有什么可以帮你', '还有什么需要帮助',
  '希望对您有帮助', '希望对你有帮助', '希望能帮到您', '希望能帮到你', '如有任何问题请随时联系', '如有任何疑问',
  '如有其他问题', '随时联系我们', '欢迎随时咨询', '关于您的问题', '关于你的问题', '祝您生活愉快', '祝您购物愉快',
  'great question', 'certainly!', 'absolutely!', 'i hope this helps', 'hope this helps', 'feel free to reach out',
  'feel free to contact', 'is there anything else i can help you with', 'anything else i can help you with',
  'is there anything else i can help with', "don't hesitate to", 'thank you for your inquiry', 'thank you for reaching out',
  'thanks for reaching out', 'i hope this message finds you well', 'happy to assist', 'glad to assist',
];

/** 货币符号或代码写在数字前面 */
const CURRENCY_BEFORE = /(us\$|hk\$|[¥$€£]|(?<![a-z])(?:rmb|cny|usd|eur|gbp|hkd))\s*(\d+(?:\.\d+)?)/g;
/** 货币单位写在数字后面 */
const CURRENCY_AFTER =
  /(\d+(?:\.\d+)?)\s*(?:万|千|k)?\s*(块钱|元|块|美元|美金|欧元|英镑|港币|港元|人民币|[¥$€£]|(?:rmb|cny|usd|eur|gbp|hkd|dollars?|yuan|euros?|pounds?)(?![a-z]))/g;
/** 中文数字写的金额，只能按原样比对 */
const CN_MONEY = /[零〇一二两三四五六七八九十百千万]+\s*(?:块钱|元|块|美元|美金|欧元|英镑|港币|港元)/g;
const PERCENT = /(\d+(?:\.\d+)?)\s*(?:%|percent(?![a-z])|个百分点)/g;
const CN_PERCENT = /百分之[零〇一二两三四五六七八九十百点]+/g;
// "折"后面跟这些字时是别的词（折叠、折旧……），不算折扣
const ZHE_DIGIT = /(\d+(?:\.\d+)?)\s*折(?![叠旧合算线腾磨返射])/g;
const ZHE_CN = /([一二三四五六七八九])([一二三四五六七八九])?\s*折(?![叠旧合算线腾磨返射])/g;
const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 规范化：全角转半角、小写、弯引号转直引号、去掉千分位逗号和空格。
 * @param {string} text
 */
export function normalizeForCheck(text) {
  let s = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'");
  let prev;
  do {
    prev = s;
    s = s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
  } while (s !== prev);
  return s;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAsciiWord = (ch) => /[a-z0-9]/.test(ch);

/** 词语是否出现在已规范化的文本里（英文按词边界，中文忽略空白） */
function hasTerm(norm, term) {
  const t = normalizeForCheck(term);
  const cjk = /[㐀-鿿]/.test(t);
  const hay = cjk ? norm.replace(/\s+/g, '') : norm;
  const body = cjk ? escapeRe(t.replace(/\s+/g, '')) : escapeRe(t).replace(/\s+/g, '\\s+');
  const before = isAsciiWord(t[0]) ? '(?<![a-z0-9])' : '';
  const after = isAsciiWord(t[t.length - 1]) ? '(?![a-z0-9])' : '';
  return new RegExp(`${before}${body}${after}`).test(hay);
}

/** @returns {string[]} 文本里出现的词表词语 */
export function findTerms(text, terms) {
  const norm = normalizeForCheck(text);
  return terms.filter((t) => hasTerm(norm, t));
}

const num = (s) => Number.parseFloat(s);
const zheValue = (n) => (n >= 10 ? n / 10 : n);

/** 提取金额、百分比、"X 折" */
export function extractPriceTokens(text) {
  const norm = normalizeForCheck(text);
  const money = [];
  const literal = [];
  const percent = [];
  const zhe = [];
  for (const m of norm.matchAll(CURRENCY_BEFORE)) money.push({ value: num(m[2]), text: m[0].trim() });
  for (const m of norm.matchAll(CURRENCY_AFTER)) money.push({ value: num(m[1]), text: m[0].trim() });
  for (const m of norm.matchAll(CN_MONEY)) literal.push({ text: m[0].replace(/\s+/g, '') });
  for (const m of norm.matchAll(CN_PERCENT)) literal.push({ text: m[0] });
  for (const m of norm.matchAll(PERCENT)) percent.push({ value: num(m[1]), text: m[0].trim() });
  for (const m of norm.matchAll(ZHE_DIGIT)) zhe.push({ value: zheValue(num(m[1])), text: m[0].trim() });
  for (const m of norm.matchAll(ZHE_CN)) {
    const v = m[2] ? CN_DIGIT[m[1]] + CN_DIGIT[m[2]] / 10 : CN_DIGIT[m[1]];
    zhe.push({ value: v, text: m[0].trim() });
  }
  return { money, literal, percent, zhe };
}

/**
 * 价格数字核对：回复里的金额要在引用条目里出现同样的数值；百分比和"X 折"要在条目里以百分比、"X 折"出现同样的数值；
 * 中文数字写的金额和"百分之几"按原样比对。
 * @returns {string|null} 对不上的第一个片段
 */
export function findUngroundedPrice(reply, sourceText) {
  const r = extractPriceTokens(reply);
  if (!r.money.length && !r.literal.length && !r.percent.length && !r.zhe.length) return null;
  const srcNorm = normalizeForCheck(sourceText);
  const src = extractPriceTokens(sourceText);
  const numbers = new Set([...srcNorm.matchAll(/\d+(?:\.\d+)?/g)].map((m) => num(m[0])));
  const percents = new Set(src.percent.map((p) => p.value));
  const zhes = new Set(src.zhe.map((z) => z.value));
  const srcCompact = srcNorm.replace(/\s+/g, '');
  for (const m of r.money) if (!numbers.has(m.value)) return m.text;
  for (const p of r.percent) if (!percents.has(p.value)) return p.text;
  for (const z of r.zhe) if (!zhes.has(z.value)) return z.text;
  for (const l of r.literal) if (!srcCompact.includes(l.text)) return l.text;
  return null;
}

/**
 * 依次检查身份（含元话语）、成交措辞、价格数字、折扣措辞。
 * @param {string} reply
 * @param {string} sourceText 本次引用条目的原文（标题和内容）
 * @returns {{code:string, reason:string}|null} 拦截的 code（F12 的枚举）和给管理员看的中文原因；通过时返回 null
 */
export function checkRedLines(reply, sourceText) {
  const identity = findTerms(reply, IDENTITY_TERMS);
  if (identity.length) return { code: 'identity_leak', reason: `回复里有身份或元话语「${identity[0]}」，会暴露是机器人` };
  const commit = findTerms(reply, COMMITMENT_TERMS);
  if (commit.length) return { code: 'commitment_phrase', reason: `回复里有成交或承诺措辞「${commit[0]}」` };
  const compact = normalizeForCheck(reply).replace(/\s+/g, '');
  for (const re of COMMITMENT_PATTERNS) {
    const m = re.exec(compact);
    if (m) return { code: 'commitment_phrase', reason: `回复里有成交或承诺措辞「${m[0]}」` };
  }
  const price = findUngroundedPrice(reply, sourceText);
  if (price) return { code: 'price_mismatch', reason: `价格数字对不上资料：回复里的「${price}」在引用的条目里找不到` };
  const srcNorm = normalizeForCheck(sourceText);
  const discount = findTerms(reply, DISCOUNT_TERMS).filter((t) => !hasTerm(srcNorm, t));
  if (discount.length) return { code: 'discount_word', reason: `回复里有资料没写的优惠措辞「${discount[0]}」` };
  return null;
}

/**
 * 把含套话的整句删掉（F14 第 3 条）。按 。！？!?；; 和换行切句，英文句点后面跟空白或结尾才算句末（避免切开 59.5）。
 * @returns {string} 删完后的文本（可能为空）
 */
export function stripClicheSentences(text, terms = CLICHE_TERMS) {
  const pieces = String(text).match(/[^。！？!?；;\n]*?(?:[。！？!?；;]+|\.(?=\s|$)|\n|$)/g) || [];
  const kept = pieces.filter((p) => p && !findTerms(p, terms).length);
  return kept
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
