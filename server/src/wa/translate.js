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
// 开着 AI 发言检查时，ai 方式的这一次调用顺带看原文有没有不当的说法（blockwords/conduct.js 的 afterTranslate），不多调模型；
// 翻译的结果不受影响，模型没给或给坏了检查结果就当没查。api 方式（包括出错后改用 AI 翻译的那次）不顺带查，发出后照常查。
//
// 另有两处译成简体中文，方式同上（ai 用回复模型的 translateToChinese，api 用选的服务、自动判断源语言），出错时的处理也一样：
// - 消息的「翻译」：POST …/messages/:messageId/translation，译文存进 messages.translation，再请求直接返回；
// - 推荐回复 / 草稿的「中文意思」：POST …/draft/translation，译文存进草稿 JSON 的 zh（草稿没变时才存）。
// 原文去掉【待你确认：…】后本地判断就是中文的不调接口，via 记 none。同样只读会话状态、不计入会话每日模型次数。
// 推荐回复和转人工草稿起草完、存下之前，括号里写成外文的【待你确认：…】也用这条路译成中文（fixDraftPlaceholders，在文件最后）。
import { llmScope } from '../records.js';
import { foreignPlaceholderContents, isChineseText, normalizePlaceholderLabels, replacePlaceholderContents } from '../reply/placeholders.js';
import { llmConfigured } from '../settings.js';
import { detectLocal } from '../translate/detect-local.js';
import { callTranslationProvider, FIELD_LABELS, getTranslationProvider, missingField, TranslateError } from '../translate/index.js';
import { languageName } from '../translate/languages.js';
import { badRequest, clip, HttpError, notFound, nowIso, safeJsonParse } from '../util.js';

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
/** 【待你确认：…】占位（推荐回复和草稿里要人拍板的地方，前端高亮显示），译成中文时要留着 */
const TODO_RE = /【待你确认[^】]*】/g;
/** 消息开头的媒体标签（语音转写的 [语音]、没识别的媒体、导入的历史消息），译成中文时去掉 */
const MEDIA_LABEL_RE = /^\[(图片|视频|语音|文件|贴纸|媒体消息|非文字消息)\]\s*/;

/**
 * 客户最近的文字消息（从早到晚）和最新一条的 seq。语音、图片（含识别后的描述）、导入的非文字占位都不算：
 * 图片描述是模型用中文写的，会把语言判断带偏。客户撤回了的也不算（撤回过的消息不进模型和翻译接口）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 * @returns {{texts: string[], latestSeq: number|null}}
 */
function recentCustomerTexts(db, convId) {
  const rows = db
    .prepare(
      `SELECT seq, text FROM messages
       WHERE conversation_id = ? AND direction = 'in' AND author = 'customer' AND kind = 'text' AND media IS NULL AND trim(text) <> ''
         AND revoked_at IS NULL
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

/**
 * 用回复模型翻译（原来的做法）。conduct=true 时顺带做 AI 发言检查（user 是点翻译的人，记录里当发送人）
 */
async function aiTranslate(ctx, conv, source, customerMessages, { conduct = false, user = null } = {}) {
  let out;
  try {
    out = await llmScope({ accountId: conv.accountId ?? null, conversationId: conv.id, purpose: 'translate' }, () =>
      ctx.ai.translate(conduct ? { text: source, customerMessages, conduct: true } : { text: source, customerMessages }),
    );
  } catch (err) {
    throw new HttpError(502, 'llm_error', `翻译失败：${err?.message || err}`);
  }
  const language = typeof out?.language === 'string' ? out.language.trim() : '';
  const translation = typeof out?.translation === 'string' ? out.translation.trim() : '';
  if (!language || !translation) throw new HttpError(502, 'llm_error', '翻译失败：模型返回的结果不完整，请重试');
  const result = { text: clip(translation, MAX_TRANSLATION), language: clip(language, 20) };
  if (conduct) {
    // 检查结果只用来提醒，出什么错都不影响这次翻译
    try {
      // 译文超过发送上限时，发出去的是截断的那段：两种都记进查重表，原样发出去后不再查
      const translations = [result.text, clip(result.text, MAX_TRANSLATE_TEXT)];
      ctx.conduct.afterTranslate({ conversationId: conv.id, accountId: conv.accountId ?? null, user, text: source, translations, raw: out.conduct });
    } catch (err) {
      ctx.log.warn(`[conduct] 记录翻译时的发言检查结果失败：${err?.message || err}`);
    }
  }
  return result;
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

/** 选的翻译服务和它的配置；没选、没配好抛 TranslateError（config） */
function apiProvider(tr) {
  const provider = getTranslationProvider(tr.provider);
  if (!provider) throw new TranslateError('还没有选翻译服务', 'config');
  const cfg = tr.providers[provider.id] || {};
  const missing = missingField(provider.id, cfg);
  if (missing) throw new TranslateError(`${provider.label} 还没配好（没填 ${FIELD_LABELS[missing] || missing}）`, 'config');
  return { provider, cfg };
}

/** 用翻译接口翻译。出错抛 TranslateError */
async function apiTranslate(ctx, conv, source, customer, tr) {
  const { provider, cfg } = apiProvider(tr);
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
 * 翻译接口出错（TranslateError）之后，几处翻译共用：开着「改用 AI 翻译」而且回复模型配好了的，这次用 aiFn 翻译，
 * 返回它的结果加上 via=ai 和原因（fallbackReason）；否则报错（apiFailure）。别的错误原样抛出
 * @param {() => Promise<object>} aiFn
 */
async function afterApiError(ctx, conv, err, tr, canUseAi, aiFn) {
  if (!(err instanceof TranslateError)) throw err;
  ctx.log.warn?.(`[translate] 会话 ${conv.id}：${err.message}`);
  if (!tr.fallbackToAi) throw apiFailure(err, '');
  if (!canUseAi) throw apiFailure(err, '（回复模型还没配好，没法改用 AI 翻译）');
  try {
    return { ...(await aiFn()), via: 'ai', fallbackReason: err.message };
  } catch (aiErr) {
    if (aiErr instanceof HttpError) throw new HttpError(aiErr.status, aiErr.code, `翻译接口出错（${err.message}），改用 AI 翻译也失败了：${aiErr.message.replace(/^翻译失败：/, '')}`);
    throw aiErr;
  }
}

/**
 * 把业务员写的话直译成这个会话客户的语言。权限由路由检查（同手动回复）。
 * 原文里有屏蔽词的不翻译（400 blockword_hit），和发送时命中一样记一条、提醒管理员。
 * @param {any} ctx
 * @param {{id:string, accountId:string|null}} conv 路由 loadConv 返回的会话
 * @param {unknown} text
 * @param {any} [user] 点翻译的人（屏蔽词记录用）
 * @returns {Promise<{text:string, language:string, via:string, fallbackReason?:string}>}
 */
export async function translateForConversation(ctx, conv, text, user = null) {
  if (typeof text !== 'string' || !text.trim()) throw badRequest('要翻译的内容不能为空');
  const source = text.trim();
  if (source.length > MAX_TRANSLATE_TEXT) throw badRequest(`要翻译的内容不能超过 ${MAX_TRANSLATE_TEXT} 字`, 'text_too_long');
  ctx.blockwords?.guard(source, { source: 'translate', accountId: conv.accountId, conversationId: conv.id, user });
  const settings = ctx.getSettings();
  const tr = settings.translation;
  const canUseAi = llmConfigured(settings, ctx.config);

  if (tr?.mode !== 'api') {
    if (!canUseAi) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
    const customer = recentCustomerTexts(ctx.db, conv.id);
    if (!customer.texts.length) throw badRequest('客户还没发过文字消息，判断不了用什么语言', 'language_unknown');
    const conduct = !!ctx.conduct?.enabled();
    return { ...(await aiTranslate(ctx, conv, source, customer.texts, { conduct, user })), via: 'ai' };
  }

  const customer = recentCustomerTexts(ctx.db, conv.id);
  if (!customer.texts.length) throw badRequest('客户还没发过文字消息，判断不了用什么语言', 'language_unknown');
  try {
    return await apiTranslate(ctx, conv, source, customer, tr);
  } catch (err) {
    return afterApiError(ctx, conv, err, tr, canUseAi, () => aiTranslate(ctx, conv, source, customer.texts));
  }
}

// ---------------- 译成中文：消息的「翻译」、推荐回复的「中文意思」 ----------------

/**
 * 存着的中文译文（消息的 translation 列、草稿 JSON 的 zh）→ {text, via, createdAt, truncated?}；没有或格式不对的返回 null。
 * via：ai、翻译服务的 id，或 none（原文本来就是中文，text 是原文）
 * @param {unknown} raw JSON 字符串或已经解析的对象
 */
export function storedTranslation(raw) {
  const t = typeof raw === 'string' ? safeJsonParse(raw, null) : raw;
  if (!t || typeof t !== 'object' || typeof t.text !== 'string' || typeof t.via !== 'string' || !t.via) return null;
  return { text: t.text, via: t.via, createdAt: typeof t.createdAt === 'string' ? t.createdAt : null, ...(t.truncated === true ? { truncated: true } : {}) };
}

/**
 * 一条消息里要译成中文的文字（客户、我方、机器人发的都算）：语音转写去掉开头的 [语音]；识别出来的图片描述（[图片] 后面接描述）
 * 是模型用中文写的，不翻译；还在识别的（kind=media）、只有 [图片] 这类标签的没有文字可译。没有可译的返回 ''
 * @param {{kind:string, text:string}} row messages 表的行
 */
function messageSourceText(row) {
  if (row.kind !== 'text') return '';
  const text = String(row.text ?? '').trim();
  if (text.startsWith('[图片] ')) return '';
  return text.replace(MEDIA_LABEL_RE, '').trim();
}

/** 用回复模型译成中文 */
async function aiToChinese(ctx, conv, source) {
  let out;
  try {
    out = await llmScope({ accountId: conv.accountId ?? null, conversationId: conv.id, purpose: 'translate' }, () =>
      ctx.ai.translateToChinese({ text: source }),
    );
  } catch (err) {
    throw new HttpError(502, 'llm_error', `翻译失败：${err?.message || err}`);
  }
  const translation = typeof out?.translation === 'string' ? out.translation.trim() : '';
  if (!translation) throw new HttpError(502, 'llm_error', '翻译失败：模型返回的结果不完整，请重试');
  return { text: clip(translation, MAX_TRANSLATION) };
}

/** 用翻译接口译成中文（让对方自动判断源语言）。对方判断出的源语言就是中文的按原文返回（via=none）。出错抛 TranslateError */
async function apiToChinese(ctx, conv, source, tr) {
  const { provider, cfg } = apiProvider(tr);
  const meta = { purpose: 'translate', accountId: conv.accountId ?? null, conversationId: conv.id };
  const r = await callTranslationProvider(ctx, meta, 'translate', provider.id, cfg, { text: source, source: 'auto', target: 'zh' });
  if (r.detectedSource === 'zh') return { text: source, via: 'none' };
  const out = String(r.text ?? '').trim();
  if (!out) throw new TranslateError(`${provider.label} 返回的译文是空的`, 'bad_response');
  return { text: clip(out, MAX_TRANSLATION), via: provider.id };
}

/** 原文里的【待你确认：…】在译文里找不到原样的（翻译服务可能改了括号或里面的字），补在译文最后一行，业务员照样看得出还有这几处要填 */
function keepTodos(source, out) {
  const missing = [...new Set(source.match(TODO_RE) || [])].filter((t) => !out.includes(t));
  return missing.length ? `${out}\n${missing.join(' ')}` : out;
}

/**
 * 把一段文字译成简体中文，方式按「设置 → 翻译」：去掉【待你确认：…】后本地判断就是中文的（或者只剩占位）原样返回、
 * via=none、不调接口；ai 用回复模型；api 用选的服务，出错时同一键翻译（afterApiError）。
 * @returns {Promise<{text:string, via:string, fallbackReason?:string}>}
 */
async function toChinese(ctx, conv, source) {
  const plain = source.replace(TODO_RE, ' ').trim();
  if (!plain || detectLocal(plain) === 'zh') return { text: source, via: 'none' };
  const r = await dispatchToChinese(ctx, conv, source);
  return r.via === 'none' ? r : { ...r, text: keepTodos(source, r.text) };
}

/** 译成简体中文的那一次调用（不做前面的判断）：ai 用回复模型；api 用选的服务，出错时同一键翻译（afterApiError） */
async function dispatchToChinese(ctx, conv, source) {
  const settings = ctx.getSettings();
  const tr = settings.translation;
  const canUseAi = llmConfigured(settings, ctx.config);
  let r;
  if (tr?.mode !== 'api') {
    if (!canUseAi) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
    r = { ...(await aiToChinese(ctx, conv, source)), via: 'ai' };
  } else {
    try {
      r = await apiToChinese(ctx, conv, source, tr);
    } catch (err) {
      r = await afterApiError(ctx, conv, err, tr, canUseAi, () => aiToChinese(ctx, conv, source));
    }
  }
  return r;
}

/** 存下的译文加上这次的 fallbackReason（改用了 AI 翻译的原因只在这次返回里，不存） */
const withReason = (saved, r) => (r.fallbackReason ? { ...saved, fallbackReason: r.fallbackReason } : saved);

/**
 * 会话里的一条消息译成简体中文。权限由路由检查（同看这个会话）。译文 {text, via, createdAt, truncated?} 存进这条消息的
 * translation 列：再请求直接返回、不再调接口，同事打开会话也看得到。原文超过 MAX_TRANSLATE_TEXT 字的只译前面这些，truncated=true。
 * @param {any} ctx
 * @param {{id:string, accountId:string|null}} conv 路由 loadConv 返回的会话
 * @param {string} messageId
 */
export async function translateMessage(ctx, conv, messageId) {
  const row = ctx.db.prepare('SELECT id, kind, text, translation FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conv.id);
  if (!row) throw notFound('消息不存在');
  const saved = storedTranslation(row.translation);
  if (saved) return saved;
  const full = messageSourceText(row);
  if (!full) throw badRequest('这条消息没有要翻译的文字（图片描述本来就是中文；语音、图片还在识别的，识别完再翻译）', 'nothing_to_translate');
  const truncated = full.length > MAX_TRANSLATE_TEXT;
  // 截断时别把 emoji 这类四字节字符劈成两半
  const source = truncated ? full.slice(0, MAX_TRANSLATE_TEXT).replace(/[\uD800-\uDBFF]$/, '') : full;
  const r = await toChinese(ctx, conv, source);
  const t = { text: r.text, via: r.via, createdAt: nowIso(), ...(truncated ? { truncated: true } : {}) };
  // 同时有人在译同一条的，先存下的为准
  ctx.db.prepare('UPDATE messages SET translation = ? WHERE id = ? AND translation IS NULL').run(JSON.stringify(t), row.id);
  return withReason(t, r);
}

/**
 * 推荐回复 / 草稿正文的中文意思，体 {createdAt, text}：text 是卡片上显示的草稿正文，createdAt 是这份草稿的生成时间。
 * 这是给业务员核对外文实际说了什么的，所以对正文单独翻译（方式同上），不让起草的模型顺便写中文。
 * 会话当前的草稿就是这一份（createdAt 和正文都一样）时：已经有译文的直接返回；没有的译完存进草稿 JSON 的 zh
 * （json_set 只加这一项，草稿里只在库里用的 agentUserId、followUp 不动）。翻译期间草稿换了、清掉了，或者这份是没存进会话的
 * 推荐回复（起草期间我方已经回了），照样返回、但不存；草稿换了 zh 自然就没了。返回 {text, via, createdAt}，改用了 AI 翻译时另带 fallbackReason
 * @param {any} ctx
 * @param {{id:string, accountId:string|null}} conv
 * @param {any} body
 */
export async function translateDraft(ctx, conv, body) {
  const createdAt = body?.createdAt;
  const text = body?.text;
  if (typeof createdAt !== 'string' || !createdAt) throw badRequest('createdAt 必须是草稿的生成时间');
  if (typeof text !== 'string' || !text.trim()) throw badRequest('草稿正文不能为空');
  if (text.length > MAX_TRANSLATE_TEXT) throw badRequest(`草稿正文不能超过 ${MAX_TRANSLATE_TEXT} 字`, 'text_too_long');
  const draft = safeJsonParse(ctx.db.prepare('SELECT draft FROM conversations WHERE id = ?').get(conv.id)?.draft, null);
  if (draft?.createdAt === createdAt && draft.text === text) {
    const saved = storedTranslation(draft.zh);
    if (saved) return saved;
  }
  const r = await toChinese(ctx, conv, text.trim());
  const zh = { text: r.text, via: r.via, createdAt: nowIso() };
  ctx.db
    .prepare(
      `UPDATE conversations SET draft = json_set(draft, '$.zh', json(?))
       WHERE id = ? AND json_valid(draft) AND json_extract(draft, '$.createdAt') = ? AND json_extract(draft, '$.text') = ?`,
    )
    .run(JSON.stringify(zh), conv.id, createdAt, text);
  return withReason(zh, r);
}

// ---------------- 推荐回复和草稿里外文的【待你确认：…】 ----------------

/** 占位转中文那一次翻译最多等多久（毫秒）：超时就不等了，草稿照原样给出去 */
export const PLACEHOLDER_FIX_TIMEOUT_MS = 10_000;
/** 一处占位的译文最多多少字 */
const MAX_PLACEHOLDER_ZH = 200;

/**
 * 推荐回复、转人工草稿起草之后的兜底：括号里要确认的内容必须是中文，业务员才看得懂（判断规则见 reply/placeholders.js）。
 * 1. 认得出的外文标签（【Por confirmar: …】）换回【待你确认：…】，不调接口；
 * 2. 括号里还是外文的，把这几段（每段一行）拼起来调一次翻译，再按行放回各自的位置。翻译方式和「中文意思」一样按「设置 → 翻译」
 *    （ai 用回复模型的 translateToChinese，api 用选的服务，出错时同一键翻译），llm_calls 记 translate，同样不计入会话每日模型次数；
 *    占位都是中文的不调。用这条路而不另做一次模型调用：用翻译 API 的团队不会因为这个多出模型费用，记录和花费也和「中文意思」放在一起看。
 * 翻译出错、超过 timeoutMs（默认 PLACEHOLDER_FIX_TIMEOUT_MS，测试可以用 ctx.placeholderFixTimeoutMs 改）、行数对不上的，记一条 warn，括号里照原样（第 1 步换回的标签保留）；某一行译出来没有汉字的，那一处照原样。
 * 不抛错，最多多等 timeoutMs。
 * @param {any} ctx
 * @param {{id:string, accountId:string|null}} conv
 * @param {string} text 草稿正文
 * @param {{timeoutMs?:number}} [o]
 * @returns {Promise<string>}
 */
export async function fixDraftPlaceholders(ctx, conv, text, { timeoutMs = ctx.placeholderFixTimeoutMs ?? PLACEHOLDER_FIX_TIMEOUT_MS } = {}) {
  const normalized = normalizePlaceholderLabels(text);
  const foreign = foreignPlaceholderContents(normalized);
  if (!foreign.length) return normalized;
  const source = foreign.map((c) => c.replace(/\s+/g, ' ')).join('\n');
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`)), timeoutMs);
    });
    const r = await Promise.race([dispatchToChinese(ctx, conv, source), deadline]);
    if (r.via === 'none') throw new Error('翻译服务认为原文是中文，没有翻译');
    const lines = String(r.text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length !== foreign.length) throw new Error(`译文行数对不上（${foreign.length} 处占位，译文 ${lines.length} 行）`);
    const zh = new Map();
    foreign.forEach((c, i) => {
      const t = clip(lines[i].replace(/[【】]/g, '').trim(), MAX_PLACEHOLDER_ZH);
      if (isChineseText(t)) zh.set(c, t);
    });
    return replacePlaceholderContents(normalized, zh);
  } catch (err) {
    ctx.log.warn(`[translate] 会话 ${conv.id} 草稿里的【待你确认】是外文，译成中文失败，照原样给出：${err?.message || err}`);
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}
