// 首页 AI 助手：对话、提问的运行和每人每天的次数（表结构见 db.js，接口见 routes/assistant.js，提问循环见 agent.js）。
// - 对话只有本人看得到、删得掉，别人的一律当不存在（404）；
// - 一个人同一时间只能有一个问题在查（409），每人每天最多问 ASSISTANT_DAILY_QUESTIONS 次（429，按服务器本地日期，
//   和会话每日模型次数一样用 wa/service.js 的 localDay），「重试」也算一次，删对话不退次数；
// - 提问立即返回一条 running 的记录，后台跑完再写回答；查询进度（steps）边跑边写，前端轮询；
// - 模型调用都在 llmScope({purpose:'assistant'}) 里，llm_calls 记 assistant、不带号和会话，不计入会话每日模型次数；
// - 进程重启时还在跑的标成 failed（服务重启，回答中断）；删掉的成员留下的对话启动时清掉。
import { LlmError } from '../ai/llm.js';
import { TOOLS_UNSUPPORTED_MESSAGE } from '../ai/tool-call.js';
import { canAccessConversation } from '../auth.js';
import { canonicalTz } from '../dashboard.js';
import { llmScope } from '../records.js';
import { llmConfigured } from '../settings.js';
import { HttpError, badRequest, clip, newId, notFound, nowIso, safeJsonParse } from '../util.js';
import { localDay } from '../wa/service.js';
import { AssistantError, HISTORY_TURNS, runAssistant } from './agent.js';
import { contactLabel } from './tools.js';

/** 每人每天最多问几次（一问最多调 MAX_TOOL_CALLS + 1 次模型，见 docs/features.md 的「AI 助手」） */
export const ASSISTANT_DAILY_QUESTIONS = 50;
/** 一个问题最长多少字 */
export const MAX_QUESTION_CHARS = 2000;
/** 每人最多留多少个对话，多的删最早的 */
export const MAX_CHATS_PER_USER = 100;
/** 对话列表返回最近几个 */
export const CHAT_LIST_LIMIT = 30;
/** 打开对话时返回最近几问 */
export const CHAT_MESSAGES_LIMIT = 100;
/** 检查出不支持工具调用后，这么久之内同一个模型配置直接报不支持，不再调模型 */
const UNSUPPORTED_RECHECK_MS = 10 * 60_000;
/** 浏览器带来的「现在」和服务器差得不多时用浏览器的，差太多（电脑时间不准）用服务器的 */
const CLIENT_CLOCK_SKEW_MS = 5 * 60_000;

const chatView = (r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });

/**
 * @param {any} ctx
 * @param {{now?: () => number, limits?: {maxToolCalls?:number, runTimeoutMs?:number, stepTimeoutMs?:number}}} [opts]
 *   now 是测试注入的时钟；limits 是测试用的循环上限
 */
export function createAssistant(ctx, opts = {}) {
  const { db, log } = ctx;
  const clock = opts.now || Date.now;
  /** @type {Map<string, {controller:AbortController, messageId:string, chatId:string}>} 用户 id → 正在查的问题 */
  const running = new Map();
  /** @type {Set<Promise<void>>} */
  const tasks = new Set();
  /** 见过原生工具调用（或检查通过）的模型配置 */
  const verified = new Set();
  /** @type {Map<string, number>} 检查出不支持的模型配置 → 到什么时候之前直接报不支持 */
  const unsupportedUntil = new Map();

  db.prepare(
    "UPDATE assistant_messages SET status = 'failed', error = '服务重启，回答中断，请重试', error_code = 'interrupted', finished_at = ? WHERE status = 'running'",
  ).run(nowIso());
  db.transaction(() => {
    db.prepare('DELETE FROM assistant_messages WHERE chat_id IN (SELECT id FROM assistant_chats WHERE user_id NOT IN (SELECT id FROM users))').run();
    db.prepare('DELETE FROM assistant_chats WHERE user_id NOT IN (SELECT id FROM users)').run();
  })();

  /** 模型配置的指纹：格式、地址、模型名任何一个变了都重新判断支不支持工具调用 */
  const fingerprint = () => {
    if (ctx.config.llmMock) return 'mock';
    const s = ctx.getSettings().llm;
    return `${s.format}\n${s.baseUrl}\n${s.model}`;
  };
  const knownUnsupported = (fp) => (unsupportedUntil.get(fp) || 0) > Date.now();

  function supportFor(fp) {
    return {
      verified: verified.has(fp),
      markVerified() {
        verified.add(fp);
        unsupportedUntil.delete(fp);
      },
      async probe(signal) {
        const r = await ctx.ai.assistantProbe({ signal });
        if (r?.supported) {
          verified.add(fp);
          return true;
        }
        log.warn(`[assistant] 当前模型不支持工具调用：${r?.detail || '检查时没有调用工具'}`);
        return false;
      },
    };
  }

  /** 错误 → 存下来给前端看的 {code, message} */
  function describeError(err) {
    if (err?.code === 'tools_unsupported') {
      if (err.detail) log.warn(`[assistant] 模型或中转不支持工具调用：${err.detail}`);
      return { code: 'tools_unsupported', message: TOOLS_UNSUPPORTED_MESSAGE };
    }
    if (err instanceof AssistantError) return { code: err.code, message: err.message };
    if (err instanceof LlmError) return { code: 'llm_error', message: `模型调用失败：${err.message}` };
    log.error(`[assistant] 出错：${err?.stack || err}`);
    return { code: 'internal', message: '助手处理失败，请重试' };
  }

  const getOwnChat = (user, chatId) => {
    const row = db.prepare('SELECT * FROM assistant_chats WHERE id = ? AND user_id = ?').get(String(chatId ?? ''), user.id);
    if (!row) throw notFound('对话不存在');
    return row;
  };

  const usedToday = (userId) =>
    db.prepare('SELECT questions FROM assistant_usage WHERE user_id = ? AND day = ?').get(userId, localDay())?.questions || 0;

  /** 能不能开始一个新问题：模型配了、没有别的问题在查、今天还有次数 */
  function assertCanStart(user) {
    if (!llmConfigured(ctx.getSettings(), ctx.config)) throw new HttpError(400, 'llm_not_configured', '未配置 AI 模型，请前往设置页填写');
    if (running.has(user.id)) throw new HttpError(409, 'assistant_busy', '上一个问题尚在处理，请稍后再提问');
    if (usedToday(user.id) >= ASSISTANT_DAILY_QUESTIONS) {
      throw new HttpError(429, 'assistant_daily_limit', `今日提问次数已用完（每人每天 ${ASSISTANT_DAILY_QUESTIONS} 次），请明日再试`);
    }
  }

  /** 时区和「现在」：tz 不是 IANA 时区 400；没带按 UTC */
  function timeOf(body) {
    let tz = 'UTC';
    if (body?.tz !== undefined && body.tz !== '') {
      tz = canonicalTz(body.tz);
      if (!tz) throw badRequest('tz 不是可用的 IANA 时区（例如 Asia/Shanghai）', 'invalid_tz');
    }
    const serverNow = clock();
    const client = typeof body?.now === 'number' ? body.now : Date.parse(String(body?.now ?? ''));
    const nowMs = Number.isFinite(client) && Math.abs(client - serverNow) <= CLIENT_CLOCK_SKEW_MS ? client : serverNow;
    return { tz, nowMs };
  }

  function messageRow(id) {
    return db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(id);
  }

  /** 回答里引用的对象换成现在的样子：会话按现在的权限（没权限的只留编号）；条目、文件已删除的为 null */
  function hydrateRefs(user, refs) {
    return refs
      .map((r) => {
        if (r.kind === 'conversation') {
          const c = ctx.wa.getConversation(r.id);
          if (!c || !canAccessConversation(user, c)) return { key: r.key, kind: r.kind, id: null, available: false };
          return { key: r.key, kind: r.kind, id: c.id, available: true, name: contactLabel(c.contactName, c.contactNumber), accountName: c.accountName };
        }
        if (r.kind === 'entry') {
          const e = ctx.kb.getEntry(r.id);
          return { key: r.key, kind: r.kind, id: r.id, available: !!e, entry: e ?? null };
        }
        if (r.kind === 'file') {
          const f = ctx.files.get(r.id);
          return { key: r.key, kind: r.kind, id: r.id, available: !!f, file: f ?? null };
        }
        return null;
      })
      .filter(Boolean);
  }

  function messageView(user, r) {
    return {
      id: r.id,
      chatId: r.chat_id,
      question: r.question,
      answer: r.answer ?? null,
      status: r.status,
      steps: safeJsonParse(r.steps, []),
      refs: r.status === 'done' ? hydrateRefs(user, safeJsonParse(r.refs, [])) : [],
      error: r.error ?? null,
      errorCode: r.error_code ?? null,
      createdAt: r.created_at,
      finishedAt: r.finished_at ?? null,
    };
  }

  /** 后台回答一个问题（记录已经是 running） */
  function start(user, chatId, messageId, { tz, nowMs }) {
    const controller = new AbortController();
    running.set(user.id, { controller, messageId, chatId });
    const row = messageRow(messageId);
    const history = db
      .prepare(
        `SELECT question, answer, refs FROM assistant_messages
          WHERE chat_id = ? AND id <> ? AND status = 'done' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(chatId, messageId, HISTORY_TURNS)
      .reverse()
      .map((h) => ({ question: h.question, answer: h.answer, refs: safeJsonParse(h.refs, []) }));
    const progress = db.prepare('UPDATE assistant_messages SET steps = ?, llm_calls = ?, tool_calls = ? WHERE id = ?');
    const fp = fingerprint();
    const task = (async () => {
      try {
        if (knownUnsupported(fp)) throw new AssistantError('tools_unsupported', TOOLS_UNSUPPORTED_MESSAGE);
        const r = await llmScope({ purpose: 'assistant', accountId: null, conversationId: null }, () =>
          runAssistant(ctx, {
            user,
            question: row.question,
            history,
            tz,
            nowMs,
            signal: controller.signal,
            support: supportFor(fp),
            limits: opts.limits,
            onProgress: (p) => progress.run(JSON.stringify(p.steps), p.llmCalls, p.toolCalls, messageId),
          }),
        );
        db.prepare(
          `UPDATE assistant_messages SET status = 'done', answer = ?, refs = ?, steps = ?, llm_calls = ?, tool_calls = ?, finished_at = ?
            WHERE id = ?`,
        ).run(r.answer, JSON.stringify(r.refs), JSON.stringify(r.steps), r.llmCalls, r.toolCalls, nowIso(), messageId);
      } catch (err) {
        const e = describeError(err);
        if (e.code === 'tools_unsupported' && !knownUnsupported(fp)) unsupportedUntil.set(fp, Date.now() + UNSUPPORTED_RECHECK_MS);
        // 进度里还在 running 的步骤一并标成没查完
        const steps = safeJsonParse(messageRow(messageId)?.steps, []).map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s));
        db.prepare("UPDATE assistant_messages SET status = 'failed', error = ?, error_code = ?, steps = ?, finished_at = ? WHERE id = ?").run(
          e.message,
          e.code,
          JSON.stringify(steps),
          nowIso(),
          messageId,
        );
      } finally {
        if (running.get(user.id)?.messageId === messageId) running.delete(user.id);
        db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(nowIso(), chatId);
      }
    })();
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  }

  return {
    /** GET /api/assistant/chats：自己最近的对话和今天用了几次 */
    list(user) {
      const chats = db
        .prepare('SELECT * FROM assistant_chats WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?')
        .all(user.id, CHAT_LIST_LIMIT)
        .map(chatView);
      return { chats, usage: { used: usedToday(user.id), limit: ASSISTANT_DAILY_QUESTIONS } };
    },

    /** GET /api/assistant/chats/:id：对话和最近的问答（从早到晚） */
    get(user, chatId) {
      const chat = getOwnChat(user, chatId);
      const rows = db
        .prepare('SELECT * FROM assistant_messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(chat.id, CHAT_MESSAGES_LIMIT)
        .reverse();
      return { chat: chatView(chat), messages: rows.map((r) => messageView(user, r)) };
    },

    /** GET /api/assistant/chats/:id/messages/:messageId：一问的当前状态（轮询进度用） */
    getMessage(user, chatId, messageId) {
      const chat = getOwnChat(user, chatId);
      const r = db.prepare('SELECT * FROM assistant_messages WHERE id = ? AND chat_id = ?').get(String(messageId ?? ''), chat.id);
      if (!r) throw notFound('问答不存在');
      return messageView(user, r);
    },

    /**
     * POST /api/assistant/ask {question, chatId?, tz?, now?}：没给 chatId 新建对话。立即返回 {chat, message}（message.status 为 running），
     * 之后轮询 getMessage。400 问题为空、太长、tz 不对、模型没配；404 对话不是自己的；409 有问题在查；429 今天的次数用完
     */
    ask(user, body = {}) {
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question) throw badRequest('问题不能为空');
      if (question.length > MAX_QUESTION_CHARS) throw badRequest(`问题最长 ${MAX_QUESTION_CHARS} 字`);
      const time = timeOf(body);
      let chat = body.chatId ? getOwnChat(user, body.chatId) : null;
      assertCanStart(user);
      const now = nowIso();
      if (!chat) {
        chat = { id: newId(), user_id: user.id, title: clip(question.replace(/\s+/g, ' '), 40), created_at: now, updated_at: now };
        db.prepare('INSERT INTO assistant_chats(id, user_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(
          chat.id,
          user.id,
          chat.title,
          now,
          now,
        );
        // 每人最多留 MAX_CHATS_PER_USER 个，删最早的
        const old = db
          .prepare('SELECT id FROM assistant_chats WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?')
          .all(user.id, MAX_CHATS_PER_USER)
          .map((x) => x.id);
        for (const id of old) {
          db.prepare('DELETE FROM assistant_messages WHERE chat_id = ?').run(id);
          db.prepare('DELETE FROM assistant_chats WHERE id = ?').run(id);
        }
      } else {
        db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(now, chat.id);
      }
      const id = newId();
      db.prepare("INSERT INTO assistant_messages(id, chat_id, question, status, created_at) VALUES(?, ?, ?, 'running', ?)").run(id, chat.id, question, now);
      db.prepare(
        'INSERT INTO assistant_usage(user_id, day, questions) VALUES(?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET questions = questions + 1',
      ).run(user.id, localDay());
      start(user, chat.id, id, time);
      return { chat: chatView(getOwnChat(user, chat.id)), message: messageView(user, messageRow(id)) };
    },

    /** POST /api/assistant/chats/:id/retry {tz?, now?}：重答这个对话最后一个没答成的问题（算一次提问）→ message */
    retry(user, chatId, body = {}) {
      const chat = getOwnChat(user, chatId);
      const last = db.prepare('SELECT * FROM assistant_messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(chat.id);
      if (!last || last.status !== 'failed') throw badRequest('仅可重试最后一个失败的问题', 'nothing_to_retry');
      const time = timeOf(body);
      assertCanStart(user);
      db.prepare(
        `UPDATE assistant_messages SET status = 'running', answer = NULL, refs = '[]', steps = '[]', error = NULL, error_code = NULL,
                llm_calls = 0, tool_calls = 0, finished_at = NULL WHERE id = ?`,
      ).run(last.id);
      db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(nowIso(), chat.id);
      db.prepare(
        'INSERT INTO assistant_usage(user_id, day, questions) VALUES(?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET questions = questions + 1',
      ).run(user.id, localDay());
      start(user, chat.id, last.id, time);
      return messageView(user, messageRow(last.id));
    },

    /** DELETE /api/assistant/chats/:id：删自己的对话（正在查的先停掉） */
    remove(user, chatId) {
      const chat = getOwnChat(user, chatId);
      const r = running.get(user.id);
      if (r?.chatId === chat.id) r.controller.abort();
      db.transaction(() => {
        db.prepare('DELETE FROM assistant_messages WHERE chat_id = ?').run(chat.id);
        db.prepare('DELETE FROM assistant_chats WHERE id = ?').run(chat.id);
      })();
    },

    /** 关闭服务时停掉所有正在查的问题，等它们写完 */
    async close() {
      for (const r of running.values()) r.controller.abort();
      await Promise.allSettled([...tasks]);
    },
  };
}
