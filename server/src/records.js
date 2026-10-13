// F12 看板要额外记录的数据：处理记录 decisions、模型调用 llm_calls、转人工 handoffs（表结构见 db.js）。
// 看板只读这些表，不额外调用模型。写入失败只记日志，不影响回复流程。
import { AsyncLocalStorage } from 'node:async_hooks';
import { newId, nowIso } from './util.js';

/**
 * 模型调用的上下文 {accountId, conversationId, purpose?, call?}。
 * service.js 处理会话时用 llmScope 包住，期间的模型调用都记到这个号和会话上；purpose 给了就覆盖按方法名推出的用途
 * （F5 红线体检跑回复引擎时传 redteam，见 redteam/runner.js）。call 是 withLlmCallLog 给每次调用准备的格子，real.js 往里填格式、模型和 token。
 */
const llmContext = new AsyncLocalStorage();

/**
 * 在 fn 里发生的模型调用都记到 meta 指定的号和会话上。
 * @template T
 * @param {{accountId?:string|null, conversationId?:string|null, purpose?:string}} meta
 * @param {() => T} fn
 * @returns {T}
 */
export function llmScope(meta, fn) {
  const outer = llmContext.getStore() || {};
  return llmContext.run({ ...outer, ...meta, call: undefined }, fn);
}

/**
 * real.js 用：把这次调用实际用的接口格式、模型和 token 数填进当前调用的格子。不在 withLlmCallLog 包着的调用里时什么也不做。
 * @param {{format?:string, model?:string, inputTokens?:number|null, outputTokens?:number|null}} info
 */
export function reportLlmCall(info) {
  const call = llmContext.getStore()?.call;
  if (call && info) Object.assign(call, info);
}

/** ctx.ai 的方法 → llm_calls.purpose（每个方法调一次模型）。新加调模型的方法要在这里登记，否则不记 */
export const AI_METHOD_PURPOSE = {
  generate: 'reply',
  review: 'review',
  draft: 'draft',
  // 推荐回复（只有会话页手动要：「推荐回复」「换一条」），计入会话每日模型次数
  suggest: 'suggest',
  kbDraft: 'kb_draft',
  extract: 'distill',
  consolidate: 'distill',
  profile: 'distill',
  listQuestions: 'distill',
  judgeQuestions: 'distill',
  describeImage: 'media',
  transcribe: 'media',
  describeFile: 'file_describe',
  // F6：从会话里提取客户线索（leads/store.js），计入会话每日模型次数
  extractLead: 'leads',
  // 会话输入框的一键翻译（另做）：方法名用 translate 就会自动记，不计入会话每日模型次数
  translate: 'translate',
  // 知识库大、命中不足时把客户的话改写成知识库语言的检索词（kb/retrieve.js），在会话里时计入会话每日模型次数
  searchTerms: 'kb_search',
  test: 'test',
};

const tokens = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * 给 ctx.ai 的每个方法包一层：调一次写一行 llm_calls。包在测试注入的钩子外面，所以钩子替换的方法也照样记。
 * - mock 模式：格式和模型记 mock，token 记 null；
 * - 真实模式：格式、模型（设置里的模型名，按它对单价）和 token 由 real.js 填。方法在发请求之前就出错的
 *   （比如 anthropic 格式不支持语音）没有调用模型，不写。
 * ok：方法正常返回为 1，抛错为 0（模型返回了但解析不了的，按 real.js 的处理不抛错，记 1）。
 * @param {Record<string, any>} ai
 * @param {{mock:boolean, record:(row:any) => void}} o
 */
export function withLlmCallLog(ai, { mock, record }) {
  const out = { ...ai };
  for (const [name, purpose] of Object.entries(AI_METHOD_PURPOSE)) {
    const fn = ai[name];
    if (typeof fn !== 'function') continue;
    out[name] = async (...args) => {
      const outer = llmContext.getStore() || {};
      const call = {};
      const started = Date.now();
      let ok = false;
      try {
        const result = await llmContext.run({ ...outer, call }, () => fn.apply(ai, args));
        ok = true;
        return result;
      } finally {
        if (mock || call.format) {
          record({
            purpose: outer.purpose || purpose,
            format: mock ? 'mock' : call.format,
            model: mock ? 'mock' : call.model ?? null,
            inputTokens: mock ? null : tokens(call.inputTokens),
            outputTokens: mock ? null : tokens(call.outputTokens),
            ok,
            latencyMs: Date.now() - started,
            accountId: outer.accountId ?? null,
            conversationId: outer.conversationId ?? null,
          });
        }
      }
    };
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{warn: Function}} log
 */
export function createRecords(db, log) {
  const safe = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      log.warn(`[records] 写${what}失败：${err?.message || err}`);
      return null;
    }
  };

  return {
    /**
     * 处理记录：引擎每处理一轮写一行。
     * @param {{ts?:string, accountId:string|null, conversationId:string|null, decision:string, code:string, reason?:string,
     *   usedEntryIds?:string[], sentFileIds?:string[], latencyMs?:number}} r
     */
    decision(r) {
      safe('处理记录', () =>
        db
          .prepare(
            `INSERT INTO decisions(id, ts, account_id, conversation_id, decision, code, reason, used_entry_ids, sent_file_ids, latency_ms)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId(),
            r.ts || nowIso(),
            r.accountId ?? null,
            r.conversationId ?? null,
            r.decision,
            r.code || 'other',
            String(r.reason ?? ''),
            JSON.stringify(r.usedEntryIds || []),
            JSON.stringify(r.sentFileIds || []),
            Math.max(0, Math.round(r.latencyMs ?? 0)),
          ),
      );
    },

    /** 模型调用：每次调用写一行（withLlmCallLog 调） */
    llmCall(r) {
      safe('模型调用记录', () =>
        db
          .prepare(
            `INSERT INTO llm_calls(id, ts, purpose, format, model, input_tokens, output_tokens, ok, latency_ms, account_id, conversation_id)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId(),
            r.ts || nowIso(),
            r.purpose,
            r.format ?? null,
            r.model ?? null,
            r.inputTokens ?? null,
            r.outputTokens ?? null,
            r.ok ? 1 : 0,
            Math.max(0, Math.round(r.latencyMs ?? 0)),
            r.accountId ?? null,
            r.conversationId ?? null,
          ),
      );
    },

    /** 转人工开始：会话的 needsHuman 从 false 变成 true 时调 */
    handoffStart({ conversationId, accountId, code, at = nowIso() }) {
      safe('转人工记录', () =>
        db
          .prepare('INSERT INTO handoffs(id, conversation_id, account_id, code, started_at) VALUES(?, ?, ?, ?, ?)')
          .run(newId(), conversationId, accountId ?? null, code ?? null, at),
      );
    },

    /**
     * 第一条人工消息：填这个会话最近一条还没人回、也还没恢复机器人的转人工记录。消息时间早于转人工开始时间的不算
     * （手机消息的 webhook 可能晚到）。已经填过的不覆盖。
     * @param {{conversationId:string, kind:'admin_ui'|'whatsapp_relay'|'phone', userId?:string|null, at?:string}} p
     */
    handoffResponse({ conversationId, kind, userId = null, at = nowIso() }) {
      safe('转人工首次回复', () =>
        db
          .prepare(
            `UPDATE handoffs SET first_response_at = ?, first_responder_user_id = ?, first_responder_kind = ?
             WHERE id = (SELECT id FROM handoffs
                          WHERE conversation_id = ? AND first_response_at IS NULL AND resumed_at IS NULL AND started_at <= ?
                          ORDER BY started_at DESC, rowid DESC LIMIT 1)`,
          )
          .run(at, userId, kind, conversationId, at),
      );
    },

    /** 机器人恢复：这个会话还开着的转人工记录都填上 resumedAt */
    handoffResume({ conversationId, at = nowIso() }) {
      safe('转人工恢复时间', () =>
        db.prepare('UPDATE handoffs SET resumed_at = ? WHERE conversation_id = ? AND resumed_at IS NULL').run(at, conversationId),
      );
    },
  };
}
