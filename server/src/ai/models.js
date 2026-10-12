// 设置页「获取模型列表」：按接口格式调服务商的列模型接口，统一成 [{id, label?}]。
import { ANTHROPIC_VERSION, LLM_FORMATS, LlmError, llmRoot } from './llm.js';

/** 演示模式（INKDOVE_LLM_MOCK）下返回的固定列表，不发网络请求 */
export const MOCK_MODELS = [
  { id: 'mock-fast', label: '演示 · 快速' },
  { id: 'mock-smart', label: '演示 · 高质量' },
  { id: 'mock-vision', label: '演示 · 识图' },
  { id: 'mock-distill', label: '演示 · 整理资料' },
];

// gemini 最多翻 5 页（每页 1000 个，足够了）
const GEMINI_MAX_PAGES = 5;
const ERROR_MAX_CHARS = 200;

// 连不上时常见的错误码 → 中文说明
const CONNECT_ERRORS = {
  ECONNREFUSED: '连接被拒绝',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析失败',
  ECONNRESET: '连接被对方断开',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_SOCKET: '连接被对方断开',
  CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 证书是自签名的',
  SELF_SIGNED_CERT_IN_CHAIN: 'HTTPS 证书是自签名的',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书校验失败',
  ERR_TLS_CERT_ALTNAME_INVALID: 'HTTPS 证书和域名不匹配',
};

/** 把密钥原文（含 URL 编码后的样子）从任意文本里抹掉 */
export function redactKey(text, apiKey) {
  let s = String(text ?? '');
  if (!apiKey) return s;
  for (const k of new Set([apiKey, encodeURIComponent(apiKey)])) s = s.split(k).join('***');
  return s;
}

/** 按 id 去重、排序；label 为空或和 id 一样时不带 */
export function normalizeModels(list) {
  const byId = new Map();
  for (const m of list) {
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || byId.has(id)) continue;
    const label = typeof m.label === 'string' ? m.label.trim() : '';
    byId.set(id, label && label !== id ? { id, label } : { id });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** 从服务商的错误响应里取可读信息（JSON 的 error.message / error / message，否则原文） */
function providerMessage(text, statusText) {
  let msg = '';
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    msg = (typeof e === 'string' ? e : e?.message) || j?.message || '';
  } catch {
    /* 非 JSON */
  }
  if (typeof msg !== 'string' || !msg) msg = text;
  return String(msg).replace(/\s+/g, ' ').trim() || statusText || '';
}

/**
 * 发一个 GET，返回解析好的 JSON。所有错误都抛 LlmError，信息里不含密钥。
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {string} apiKey
 * @param {AbortSignal} signal
 */
async function getJson(url, headers, apiKey, signal) {
  let res;
  let text;
  try {
    res = await fetch(url, { method: 'GET', headers, signal });
    text = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError' || signal.aborted) throw err;
    const code = err?.cause?.code || err?.code || '';
    const reason = CONNECT_ERRORS[code] ? `${CONNECT_ERRORS[code]}（${code}）` : code || err?.cause?.message || err?.message || String(err);
    throw new LlmError(`连不上接口地址：${redactKey(reason, apiKey)}`);
  }
  if (!res.ok) {
    // 先抹密钥再截断，免得截出半截密钥
    const msg = redactKey(providerMessage(text, res.statusText), apiKey).slice(0, ERROR_MAX_CHARS);
    throw new LlmError(msg ? `接口返回 ${res.status}：${msg}` : `接口返回 ${res.status}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError('接口返回的不是 JSON，请检查接口地址是否正确');
  }
}

/**
 * 列出服务商的模型。地址规则和 llm.js 的 llmUrl 一致：
 * - openai：GET {base}/models，Bearer 鉴权，响应 {data:[{id}]}（也接受直接返回数组的兼容接口）
 * - anthropic：GET {root}/models?limit=1000，x-api-key + anthropic-version，display_name 当 label
 * - gemini：GET {root}/models?pageSize=1000，x-goog-api-key；去掉 models/ 前缀，只留支持 generateContent 的，按 nextPageToken 最多翻 5 页
 * 没有密钥时照样发，只是不带认证头。超时按整次操作算（含翻页）。
 * @param {{format:string, baseUrl:string, apiKey?:string, timeoutMs?:number}} o
 * @returns {Promise<{id:string, label?:string}[]>}
 */
export async function listModels({ format, baseUrl, apiKey = '', timeoutMs = 15000 }) {
  if (!LLM_FORMATS.includes(format)) throw new LlmError(`不支持的接口格式：${format}`);
  if (!String(baseUrl || '').trim()) throw new LlmError('还没有填写接口地址');
  const key = String(apiKey || '');
  // 密钥只能是可见 ASCII，否则 fetch 拼请求头时会报错，而且报错信息里带着密钥
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new LlmError('API 密钥里有空格、中文或其他特殊字符，请检查后重新填写');

  let modelsUrl;
  try {
    modelsUrl = new URL(`${llmRoot(format, baseUrl)}/models`);
  } catch {
    throw new LlmError('接口地址格式不对');
  }
  if (!/^https?:$/.test(modelsUrl.protocol)) throw new LlmError('接口地址必须以 http:// 或 https:// 开头');

  const headers = { accept: 'application/json' };
  if (format === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    modelsUrl.searchParams.set('limit', '1000');
  } else if (format === 'gemini') {
    if (key) headers['x-goog-api-key'] = key;
    modelsUrl.searchParams.set('pageSize', '1000');
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    if (format === 'gemini') {
      const out = [];
      let pageToken = '';
      for (let page = 0; page < GEMINI_MAX_PAGES; page++) {
        const u = new URL(modelsUrl);
        if (pageToken) u.searchParams.set('pageToken', pageToken);
        const data = await getJson(u.href, headers, key, signal);
        if (data?.models !== undefined && !Array.isArray(data.models)) throw new LlmError('接口返回格式不对（models 不是数组）');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('接口返回格式不对（缺少 models）');
        for (const m of data.models || []) {
          const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
          if (typeof m?.name !== 'string' || !methods.includes('generateContent')) continue;
          out.push({ id: m.name.replace(/^models\//, ''), label: m.displayName });
        }
        pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
        if (!pageToken) break;
      }
      return normalizeModels(out);
    }
    const data = await getJson(modelsUrl.href, headers, key, signal);
    const list = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(list)) throw new LlmError('接口返回格式不对（缺少 data 数组）');
    return normalizeModels(list.map((m) => ({ id: m?.id, label: format === 'anthropic' ? m?.display_name : undefined })));
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err?.name === 'TimeoutError' || signal.aborted) {
      throw new LlmError(`请求超时（${Number((timeoutMs / 1000).toFixed(1))} 秒）`);
    }
    throw new LlmError(`获取模型列表失败：${redactKey(err?.message || err, key)}`);
  }
}
