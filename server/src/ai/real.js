import { embedTexts, EmbedError } from './embed.js';
import { chat, extractJson, LlmError, transcribe } from './llm.js';
import { chatWithTools, probeToolSupport } from './tool-call.js';
import { resolveEmbeddingConfig } from '../settings.js';
import { formatEntryForContext } from '../kb/search.js';
import { reportLlmCall } from '../records.js';
import {
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  buildFileDescribeUserPrompt,
  buildKbDraftUserPrompt,
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  buildSearchTermsUserPrompt,
  buildSuggestUserPrompt,
  FILE_DESCRIBE_SYSTEM_PROMPT,
  IMAGE_DESCRIBE_PROMPT,
  KB_DRAFT_SYSTEM_PROMPT,
  profileText,
  SEARCH_TERMS_SYSTEM_PROMPT,
  VOICE_TRANSCRIBE_PROMPT,
} from '../reply/prompts.js';
import { buildTranslateUserPrompt, buildTranslateZhUserPrompt, TRANSLATE_SYSTEM_PROMPT, TRANSLATE_ZH_SYSTEM_PROMPT } from '../reply/translate.js';
import { buildLeadUserPrompt, LEAD_SYSTEM_PROMPT } from '../leads/prompts.js';

const REPLY_TIMEOUT = 60_000;
const DISTILL_TIMEOUT = 180_000;
const MEDIA_TIMEOUT = 120_000;
/** 检索改写挡在生成回复前面，等太久不如不改写 */
const SEARCH_TIMEOUT = 20_000;
/** 向量：后台算条目的一批（几十段）最多等 60 秒；检索时的查询向量挡在生成回复前面，最多等 8 秒 */
const EMBED_DOC_TIMEOUT = 60_000;
const EMBED_QUERY_TIMEOUT = 8_000;
/** 助手的一步（一次带工具的模型调用）最多等多久；整个问题的总时长由 assistant/agent.js 控制，每步取两者里小的 */
const ASSISTANT_STEP_TIMEOUT = 60_000;

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
const str = (v, n = 300) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * 真实 LLM 实现。settings 每次调用时读取，保证设置页修改即时生效。
 * purpose：reply、review、draft、suggest、kb_draft、kb_search、translate、leads、media、file_describe、distill、assistant、test。F12 的 llm_calls
 * 由 records.js 的 withLlmCallLog 按方法写，这里只用 reportLlmCall 报上实际用的格式、模型和 token 数。
 * @param {() => any} getSettings
 * @param {{replyTimeoutMs?: number, reviewTimeoutMs?: number, distillTimeoutMs?: number, mediaTimeoutMs?: number, searchTimeoutMs?: number,
 *   assistantTimeoutMs?: number}} [opts]
 */
export function createRealAi(getSettings, opts = {}) {
  const replyTimeout = opts.replyTimeoutMs ?? REPLY_TIMEOUT;
  const distillTimeout = opts.distillTimeoutMs ?? DISTILL_TIMEOUT;
  const mediaTimeout = opts.mediaTimeoutMs ?? MEDIA_TIMEOUT;
  const timeouts = {
    reply: replyTimeout,
    review: opts.reviewTimeoutMs ?? REPLY_TIMEOUT,
    draft: replyTimeout,
    suggest: replyTimeout,
    kb_draft: replyTimeout,
    kb_search: opts.searchTimeoutMs ?? SEARCH_TIMEOUT,
    translate: replyTimeout,
    leads: replyTimeout,
    test: replyTimeout,
    distill: distillTimeout,
    file_describe: distillTimeout,
    media: mediaTimeout,
    assistant: opts.assistantTimeoutMs ?? ASSISTANT_STEP_TIMEOUT,
  };
  const MAX_TOKENS = { distill: 8192, reply: 2048, review: 512, draft: 2048, suggest: 2048, kb_draft: 2048, kb_search: 300, translate: 4096, leads: 1024, media: 1024, file_describe: 1024, test: 64 };
  /** 用哪个模型：识别图片、语音（含给图片文件写描述）用 media.mediaModel；蒸馏类用蒸馏模型；其余用回复模型。为空时都回退到回复模型 */
  const modelFor = (purpose, s, withAttachments) => {
    if (purpose === 'media' || (purpose === 'file_describe' && withAttachments)) return s.media.mediaModel || s.llm.model;
    if (purpose === 'distill' || purpose === 'file_describe') return s.llm.distillModel || s.llm.model;
    return s.llm.model;
  };
  /**
   * @param {string} purpose
   * @param {string} system
   * @param {string} user
   * @param {{signal?:AbortSignal, json?:boolean, maxTokens?:number, attachments?:{mime:string, data:string}[]}} [o]
   */
  const call = async (purpose, system, user, o = {}) => {
    const all = getSettings();
    const s = all.llm;
    const model = modelFor(purpose, all, !!o.attachments?.length);
    // 先报格式和模型（调用失败也要记一行），成功后再报 token 数
    reportLlmCall({ format: s.format, model });
    const r = await chat({
      format: s.format,
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model,
      system,
      messages: [{ role: 'user', text: user, attachments: o.attachments }],
      // Gemini 2.5 起思考 token 也算在 maxOutputTokens 里，给小了会只思考不出字
      maxTokens: s.format === 'gemini' ? Math.max(o.maxTokens ?? 0, MAX_TOKENS[purpose] ?? 0, 8192) : o.maxTokens ?? MAX_TOKENS[purpose],
      temperature: 0.2,
      json: o.json ?? true,
      signal: o.signal,
      timeoutMs: timeouts[purpose] ?? replyTimeout,
    });
    reportLlmCall(r.usage);
    return r;
  };

  const callJson = async (purpose, system, user, signal) => {
    const { text } = await call(purpose, system, user, { signal });
    const data = extractJson(text);
    if (data === null) throw new LlmError('模型没有返回可解析的 JSON');
    return data;
  };

  return {
    async test() {
      const started = Date.now();
      const { model } = await call('test', '', '请只回复：ok', { json: false, maxTokens: 64 });
      return { model, latencyMs: Date.now() - started };
    },

    async extract({ text, sourceName, signal }) {
      const system = `你是企业知识整理员。从给你的企业资料片段中抽取可以用来回答客户问题的知识条目。
要求：
- 每条自洽、可独立阅读；保留具体数字、型号、规格、价格、条件、时间、联系方式。
- 不编造资料里没有的内容；资料片段里没有有用信息时返回空数组。
- type 只能是 faq（问答）、product（产品/服务）、policy（政策/规则，如付款、物流、售后、退换）、fact（其他事实，如公司信息、营业时间）。
- title 简短（不超过 40 字），content 完整（一般不超过 500 字），tags 2–5 个关键词，quote 是支撑这条的原文摘录（不超过 120 字）。
- 条目语言与资料语言一致。
只输出 JSON：{"entries":[{"type":"faq","title":"","content":"","tags":[""],"quote":""}]}`;
      const data = await callJson('distill', system, `资料来源：${sourceName}\n\n----- 片段开始 -----\n${text}\n----- 片段结束 -----`, signal);
      return Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
    },

    async consolidate({ newEntries, candidates, signal }) {
      const fmt = (e) => `[id:${e.id}] (${e.type}) ${e.title}\n${e.content}`;
      const system = `你是企业知识库的编辑。下面有一批新抽取的条目和可能相关的已有条目。请：
1. 找出讲同一件事的重复条目，合并成一条（合并后的内容要完整，保留所有具体数字和条件）。
2. 找出互相矛盾的条目（例如同一产品价格、交期、政策说法不同），说明矛盾点。
只处理确实重复或矛盾的，没有就返回空数组。ids 只能用给出的 id。
只输出 JSON：{"merges":[{"ids":["id1","id2"],"title":"","content":"","tags":[""]}],"conflicts":[{"ids":["id1","id2"],"note":"一句话说明哪里不一致","question":"需要企业确认的问题"}]}`;
      const user = `新条目：\n${newEntries.map(fmt).join('\n\n')}\n\n已有的相关条目：\n${
        candidates.length ? candidates.map(fmt).join('\n\n') : '（无）'
      }`;
      const data = await callJson('distill', system, user, signal);
      return {
        merges: Array.isArray(data?.merges) ? data.merges : [],
        conflicts: Array.isArray(data?.conflicts) ? data.conflicts : [],
      };
    },

    async profile({ current, material, entryTitles, signal }) {
      const system = `你是企业资料分析员。根据资料生成或更新企业画像。已有画像中的信息如果资料没有推翻就保留。不编造。
字段：companyName（公司名称）、summary（一段话简介）、offerings（主要产品和服务）、contact（联系方式）、hours（营业时间）、languages（服务语言）、other（其他重要信息）。不知道的字段给空字符串。
只输出 JSON：{"companyName":"","summary":"","offerings":"","contact":"","hours":"","languages":"","other":""}`;
      const user = `已有画像：\n${profileText(current)}\n\n知识条目标题：\n${entryTitles.slice(0, 200).join('\n')}\n\n资料摘录：\n${material}`;
      return callJson('distill', system, user, signal);
    },

    async listQuestions({ profile, entryTitles, signal }) {
      const system = `你是客服主管。根据企业画像和知识库概况，列出 25 个客户在 WhatsApp 上最可能问的问题。
覆盖询价、交期、起订量、付款方式、物流运费、售后保修、退换货、联系方式、营业时间等，并按这家企业的行业调整。问题用中文，具体、简短。
只输出 JSON：{"questions":["..."]}`;
      const data = await callJson('distill', system, `企业画像：\n${profileText(profile)}\n\n已有条目标题：\n${entryTitles.slice(0, 200).join('\n')}`, signal);
      const list = Array.isArray(data?.questions) ? data.questions : Array.isArray(data) ? data : [];
      return list.filter((q) => typeof q === 'string' && q.trim()).slice(0, 25);
    },

    async judgeQuestions({ questions, entries, signal }) {
      const system = `你是知识库审核员。逐条判断下面的问题能否只依据给出的知识条目完整、准确地回答（不能靠猜测）。
只输出 JSON：{"results":[{"question":"原问题","answerable":true,"reason":"答不了时说明缺什么信息"}]}`;
      const user = `知识条目：\n${entries.map(formatEntryForContext).join('\n\n') || '（空）'}\n\n问题：\n${questions
        .map((q, i) => `${i + 1}. ${q}`)
        .join('\n')}`;
      const data = await callJson('distill', system, user, signal);
      return Array.isArray(data?.results) ? data.results : [];
    },

    /**
     * 生成回复。返回 {category, reply, usedEntryIds, sendFileIds, handoffType, offtopicType, questionZh, reason}；输出解析不了时返回 null。
     */
    async generate({ message, history, entries, files = [], filesTruncated = false, profile, persona, canary, styleHint = null }) {
      const { text } = await call(
        'reply',
        buildReplySystemPrompt({ profile, persona, entries, files, filesTruncated, canary }),
        buildReplyUserPrompt({ message, history, styleHint }),
      );
      const data = extractJson(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return {
        category: typeof data.category === 'string' ? data.category.trim().toLowerCase() : '',
        reply: typeof data.reply === 'string' ? data.reply : '',
        usedEntryIds: strList(data.used_entry_ids),
        sendFileIds: strList(data.send_file_ids),
        handoffType: str(data.handoff_type, 40).toLowerCase(),
        offtopicType: str(data.offtopic_type, 40).toLowerCase(),
        questionZh: str(data.question_zh, 300),
        reason: str(data.reason, 300),
      };
    },

    /**
     * 审核待发送的回复（带要发送的文件）。返回 {verdict, reason}；解析不了返回 null。调用失败直接抛错。
     */
    async review({ profile, entries, files = [], customerMessages, reply }) {
      const { text } = await call(
        'review',
        buildReviewSystemPrompt({ profile }),
        buildReviewUserPrompt({ profile, entries, files, customerMessages, reply }),
      );
      const data = extractJson(text);
      if (!data || typeof data !== 'object' || typeof data.verdict !== 'string') return null;
      return { verdict: data.verdict.trim().toLowerCase(), reason: typeof data.reason === 'string' ? data.reason : '' };
    },

    /**
     * F2a：给人工起草回复（agentProfile 是会话负责人的「我的资料」，没有就不带）。返回 {text, fileIds, entryIds}
     * （entryIds 是模型给的 used_entry_ids 原样，调用方再规整、只留这次放进提示词的条目）；解析不了时抛错
     */
    async draft({ message, history, entries, files = [], filesTruncated = false, profile, persona, agentProfile = null, reason }) {
      const { text } = await call(
        'draft',
        buildDraftSystemPrompt({ profile, persona, entries, files, filesTruncated, agentProfile }),
        buildDraftUserPrompt({ message, history, reason }),
      );
      const data = extractJson(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('草稿输出无法解析');
      return { text: typeof data.text === 'string' ? data.text : '', fileIds: strList(data.file_ids), entryIds: strList(data.used_entry_ids) };
    },

    /**
     * 推荐回复：草稿的提示词骨架，加公司话术、个人话术和点按钮那个人的「我的资料」（agentProfile）；previous 是「换一条」时的
     * 上一条推荐；followUp / ourMessages 是跟进（我方说的是最后一条）时的说法和我方后来发的消息。
     * 返回 {text, fileIds, entryIds}（同 draft）；解析不了时抛错
     */
    async suggest({
      message,
      history,
      entries,
      files = [],
      filesTruncated = false,
      profile,
      persona,
      companyPrompt = '',
      stylePrompt = '',
      agentProfile = null,
      previous = '',
      followUp = false,
      ourMessages = [],
    }) {
      const { text } = await call(
        'suggest',
        buildDraftSystemPrompt({ profile, persona, entries, files, filesTruncated, companyPrompt, stylePrompt, agentProfile }),
        buildSuggestUserPrompt({ message, history, previous, followUp, ourMessages }),
      );
      const data = extractJson(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('推荐回复输出无法解析');
      return { text: typeof data.text === 'string' ? data.text : '', fileIds: strList(data.file_ids), entryIds: strList(data.used_entry_ids) };
    },

    /** F2b：把人工回复改写成知识条目 {type, title, content, tags} */
    async kbDraft({ question, answer }) {
      const data = await callJson('kb_draft', KB_DRAFT_SYSTEM_PROMPT, buildKbDraftUserPrompt({ question, answer }));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('改写结果无法解析');
      return data;
    },

    /**
     * 知识库检索改写（用回复模型，输出上限 300 token）：把要检索的话改写成知识库语言的检索词。返回 {terms}；
     * 解析不了时抛错（kb/retrieve.js 接住，退回只用原话检索）
     */
    async searchTerms({ query, sampleTitles = [] }) {
      const data = await callJson('kb_search', SEARCH_TERMS_SYSTEM_PROMPT, buildSearchTermsUserPrompt({ query, sampleTitles }));
      const list = Array.isArray(data) ? data : data?.terms;
      if (!Array.isArray(list)) throw new LlmError('检索词改写结果无法解析');
      return { terms: strList(list) };
    },

    /**
     * 向量（可选的向量检索，kb/vectors.js）：用设置里的向量接口（或 config 指定的，测试接口用）算一批文字的向量，只发一次请求不重试。
     * 返回 {vectors（已归一化的 Float32Array）, dims, inputTokens, model}；错误都是 EmbedError（带 kind）。
     * llm_calls 记 embedding：格式和模型是向量接口的，token 只有输入（Gemini 的旧版本或代理没给用量时记 null）。
     * @param {{texts:string[], task?:'document'|'query', signal?:AbortSignal, timeoutMs?:number, config?:any}} o
     */
    async embed({ texts, task = 'document', signal, timeoutMs, config }) {
      const cfg = config || resolveEmbeddingConfig(getSettings());
      if (!cfg.ok) throw new EmbedError(cfg.error, 'config');
      reportLlmCall({ format: cfg.format, model: cfg.model });
      const r = await embedTexts(cfg, texts, {
        task,
        signal,
        timeoutMs: timeoutMs ?? (task === 'query' ? EMBED_QUERY_TIMEOUT : EMBED_DOC_TIMEOUT),
      });
      reportLlmCall({ inputTokens: r.inputTokens, outputTokens: null });
      return r;
    },

    /** 会话输入框的一键翻译（用回复模型）：按客户最近的文字消息判断语言，直译业务员写的话。返回 {language, translation} */
    async translate({ text, customerMessages }) {
      const data = await callJson('translate', TRANSLATE_SYSTEM_PROMPT, buildTranslateUserPrompt({ text, customerMessages }));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('翻译结果无法解析');
      return { language: str(data.language, 20), translation: typeof data.translation === 'string' ? data.translation : '' };
    },

    /** 译成简体中文（会话里点「翻译」的消息、推荐回复的中文意思，用回复模型）：只直译。返回 {translation} */
    async translateToChinese({ text }) {
      const data = await callJson('translate', TRANSLATE_ZH_SYSTEM_PROMPT, buildTranslateZhUserPrompt({ text }));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('翻译结果无法解析');
      return { translation: typeof data.translation === 'string' ? data.translation : '' };
    },

    /** F6：从会话最近的消息里提取客户线索（用回复模型）。返回模型给的对象，字段由 leads/store.js 规范化；不是对象时抛错 */
    async extractLead({ contactName = '', messages }) {
      const data = await callJson('leads', LEAD_SYSTEM_PROMPT, buildLeadUserPrompt({ contactName, messages }));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmError('线索提取结果无法解析');
      return data;
    },

    /** F4：描述客户发来的图片，返回描述文本 */
    async describeImage({ mime, data }) {
      const { text } = await call('media', '', IMAGE_DESCRIBE_PROMPT, { json: false, attachments: [{ mime, data }] });
      return text.trim();
    },

    /** F4：语音转文字。openai 走 /audio/transcriptions（transcribeModel）；gemini 用 inline data；anthropic 不支持 */
    async transcribe({ audio, mime, filename }) {
      const all = getSettings();
      const s = all.llm;
      if (s.format === 'openai') {
        // 转写接口不按 token 计用量，token 记 null
        reportLlmCall({ format: 'openai', model: all.media.transcribeModel });
        const { text } = await transcribe({
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          model: all.media.transcribeModel,
          audio,
          mime,
          filename,
          timeoutMs: mediaTimeout,
        });
        return text.trim();
      }
      if (s.format === 'gemini') {
        const { text } = await call('media', '', VOICE_TRANSCRIBE_PROMPT, {
          json: false,
          attachments: [{ mime: String(mime).split(';')[0].trim(), data: Buffer.from(audio).toString('base64') }],
        });
        return text.trim();
      }
      throw new LlmError('anthropic 格式不支持语音');
    },

    /**
     * 助手（assistant/agent.js）的一步：带工具调用一次回复模型（三种格式见 ai/tool-call.js）。
     * messages 是中立格式的多轮消息（含上一步的工具调用和结果）；toolChoice 为 none 时要模型直接回答。
     * 返回 {text, toolCalls:[{id, name, args, argsError?}], raw}（raw 留着下一步原样回放）。模型或中转不支持工具调用时抛
     * ToolsUnsupportedError
     */
    async assistantStep({ system, messages, tools, toolChoice = 'auto', signal, timeoutMs }) {
      const s = getSettings().llm;
      reportLlmCall({ format: s.format, model: s.model });
      const r = await chatWithTools({
        format: s.format,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        system,
        messages,
        tools,
        toolChoice,
        signal,
        timeoutMs: Math.min(timeoutMs ?? timeouts.assistant, timeouts.assistant),
      });
      reportLlmCall(r.usage);
      return { text: r.text, toolCalls: r.toolCalls, raw: r.raw };
    },

    /** 助手：检查当前模型配置支不支持工具调用（一次很小的调用，见 ai/tool-call.js 的 probeToolSupport）→ {supported, detail?} */
    async assistantProbe({ signal } = {}) {
      const s = getSettings().llm;
      reportLlmCall({ format: s.format, model: s.model });
      const r = await probeToolSupport({
        format: s.format,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        signal,
        timeoutMs: timeouts.assistant,
      });
      if (r.usage) reportLlmCall(r.usage);
      return { supported: r.supported, detail: r.detail || '' };
    },

    /** F15：给产品资料库的文件生成描述。文档用蒸馏模型读文字；图片用识图模型看附件 */
    async describeFile({ name, filename, text = '', image = null }) {
      const user = buildFileDescribeUserPrompt({ name, filename, text });
      const { text: out } = await call('file_describe', FILE_DESCRIBE_SYSTEM_PROMPT, user, {
        json: false,
        attachments: image ? [image] : undefined,
      });
      return out.trim();
    },
  };
}
