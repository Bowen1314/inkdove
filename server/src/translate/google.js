// 谷歌 Cloud Translation 基础版 v2（https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate）：
// - POST https://translation.googleapis.com/language/translate/v2，参数 q、target、source?、format；
//   format 默认是 html（会把 & < > 转成实体），这里固定传 text；不给 source 时返回 detectedSourceLanguage；
// - POST .../v2/detect，参数 q，返回 data.detections[[{language, ...}]]；
// - API Key 放在请求头 x-goog-api-key（谷歌通用的 API Key 用法，不放进地址，免得出现在日志里）；
//   参数用 JSON 请求体发（文档写的是查询参数，JSON 体是谷歌 REST 接口的通用写法；要用真实密钥核对一次）；
// - 超额：403「Daily Limit Exceeded」「User Rate Limit Exceeded」。
// 语言写法：简体中文 zh-CN，希伯来语 iw，爪哇语 jw；返回的检测结果按同样的别名认回来。
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { normalizeLang } from './languages.js';

const LABEL = '谷歌翻译';
const BASE = 'https://translation.googleapis.com';

const TARGETS = new Set(
  (
    'af am ar az be bg bn bs ca cs cy da de el en eo es et eu fa fi fr ga gl gu ha he hi hr ht hu hy id ig is it ja jv ka kk km kn ko ku ky ' +
    'la lb lo lt lv mg mi mk ml mn mr ms mt my ne nl no pa pl ps pt ro ru rw si sk sl sm so sq sr st su sv sw ta te tg th tk tl tr tt uk ur ' +
    'uz vi xh yi yo zh zu'
  ).split(' '),
);
const TARGET_CODE = { zh: 'zh-CN', he: 'iw', jv: 'jw' };
const googleCode = (lang) => TARGET_CODE[lang] || lang;

function check(cfg) {
  const apiKey = String(cfg.apiKey || '').trim();
  if (!apiKey) throw new TranslateError('谷歌翻译未填写 API Key', 'config');
  if (!visibleAscii(apiKey)) throw new TranslateError('谷歌翻译的 API Key 包含空格、中文或其他非法字符，请检查后重新输入', 'config');
  return apiKey;
}

/** 谷歌的错误体 {error:{code, message, status, errors:[{reason}]}} */
function googleError(res, redactOpts) {
  const e = res.data?.error;
  const reasons = Array.isArray(e?.errors) ? e.errors.map((x) => String(x?.reason || '')).join(' ') : '';
  const detail = detailOf(typeof e?.message === 'string' ? e.message : res.text, redactOpts);
  const all = `${detail} ${reasons}`;
  const tail = detail ? `：${detail}` : '';
  if (/daily ?limit|quota|billing/i.test(all)) throw new TranslateError(`谷歌翻译额度已用尽或未开通结算（${res.status}）${tail}`, 'quota', { status: res.status });
  if (/rate ?limit/i.test(all) || res.status === 429) throw new TranslateError(`谷歌翻译请求过于频繁，已限流（${res.status}）${tail}`, 'rate_limit', { status: res.status });
  if (res.status === 400 && /api key|keyInvalid/i.test(all)) {
    throw new TranslateError(`谷歌翻译鉴权失败（400）${tail}。请检查 API Key`, 'auth', { status: 400 });
  }
  if (res.status === 400 && /language|target|invalid value/i.test(all)) {
    throw new TranslateError(`谷歌翻译不支持该语言（400）${tail}`, 'unsupported_language', { status: 400 });
  }
  throw httpError(LABEL, res, redactOpts, detail);
}

export default {
  id: 'google',
  label: LABEL,
  fields: [{ key: 'apiKey', type: 'secret', required: true, max: 200 }],
  targets: TARGETS,

  async translate(cfg, { text, source, target }, o = {}) {
    const apiKey = check(cfg);
    const redactOpts = { secrets: [apiKey] };
    const body = { q: [text], target: googleCode(target), format: 'text' };
    if (source && source !== 'auto') body.source = googleCode(source);
    const res = await request({
      label: LABEL,
      url: `${trimSlash(o.endpoint || BASE)}/language/translate/v2`,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) googleError(res, redactOpts);
    const t = res.data?.data?.translations?.[0];
    if (typeof t?.translatedText !== 'string') throw badResponse(LABEL, '缺少 data.translations[0].translatedText');
    return { text: t.translatedText, detectedSource: normalizeLang(t.detectedSourceLanguage) };
  },

  async detect(cfg, text, o = {}) {
    const apiKey = check(cfg);
    const redactOpts = { secrets: [apiKey] };
    const res = await request({
      label: LABEL,
      url: `${trimSlash(o.endpoint || BASE)}/language/translate/v2/detect`,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ q: [text] }),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) googleError(res, redactOpts);
    const list = res.data?.data?.detections;
    if (!Array.isArray(list)) throw badResponse(LABEL, '缺少 data.detections');
    const first = Array.isArray(list[0]) ? list[0][0] : list[0];
    return normalizeLang(first?.language);
  },
};
