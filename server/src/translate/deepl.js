// DeepL API（https://developers.deepl.com/api-reference/translate）：
// - POST {主机}/v2/translate，JSON {text:[...], target_lang, source_lang?}，鉴权头 Authorization: DeepL-Auth-Key <密钥>
//   （把密钥放在查询串或请求体里的旧写法已经停用）。不给 source_lang 时自动判断，返回 translations[].detected_source_language；
// - 免费版密钥以 :fx 结尾，用 api-free.deepl.com，其余用 api.deepl.com；
// - 456：额度用完；429 / 529：太频繁；403：密钥不对；
// - 目标语言里英语、葡语、中文有变体，这里分别用 EN-US、PT-BR、ZH-HANS（简体），挪威语用 NB。
// DeepL 没有单独的语言检测接口，判断客户语言靠「自动判断源语言」翻译一小段客户原话（index.js）。
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { normalizeLang } from './languages.js';

const LABEL = 'DeepL';

/** 支持译成的语言（https://developers.deepl.com/docs/getting-started/supported-languages 列出的目标语言，两位代码） */
const TARGETS = new Set(
  (
    'ar af sq hy az ba eu be bn bs bg my ca zh hr cs da nl en eo et fi fr gl ka de el gn gu ht ha he hi hu is ig id ga it ja jv kk ko ky la ' +
    'lv ln lt lb mk mg ms ml mt mi mr mn ne no oc om ps fa pl pt pa qu ro ru sa sr st sk sl es su sw sv tl tg ta tt te th ts tn tr tk uk ' +
    'ur uz vi cy wo xh yi zu'
  ).split(' '),
);
/** 有变体的目标语言用哪个变体 */
const TARGET_VARIANT = { en: 'EN-US', pt: 'PT-BR', zh: 'ZH-HANS', no: 'NB' };

/** 两位代码 → DeepL 的目标语言写法 */
export const deeplTarget = (lang) => TARGET_VARIANT[lang] || String(lang).toUpperCase();
/** 两位代码 → DeepL 的源语言写法（源语言不带变体） */
const deeplSource = (lang) => (lang === 'no' ? 'NB' : String(lang).toUpperCase());

/** 免费版和付费版的主机不同 */
export const deeplBase = (apiKey) => (String(apiKey).trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');

export default {
  id: 'deepl',
  label: LABEL,
  fields: [{ key: 'apiKey', type: 'secret', required: true, max: 200 }],
  targets: TARGETS,
  redactOpts: (cfg) => ({ secrets: [cfg.apiKey] }),

  /**
   * @param {{apiKey:string}} cfg
   * @param {{text:string, source:string, target:string}} p source 是 auto 或两位代码
   * @param {{endpoint?:string, timeoutMs?:number, onAttempt?:() => void}} o
   */
  async translate(cfg, { text, source, target }, o = {}) {
    const key = String(cfg.apiKey || '').trim();
    if (!key) throw new TranslateError('DeepL 还没有填 API Key', 'config');
    if (!visibleAscii(key)) throw new TranslateError('DeepL 的 API Key 里有空格、中文或其他特殊字符，请检查后重新填写', 'config');
    const redactOpts = { secrets: [key] };
    const body = { text: [text], target_lang: deeplTarget(target) };
    if (source && source !== 'auto') body.source_lang = deeplSource(source);
    const res = await request({
      label: LABEL,
      url: `${trimSlash(o.endpoint || deeplBase(key))}/v2/translate`,
      headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify(body),
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    if (!res.ok) {
      const detail = detailOf(res.data?.message || res.text, redactOpts);
      if (res.status === 456) throw new TranslateError(`DeepL 这个月的额度用完了（456）${detail ? `：${detail}` : ''}`, 'quota', { status: 456 });
      if (res.status === 529) throw new TranslateError('DeepL 请求太频繁，被限流了（529）', 'rate_limit', { status: 529 });
      if (res.status === 400 && /target_lang|source_lang|language/i.test(detail)) {
        throw new TranslateError(`DeepL 不支持这个语言（400）：${detail}`, 'unsupported_language', { status: 400 });
      }
      throw httpError(LABEL, res, redactOpts);
    }
    const t = res.data?.translations?.[0];
    if (typeof t?.text !== 'string') throw badResponse(LABEL, '缺少 translations[0].text');
    return { text: t.text, detectedSource: normalizeLang(t.detected_source_language) };
  },
};
