// 回复引擎：/api/kb/ask 和 WhatsApp 自动回复共用。
// 第 1 层（system prompt）在 prompts.js；这里做第 2 层（程序硬规则，含 4.4 红线和 F14 元话语，词表在 redlines.js）、
// F14 的套话重写，以及第 3 层（审核调用）。第 4 层（会话级闸门）在 wa/service.js，因为 /api/kb/ask 不计会话次数。
//
// 返回值里的 code 是 SPEC-phase2 F12 那张枚举表的值（decisions 表按 code 分组）。模型判 handoff 时 code 取模型给的
// handoff_type（F2c，六个值和 F12 的 handoff code 一一对应），没给或不认识的记 other。离题的 offtopic_type 由下一段接上。
// F15：模型可以带 send_file_ids 发产品资料库里的文件；文件规则（bad_file、file_limit、"条目或文件至少一样"）也在第 2 层。
import { selectContextFiles, MAX_FILES_PER_REPLY } from '../files/store.js';
import { selectContextEntries } from '../kb/search.js';
import { clip } from '../util.js';
import { HANDOFF_TYPES } from './prompts.js';
import { checkRedLines, CLICHE_TERMS, findTerms, stripClicheSentences } from './redlines.js';

export const MAX_CUSTOMER_MESSAGE = 2000;
export const MAX_BUSINESS_REPLY = 1000;
export const MAX_SMALLTALK_REPLY = 150;
export const CATEGORIES = ['business', 'smalltalk', 'offtopic', 'handoff'];

/** F2c handoff_type → F12 的 handoff code：六个值同名对应，其余记 other */
export const handoffCodeOf = (type) => (HANDOFF_TYPES.includes(type) ? type : 'other');

/** 模型给的文件 id：去掉 "file:" 前缀和方括号，去重 */
export function normalizeFileIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const id = String(raw).trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^file:/i, '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 回复和草稿共用的上下文：最近对话、相关条目、可发送文件（超过 50 个时按 BM25 取前 50）。
 * @param {any} ctx
 * @param {{message:string, history?:{role:'customer'|'bot', text:string}[]}} input
 */
export function buildReplyContext(ctx, { message, history = [] }) {
  const msg = clip(message, MAX_CUSTOMER_MESSAGE);
  const hist = history.slice(-12).map((h) => ({ role: h.role, text: clip(h.text, MAX_CUSTOMER_MESSAGE) }));
  const recentCustomer = hist.filter((h) => h.role === 'customer').slice(-3).map((h) => h.text);
  const query = [...recentCustomer, msg].join('\n');
  const entries = selectContextEntries(ctx.kb.activeEntries(), query);
  const activeFiles = ctx.files ? ctx.files.activeFiles() : [];
  const { files, truncated } = selectContextFiles(activeFiles, query);
  return { msg, hist, recentCustomer, entries, files, filesTruncated: truncated, activeFiles, profile: ctx.kb.getProfile() };
}

/**
 * @param {any} ctx
 * @param {{message: string, history?: {role:'customer'|'bot', text:string}[], persona?: string, allowRewrite?: boolean, fileQuota?: number}} input
 *   persona：号的 persona（为空时由调用方传全局 persona）；allowRewrite：今天的 LLM 次数还够不够做一次套话重写；
 *   fileQuota：这个会话今天还能自动发几个文件（F15，每天 5 个；/api/kb/ask 不限）
 * @returns {Promise<{decision:'replied'|'offtopic'|'handoff'|'blocked', code:string, reply:string, usedEntryIds:string[],
 *   sendFileIds:string[], handoffType:string|null, questionZh:string, reason:string, latencyMs:number, llmCalls:number, rewritten:boolean}>}
 */
export async function decideReply(ctx, { message, history = [], persona, allowRewrite = true, fileQuota = Infinity }) {
  const started = Date.now();
  let llmCalls = 0;
  let rewritten = false;
  const done = (decision, code, reason, extra = {}) => ({
    decision,
    code,
    reply: decision === 'replied' ? extra.reply : '',
    usedEntryIds: decision === 'replied' ? extra.usedEntryIds || [] : [],
    sendFileIds: decision === 'replied' ? extra.sendFileIds || [] : [],
    handoffType: extra.handoffType ?? null,
    questionZh: extra.questionZh ?? '',
    reason,
    latencyMs: Date.now() - started,
    llmCalls,
    rewritten,
  });

  const settings = ctx.getSettings();
  const c = buildReplyContext(ctx, { message, history });
  const { profile, msg, recentCustomer } = c;
  const byId = new Map(c.entries.map((e) => [e.id, e]));
  const activeFileById = new Map(c.activeFiles.map((f) => [f.id, f]));
  const genArgs = {
    message: msg,
    history: c.hist,
    entries: c.entries,
    files: c.files,
    filesTruncated: c.filesTruncated,
    profile,
    persona: persona && persona.trim() ? persona : settings.reply.persona,
    canary: ctx.canary,
  };

  // ---- 生成 ----
  let gen;
  try {
    llmCalls++;
    gen = await ctx.ai.generate(genArgs);
  } catch (err) {
    return done('handoff', 'other', `模型调用失败：${err?.message || err}`);
  }
  if (!gen || !CATEGORIES.includes(gen.category)) return done('handoff', 'other', '模型输出无法解析，按转人工处理');

  const genReason = clip(String(gen.reason ?? '').trim(), 200);
  if (gen.category === 'offtopic') return done('offtopic', 'other', `离题：${genReason || '模型判断与本企业业务无关'}`);
  if (gen.category === 'handoff') {
    const handoffType = HANDOFF_TYPES.includes(gen.handoffType) ? gen.handoffType : 'other';
    return done('handoff', handoffCodeOf(handoffType), genReason || '没把握或客户要求人工（模型判断）', {
      handoffType,
      questionZh: clip(String(gen.questionZh ?? '').trim(), 200),
    });
  }

  let category = gen.category;
  let reply = String(gen.reply ?? '').trim();
  let ids = gen.usedEntryIds || [];
  let fileIds = gen.sendFileIds || [];
  if (!reply) return done('handoff', 'other', '模型没有给出回复内容');

  // ---- F14 套话：重写一次；还命中就删整句；删空了用重写前的版本。只管风格，不转人工 ----
  const cliches = findTerms(reply, CLICHE_TERMS);
  if (cliches.length) {
    const original = { category, reply, ids, fileIds };
    let next = null;
    if (allowRewrite) {
      try {
        llmCalls++;
        rewritten = true;
        const g2 = await ctx.ai.generate({ ...genArgs, styleHint: { terms: cliches, previous: reply } });
        const r2 = String(g2?.reply ?? '').trim();
        if (g2 && (g2.category === 'business' || g2.category === 'smalltalk') && r2) {
          next = { category: g2.category, reply: r2, ids: g2.usedEntryIds || [], fileIds: g2.sendFileIds || [] };
        }
      } catch (err) {
        ctx.log.warn(`[reply] 套话重写失败，用原版去掉套话句：${err?.message || err}`);
      }
    }
    const candidate = next || original;
    if (findTerms(candidate.reply, CLICHE_TERMS).length) {
      const stripped = stripClicheSentences(candidate.reply);
      ({ category, reply, ids, fileIds } = stripped ? { ...candidate, reply: stripped } : original);
    } else {
      ({ category, reply, ids, fileIds } = candidate);
    }
  }

  // ---- 第 2 层：程序硬规则 ----
  let usedEntryIds = [...new Set(ids.map(String))];
  const sendFileIds = normalizeFileIds(fileIds);
  // 带文件的回复按业务回复把关（寒暄不该发文件）
  if (sendFileIds.length && category === 'smalltalk') category = 'business';
  if (sendFileIds.length > MAX_FILES_PER_REPLY) {
    return done('blocked', 'bad_file', `一次最多发 ${MAX_FILES_PER_REPLY} 个文件，模型要发 ${sendFileIds.length} 个`);
  }
  const badFiles = sendFileIds.filter((id) => !activeFileById.has(id));
  if (badFiles.length) return done('blocked', 'bad_file', `要发送的文件不存在或已停用：${badFiles.slice(0, 3).join('、')}`);
  const files = sendFileIds.map((id) => activeFileById.get(id));
  if (category === 'business') {
    if (!usedEntryIds.length && !files.length) return done('handoff', 'no_citation', '业务回复既没有引用知识条目也没有发文件，无法确认依据');
    const bad = usedEntryIds.filter((id) => !byId.has(id));
    if (bad.length) return done('handoff', 'no_citation', `引用了不存在的条目 id：${bad.slice(0, 3).join('、')}`);
    if (reply.length > MAX_BUSINESS_REPLY) {
      return done('blocked', 'too_long', `回复过长：${reply.length} 字符，业务回复上限 ${MAX_BUSINESS_REPLY}`);
    }
  } else {
    usedEntryIds = usedEntryIds.filter((id) => byId.has(id));
    if (reply.length > MAX_SMALLTALK_REPLY) {
      return done('blocked', 'too_long', `寒暄回复过长：${reply.length} 字符，上限 ${MAX_SMALLTALK_REPLY}`);
    }
  }
  if (reply.includes('```')) return done('blocked', 'code_block', '回复里有代码块标记 ```');
  if (ctx.canary && reply.includes(ctx.canary)) return done('blocked', 'canary', '回复里出现了金丝雀串，疑似提示词泄露');
  const cited = usedEntryIds.map((id) => byId.get(id));
  const grounding = [...cited.map((e) => `${e.title}\n${e.content}`), ...files.map((f) => `${f.name}\n${f.description}`)].join('\n');
  const red = checkRedLines(reply, grounding);
  if (red) return done('blocked', red.code, red.reason);
  // F15：同一会话每天最多自动发 5 个文件，超出就整轮改判转人工（文字也不发）
  if (files.length > fileQuota) {
    return done(
      'handoff',
      'file_limit',
      `这个会话今天自动发文件已到上限，还能发 ${Math.max(0, fileQuota)} 个，这次要发 ${files.length} 个`,
    );
  }

  // ---- 第 3 层：审核调用（失败默认不发） ----
  let verdict;
  try {
    llmCalls++;
    verdict = await ctx.ai.review({ profile, entries: cited, files, customerMessages: [...recentCustomer, msg], reply });
  } catch (err) {
    return done('handoff', 'review_failed', `审核调用失败，未发送：${err?.message || err}`);
  }
  if (!verdict || typeof verdict.verdict !== 'string') return done('handoff', 'review_failed', '审核结果无法解析，未发送');
  const why = String(verdict.reason || '').trim();
  switch (verdict.verdict) {
    case 'ok': {
      const parts = [];
      if (usedEntryIds.length) parts.push(`引用 ${usedEntryIds.length} 条条目`);
      if (files.length) parts.push(`发送 ${files.length} 个文件`);
      return done(
        'replied',
        category,
        category === 'business' ? `已回复：${parts.join('，')}，审核通过` : '已回复：寒暄，审核通过',
        { reply, usedEntryIds, sendFileIds },
      );
    }
    case 'offtopic':
      return done('offtopic', 'review_offtopic', `离题（审核判定）${why ? `：${why}` : ''}`);
    case 'commitment':
      return done('handoff', 'review_commitment', `审核判定有议价、成交承诺或身份问题${why ? `：${why}` : ''}`);
    case 'ungrounded':
      return done('handoff', 'review_ungrounded', `审核未通过${why ? `：${why}` : '：回复里有资料找不到依据的内容'}`);
    default:
      return done('handoff', 'review_failed', `审核结果无法识别（${clip(verdict.verdict, 20)}），未发送`);
  }
}
