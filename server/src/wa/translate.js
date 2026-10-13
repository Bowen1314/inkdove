// 会话输入框的一键翻译：POST /api/wa/conversations/:id/translate。
// 只读会话，不改会话任何状态（不暂停机器人、不清草稿），也不计入会话每日模型次数（不碰 conversations.llm_calls）；
// 模型调用照常记进 llm_calls（purpose=translate，见 records.js 的 AI_METHOD_PURPOSE），翻译接口的调用也记（format、model 记服务的 id）。
//
// 两种方式（设置 → 翻译，settings.translation.mode）：
// - ai（默认）：把业务员的话和客户最近的文字消息交给回复模型，模型判断客户语言并翻译；
// - api：用选的翻译接口（translate/ 下每家一个文件）：
//   1. 判断客户语言：取客户最近的文字消息（截到几百字），有语言检测接口的用检测接口，没有的「自动判断源语言」译成中文一次，
//      看对方判断出的源语言；对方没给结果时用本地的 tinyld 判断。结果按会话记在进程里，客户发了新消息才重新判断；
//   2. 把业务员的话译成那种语言；本来就是那种语言（本地判断或对方判断出的源语言）的原样返回；
//   3. 出错时：开着「翻译接口出错时改用 AI 翻译」而且回复模型配好了的，这次改用 AI 翻译并说明原因（fallbackReason）；
//      否则报错，说清楚是哪家、什么问题。
// 返回 {text, language（中文名）, via（ai 或服务 id）, fallbackReason?}。
import { llmScope } from '../records.js';
import { llmConfigured } from '../settings.js';
import { detectLocal } from '../translate/detect-local.js';
import { callTranslationProvider, FIELD_LABELS, getTranslationProvider, missingField, TranslateError } from '../translate/index.js';
import { languageName } from '../translate/languages.js';
import { badRequest, clip, HttpError } from '../util.js';

/** 原文长度上限，和人工发送的上限一致（service.js 的 MAX_OPERATOR_TEXT） */
export const MAX_TRANSLATE_TEXT = 4096;
/** 判断客户语言最多看客户最近几条文字消息 */
export const LANGUAGE_SAMPLE_COUNT = 10;
/** 用翻译接口判断客户语言时，发过去的客户原话最多多少字（从最近的往前取） */
export const DETECT_SAMPLE_CHARS = 300;
/** 进程里最多记多少个会话的客户语言（超了丢最久没用的） */
export const LANGUAGE_CACHE_MAX = 500;
/** 译文上限：译成别的语言可能比原文长不少，这里只防模型失控 */
const MAX_TRANSLATION = 20_000;
/** 判断语言时碰到这些错误说明这家服务现在用不了，不再接着翻译（免得再等一次超时），直接按出错处理 */
const STOP_KINDS = new Set(['config', 'auth', 'network', 'timeout', 'quota', 'rate_limit', 'server']);

/**
 * 客户最近的文字消息（从早到晚）和最新一条的 seq。语音、图片（含识别后的描述）、导入的非文字占位都不算：
 * 图片描述是模型用中文写的，会把语言判断带偏。
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 * @returns {{texts: string[], latestSeq: number|null}}
 */
function recentCustomerTexts(db, convId) {
  const rows = db
    .prepare(
      `SELECT seq, text FROM messages
       WHERE conversation_id = ? AND direction = 'in' AND author = 'customer' AND kind = 'text' AND media IS NULL AND trim(text) <> ''
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(convId, LANGUAGE_SAMPLE_COUNT);
  return { texts: rows.map((r) => r.text).reverse(), latestSeq: rows.length ? rows[0].seq : null };
}

/**
 * 判断语言用的客户原话：从最近的一条往前拼，总共不超过 DETECT_SAMPLE_CHARS 字（单条太长的截断），再按时间顺序排好。
 * @param {string[]} texts 从早到晚
 */
export function detectionSample(texts) {
  const picked = [];
  let total = 0;
  for (let i = texts.length - 1; i >= 0 && total < DETECT_SAMPLE_CHARS; i--) {
    const t = String(texts[i]).trim().slice(0, DETECT_SAMPLE_CHARS - total);
    if (!t) continue;
    picked.push(t);
    total += t.length + 1;
  }
  return picked.reverse().join('\n');
}

/** 用回复模型翻译（原来的做法） */
async function aiTranslate(ctx, conv, source, customerMessages) {
  let out;
  try {
    out = await llmScope({ accountId: conv.accountId ?? null, conversationId: conv.id, purpose: 'translate' }, () =>
      ctx.ai.translate({ text: source, customerMessages }),
    );
  } catch (err) {
    throw new HttpError(502, 'llm_error', `翻译失败：${err?.message || err}`);
  }
  const language = typeof out?.language === 'string' ? out.language.trim() : '';
  const translation = typeof out?.translation === 'string' ? out.translation.trim() : '';
  if (!language || !translation) throw new HttpError(502, 'llm_error', '翻译失败：模型返回的结果不完整，请重试');
  return { text: clip(translation, MAX_TRANSLATION), language: clip(language, 20) };
}

/**
 * 客户用的语言（两位代码）。按会话记住，客户发了新的文字消息（latestSeq 变了）才重新判断。
 * @returns {Promise<string>}
 */
async function customerLanguage(ctx, conv, meta, provider, cfg, customer) {
  const cache = ctx.translationLanguages;
  const hit = cache.get(conv.id);
  if (hit && hit.seq === customer.latestSeq) {
    // 挪到最后：最久没用的在最前面，超了先丢
    cache.delete(conv.id);
    cache.set(conv.id, hit);
    return hit.lang;
  }
  const sample = detectionSample(customer.texts);
  let lang = null;
  try {
    if (typeof provider.detect === 'function') lang = await callTranslationProvider(ctx, meta, 'detect', provider.id, cfg, sample);
    else lang = (await callTranslationProvider(ctx, meta, 'translate', provider.id, cfg, { text: sample, source: 'auto', target: 'zh' })).detectedSource;
  } catch (err) {
    if (!(err instanceof TranslateError) || STOP_KINDS.has(err.kind)) throw err;
    // 返回格式不对、这段话的语言对方不支持之类：交给本地判断
  }
  if (!lang) lang = detectLocal(sample);
  if (!lang) throw new TranslateError('判断不出客户用的是什么语言（客户的消息太短，或者都是数字、符号）', 'language_unknown');
  cache.delete(conv.id);
  while (cache.size >= LANGUAGE_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(conv.id, { seq: customer.latestSeq, lang });
  return lang;
}

/** 用翻译接口翻译。出错抛 TranslateError */
async function apiTranslate(ctx, conv, source, customer, tr) {
  const provider = getTranslationProvider(tr.provider);
  if (!provider) throw new TranslateError('还没有选翻译服务', 'config');
  const cfg = tr.providers[provider.id] || {};
  const missing = missingField(provider.id, cfg);
  if (missing) throw new TranslateError(`${provider.label} 还没配好（没填 ${FIELD_LABELS[missing] || missing}）`, 'config');
  const meta = { purpose: 'translate', accountId: conv.accountId ?? null, conversationId: conv.id };
  const target = await customerLanguage(ctx, conv, meta, provider, cfg, customer);
  const done = (text) => ({ text: clip(text, MAX_TRANSLATION), language: languageName(target), via: provider.id });
  // 业务员写的本来就是客户的语言（比如客户说中文）：原样返回，不调接口
  if (detectLocal(source) === target) return done(source);
  if (provider.targets && !provider.targets.has(target)) {
    throw new TranslateError(`${provider.label} 不支持译成${languageName(target)}`, 'unsupported_language');
  }
  const r = await callTranslationProvider(ctx, meta, 'translate', provider.id, cfg, { text: source, source: 'auto', target });
  if (r.detectedSource && r.detectedSource === target) return done(source);
  const out = String(r.text ?? '').trim();
  if (!out) throw new TranslateError(`${provider.label} 返回的译文是空的`, 'bad_response');
  return done(out);
}

/** 翻译接口的错误 → 接口错误（没有改用 AI 翻译时） */
function apiFailure(err, hint) {
  const message = `翻译失败：${err.message}${hint}`;
  if (err.kind === 'config') return new HttpError(400, 'translation_not_configured', message);
  if (err.kind === 'unsupported_language') return new HttpError(400, 'translation_unsupported_language', message);
  if (err.kind === 'language_unknown') return new HttpError(400, 'language_unknown', message);
  return new HttpError(502, 'translation_api_error', message);
}

/**
 * 把业务员写的话直译成这个会话客户的语言。权限由路由检查（同手动回复）。
 * @param {any} ctx
 * @param {{id:string, accountId:string|null}} conv 路由 loadConv 返回的会话
 * @param {unknown} text
 * @returns {Promise<{text:string, language:string, via:string, fallbackReason?:string}>}
 */
export async function translateForConversation(ctx, conv, text) {
  if (typeof text !== 'string' || !text.trim()) throw badRequest('要翻译的内容不能为空');
  const source = text.trim();
  if (source.length > MAX_TRANSLATE_TEXT) throw badRequest(`要翻译的内容不能超过 ${MAX_TRANSLATE_TEXT} 字`, 'text_too_long');
  const settings = ctx.getSettings();
  const tr = settings.translation;
  const canUseAi = llmConfigured(settings, ctx.config);

  if (tr?.mode !== 'api') {
    if (!canUseAi) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
    const customer = recentCustomerTexts(ctx.db, conv.id);
    if (!customer.texts.length) throw badRequest('客户还没发过文字消息，判断不了用什么语言', 'language_unknown');
    return { ...(await aiTranslate(ctx, conv, source, customer.texts)), via: 'ai' };
  }

  const customer = recentCustomerTexts(ctx.db, conv.id);
  if (!customer.texts.length) throw badRequest('客户还没发过文字消息，判断不了用什么语言', 'language_unknown');
  try {
    return await apiTranslate(ctx, conv, source, customer, tr);
  } catch (err) {
    if (!(err instanceof TranslateError)) throw err;
    ctx.log.warn?.(`[translate] 会话 ${conv.id}：${err.message}`);
    if (!tr.fallbackToAi) throw apiFailure(err, '');
    if (!canUseAi) throw apiFailure(err, '（回复模型还没配好，没法改用 AI 翻译）');
    try {
      return { ...(await aiTranslate(ctx, conv, source, customer.texts)), via: 'ai', fallbackReason: err.message };
    } catch (aiErr) {
      if (aiErr instanceof HttpError) throw new HttpError(aiErr.status, aiErr.code, `翻译接口出错（${err.message}），改用 AI 翻译也失败了：${aiErr.message.replace(/^翻译失败：/, '')}`);
      throw aiErr;
    }
  }
}
