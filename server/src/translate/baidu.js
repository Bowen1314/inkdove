// 百度翻译开放平台「通用文本翻译」（https://fanyi-api.baidu.com/doc/23）：
// - POST https://fanyi-api.baidu.com/api/trans/vip/translate，application/x-www-form-urlencoded：q、from、to、appid、salt、sign；
//   sign = MD5(appid + q + salt + 密钥)，32 位小写；拼 sign 时 q 不做 URL 编码，发请求时才编码；
// - 返回 {from, to, trans_result:[{src, dst}]}，q 里有换行时按行分段各一项（这里按换行拼回去）；from=auto 时 from 是检测出的语种；
// - 出错返回 {error_code, error_msg}（error_code 是字符串，比如 "54001"）；
// - 个人标准版、高级版只能用 28 个常见语种（印尼语、土耳其语、印地语、马来语等要企业认证的尊享版，否则 58001）；
//   标准版单次最多 1000 字符、QPS 1；超出免费额度按 49 元 / 百万字符计费，次日结算，余额不够会欠费（https://fanyi-api.baidu.com/doc/33）。
// 百度的语种代码不是 ISO：日语 jp、韩语 kor、法语 fra、西班牙语 spa、阿拉伯语 ara、越南语 vie、繁体中文 cht、
// 斯洛文尼亚语 slo（斯洛伐克语才是 sk）、罗马尼亚语 rom（ro 是罗姆语）……
// 百度的语种识别接口只认 7 种语言，这里不用，靠 from=auto 时返回的 from 判断。
import crypto from 'node:crypto';
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';

const LABEL = '百度翻译';
const BASE = 'https://fanyi-api.baidu.com';

/** 两位代码 → 百度代码（28 个常见语种，个人版能用的就这些） */
const TO_BAIDU = {
  zh: 'zh',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
  fr: 'fra',
  es: 'spa',
  th: 'th',
  ar: 'ara',
  ru: 'ru',
  pt: 'pt',
  de: 'de',
  it: 'it',
  el: 'el',
  nl: 'nl',
  pl: 'pl',
  bg: 'bul',
  et: 'est',
  da: 'dan',
  fi: 'fin',
  cs: 'cs',
  ro: 'rom',
  sl: 'slo',
  sv: 'swe',
  hu: 'hu',
  vi: 'vie',
};
const TARGETS = new Set(Object.keys(TO_BAIDU));

/** 百度代码 → 两位代码（含完整语种表里常见的，检测结果可能是这些） */
const FROM_BAIDU = {
  ...Object.fromEntries(Object.entries(TO_BAIDU).map(([k, v]) => [v, k])),
  cht: 'zh',
  yue: 'zh',
  wyw: 'zh',
  id: 'id',
  tr: 'tr',
  hi: 'hi',
  may: 'ms',
  per: 'fa',
  heb: 'he',
  ukr: 'uk',
  urd: 'ur',
  ben: 'bn',
  bur: 'my',
  hkm: 'km',
  lao: 'lo',
  fil: 'tl',
  tgl: 'tl',
  swa: 'sw',
  alb: 'sq',
  arm: 'hy',
  geo: 'ka',
  aze: 'az',
  kur: 'ku',
  srp: 'sr',
  hrv: 'hr',
  sk: 'sk',
  lit: 'lt',
  lav: 'lv',
  mac: 'mk',
  bel: 'be',
  tam: 'ta',
  tel: 'te',
  kan: 'kn',
  mal: 'ml',
  mar: 'mr',
  guj: 'gu',
  pan: 'pa',
  nep: 'ne',
  sin: 'si',
  afr: 'af',
  nor: 'no',
  nob: 'no',
  nno: 'no',
  ice: 'is',
  gle: 'ga',
  wel: 'cy',
  baq: 'eu',
  cat: 'ca',
  glg: 'gl',
  lat: 'la',
  epo: 'eo',
  amh: 'am',
  som: 'so',
  xho: 'xh',
  zul: 'zu',
  yor: 'yo',
  ibo: 'ig',
  hau: 'ha',
  kin: 'rw',
  mlt: 'mt',
  mg: 'mg',
  tgk: 'tg',
  tat: 'tt',
  tuk: 'tk',
  kir: 'ky',
  jav: 'jv',
  sun: 'su',
  pot: 'pt',
  frn: 'fr',
};
/** 百度返回的语种代码 → 两位代码；不认识的返回 null（不要把 ro 这种百度自己的代码当成 ISO 用） */
export const fromBaidu = (code) => (typeof code === 'string' && FROM_BAIDU[code.trim().toLowerCase()]) || null;

/** sign = MD5(appid + q + salt + 密钥) */
export const baiduSign = (appId, q, salt, appKey) => crypto.createHash('md5').update(`${appId}${q}${salt}${appKey}`, 'utf8').digest('hex');

/** 按百度的错误码分类 */
function baiduError(code, msg, redactOpts) {
  const detail = detailOf(msg, redactOpts);
  const what = `${code}${detail ? `：${detail}` : ''}`;
  if (code === '54001' || code === '52003') return new TranslateError(`百度翻译鉴权失败（${what}）。请检查 APP ID 和密钥，或通用翻译有没有开通`, 'auth');
  if (code === '58000') return new TranslateError(`百度翻译拒绝了这台服务器的 IP（${what}）。请在开发者信息里改 IP 白名单或留空`, 'auth');
  if (code === '58002') return new TranslateError(`百度翻译的服务被关掉了（${what}）。请到管理控制台开启`, 'auth');
  if (code === '58003') return new TranslateError(`百度翻译封了这个 IP 一天（${what}）`, 'auth');
  if (code === '90107') return new TranslateError(`百度翻译的认证没通过或还没生效（${what}）`, 'auth');
  if (code === '54004') return new TranslateError(`百度翻译账户余额不足（${what}）`, 'quota');
  if (code === '54003' || code === '54005' || code === '59004') return new TranslateError(`百度翻译请求太频繁，被限流了（${what}）`, 'rate_limit');
  if (code === '58001') {
    return new TranslateError(`百度翻译不支持这个语言（${what}）。个人版只能用 28 个常见语种`, 'unsupported_language');
  }
  if (code === '52001') return new TranslateError(`百度翻译处理超时（${what}）`, 'timeout');
  if (code === '52002') return new TranslateError(`百度翻译出错了（${what}）`, 'server');
  return new TranslateError(`百度翻译返回错误（${what}）`, 'bad_request');
}

export default {
  id: 'baidu',
  label: LABEL,
  fields: [
    { key: 'appId', type: 'secret', required: true, max: 100 },
    { key: 'appKey', type: 'secret', required: true, max: 200 },
  ],
  targets: TARGETS,

  async translate(cfg, { text, source, target }, o = {}) {
    const appId = String(cfg.appId || '').trim();
    const appKey = String(cfg.appKey || '').trim();
    if (!appId || !appKey) throw new TranslateError('百度翻译还没有填 APP ID 和密钥', 'config');
    if (!visibleAscii(appId) || !visibleAscii(appKey)) throw new TranslateError('百度翻译的 APP ID 或密钥里有空格、中文或其他特殊字符，请检查后重新填写', 'config');
    const to = TO_BAIDU[target];
    if (!to) throw new TranslateError('百度翻译（个人版）不支持译成这个语言', 'unsupported_language');
    const from = source && source !== 'auto' ? TO_BAIDU[source] || 'auto' : 'auto';
    const redactOpts = { secrets: [appId, appKey] };
    const salt = String(crypto.randomInt(1e9, 1e10));
    const form = new URLSearchParams({ q: text, from, to, appid: appId, salt, sign: baiduSign(appId, text, salt, appKey) });
    const res = await request({
      label: LABEL,
      url: `${trimSlash(o.endpoint || BASE)}/api/trans/vip/translate`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    const d = res.data;
    if (d && d.error_code !== undefined && String(d.error_code) !== '52000' && String(d.error_code) !== '0') {
      throw baiduError(String(d.error_code), d.error_msg, redactOpts);
    }
    if (!res.ok) throw httpError(LABEL, res, redactOpts);
    if (!Array.isArray(d?.trans_result) || !d.trans_result.length || d.trans_result.some((x) => typeof x?.dst !== 'string')) {
      throw badResponse(LABEL, '缺少 trans_result');
    }
    return { text: d.trans_result.map((x) => x.dst).join('\n'), detectedSource: fromBaidu(d.from) };
  },
};
