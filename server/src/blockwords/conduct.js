// AI 发言检查：让回复模型看我方发给客户的话里有没有辱骂、威胁、歧视、骚扰、粗鲁这类说法（提示词和结果校验见 conduct-prompts.js）。
// 只提醒、从不拦：不拦、不延后、不改任何消息，屏蔽词照旧按词表拦。发现的记进 blockword_hits（detector=ai，blockwords/store.js 的
// recordAi），严重的弹窗提醒管理员，轻微的只进列表。开关在设置的 blockwords.aiCheck（默认关，和词表的开关互不相干），
// 开着而且回复模型配好了才做；关着时一次模型都不调。
// 在哪里查：
// - 一键翻译（AI 翻译）：翻译那一次调用顺带看原文（wa/translate.js 调 afterTranslate），不多调模型。发现了记一条
//   （stage=pre，翻译时发现、还没发出），原文和译文都记进 24 小时的查重表，原样发出去后不再查、不重复提醒。
//   翻译 API（DeepL 等）不顺带查，发出后照常查；
// - 自动回复：审核那一次调用顺带看回复（reply/engine.js 的 conductCheck，wa/service.js 发完调 afterBotReply），不多调模型。
//   看过的几段标成已查，发出后不再查；模型没给或给坏了的，发出后照常查；
// - 其余发出去的（后台发的消息和文件说明、通知号码上转发和 /d、外联开场消息、机主在手机上发的、上面没查成的自动回复）：
//   发出后在后台查。同一个会话最后一条我方消息过了 debounceMs（默认 30 秒）还没有新的，就把这个会话还没查的一起查，
//   一次调用最多 MAX_BATCH 条，每条前面带最多 CONTEXT_BEFORE 条消息当上下文（客户的话按不可信数据转义）。
//   不计入会话每日模型次数。进程重启后接着查最近 24 小时里没查的；打开开关之前发的一律不查。
// 不查的：没有文字的、撤回了的（撤回的内容绝不发给模型）、没发出去的（失败、被屏蔽词拦下的本来就没有消息）、历史导入的、
//   Meta 号的外联（发的是 Meta 审核过的模板，会话里只存了模板名），以及 24 小时内查过一模一样文字的（沿用上次的结果，不重复提醒；
//   外联同一段开场消息、常用话术因此只查一次）。
// 模型调用失败或输出解析不了：记一条警告，这几条留着不标，过一会儿再试，同一个会话连续失败 MAX_ATTEMPTS 次后这次进程里不再试。
import crypto from 'node:crypto';
import { llmScope } from '../records.js';
import { llmConfigured } from '../settings.js';
import { normalizeConduct, parseConductResults } from './conduct-prompts.js';

/** 会话最后一条我方消息之后等多久再查（等这一阵说完，一起查） */
export const CONDUCT_DEBOUNCE_MS = 30_000;
/** 多久扫一次有没有该查的会话 */
export const CONDUCT_SWEEP_MS = 10_000;
/** 只查最近多久发的（重启后接着查的范围），查重表也只认这么久以内的 */
const LOOKBACK_MS = 24 * 3600 * 1000;
/** 一次调用最多查几条，多的下一轮再查 */
export const MAX_BATCH = 20;
/** 每条要查的消息前面最多带几条上下文 */
const CONTEXT_BEFORE = 4;
/** 同一个会话连续失败几次后这次进程里不再试；每次失败后等多久再试（乘以失败次数） */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 60_000;

/** 查重表的键：去掉首尾空白后的 sha256 */
export const conductHash = (text) => crypto.createHash('sha256').update(String(text ?? '').trim()).digest('hex');

/**
 * 发出去的消息算谁发的（和屏蔽词命中记录的 source 一样）
 * @param {{author:string, via:string|null, kind:string}} r messages 表的行
 */
export function conductSource(r) {
  if (r.author === 'owner' || r.via === 'phone') return 'phone';
  if (r.author === 'bot') return r.via === 'campaign' ? 'campaign' : 'bot';
  if (r.via === 'whatsapp') return 'relay';
  return r.kind === 'file' ? 'file' : 'operator';
}

/**
 * @param {any} ctx 需要 db、log、getSettings、config、ai、blockwords
 * @param {{debounceMs?: number, now?: () => number}} [opts] now：测试用的时钟
 */
export function createConduct(ctx, opts = {}) {
  const { db, log } = ctx;
  const debounceMs = opts.debounceMs ?? CONDUCT_DEBOUNCE_MS;
  const clock = opts.now || Date.now;
  const iso = (ms) => new Date(ms).toISOString();
  /** 会话 → {count 连续失败次数, nextAt 什么时候再试} */
  const failures = new Map();
  let timer = null;
  let running = null;
  let closed = false;

  /** 开着而且回复模型配好了 */
  function enabled() {
    const s = ctx.getSettings();
    return !!s.blockwords?.aiCheck && llmConfigured(s, ctx.config);
  }

  /** 从什么时候发的开始查：最近 24 小时和打开开关的时间里取晚的 */
  function sinceIso() {
    const cutoff = iso(clock() - LOOKBACK_MS);
    const on = ctx.getSettings().blockwords?.aiCheckSince;
    return typeof on === 'string' && on > cutoff ? on : cutoff;
  }

  /** 24 小时内查过一模一样的文字：返回当时的 level，没查过返回 null */
  function cachedLevel(text) {
    const r = db.prepare('SELECT level FROM conduct_cache WHERE hash = ? AND ts >= ?').get(conductHash(text), iso(clock() - LOOKBACK_MS));
    return r ? r.level : null;
  }

  /** 记下一段查过的文字（空的不记） */
  function remember(text, level) {
    if (!String(text ?? '').trim()) return;
    db.prepare(
      `INSERT INTO conduct_cache(hash, ts, level) VALUES(?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET ts = excluded.ts, level = excluded.level`,
    ).run(conductHash(text), iso(clock()), level);
  }

  const markChecked = (ids) => {
    if (!ids.length) return;
    const at = iso(clock());
    const st = db.prepare('UPDATE messages SET conduct_checked_at = ? WHERE id = ? AND conduct_checked_at IS NULL');
    db.transaction(() => {
      for (const id of ids) st.run(at, id);
    })();
  };

  /**
   * 一键翻译（AI 翻译）顺带查了原文之后：raw 是模型给的 conduct（没给或给坏了就当没查，什么都不做）。
   * 原文和译文都记进查重表（translations：译文，以及按发送上限截断后的译文）；有问题的记一条（stage=pre，翻译的人当发送人）
   * @param {{conversationId:string, accountId?:string|null, user?:any, text:string, translations:string[], raw:any}} p
   */
  function afterTranslate({ conversationId, accountId = null, user = null, text, translations, raw }) {
    const v = normalizeConduct(raw);
    if (!v) return null;
    remember(text, v.level);
    for (const t of translations) remember(t, v.level);
    if (v.level === 'none') return v;
    ctx.blockwords.recordAi({ source: 'translate', stage: 'pre', accountId, conversationId, user, text, verdict: v });
    return v;
  }

  /**
   * 自动回复的审核顺带查了回复、回复（全部或前几段）发出去之后：raw 是模型给的 conduct（没给或给坏了就当没查，发出后照常查）。
   * 发出去的几段（messageIds）标成已查；有问题的记一条（stage=post，已经发出去了），原文是整段回复
   * @param {{conversationId:string, accountId?:string|null, reply:string, parts:string[], messageIds:string[], raw:any}} p
   */
  function afterBotReply({ conversationId, accountId = null, reply, parts = [], messageIds, raw }) {
    const v = normalizeConduct(raw);
    if (!v || !messageIds.length) return null;
    markChecked(messageIds);
    remember(reply, v.level);
    for (const p of parts) remember(p, v.level);
    if (v.level === 'none') return v;
    ctx.blockwords.recordAi({ source: 'bot', stage: 'post', accountId, conversationId, text: reply, messageId: messageIds[0], verdict: v });
    return v;
  }

  /** 外联开场消息：这个会话最近一次是哪个任务发的（任务名、发起人） */
  function campaignOf(convId) {
    const c = db
      .prepare(
        `SELECT c.id, c.name, c.created_by_id, c.created_by_name FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
         WHERE r.conversation_id = ? AND r.status = 'sent' ORDER BY r.sent_at DESC LIMIT 1`,
      )
      .get(convId);
    return c ? { campaign: { id: c.id, name: c.name }, user: c.created_by_id ? { id: c.created_by_id, name: c.created_by_name } : null } : null;
  }

  /** 能当上下文的：有文字，我方的要是发出去了的（撤回的在查询里就去掉了） */
  const usableContext = (r) => !!String(r.text ?? '').trim() && (r.direction === 'in' || r.status === 'sent');

  /** 查一个会话里还没查的我方消息。返回这次调了几次模型（0 或 1） */
  async function checkConversation(convId, since) {
    const conv = db.prepare('SELECT id, account_id, channel FROM conversations WHERE id = ?').get(convId);
    const rows = db
      .prepare(
        `SELECT id, seq, author, via, kind, text, status, revoked_at, sent_by_user_id, sent_by_name FROM messages
         WHERE conversation_id = ? AND direction = 'out' AND ts >= ? AND conduct_checked_at IS NULL ORDER BY seq`,
      )
      .all(convId, since);
    const skip = [];
    /** 文字的哈希 → 这一批里第一条（要查的）和后面一模一样的几条（跟着第一条的结果，不重复提醒） */
    const groups = new Map();
    for (const r of rows) {
      const text = String(r.text ?? '').trim();
      const usable =
        conv &&
        r.status === 'sent' &&
        !r.revoked_at &&
        text &&
        (r.kind === 'text' || r.kind === 'file') &&
        r.via !== 'import' &&
        !(r.via === 'campaign' && conv.channel === 'meta');
      if (!usable || cachedLevel(text) !== null) {
        skip.push(r.id);
        continue;
      }
      const h = conductHash(text);
      if (groups.has(h)) groups.get(h).same.push(r.id);
      else if (groups.size < MAX_BATCH) groups.set(h, { row: r, same: [] });
    }
    // 不用查的先标上（和模型调用成不成功无关）
    markChecked(skip);
    if (!groups.size) return 0;

    const batch = [...groups.values()];
    const ids = new Set(batch.map((g) => g.row.id));
    const firstSeq = batch[0].row.seq;
    const lastSeq = batch[batch.length - 1].row.seq;
    const before = db
      .prepare(
        `SELECT id, direction, status, text FROM messages WHERE conversation_id = ? AND seq < ? AND revoked_at IS NULL
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(convId, firstSeq, CONTEXT_BEFORE * 3)
      .filter(usableContext)
      .slice(0, CONTEXT_BEFORE)
      .reverse();
    const span = db
      .prepare(
        `SELECT id, direction, status, text FROM messages WHERE conversation_id = ? AND seq >= ? AND seq <= ? AND revoked_at IS NULL
         ORDER BY seq`,
      )
      .all(convId, firstSeq, lastSeq);
    // 聊天记录：要查的标编号；中间夹着的别的消息当上下文，每条要查的前面最多带 CONTEXT_BEFORE 条
    const messages = [];
    const checkIdOf = new Map();
    let pendingContext = before;
    for (const r of span) {
      if (ids.has(r.id)) {
        for (const c of pendingContext.slice(-CONTEXT_BEFORE)) messages.push({ role: c.direction === 'in' ? 'customer' : 'ours', text: c.text });
        pendingContext = [];
        const checkId = String(checkIdOf.size + 1);
        checkIdOf.set(r.id, checkId);
        messages.push({ role: 'ours', text: r.text, checkId });
      } else if (usableContext(r)) {
        pendingContext = [...pendingContext, r];
      }
    }

    let results;
    try {
      const data = await llmScope({ accountId: conv.account_id ?? null, conversationId: convId, purpose: 'conduct' }, () =>
        ctx.ai.assessConduct({ messages }),
      );
      results = parseConductResults(data);
      if (!results) throw new Error('输出里没有 results');
    } catch (err) {
      const f = failures.get(convId) || { count: 0, nextAt: 0 };
      f.count++;
      f.nextAt = f.count >= MAX_ATTEMPTS ? Infinity : clock() + RETRY_MS * f.count;
      failures.set(convId, f);
      log.warn(
        `[conduct] 会话 ${convId} 的发言检查失败（第 ${f.count} 次${f.count >= MAX_ATTEMPTS ? '，这次运行里不再试' : '，稍后重试'}）：${err?.message || err}`,
      );
      return 1;
    }
    failures.delete(convId);

    // 查的期间撤回了的：照样标成已查，不记（撤回的不提醒）
    const revokedNow = new Set(
      db
        .prepare(`SELECT id FROM messages WHERE id IN (${batch.map(() => '?').join(', ')}) AND revoked_at IS NOT NULL`)
        .all(...batch.map((g) => g.row.id))
        .map((r) => r.id),
    );
    const camp = batch.some((g) => conductSource(g.row) === 'campaign') ? campaignOf(convId) : null;
    db.transaction(() => {
      for (const g of batch) {
        const r = g.row;
        // 模型漏了的一条按没问题算（宁可漏报）
        const v = results.get(checkIdOf.get(r.id)) || { level: 'none', category: '', reason: '', quote: '' };
        remember(r.text, v.level);
        markChecked([r.id, ...g.same]);
        if (v.level === 'none' || revokedNow.has(r.id)) continue;
        const source = conductSource(r);
        const user =
          source === 'campaign' ? camp?.user ?? null : r.sent_by_user_id ? { id: r.sent_by_user_id, name: r.sent_by_name || '' } : null;
        ctx.blockwords.recordAi({
          source,
          stage: 'post',
          accountId: conv.account_id ?? null,
          conversationId: convId,
          campaign: source === 'campaign' ? camp?.campaign ?? null : null,
          user,
          text: r.text,
          messageId: r.id,
          verdict: v,
        });
      }
    })();
    return 1;
  }

  /**
   * 扫一遍：开着时把「最后一条我方消息已经过了 debounceMs」的会话逐个查（一个一个来，外联同一段话查完第一个，后面的直接沿用）。
   * 同时只跑一遍，正在跑时返回正在跑的那一遍。返回这一遍调了几次模型（测试用）
   */
  function run() {
    if (running) return running;
    running = (async () => {
      if (closed || !enabled()) return 0;
      db.prepare('DELETE FROM conduct_cache WHERE ts < ?').run(iso(clock() - LOOKBACK_MS));
      const since = sinceIso();
      const readyBefore = iso(clock() - debounceMs);
      // 用 messages_direction_ts 只扫最近 24 小时（或开启以来）发出的
      const convs = db
        .prepare(
          `SELECT conversation_id id, MAX(ts) last FROM messages
           WHERE direction = 'out' AND ts >= ? AND conduct_checked_at IS NULL GROUP BY conversation_id ORDER BY last`,
        )
        .all(since)
        .filter((c) => c.last <= readyBefore);
      let calls = 0;
      for (const c of convs) {
        if (closed || !enabled()) break;
        const f = failures.get(c.id);
        if (f && f.nextAt > clock()) continue;
        calls += await checkConversation(c.id, since);
      }
      return calls;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    enabled,
    afterTranslate,
    afterBotReply,
    run,

    /** 定时扫；intervalMs 为 0 时不起定时器（测试里手动调 run）。重启后第一轮就会接着查最近 24 小时里没查的 */
    start(intervalMs = CONDUCT_SWEEP_MS) {
      if (!intervalMs || timer || closed) return;
      timer = setInterval(() => {
        run().catch((err) => log.error(`[conduct] 发言检查出错：${err?.stack || err}`));
      }, intervalMs);
      timer.unref?.();
    },

    /** 停定时器，等正在跑的那一遍收尾（关数据库之前） */
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}
