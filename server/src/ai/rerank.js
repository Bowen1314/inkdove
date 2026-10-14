// 重排接口客户端（可选的重排，规则见 docs/features.md 的「知识库怎么带进回复」）。一种格式，Jina、Cohere v2、硅基流动、Voyage
// 和自己部署的 vLLM、Xinference、Infinity 都是这个形状（依据见 docs/external-apis.md）：
// - POST {地址}/rerank，Authorization: Bearer <key>（没填密钥时不带），体 {model, query, documents: [字符串]}；
// - 不带 top_n：各家不给时都按全部候选排好返回（Voyage 的字段叫 top_k，没有 top_n），候选最多 40 条，本来就要全部的顺序；
// - 返回 results[].{index, relevance_score}（Jina、Cohere、硅基流动、vLLM、Xinference）或 data[].{index, relevance_score}（Voyage）；
// - 用量：usage.total_tokens（Jina、Voyage、vLLM）、tokens.input_tokens / output_tokens（硅基流动）、meta.tokens（Cohere，可能没有；
//   Cohere 按 search_units 计费，不是 token，不记）。都没有记 null。
// 这里只发一次请求、不重试：检索时失败直接按原来的顺序（kb/rerank.js）。
import { LlmError } from './llm.js';
import { CONNECT_ERRORS, providerMessage, redactKey } from './models.js';

const ERROR_MAX_CHARS = 200;

/**
 * 重排接口的错误。kind 和向量接口的一样：config（没配好，没发请求）、auth（401 / 403）、not_found（404）、bad_request（其他 4xx）、
 * rate_limit（429）、server（5xx 和 408）、network（连不上）、timeout（超时）、bad_response（不是 JSON、缺 results、序号不对）
 */
export class RerankError extends LlmError {
  /**
   * @param {string} message
   * @param {string} kind
   * @param {{status?:number}} [o]
   */
  constructor(message, kind, { status = 0 } = {}) {
    super(message, status);
    this.kind = kind;
  }
}

/** 接口根地址：填的地址去掉首尾空白和末尾的 / */
export const rerankRoot = (baseUrl) => String(baseUrl ?? '').trim().replace(/\/+$/, '');

/**
 * 构造请求（地址、头、体），不发网络请求，方便测试。
 * @param {{baseUrl:string, apiKey?:string, model:string}} cfg
 * @param {string} query
 * @param {string[]} documents
 */
export function buildRerankRequest(cfg, query, documents) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { url: `${rerankRoot(cfg.baseUrl)}/rerank`, headers, body: { model: String(cfg.model).trim(), query, documents } };
}

const usageNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * 从响应体里取排好的序号和用量。序号不是整数、超出范围、重复的跳过，分数不是数的跳过；一个能用的都没有抛 bad_response。
 * 按分数从高到低排（分数一样的按返回的先后）。也认 TEI 那种直接返回数组、分数叫 score 的，免得兼容服务换个写法就用不了。
 * @param {any} data
 * @param {number} n 发过去几条
 * @returns {{results:{index:number, score:number}[], inputTokens:number|null, outputTokens:number|null}}
 */
export function parseRerankResponse(data, n) {
  const list = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : null;
  if (!list) throw new RerankError('重排接口返回格式不对（缺少 results 数组）', 'bad_response');
  const seen = new Set();
  const results = [];
  list.forEach((r, order) => {
    const index = r?.index;
    const score = typeof r?.relevance_score === 'number' ? r.relevance_score : r?.score;
    if (!Number.isInteger(index) || index < 0 || index >= n || seen.has(index)) return;
    if (typeof score !== 'number' || !Number.isFinite(score)) return;
    seen.add(index);
    results.push({ index, score, order });
  });
  if (n && !results.length) throw new RerankError('重排接口返回格式不对（结果里没有能用的序号和分数）', 'bad_response');
  results.sort((a, b) => b.score - a.score || a.order - b.order);
  const inputTokens =
    usageNum(data?.usage?.prompt_tokens) ??
    usageNum(data?.usage?.total_tokens) ??
    usageNum(data?.tokens?.input_tokens) ??
    usageNum(data?.meta?.tokens?.input_tokens) ??
    usageNum(data?.meta?.billed_units?.input_tokens);
  const outputTokens = usageNum(data?.tokens?.output_tokens) ?? usageNum(data?.meta?.tokens?.output_tokens) ?? null;
  return { results: results.map(({ index, score }) => ({ index, score })), inputTokens, outputTokens };
}

/** 按 HTTP 状态码分类，信息里不含密钥 */
function httpError(status, text, statusText, apiKey) {
  const msg = redactKey(providerMessage(text, statusText), apiKey).slice(0, ERROR_MAX_CHARS);
  const detail = msg ? `：${msg}` : '';
  if (status === 401 || status === 403) return new RerankError(`重排接口鉴权失败（${status}）${detail}。请检查 API 密钥`, 'auth', { status });
  if (status === 404) {
    return new RerankError(
      `重排接口返回 404${detail}。模型名不对或这个服务没有这个模型，也可能是接口地址不对（地址通常以 /v1 结尾，Cohere 是 /v2，系统会在后面加上 /rerank）`,
      'not_found',
      { status },
    );
  }
  if (status === 429) return new RerankError(`重排接口限流（429）${detail}`, 'rate_limit', { status });
  if (status === 408 || status >= 500) return new RerankError(`重排接口返回 ${status}${detail}`, 'server', { status });
  return new RerankError(`重排接口返回 ${status}${detail}`, 'bad_request', { status });
}

/**
 * 给一批文字按和 query 的相关度排序（只发一次请求，不重试）。所有错误都抛 RerankError，信息里不含密钥。
 * @param {{baseUrl:string, apiKey?:string, model:string}} cfg
 * @param {{query:string, documents:string[], timeoutMs?:number, signal?:AbortSignal}} o
 * @returns {Promise<{results:{index:number, score:number}[], inputTokens:number|null, outputTokens:number|null, model:string}>}
 *   results 按分数从高到低，index 是 documents 里的序号；接口没返回的条目不在里面
 */
export async function rerankDocuments(cfg, { query, documents, timeoutMs = 8_000, signal }) {
  if (!rerankRoot(cfg?.baseUrl)) throw new RerankError('还没有填写重排接口地址', 'config');
  if (!String(cfg.model || '').trim()) throw new RerankError('还没有填写重排模型', 'config');
  const key = String(cfg.apiKey || '');
  // 密钥只能是可见 ASCII，否则 fetch 拼请求头时会报错，而且报错信息里带着密钥
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new RerankError('API 密钥里有空格、中文或其他特殊字符，请检查后重新填写', 'config');
  if (!documents.length) return { results: [], inputTokens: null, outputTokens: null, model: cfg.model };
  const { url, headers, body } = buildRerankRequest(cfg, query, documents);
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('protocol');
  } catch {
    throw new RerankError('重排接口地址格式不对，要以 http:// 或 https:// 开头', 'config');
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  let text;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new RerankError('已取消', 'network');
    if (err?.name === 'TimeoutError' || timeout.aborted) {
      throw new RerankError(`重排接口请求超时（${Number((timeoutMs / 1000).toFixed(1))} 秒）`, 'timeout');
    }
    const code = err?.cause?.code || err?.code || '';
    const reason = CONNECT_ERRORS[code] ? `${CONNECT_ERRORS[code]}（${code}）` : code || err?.cause?.message || err?.message || String(err);
    throw new RerankError(`连不上重排接口：${redactKey(reason, key)}`, 'network');
  }
  if (!res.ok) throw httpError(res.status, text, res.statusText, key);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RerankError('重排接口返回的不是 JSON，请检查接口地址是否正确', 'bad_response');
  }
  return { ...parseRerankResponse(data, documents.length), model: cfg.model };
}
