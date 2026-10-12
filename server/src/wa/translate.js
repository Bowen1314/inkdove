// 会话输入框的一键翻译：POST /api/wa/conversations/:id/translate。
// 只读会话，不改会话任何状态（不暂停机器人、不清草稿），也不计入会话每日模型次数（不碰 conversations.llm_calls）；
// 模型调用照常记进 llm_calls（purpose=translate，见 records.js 的 AI_METHOD_PURPOSE）。
import { llmScope } from '../records.js';
import { llmConfigured } from '../settings.js';
import { badRequest, clip, HttpError } from '../util.js';

/** 原文长度上限，和人工发送的上限一致（service.js 的 MAX_OPERATOR_TEXT） */
export const MAX_TRANSLATE_TEXT = 4096;
/** 判断客户语言最多看客户最近几条文字消息 */
export const LANGUAGE_SAMPLE_COUNT = 10;
/** 译文上限：译成别的语言可能比原文长不少，这里只防模型失控 */
const MAX_TRANSLATION = 20_000;

/**
 * 客户最近的文字消息（从早到晚）。语音、图片（含识别后的描述）、导入的非文字占位都不算：
 * 图片描述是模型用中文写的，会把语言判断带偏。
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 */
function recentCustomerTexts(db, convId) {
  return db
    .prepare(
      `SELECT text FROM messages
       WHERE conversation_id = ? AND direction = 'in' AND author = 'customer' AND kind = 'text' AND media IS NULL AND trim(text) <> ''
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(convId, LANGUAGE_SAMPLE_COUNT)
    .map((r) => r.text)
    .reverse();
}

/**
 * 把业务员写的话直译成这个会话客户的语言。权限由路由检查（同手动回复）。
 * @param {any} ctx
 * @param {{id:string, accountId:string|null}} conv 路由 loadConv 返回的会话
 * @param {unknown} text
 * @returns {Promise<{text:string, language:string}>}
 */
export async function translateForConversation(ctx, conv, text) {
  if (typeof text !== 'string' || !text.trim()) throw badRequest('要翻译的内容不能为空');
  const source = text.trim();
  if (source.length > MAX_TRANSLATE_TEXT) throw badRequest(`要翻译的内容不能超过 ${MAX_TRANSLATE_TEXT} 字`, 'text_too_long');
  if (!llmConfigured(ctx.getSettings(), ctx.config)) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
  const customerMessages = recentCustomerTexts(ctx.db, conv.id);
  if (!customerMessages.length) throw badRequest('客户还没发过文字消息，判断不了用什么语言', 'language_unknown');
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
