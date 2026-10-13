// 翻译接口（设置 → 翻译 → 翻译 API）：八家服务的登记表、配置字段、调用记录。
// 每家一个文件，接口统一：
//   translate(cfg, {text, source:'auto'|两位代码, target:两位代码}, {endpoint?, timeoutMs?, onAttempt?}) → {text, detectedSource?}
//   detect?(cfg, text, o) → 两位代码或 null（有单独语言检测接口的才有）
//   targets：支持译成的语言（两位代码的 Set）；null 表示要看对方装了哪些语言（LibreTranslate），交给对方判断
//   fields：配置字段 {key, type:'secret'|'secretUrl'|'url'|'text', required, max, pattern?, default?}
//     secret / secretUrl 不回传明文（对外视图只给「已设置」和后四位，secretUrl 只给协议和主机）。
// 出错都抛 TranslateError（common.js），信息是中文，不带密钥。
import azure from './azure.js';
import baidu from './baidu.js';
import { maskUrl, TranslateError, TRANSLATE_TIMEOUT_MS } from './common.js';
import deepl from './deepl.js';
import deeplx from './deeplx.js';
import google from './google.js';
import libretranslate from './libretranslate.js';
import tencent from './tencent.js';
import volcengine from './volcengine.js';

export { TranslateError } from './common.js';

/** 按设置页的顺序 */
export const TRANSLATION_PROVIDERS = [deepl, deeplx, azure, google, tencent, baidu, volcengine, libretranslate];
export const TRANSLATION_PROVIDER_IDS = TRANSLATION_PROVIDERS.map((p) => p.id);
const BY_ID = new Map(TRANSLATION_PROVIDERS.map((p) => [p.id, p]));

/** @param {string} id */
export const getTranslationProvider = (id) => BY_ID.get(id) || null;

/** 字段的中文名（错误信息用；前端 labels.js 里有同样的一份） */
export const FIELD_LABELS = {
  apiKey: 'API Key',
  url: '服务地址',
  token: '访问令牌',
  region: '区域',
  endpoint: '自定义终结点',
  secretId: 'SecretId',
  secretKey: 'SecretKey',
  appId: 'APP ID',
  appKey: '密钥',
  accessKeyId: 'Access Key ID',
  secretAccessKey: 'Secret Access Key',
};

/** 每家服务的默认配置 {字段: 默认值} */
export function providerDefaults() {
  const out = {};
  for (const p of TRANSLATION_PROVIDERS) out[p.id] = Object.fromEntries(p.fields.map((f) => [f.key, f.default ?? '']));
  return out;
}

/**
 * 这家服务还缺哪个必填字段（第一个），都填了返回 null。
 * @param {string} id
 * @param {Record<string, any>} cfg
 */
export function missingField(id, cfg) {
  const p = getTranslationProvider(id);
  if (!p) return null;
  for (const f of p.fields) if (f.required && !String(cfg?.[f.key] ?? '').trim()) return f.key;
  return null;
}

const last4 = (k) => (k ? k.slice(-4) : null);

/**
 * 对外视图：secret 只给是否设置和后四位，secretUrl 只给是否设置和「协议 + 主机」，其余原样；ready 是必填字段是否都填了。
 * @param {Record<string, Record<string, any>>} providers settings.translation.providers
 */
export function publicProviders(providers) {
  const out = {};
  for (const p of TRANSLATION_PROVIDERS) {
    const cfg = providers?.[p.id] || {};
    const view = { ready: !missingField(p.id, cfg) };
    for (const f of p.fields) {
      const v = typeof cfg[f.key] === 'string' ? cfg[f.key] : '';
      if (f.type === 'secret') {
        view[`${f.key}Set`] = !!v;
        view[`${f.key}Last4`] = last4(v);
      } else if (f.type === 'secretUrl') {
        view[`${f.key}Set`] = !!v;
        view[`${f.key}Display`] = v ? maskUrl(v) : '';
      } else view[f.key] = v;
    }
    out[p.id] = view;
  }
  return out;
}

/** 这家服务的配置里所有要抹掉的东西（错误信息、日志用） */
export function redactOptsOf(id, cfg) {
  const p = getTranslationProvider(id);
  const secrets = [];
  const secretUrls = [];
  for (const f of p?.fields || []) {
    const v = String(cfg?.[f.key] ?? '').trim();
    if (!v) continue;
    if (f.type === 'secret') secrets.push(v);
    else if (f.type === 'secretUrl') secretUrls.push(v);
  }
  return { secrets, secretUrls };
}

/**
 * 调一次翻译接口，发出去了的都记一行 llm_calls（purpose 由调用方给：会话里是 translate，设置页测试是 test；
 * format 和 model 都记服务的 id，token 记 null）。不计入会话每日模型次数。
 * @param {any} ctx
 * @param {{purpose:string, accountId?:string|null, conversationId?:string|null}} meta
 * @param {string} op 'translate' | 'detect'
 * @param {string} id 服务
 * @param {Record<string, any>} cfg
 * @param {any} arg translate 是 {text, source, target}，detect 是文字
 */
export async function callTranslationProvider(ctx, meta, op, id, cfg, arg) {
  const p = getTranslationProvider(id);
  if (!p) throw new TranslateError(`不认识的翻译服务：${id}`, 'config');
  if (typeof p[op] !== 'function') throw new TranslateError(`${p.label} 没有这个功能`, 'config');
  let attempted = false;
  const started = Date.now();
  let ok = false;
  try {
    const r = await p[op](cfg, arg, {
      endpoint: ctx.translateEndpoints?.[id],
      timeoutMs: ctx.translateTimeoutMs ?? TRANSLATE_TIMEOUT_MS,
      onAttempt: () => {
        attempted = true;
      },
    });
    ok = true;
    return r;
  } finally {
    if (attempted) {
      ctx.records.llmCall({
        purpose: meta.purpose,
        format: id,
        model: id,
        inputTokens: null,
        outputTokens: null,
        ok,
        latencyMs: Date.now() - started,
        accountId: meta.accountId ?? null,
        conversationId: meta.conversationId ?? null,
      });
    }
  }
}
