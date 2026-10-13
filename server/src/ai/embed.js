// 向量接口客户端（可选的向量检索，规则见 docs/features.md 的「知识库怎么带进回复」）：
// - OpenAI 兼容：POST {root}/embeddings，{model, input:[...], encoding_format:'float'}，返回 data[].embedding（按 index 排）和 usage。
//   OpenAI、本机 Ollama（地址填 http://<主机>:11434/v1）、Voyage、Jina、硅基流动等都是这个格式；
// - Gemini：POST {root}/models/{model}:batchEmbedContents，{requests:[{model:'models/{model}', content:{parts:[{text}]}, taskType}]}，
//   返回 embeddings[].values，用量在 usageMetadata.promptTokenCount（有的版本或代理不给，记 null）。taskType 官方文档标了
//   「改用 embedContentConfig.taskType」，但旧字段仍然收，兼容的代理也多半只认旧的，这里照旧放在每个请求上。
// root 和鉴权头的规则和 llm.js 一样（openai 就是填的地址本身；gemini 不以 /v1 或 /v1beta 结尾时补 /v1beta）。
// 这里只发一次请求、不重试：后台计算（kb/vectors.js）自己按错误种类退避或停下，检索时查询向量失败直接退回关键词检索。
import crypto from 'node:crypto';
import { LlmError, llmRoot } from './llm.js';
import { CONNECT_ERRORS, providerMessage, redactKey } from './models.js';

export const EMBED_FORMATS = ['openai', 'gemini'];
const ERROR_MAX_CHARS = 200;
/** Retry-After 最多信 1 小时，免得对方给个离谱的数一直不重试 */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * 向量接口的错误。kind：
 * - config：没配好（地址、模型、密钥格式），没发请求；
 * - auth：401 / 403；not_found：404（模型名或地址不对）；bad_request：其他 4xx（比如输入太长、模型不是向量模型）；
 * - rate_limit：429（retryAfterMs 是对方 Retry-After 给的毫秒数，没给是 null）；server：5xx 和 408；
 * - network：连不上；timeout：超时；bad_response：返回的不是 JSON、缺字段、条数或维度不对。
 */
export class EmbedError extends LlmError {
  /**
   * @param {string} message
   * @param {string} kind
   * @param {{status?:number, retryAfterMs?:number|null}} [o]
   */
  constructor(message, kind, { status = 0, retryAfterMs = null } = {}) {
    super(message, status);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 重试也没用的错误：后台计算碰到就停下，等设置改了或手动重试 */
export const FATAL_EMBED_KINDS = new Set(['config', 'auth', 'not_found', 'bad_request', 'bad_response', 'dims']);

/** 接口根地址（不带末尾的 /），规则同 llm.js 的 llmRoot */
export const embedRoot = (format, baseUrl) => llmRoot(format, baseUrl);

/** 去掉 Gemini 模型名前面的 models/ */
const geminiModel = (model) => String(model).trim().replace(/^models\//, '');

/**
 * 向量属于哪个「模型 + 服务」：格式、接口根地址、模型名的哈希。换了任何一样，旧向量都不能和新的放在一起比，全部重算。
 * 密钥不算在里面（换密钥不用重算）。
 * @param {{format:string, baseUrl:string, model:string}} cfg
 */
export function embedModelKey(cfg) {
  const raw = `${cfg.format}\n${embedRoot(cfg.format, cfg.baseUrl)}\n${cfg.format === 'gemini' ? geminiModel(cfg.model) : String(cfg.model).trim()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * 构造请求（地址、头、体），不发网络请求，方便测试。
 * @param {{format:string, baseUrl:string, apiKey?:string, model:string}} cfg
 * @param {string[]} texts
 * @param {{task?:'document'|'query'}} [o] task：Gemini 的 taskType，文档 RETRIEVAL_DOCUMENT、查询 RETRIEVAL_QUERY；OpenAI 格式不用
 */
export function buildEmbedRequest(cfg, texts, { task = 'document' } = {}) {
  const root = embedRoot(cfg.format, cfg.baseUrl);
  const headers = { 'content-type': 'application/json' };
  if (cfg.format === 'gemini') {
    const m = geminiModel(cfg.model);
    if (cfg.apiKey) headers['x-goog-api-key'] = cfg.apiKey;
    const taskType = task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    return {
      url: `${root}/models/${encodeURIComponent(m)}:batchEmbedContents`,
      headers,
      body: { requests: texts.map((text) => ({ model: `models/${m}`, content: { parts: [{ text }] }, taskType })) },
    };
  }
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { url: `${root}/embeddings`, headers, body: { model: String(cfg.model).trim(), input: texts, encoding_format: 'float' } };
}

/** 一个向量：数字数组，或者 base64 编码的 float32（有的兼容接口不认 encoding_format，默认给 base64） */
function toFloat32(v) {
  if (Array.isArray(v)) {
    if (!v.length || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    return Float32Array.from(v);
  }
  if (typeof v === 'string' && v) {
    const buf = Buffer.from(v, 'base64');
    if (!buf.length || buf.length % 4) return null;
    const out = new Float32Array(buf.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out.every(Number.isFinite) ? out : null;
  }
  return null;
}

/** 归一化成单位长度（点积就是余弦相似度）。全是 0 的原样返回 */
export function normalizeVector(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (!sum) return v;
  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

const usageNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * 从响应体里取向量（按输入的顺序）和输入 token 数。条数不对、不是数字、维度不一致都抛 bad_response。
 * @param {string} format
 * @param {any} data
 * @param {number} n 输入了几段
 * @returns {{vectors: Float32Array[], dims:number, inputTokens:number|null}}
 */
export function parseEmbedResponse(format, data, n) {
  let raw;
  let inputTokens = null;
  if (format === 'gemini') {
    if (!Array.isArray(data?.embeddings)) throw new EmbedError('向量接口返回格式不对（缺少 embeddings 数组）', 'bad_response');
    raw = data.embeddings.map((e) => e?.values);
    inputTokens = usageNum(data?.usageMetadata?.promptTokenCount);
  } else {
    if (!Array.isArray(data?.data)) throw new EmbedError('向量接口返回格式不对（缺少 data 数组）', 'bad_response');
    const items = data.data.map((d, i) => ({ i: Number.isInteger(d?.index) ? d.index : i, v: d?.embedding }));
    items.sort((a, b) => a.i - b.i);
    raw = items.map((x) => x.v);
    inputTokens = usageNum(data?.usage?.prompt_tokens) ?? usageNum(data?.usage?.total_tokens);
  }
  if (raw.length !== n) throw new EmbedError(`向量接口返回了 ${raw.length} 个向量，发过去的是 ${n} 段`, 'bad_response');
  const vectors = [];
  for (const v of raw) {
    const f = toFloat32(v);
    if (!f) throw new EmbedError('向量接口返回格式不对（向量不是数字数组）', 'bad_response');
    vectors.push(normalizeVector(f));
  }
  const dims = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== dims)) throw new EmbedError('向量接口这次返回的几个向量维度不一样', 'bad_response');
  return { vectors, dims, inputTokens };
}

/**
 * Retry-After 头：秒数或 HTTP 日期 → 毫秒；没有、解析不了返回 null。最多 1 小时
 * @param {string|null} v
 * @param {number} [now]
 */
export function parseRetryAfter(v, now = Date.now()) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  let ms;
  if (/^\d+(\.\d+)?$/.test(s)) ms = Number(s) * 1000;
  else {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    ms = t - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

/** 按 HTTP 状态码分类，信息里不含密钥 */
function httpError(status, text, statusText, retryAfter, cfg) {
  const msg = redactKey(providerMessage(text, statusText), cfg.apiKey).slice(0, ERROR_MAX_CHARS);
  const detail = msg ? `：${msg}` : '';
  if (status === 401 || status === 403) {
    return new EmbedError(`向量接口鉴权失败（${status}）${detail}。请检查 API 密钥`, 'auth', { status });
  }
  if (status === 404) {
    const hint = cfg.format === 'openai' ? '（OpenAI 兼容的地址通常以 /v1 结尾，本机 Ollama 填 http://<主机>:11434/v1）' : '';
    return new EmbedError(`向量接口返回 404${detail}。模型名不对或这个服务没有这个模型，也可能是接口地址不对${hint}`, 'not_found', { status });
  }
  if (status === 429) {
    return new EmbedError(`向量接口限流（429）${detail}`, 'rate_limit', { status, retryAfterMs: parseRetryAfter(retryAfter) });
  }
  if (status === 408 || status >= 500) return new EmbedError(`向量接口返回 ${status}${detail}`, 'server', { status });
  return new EmbedError(`向量接口返回 ${status}${detail}`, 'bad_request', { status });
}

/**
 * 算一批文字的向量（只发一次请求，不重试）。所有错误都抛 EmbedError，信息里不含密钥。
 * @param {{format:string, baseUrl:string, apiKey?:string, model:string}} cfg
 * @param {string[]} texts
 * @param {{task?:'document'|'query', timeoutMs?:number, signal?:AbortSignal}} [o]
 * @returns {Promise<{vectors: Float32Array[], dims:number, inputTokens:number|null, model:string}>} 向量已归一化
 */
export async function embedTexts(cfg, texts, { task = 'document', timeoutMs = 60_000, signal } = {}) {
  if (!EMBED_FORMATS.includes(cfg?.format)) throw new EmbedError(`向量接口不支持这个格式：${cfg?.format}`, 'config');
  if (!String(cfg.baseUrl || '').trim()) throw new EmbedError('还没有填写向量接口地址', 'config');
  if (!String(cfg.model || '').trim()) throw new EmbedError('还没有填写向量模型', 'config');
  const key = String(cfg.apiKey || '');
  // 密钥只能是可见 ASCII，否则 fetch 拼请求头时会报错，而且报错信息里带着密钥
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new EmbedError('API 密钥里有空格、中文或其他特殊字符，请检查后重新填写', 'config');
  if (!texts.length) return { vectors: [], dims: 0, inputTokens: null, model: cfg.model };
  const { url, headers, body } = buildEmbedRequest(cfg, texts, { task });
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('protocol');
  } catch {
    throw new EmbedError('向量接口地址格式不对，要以 http:// 或 https:// 开头', 'config');
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  let text;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new EmbedError('已取消', 'network');
    if (err?.name === 'TimeoutError' || timeout.aborted) {
      throw new EmbedError(`向量接口请求超时（${Number((timeoutMs / 1000).toFixed(1))} 秒）`, 'timeout');
    }
    const code = err?.cause?.code || err?.code || '';
    const reason = CONNECT_ERRORS[code] ? `${CONNECT_ERRORS[code]}（${code}）` : code || err?.cause?.message || err?.message || String(err);
    throw new EmbedError(`连不上向量接口：${redactKey(reason, key)}`, 'network');
  }
  if (!res.ok) throw httpError(res.status, text, res.statusText, res.headers.get('retry-after'), cfg);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new EmbedError('向量接口返回的不是 JSON，请检查接口地址是否正确', 'bad_response');
  }
  return { ...parseEmbedResponse(cfg.format, data, texts.length), model: cfg.model };
}
