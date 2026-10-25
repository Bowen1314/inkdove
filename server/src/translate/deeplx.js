// DeepLX（开源项目，https://github.com/OwO-Network/DeepLX，文档 https://deeplx.owo.network/endpoints/free.html）：
// - POST {地址}/translate，JSON {text, source_lang, target_lang}，source_lang 填 auto 由对方判断；
//   返回 {code, data, alternatives, source_lang?}，code 和 HTTP 状态一致，data 是译文；
// - 部署时设了令牌（-token / TOKEN）才要鉴权，这里用请求头 Authorization: Bearer <令牌>；
// - 公共服务（比如 api.deeplx.org，令牌在地址路径里）经常被限流（429、503），建议自己部署。
// 地址可能带令牌，按密钥处理：不回传、不进日志和错误信息（对外只露出协议和主机）。
// 语言写法和 DeepL 一样（EN-US、PT-BR、ZH-HANS）；DeepLX 没公开完整语言表，这里按 DeepL 的常用语言算。
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { deeplTarget } from './deepl.js';
import { normalizeLang } from './languages.js';

const LABEL = 'DeepLX';

const TARGETS = new Set('ar bg cs da de el en es et fi fr he hu id it ja ko lt lv no nl pl pt ro ru sk sl sv th tr uk vi zh'.split(' '));

/** 填的地址 → 实际请求的地址：不以 /translate 结尾的补上 */
export function deeplxUrl(url) {
  const base = trimSlash(url);
  return /\/translate$/i.test(base) ? base : `${base}/translate`;
}

export default {
  id: 'deeplx',
  label: LABEL,
  fields: [
    { key: 'url', type: 'secretUrl', required: true, max: 500 },
    { key: 'token', type: 'secret', required: false, max: 500 },
  ],
  targets: TARGETS,

  async translate(cfg, { text, source, target }, o = {}) {
    const url = String(cfg.url || '').trim();
    const token = String(cfg.token || '').trim();
    if (!url) throw new TranslateError('DeepLX 未填写服务地址', 'config');
    if (token && !visibleAscii(token)) throw new TranslateError('DeepLX 的访问令牌包含空格、中文或其他非法字符，请检查后重新输入', 'config');
    const redactOpts = { secrets: [token], secretUrls: [url, o.endpoint || ''] };
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await request({
      label: LABEL,
      url: deeplxUrl(o.endpoint || url),
      headers,
      body: JSON.stringify({
        text,
        source_lang: source && source !== 'auto' ? String(source).toUpperCase() : 'auto',
        target_lang: deeplTarget(target),
      }),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    const data = res.data;
    const code = Number(data?.code);
    if (!res.ok || (Number.isFinite(code) && code !== 200)) {
      const status = res.ok ? code : res.status;
      const detail = detailOf(data?.message || res.text, redactOpts);
      const tail = detail ? `：${detail}` : '';
      if (status === 429) throw new TranslateError(`DeepLX 请求过于频繁，已限流（429）${tail}。公共服务常见此问题，建议自行部署`, 'rate_limit', { status });
      if (status === 503) throw new TranslateError(`DeepLX 翻译失败（503）${tail}。公共服务常被 DeepL 临时封禁，建议自行部署`, 'server', { status });
      if (status === 400 && /lang/i.test(detail)) throw new TranslateError(`DeepLX 不支持该语言（400）${tail}`, 'unsupported_language', { status });
      throw httpError(LABEL, { ...res, status }, redactOpts, detail);
    }
    const out = Array.isArray(data?.data) ? data.data[0] : data?.data;
    if (typeof out !== 'string') throw badResponse(LABEL, '缺少 data');
    return { text: out, detectedSource: normalizeLang(data?.source_lang) };
  },
};
