import { sleep } from '../util.js';

export class LlmError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export const LLM_FORMATS = ['openai', 'anthropic', 'gemini'];
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');

/**
 * 按格式取接口根地址（不带末尾的 /）：
 * anthropic 以 /v1 结尾就直接用，否则补 /v1；gemini 以 /v1 或 /v1beta 结尾就直接用，否则补 /v1beta；openai 就是 baseUrl 本身。
 */
export function llmRoot(format, baseUrl) {
  const base = trimBase(baseUrl);
  if (format === 'anthropic') return /\/v1$/.test(base) ? base : `${base}/v1`;
  if (format === 'gemini') return /\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`;
  return base;
}

/** 按格式拼请求地址 */
export function llmUrl(format, baseUrl, model) {
  const root = llmRoot(format, baseUrl);
  if (format === 'anthropic') return `${root}/messages`;
  if (format === 'gemini') {
    const m = encodeURIComponent(String(model).replace(/^models\//, ''));
    return `${root}/models/${m}:generateContent`;
  }
  return `${root}/chat/completions`;
}

/**
 * F4：消息可以带附件 {mime, data(base64，不带 data: 前缀)}。各格式的写法：
 * - openai：content 数组，图片用 {type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}；语音不走 chat，用 transcribe()
 * - anthropic：content 数组，图片用 {type:"image", source:{type:"base64", media_type, data}}，放在文字前面；不支持音频
 * - gemini：parts 里放 {inlineData:{mimeType, data}}，图片和音频都可以
 */
function contentFor(format, m) {
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  if (!atts.length) return null;
  for (const a of atts) {
    const isImage = /^image\//.test(a.mime);
    if (!isImage && format !== 'gemini') throw new LlmError(`${format} 格式不支持在对话里直接传 ${a.mime}`);
  }
  if (format === 'anthropic') {
    return [
      ...atts.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })),
      ...(m.text ? [{ type: 'text', text: m.text }] : []),
    ];
  }
  if (format === 'gemini') {
    return [...atts.map((a) => ({ inlineData: { mimeType: a.mime, data: a.data } })), ...(m.text ? [{ text: m.text }] : [])];
  }
  return [
    ...(m.text ? [{ type: 'text', text: m.text }] : []),
    ...atts.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } })),
  ];
}

/**
 * 构造请求（地址、头、体），不含任何网络操作，方便测试。
 * @param {{format?:string, baseUrl:string, apiKey?:string, model:string, system?:string,
 *   messages:{role:'user'|'assistant', text:string, attachments?:{mime:string, data:string}[]}[],
 *   maxTokens?:number, temperature?:number, json?:boolean}} o
 */
export function buildLlmRequest(o) {
  const format = o.format || 'openai';
  const url = llmUrl(format, o.baseUrl, o.model);
  const headers = { 'content-type': 'application/json' };
  const temperature = o.temperature ?? 0.2;
  let body;
  if (format === 'anthropic') {
    if (o.apiKey) headers['x-api-key'] = o.apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    body = {
      model: o.model,
      max_tokens: o.maxTokens || DEFAULT_MAX_TOKENS,
      ...(o.system ? { system: o.system } : {}),
      messages: o.messages.map((m) => ({ role: m.role, content: contentFor(format, m) ?? m.text })),
      temperature,
    };
  } else if (format === 'gemini') {
    if (o.apiKey) headers['x-goog-api-key'] = o.apiKey;
    body = {
      ...(o.system ? { systemInstruction: { parts: [{ text: o.system }] } } : {}),
      contents: o.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: contentFor(format, m) ?? [{ text: m.text }] })),
      generationConfig: {
        temperature,
        maxOutputTokens: o.maxTokens || DEFAULT_MAX_TOKENS,
        ...(o.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
  } else {
    if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
    // 不发 max_tokens：OpenAI 的新模型只认 max_completion_tokens，而很多兼容接口只认 max_tokens
    body = {
      model: o.model,
      messages: [
        ...(o.system ? [{ role: 'system', content: o.system }] : []),
        ...o.messages.map((m) => ({ role: m.role, content: contentFor(format, m) ?? m.text })),
      ],
      temperature,
    };
  }
  return { url, headers, body };
}

/**
 * 从响应体里取文本；取不到时抛 LlmError。
 * @param {string} format
 * @param {any} data
 */
export function parseLlmResponse(format, data) {
  if (format === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : null;
    if (!blocks) throw new LlmError('Anthropic 返回格式不对（缺少 content）');
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!text) throw new LlmError(`Anthropic 没有返回文本（stop_reason: ${data?.stop_reason ?? '未知'}）`);
    return text;
  }
  if (format === 'gemini') {
    const cand = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
    if (!cand) {
      const block = data?.promptFeedback?.blockReason;
      throw new LlmError(block ? `Gemini 拦截了请求（blockReason: ${block}）` : 'Gemini 没有返回候选结果');
    }
    const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
    const text = parts
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (!text) throw new LlmError(`Gemini 没有返回文本（finishReason: ${cand.finishReason ?? '未知'}）`);
    return text;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new LlmError('LLM 返回格式不对（缺少 choices[0].message.content）');
  return content;
}

/** 用量字段：非负数取整，其余（缺失、null、负数、字符串）为 null */
const usageNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
/** 几个用量字段相加：都没有时为 null，有一个就把缺的当 0 */
const usageSum = (...vals) => {
  const nums = vals.map(usageNum);
  return nums.every((n) => n === null) ? null : nums.reduce((a, n) => a + (n ?? 0), 0);
};

/**
 * F12：从响应体里取 token 用量，取不到的记 null。
 * - openai：usage.prompt_tokens、usage.completion_tokens（completion 已含推理 token）；
 * - anthropic：输入 = usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens（input_tokens 不含缓存的部分），
 *   输出 = usage.output_tokens；
 * - gemini：输入 = usageMetadata.promptTokenCount，输出 = candidatesTokenCount + thoughtsTokenCount（思考 token 单独计）。
 * @param {string} format
 * @param {any} data
 * @returns {{inputTokens:number|null, outputTokens:number|null}}
 */
export function parseLlmUsage(format, data) {
  if (format === 'anthropic') {
    const u = data?.usage;
    return {
      inputTokens: usageSum(u?.input_tokens, u?.cache_creation_input_tokens, u?.cache_read_input_tokens),
      outputTokens: usageNum(u?.output_tokens),
    };
  }
  if (format === 'gemini') {
    const u = data?.usageMetadata;
    return { inputTokens: usageNum(u?.promptTokenCount), outputTokens: usageSum(u?.candidatesTokenCount, u?.thoughtsTokenCount) };
  }
  const u = data?.usage;
  return { inputTokens: usageNum(u?.prompt_tokens), outputTokens: usageNum(u?.completion_tokens) };
}

/** 把 key 从任意文本里抹掉 */
function scrub(text, apiKey) {
  let s = String(text ?? '');
  if (apiKey && apiKey.length >= 4) s = s.split(apiKey).join('***');
  return s;
}

/**
 * 发请求、按规则重试、解析 JSON 响应。429、5xx（含 Anthropic 529）和连接错误重试 2 次，指数退避；超时不重试。
 * @param {{url:string, headers:Record<string,string>, body:any, apiKey?:string, timeoutMs:number, signal?:AbortSignal, retryBaseMs?:number}} o
 */
async function requestJson(o) {
  const { url, headers, body, apiKey, timeoutMs, signal } = o;
  const retryBase = o.retryBaseMs ?? 1000;
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new LlmError('已取消');
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let retryable = false;
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: combined });
      const text = await res.text();
      if (!res.ok) {
        retryable = res.status === 429 || res.status >= 500;
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          const e = Array.isArray(j) ? j[0]?.error : j?.error;
          msg = (typeof e === 'string' ? e : e?.message) || j?.message || msg;
        } catch {
          /* 非 JSON */
        }
        throw new LlmError(`LLM 接口返回 ${res.status}：${scrub(msg, apiKey)}`, res.status);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError('LLM 返回的不是 JSON');
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? new LlmError('已取消');
      if (err instanceof LlmError) {
        lastErr = err;
      } else if (err?.name === 'TimeoutError' || timeout.aborted) {
        // 超时不重试（否则一次回复可能拖到 3 倍超时）
        lastErr = new LlmError(`LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        retryable = false;
      } else {
        lastErr = new LlmError(`LLM 请求失败：${scrub(err?.cause?.code || err?.message || err, apiKey)}`);
        retryable = true;
      }
      if (!retryable || attempt === maxAttempts - 1) throw lastErr;
      await sleep(retryBase * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

/**
 * 统一的 LLM 调用：openai / anthropic / gemini 三种格式。
 * 429、5xx（含 Anthropic 529）和连接错误重试 2 次，指数退避；超时不重试。
 * 错误信息带 HTTP 状态码和对方的 error message，不含 key。
 *
 * @param {{format?:string, baseUrl:string, apiKey?:string, model:string, system?:string,
 *   messages:{role:'user'|'assistant', text:string, attachments?:{mime:string, data:string}[]}[],
 *   maxTokens?:number, temperature?:number, json?:boolean,
 *   timeoutMs:number, signal?:AbortSignal, retryBaseMs?:number}} opts
 * @returns {Promise<{text:string, model:string, usage:{inputTokens:number|null, outputTokens:number|null}}>}
 *   usage 是 F12 的 token 用量（见 parseLlmUsage）
 */
export async function chat(opts) {
  const format = opts.format || 'openai';
  if (!LLM_FORMATS.includes(format)) throw new LlmError(`不支持的接口格式：${format}`);
  if (!opts.baseUrl || !opts.model) throw new LlmError('LLM 未配置');
  const { url, headers, body } = buildLlmRequest(opts);
  const data = await requestJson({ ...opts, url, headers, body: JSON.stringify(body) });
  return {
    text: parseLlmResponse(format, data),
    model: data?.model || data?.modelVersion || opts.model,
    usage: parseLlmUsage(format, data),
  };
}

/** OpenAI 转写接口地址：{baseUrl}/audio/transcriptions */
export const transcriptionUrl = (baseUrl) => `${trimBase(baseUrl)}/audio/transcriptions`;

/**
 * F4：OpenAI 格式的语音转写。POST {baseUrl}/audio/transcriptions，multipart：file、model、response_format=json；
 * 不传 language，保留原语言。返回 {text}。
 * https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
 * @param {{baseUrl:string, apiKey?:string, model:string, audio:Buffer, mime:string, filename?:string,
 *   timeoutMs:number, signal?:AbortSignal, retryBaseMs?:number}} opts
 */
export async function transcribe(opts) {
  if (!opts.baseUrl || !opts.model) throw new LlmError('转写模型未配置');
  const form = new FormData();
  form.append('file', new Blob([opts.audio], { type: opts.mime }), opts.filename || 'voice.ogg');
  form.append('model', opts.model);
  form.append('response_format', 'json');
  const headers = {};
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const data = await requestJson({ ...opts, url: transcriptionUrl(opts.baseUrl), headers, body: form });
  if (typeof data?.text !== 'string') throw new LlmError('转写接口返回格式不对（缺少 text）');
  return { text: data.text };
}

/**
 * 宽容地从模型输出里提取 JSON：整体、```json 代码块、或首个平衡的 {...}。
 * @param {string} text
 * @returns {any|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(s);
  if (v !== undefined) return v;
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(s))) {
    v = tryParse(m[1].trim());
    if (v !== undefined) return v;
  }
  // 找平衡的大括号/方括号
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    let start = s.indexOf(open);
    while (start >= 0) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            v = tryParse(s.slice(start, i + 1));
            if (v !== undefined) return v;
            break;
          }
        }
      }
      start = s.indexOf(open, start + 1);
    }
  }
  return null;
}
