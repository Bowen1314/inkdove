// 翻译接口内部统一用 ISO 639-1 两位小写代码（zh、en、es ……），不分简繁、不分地区；各家服务的写法（DeepL 的 EN-US、
// 百度的 jp / kor、谷歌的 iw ……）在各自的文件里转换。界面上显示的语言名（「已翻译为 西班牙语」）查这里的表。

/** 两位代码 → 中文名。表里没有的代码照原样显示 */
export const LANGUAGE_NAMES = {
  zh: '中文',
  en: '英语',
  es: '西班牙语',
  pt: '葡萄牙语',
  fr: '法语',
  de: '德语',
  it: '意大利语',
  ru: '俄语',
  ja: '日语',
  ko: '韩语',
  ar: '阿拉伯语',
  tr: '土耳其语',
  vi: '越南语',
  th: '泰语',
  id: '印尼语',
  ms: '马来语',
  tl: '菲律宾语',
  hi: '印地语',
  bn: '孟加拉语',
  ur: '乌尔都语',
  fa: '波斯语',
  he: '希伯来语',
  nl: '荷兰语',
  pl: '波兰语',
  uk: '乌克兰语',
  ro: '罗马尼亚语',
  el: '希腊语',
  cs: '捷克语',
  sk: '斯洛伐克语',
  sl: '斯洛文尼亚语',
  hu: '匈牙利语',
  bg: '保加利亚语',
  sr: '塞尔维亚语',
  hr: '克罗地亚语',
  bs: '波斯尼亚语',
  mk: '马其顿语',
  sq: '阿尔巴尼亚语',
  sv: '瑞典语',
  da: '丹麦语',
  no: '挪威语',
  fi: '芬兰语',
  is: '冰岛语',
  et: '爱沙尼亚语',
  lv: '拉脱维亚语',
  lt: '立陶宛语',
  be: '白俄罗斯语',
  ka: '格鲁吉亚语',
  hy: '亚美尼亚语',
  az: '阿塞拜疆语',
  kk: '哈萨克语',
  uz: '乌兹别克语',
  ky: '吉尔吉斯语',
  tg: '塔吉克语',
  tk: '土库曼语',
  mn: '蒙古语',
  tt: '鞑靼语',
  ps: '普什图语',
  ku: '库尔德语',
  ne: '尼泊尔语',
  si: '僧伽罗语',
  ta: '泰米尔语',
  te: '泰卢固语',
  kn: '卡纳达语',
  ml: '马拉雅拉姆语',
  mr: '马拉地语',
  gu: '古吉拉特语',
  pa: '旁遮普语',
  my: '缅甸语',
  km: '高棉语',
  lo: '老挝语',
  sw: '斯瓦希里语',
  am: '阿姆哈拉语',
  so: '索马里语',
  ha: '豪萨语',
  yo: '约鲁巴语',
  ig: '伊博语',
  zu: '祖鲁语',
  xh: '科萨语',
  af: '南非荷兰语',
  rw: '卢旺达语',
  mg: '马达加斯加语',
  ca: '加泰罗尼亚语',
  eu: '巴斯克语',
  gl: '加利西亚语',
  cy: '威尔士语',
  ga: '爱尔兰语',
  mt: '马耳他语',
  lb: '卢森堡语',
  la: '拉丁语',
  eo: '世界语',
  ht: '海地克里奥尔语',
  jv: '爪哇语',
  su: '巽他语',
  mi: '毛利语',
  sm: '萨摩亚语',
  yi: '意第绪语',
};

/** 中文名（显示用）：表里没有就显示代码本身 */
export const languageName = (code) => LANGUAGE_NAMES[code] || String(code || '');

/** 各家返回的写法里常见的别名 → 两位代码（三位代码、旧代码） */
const ALIASES = {
  iw: 'he',
  ji: 'yi',
  in: 'id',
  jw: 'jv',
  fil: 'tl',
  nb: 'no',
  nn: 'no',
  zt: 'zh',
  pb: 'pt',
  yue: 'zh',
  lzh: 'zh',
  wyw: 'zh',
  cmn: 'zh',
  ckb: 'ku',
  kmr: 'ku',
};

/**
 * 把各家返回的语言代码规范成两位小写代码：去掉地区和文字变体（zh-Hans、EN-US、pt-BR → zh、en、pt），认识常见别名。
 * 不是 2–3 位字母的返回 null。三位代码（没有对应两位代码的）原样返回，界面上照原样显示。
 * @param {unknown} code
 */
export function normalizeLang(code) {
  if (typeof code !== 'string') return null;
  const s = code.trim().toLowerCase().replace(/_/g, '-');
  if (!s || s === 'auto' || s === 'und') return null;
  if (ALIASES[s]) return ALIASES[s];
  const base = s.split('-')[0];
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  return ALIASES[base] || base;
}
