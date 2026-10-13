// Azure AI Translator 文本翻译 v3.0（https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate）：
// - POST {终结点}/translate?api-version=3.0&to=xx[&from=xx]，体 [{"Text": "..."}]；不给 from 时返回 detectedLanguage.language；
// - POST {终结点}/detect?api-version=3.0，体同上，返回 [{language, score, ...}]；
// - 鉴权头 Ocp-Apim-Subscription-Key；区域资源（不是 Global）还要 Ocp-Apim-Subscription-Region；
// - 终结点默认 https://api.cognitive.microsofttranslator.com；填了自己资源的 xxx.cognitiveservices.azure.com 时路径要带
//   /translator/text/v3.0；
// - 错误体 {"error":{"code":403001,"message":"..."}}，code 前三位是 HTTP 状态，403001 是免费额度用完。
// 语言写法：简体中文 zh-Hans，挪威语 nb，菲律宾语 fil，塞尔维亚语这里用拉丁字母 sr-Latn，蒙古语 mn-Cyrl。
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { normalizeLang } from './languages.js';

const LABEL = 'Azure 翻译';
const GLOBAL_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

const TARGETS = new Set(
  (
    'af am ar az ba bg bn bs ca cs cy da de el en es et eu fa fi fr ga gl gu ha he hi hr ht hu hy id ig is it ja ka kk km kn ko ku ky lo lt ' +
    'lv mg mi mk ml mn mr ms mt my ne nl no pa pl ps pt ro ru rw si sk sl sm so sq sr st sv sw ta te tg th tk tl tr tt uk ur uz vi xh yo zh zu'
  ).split(' '),
);
const TARGET_CODE = { zh: 'zh-Hans', no: 'nb', tl: 'fil', sr: 'sr-Latn', mn: 'mn-Cyrl' };
const azureCode = (lang) => TARGET_CODE[lang] || lang;

/** 填的终结点（可以不填）→ 接口根地址 */
export function azureRoot(endpoint) {
  const base = trimSlash(endpoint) || GLOBAL_ENDPOINT;
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    return base;
  }
  // 自己资源的终结点：路径要带 /translator/text/v3.0（门户里复制的往往只有主机）
  if (/\.cognitiveservices\.azure\.com$/i.test(host) && !/\/translator\/text\/v3\.0$/i.test(base)) return `${base}/translator/text/v3.0`;
  return base;
}

function headersOf(cfg) {
  const h = { 'content-type': 'application/json; charset=UTF-8', 'ocp-apim-subscription-key': cfg.apiKey };
  if (cfg.region) h['ocp-apim-subscription-region'] = cfg.region;
  return h;
}

function check(cfg) {
  const apiKey = String(cfg.apiKey || '').trim();
  const region = String(cfg.region || '').trim();
  if (!apiKey) throw new TranslateError('Azure 翻译还没有填 API Key', 'config');
  if (!visibleAscii(apiKey)) throw new TranslateError('Azure 翻译的 API Key 里有空格、中文或其他特殊字符，请检查后重新填写', 'config');
  return { apiKey, region, endpoint: String(cfg.endpoint || '').trim() };
}

/** 按 Azure 的错误码分类 */
function azureError(res, redactOpts) {
  const err = res.data?.error;
  const code = Number(err?.code);
  const detail = detailOf(typeof err?.message === 'string' ? err.message : res.text, redactOpts);
  const tail = detail ? `：${detail}` : '';
  if (code === 403001) throw new TranslateError(`Azure 翻译的免费额度用完了（403001）${tail}`, 'quota', { status: res.status });
  if (res.status === 400 && /language/i.test(detail)) {
    throw new TranslateError(`Azure 翻译不支持这个语言（${code || 400}）${tail}`, 'unsupported_language', { status: 400 });
  }
  if (res.status === 401) {
    throw new TranslateError(`Azure 翻译鉴权失败（${code || 401}）${tail}。请检查 API Key 和区域（Global 资源区域留空）`, 'auth', { status: 401 });
  }
  throw httpError(LABEL, res, redactOpts, detail);
}

export default {
  id: 'azure',
  label: LABEL,
  fields: [
    { key: 'apiKey', type: 'secret', required: true, max: 200 },
    { key: 'region', type: 'text', required: false, max: 50, pattern: /^[a-z0-9-]{2,50}$/ },
    { key: 'endpoint', type: 'url', required: false, max: 500 },
  ],
  targets: TARGETS,

  async translate(cfg, { text, source, target }, o = {}) {
    const c = check(cfg);
    const redactOpts = { secrets: [c.apiKey] };
    const q = new URLSearchParams({ 'api-version': '3.0', to: azureCode(target) });
    if (source && source !== 'auto') q.set('from', azureCode(source));
    const res = await request({
      label: LABEL,
      url: `${azureRoot(o.endpoint || c.endpoint)}/translate?${q}`,
      headers: headersOf(c),
      body: JSON.stringify([{ Text: text }]),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) azureError(res, redactOpts);
    const item = Array.isArray(res.data) ? res.data[0] : null;
    const out = item?.translations?.[0]?.text;
    if (typeof out !== 'string') throw badResponse(LABEL, '缺少 translations[0].text');
    return { text: out, detectedSource: normalizeLang(item?.detectedLanguage?.language) };
  },

  async detect(cfg, text, o = {}) {
    const c = check(cfg);
    const redactOpts = { secrets: [c.apiKey] };
    const res = await request({
      label: LABEL,
      url: `${azureRoot(o.endpoint || c.endpoint)}/detect?api-version=3.0`,
      headers: headersOf(c),
      body: JSON.stringify([{ Text: text }]),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) azureError(res, redactOpts);
    if (!Array.isArray(res.data)) throw badResponse(LABEL, '语言检测返回的不是数组');
    return normalizeLang(res.data[0]?.language);
  },
};
