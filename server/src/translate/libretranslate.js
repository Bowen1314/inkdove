// LibreTranslate（开源，可以自己部署，https://github.com/LibreTranslate/LibreTranslate，按 libretranslate/app.py 核对）：
// - POST {地址}/translate，JSON {q, source:'auto', target, format:'text', api_key?}，返回 {translatedText, detectedLanguage:{language}}；
// - POST {地址}/detect，JSON {q, api_key?}，返回 [{language, confidence}]；
// - 出错返回 {"error": "..."}：400 语言不支持（"... is not supported"）、缺 API Key；403 API Key 不对或被封；429 太频繁；
// - 语言写法：简体中文 zh-Hans，挪威语 nb；装了哪些语言看部署时下载了哪些模型，这里不预先限定，不支持的由对方报错。
// 自己部署的不限量；公共服务 libretranslate.com 要 API Key（收费）。
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { normalizeLang } from './languages.js';

const LABEL = 'LibreTranslate';
const TARGET_CODE = { zh: 'zh-Hans', no: 'nb' };

/** 填的地址 → 根地址（去掉末尾的斜杠和 /translate） */
export const libreRoot = (url) => trimSlash(url).replace(/\/translate$/i, '');

function check(cfg) {
  const url = String(cfg.url || '').trim();
  const apiKey = String(cfg.apiKey || '').trim();
  if (!url) throw new TranslateError('LibreTranslate 未填写服务地址', 'config');
  if (apiKey && !visibleAscii(apiKey)) throw new TranslateError('LibreTranslate 的 API Key 包含空格、中文或其他非法字符，请检查后重新输入', 'config');
  return { url, apiKey };
}

function libreError(res, redactOpts) {
  const detail = detailOf(typeof res.data?.error === 'string' ? res.data.error : res.text, redactOpts);
  const tail = detail ? `：${detail}` : '';
  if (res.status === 400 && /not supported|not available as a target/i.test(detail)) {
    throw new TranslateError(`LibreTranslate 不支持该语言（400）${tail}`, 'unsupported_language', { status: 400 });
  }
  if (res.status === 400 && /api key/i.test(detail)) throw new TranslateError(`LibreTranslate 需要 API Key（400）${tail}`, 'auth', { status: 400 });
  if (res.status === 403 && /too many/i.test(detail)) throw new TranslateError(`LibreTranslate 请求过于频繁，已临时封禁（403）${tail}`, 'rate_limit', { status: 403 });
  throw httpError(LABEL, res, redactOpts, detail);
}

export default {
  id: 'libretranslate',
  label: LABEL,
  fields: [
    { key: 'url', type: 'url', required: true, max: 500 },
    { key: 'apiKey', type: 'secret', required: false, max: 200 },
  ],
  targets: null,

  async translate(cfg, { text, source, target }, o = {}) {
    const c = check(cfg);
    const redactOpts = { secrets: [c.apiKey] };
    const body = { q: text, source: source && source !== 'auto' ? TARGET_CODE[source] || source : 'auto', target: TARGET_CODE[target] || target, format: 'text' };
    if (c.apiKey) body.api_key = c.apiKey;
    const res = await request({
      label: LABEL,
      url: `${libreRoot(o.endpoint || c.url)}/translate`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) libreError(res, redactOpts);
    const out = res.data?.translatedText;
    if (typeof out !== 'string') throw badResponse(LABEL, '缺少 translatedText');
    return { text: out, detectedSource: normalizeLang(res.data?.detectedLanguage?.language) };
  },

  async detect(cfg, text, o = {}) {
    const c = check(cfg);
    const redactOpts = { secrets: [c.apiKey] };
    const body = { q: text };
    if (c.apiKey) body.api_key = c.apiKey;
    const res = await request({
      label: LABEL,
      url: `${libreRoot(o.endpoint || c.url)}/detect`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) libreError(res, redactOpts);
    if (!Array.isArray(res.data)) throw badResponse(LABEL, '语言检测结果非数组');
    return normalizeLang(res.data[0]?.language);
  },
};
