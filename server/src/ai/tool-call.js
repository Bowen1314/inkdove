// 助手（assistant/）用的工具调用：openai / anthropic / gemini 三种接口格式的请求、响应解析和多轮回放。
// 发请求和重试沿用 llm.js 的 requestJson（同样的重试、超时和抹掉 key 的规则），这里只管各格式的结构：
//
// - openai（Chat Completions，https://developers.openai.com/api/docs/api-reference/chat）：
//   请求 tools:[{type:"function", function:{name, description, parameters}}]、tool_choice:"auto"|"none"；
//   响应 choices[0].message.tool_calls:[{id, type:"function", function:{name, arguments（JSON 字符串）}}]；
//   回放时助手消息带 tool_calls（有调用、没文字时 content 为 null），每个结果一条 {role:"tool", tool_call_id, content}。
// - anthropic（Messages，https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools 、handle-tool-calls）：
//   请求 tools:[{name, description, input_schema}]、tool_choice:{type:"auto"|"none"}；响应 content 里的
//   {type:"tool_use", id, name, input}（stop_reason 为 tool_use）；回放时助手的 content 原样带回（含 thinking 块的签名），
//   结果放在紧跟着的一条 user 消息里，全部是 {type:"tool_result", tool_use_id, content, is_error?}，按调用的顺序。
// - gemini（generateContent，https://ai.google.dev/api/generate-content 、https://ai.google.dev/api/caching）：
//   请求 tools:[{functionDeclarations:[{name, description, parameters}]}]、toolConfig.functionCallingConfig.mode:"AUTO"|"NONE"；
//   响应 parts 里的 {functionCall:{id?, name, args}}；回放时模型那条 content 原样带回（parts 里的 thoughtSignature 必须原样
//   带回去），结果是一条 role 为 user 的 content，每个调用一个 {functionResponse:{id?, name, response:{output|error}}}。
//   parameters 用 OpenAPI 子集（type 写成大写的 STRING、OBJECT…），不用 parametersJsonSchema：兼容 Gemini 格式的中转更多。
//
// 不支持工具调用的判断（尽量不让助手在没有工具的情况下瞎答）：
// 1. 接口返回 4xx、错误信息里提到 tool / function；
// 2. 没解析出工具调用，回答的文字却像是把调用写成了文字（<tool_call>、"tool_calls"、工具名加括号之类）；
// 3. 每个模型配置第一次用助手时先发一次很小的检查请求（probeToolSupport），明确要求调用一个工具，没调就当不支持。
// 这几条都是启发式的，个别中转可能误判，提示里会让换模型或中转。
import { ANTHROPIC_VERSION, LLM_FORMATS, LlmError, llmUrl, parseLlmUsage, requestJson } from './llm.js';

/** 不支持工具调用时给用户看的话（原样显示） */
export const TOOLS_UNSUPPORTED_MESSAGE = '当前模型或中转站不支持工具调用，助手用不了，请换一个支持的模型';

export class ToolsUnsupportedError extends LlmError {
  /** @param {string} [detail] 对方原始的错误信息（只写日志） */
  constructor(detail = '') {
    super(TOOLS_UNSUPPORTED_MESSAGE);
    this.code = 'tools_unsupported';
    this.detail = detail;
  }
}

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
/** Gemini 2.5 起思考 token 也算在 maxOutputTokens 里，给小了会只思考不出字（同 real.js） */
const GEMINI_MIN_MAX_TOKENS = 8192;

/**
 * JSON Schema（只用 type、description、enum、properties、required、items、minimum、maximum 这几项）→ Gemini 的 Schema：
 * type 换成大写，字符串枚举加 format:"enum"（文档的写法），其余字段不带。
 * @param {any} s
 */
export function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (typeof s.type === 'string') out.type = s.type.toUpperCase();
  if (s.description) out.description = s.description;
  if (Array.isArray(s.enum)) {
    out.enum = s.enum.map(String);
    if (out.type === 'STRING') out.format = 'enum';
  }
  if (s.properties && typeof s.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (Array.isArray(s.required) && s.required.length) out.required = [...s.required];
  if (s.items) out.items = toGeminiSchema(s.items);
  if (typeof s.minimum === 'number') out.minimum = s.minimum;
  if (typeof s.maximum === 'number') out.maximum = s.maximum;
  return out;
}

const hasParams = (t) => !!t.parameters && Object.keys(t.parameters.properties || {}).length > 0;
const emptyObjectSchema = () => ({ type: 'object', properties: {} });

/** 工具定义 {name, description, parameters} → 各格式的写法 */
function toolsFor(format, tools) {
  if (format === 'anthropic') {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: hasParams(t) ? t.parameters : emptyObjectSchema() }));
  }
  if (format === 'gemini') {
    // 没有参数的函数不带 parameters（OBJECT 的 properties 为空时 Gemini 会报错）
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          ...(hasParams(t) ? { parameters: toGeminiSchema(t.parameters) } : {}),
        })),
      },
    ];
  }
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: hasParams(t) ? t.parameters : emptyObjectSchema() },
  }));
}

/** 工具结果的文字（openai 格式没有 is_error 字段，出错的在下面加「错误：」前缀） */
const resultText = (r) => String(r.content ?? '');

/**
 * 中立的消息 → 各格式的消息。
 * 中立格式：{role:'user', text}；{role:'assistant', text, toolCalls?, raw?}（raw 是 parseToolResponse 给的原始助手消息，
 * 格式相同时原样回放）；{role:'tool', results:[{id, name, content, isError?, idFromModel?}]}。
 */
function messagesFor(format, messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (format === 'gemini') out.push({ role: 'user', parts: [{ text: m.text }] });
      else out.push({ role: 'user', content: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const raw = m.raw?.format === format ? m.raw : null;
      if (format === 'anthropic') {
        if (raw) out.push({ role: 'assistant', content: raw.content });
        else if (!calls.length) out.push({ role: 'assistant', content: m.text || '' });
        else {
          out.push({
            role: 'assistant',
            content: [
              ...(m.text ? [{ type: 'text', text: m.text }] : []),
              ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} })),
            ],
          });
        }
      } else if (format === 'gemini') {
        if (raw) out.push({ role: 'model', parts: raw.content.parts });
        else {
          out.push({
            role: 'model',
            parts: [
              ...(m.text ? [{ text: m.text }] : []),
              ...calls.map((c) => ({ functionCall: { ...(c.idFromModel ? { id: c.id } : {}), name: c.name, args: c.args || {} } })),
            ],
          });
        }
      } else {
        const msg = { role: 'assistant', content: m.text || (calls.length ? null : '') };
        if (calls.length) {
          msg.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: typeof c.rawArgs === 'string' ? c.rawArgs : JSON.stringify(c.args || {}) },
          }));
        }
        // 一些兼容接口（如 DeepSeek 的思考模式）要求同一轮里把 reasoning_content 带回去
        if (raw && typeof raw.message?.reasoning_content === 'string') msg.reasoning_content = raw.message.reasoning_content;
        out.push(msg);
      }
      continue;
    }
    if (m.role === 'tool') {
      const results = Array.isArray(m.results) ? m.results : [];
      if (format === 'anthropic') {
        out.push({
          role: 'user',
          content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: resultText(r), ...(r.isError ? { is_error: true } : {}) })),
        });
      } else if (format === 'gemini') {
        out.push({
          role: 'user',
          parts: results.map((r) => ({
            functionResponse: {
              ...(r.idFromModel ? { id: r.id } : {}),
              name: r.name,
              response: r.isError ? { error: resultText(r) } : { output: resultText(r) },
            },
          })),
        });
      } else {
        for (const r of results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `错误：${resultText(r)}` : resultText(r) });
      }
    }
  }
  return out;
}

/**
 * 构造带工具的请求（地址、头、体），不含网络操作，方便测试。
 * @param {{format?:string, baseUrl:string, apiKey?:string, model:string, system?:string, messages:any[],
 *   tools:{name:string, description:string, parameters?:any}[], toolChoice?:'auto'|'none', maxTokens?:number, temperature?:number}} o
 */
export function buildToolRequest(o) {
  const format = o.format || 'openai';
  const url = llmUrl(format, o.baseUrl, o.model);
  const headers = { 'content-type': 'application/json' };
  const temperature = o.temperature ?? 0.2;
  const choice = o.toolChoice === 'none' ? 'none' : 'auto';
  const tools = o.tools || [];
  let body;
  if (format === 'anthropic') {
    if (o.apiKey) headers['x-api-key'] = o.apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    // 历史里有 tool_use 时必须带着 tools 定义，所以要模型直接回答时也照带 tools，只把 tool_choice 设成 none
    body = {
      model: o.model,
      max_tokens: o.maxTokens || DEFAULT_ANTHROPIC_MAX_TOKENS,
      ...(o.system ? { system: o.system } : {}),
      messages: messagesFor(format, o.messages),
      temperature,
      ...(tools.length ? { tools: toolsFor(format, tools), tool_choice: { type: choice } } : {}),
    };
  } else if (format === 'gemini') {
    if (o.apiKey) headers['x-goog-api-key'] = o.apiKey;
    // 不设 responseMimeType：和函数调用冲突
    body = {
      ...(o.system ? { systemInstruction: { parts: [{ text: o.system }] } } : {}),
      contents: messagesFor(format, o.messages),
      ...(tools.length
        ? { tools: toolsFor(format, tools), toolConfig: { functionCallingConfig: { mode: choice === 'none' ? 'NONE' : 'AUTO' } } }
        : {}),
      generationConfig: { temperature, maxOutputTokens: Math.max(o.maxTokens || 0, GEMINI_MIN_MAX_TOKENS) },
    };
  } else {
    if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
    // 和 llm.js 一样不发 max_tokens（新模型只认 max_completion_tokens，很多兼容接口只认 max_tokens）
    body = {
      model: o.model,
      messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), ...messagesFor(format, o.messages)],
      temperature,
      ...(tools.length ? { tools: toolsFor(format, tools), tool_choice: choice } : {}),
    };
  }
  return { url, headers, body };
}

/** openai 的 arguments 是 JSON 字符串：解析不了的不抛错，交给调用方当成参数错误告诉模型 */
function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { args: raw };
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return { args: {} };
  try {
    const v = JSON.parse(String(raw));
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v };
  } catch {
    /* 下面按参数错误处理 */
  }
  return { args: {}, argsError: '参数不是合法的 JSON 对象' };
}

/**
 * 解析带工具的响应 → {text, toolCalls:[{id, name, args, argsError?, rawArgs?, idFromModel}], raw}。
 * id：模型给的调用 id；Gemini 没给 id 时本地编一个（idFromModel=false，回放时不带）。取不到候选结果时抛 LlmError。
 * @param {string} format
 * @param {any} data
 */
export function parseToolResponse(format, data) {
  if (format === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : null;
    if (!blocks) throw new LlmError('Anthropic 返回格式不对（缺少 content）');
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    const toolCalls = blocks
      .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
      .map((b, i) => ({ id: String(b.id || `toolu_local_${i}`), name: b.name, ...parseArgs(b.input), idFromModel: !!b.id }));
    return { text, toolCalls, raw: { format, content: blocks } };
  }
  if (format === 'gemini') {
    const cand = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
    if (!cand) {
      const block = data?.promptFeedback?.blockReason;
      throw new LlmError(block ? `Gemini 拦截了请求（blockReason: ${block}）` : 'Gemini 没有返回候选结果');
    }
    if (cand.finishReason === 'MALFORMED_FUNCTION_CALL' || cand.finishReason === 'UNEXPECTED_TOOL_CALL') {
      throw new LlmError(`Gemini 生成的工具调用不对（finishReason: ${cand.finishReason}）`);
    }
    const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
    const text = parts
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const toolCalls = parts
      .filter((p) => p?.functionCall && typeof p.functionCall.name === 'string')
      .map((p, i) => ({
        id: String(p.functionCall.id || `gemini_call_${i}`),
        name: p.functionCall.name,
        ...parseArgs(p.functionCall.args),
        idFromModel: !!p.functionCall.id,
      }));
    return { text, toolCalls, raw: { format, content: { role: 'model', parts } } };
  }
  const msg = data?.choices?.[0]?.message;
  if (!msg || typeof msg !== 'object') throw new LlmError('LLM 返回格式不对（缺少 choices[0].message）');
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((p) => typeof p?.text === 'string')
            .map((p) => p.text)
            .join('')
        : '';
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
    .filter((c) => typeof c?.function?.name === 'string')
    .map((c, i) => ({
      id: String(c.id || `call_local_${i}`),
      name: c.function.name,
      ...parseArgs(c.function.arguments),
      rawArgs: typeof c.function.arguments === 'string' ? c.function.arguments : undefined,
      idFromModel: !!c.id,
    }));
  return {
    text,
    toolCalls,
    raw: { format, message: { ...(typeof msg.reasoning_content === 'string' ? { reasoning_content: msg.reasoning_content } : {}) } },
  };
}

/**
 * 没解析出工具调用、文字却像是把调用写成了文字：说明工具定义没传到模型（中转站丢了 tools），模型在照着说明"假装"调用。
 * @param {string} text
 * @param {string[]} toolNames
 */
export function looksLikeTextToolCall(text, toolNames) {
  const s = String(text || '');
  if (!s) return false;
  if (/<\/?(tool_call|function_call|tool_use|invoke)\b|<\|tool|"tool_calls"\s*:|"function_call"\s*:/i.test(s)) return true;
  return toolNames.some((n) => new RegExp(`\\b${n}\\s*\\(|"name"\\s*:\\s*"${n}"|"(tool|function)"\\s*:\\s*"${n}"`).test(s));
}

/** 4xx 而且错误信息提到 tool / function：多半是模型或中转不支持工具调用 */
export function isToolsRejection(err) {
  const status = Number(err?.status) || 0;
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status) && /tool|function/i.test(String(err?.message || ''));
}

/**
 * 带工具的一次模型调用（不含循环）。
 * @param {{format?:string, baseUrl:string, apiKey?:string, model:string, system?:string, messages:any[],
 *   tools:{name:string, description:string, parameters?:any}[], toolChoice?:'auto'|'none', maxTokens?:number,
 *   timeoutMs:number, signal?:AbortSignal, retryBaseMs?:number}} opts
 * @returns {Promise<{text:string, toolCalls:any[], raw:any, model:string, usage:{inputTokens:number|null, outputTokens:number|null}}>}
 */
export async function chatWithTools(opts) {
  const format = opts.format || 'openai';
  if (!LLM_FORMATS.includes(format)) throw new LlmError(`不支持的接口格式：${format}`);
  if (!opts.baseUrl || !opts.model) throw new LlmError('LLM 未配置');
  const { url, headers, body } = buildToolRequest(opts);
  let data;
  try {
    data = await requestJson({ ...opts, url, headers, body: JSON.stringify(body) });
  } catch (err) {
    if ((opts.tools || []).length && isToolsRejection(err)) throw new ToolsUnsupportedError(err.message);
    throw err;
  }
  const parsed = parseToolResponse(format, data);
  if (
    !parsed.toolCalls.length &&
    (opts.tools || []).length &&
    looksLikeTextToolCall(
      parsed.text,
      opts.tools.map((t) => t.name),
    )
  ) {
    throw new ToolsUnsupportedError('回答里把工具调用写成了文字');
  }
  return { ...parsed, model: data?.model || data?.modelVersion || opts.model, usage: parseLlmUsage(format, data) };
}

/** 检查用的工具：没有参数 */
export const PROBE_TOOL = { name: 'inkdove_ping', description: '连通性检查。收到检查请求时调用它，不需要参数。' };

/**
 * 检查当前模型配置能不能用工具调用：明确要求调用一个没有参数的工具，返回了原生的工具调用就算支持。
 * 支持返回 {supported:true}；接口明确拒绝工具、或者没调用时返回 {supported:false, detail}；其他错误（网络、鉴权…）照常抛出。
 * @param {Omit<Parameters<typeof chatWithTools>[0], 'messages'|'tools'|'system'>} opts
 */
export async function probeToolSupport(opts) {
  try {
    const r = await chatWithTools({
      ...opts,
      system: '这是一次工具调用检查。不要回答文字，直接调用 inkdove_ping 工具。',
      messages: [{ role: 'user', text: '请调用 inkdove_ping 工具。' }],
      tools: [PROBE_TOOL],
      toolChoice: 'auto',
      maxTokens: 1024,
    });
    return r.toolCalls.some((c) => c.name === PROBE_TOOL.name)
      ? { supported: true, usage: r.usage, model: r.model }
      : { supported: false, detail: '检查时模型没有调用工具', usage: r.usage, model: r.model };
  } catch (err) {
    if (err instanceof ToolsUnsupportedError) return { supported: false, detail: err.detail };
    throw err;
  }
}
