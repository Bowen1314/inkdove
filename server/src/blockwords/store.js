// 屏蔽词：发出前检查、命中记录、给管理员的提醒和历史、AI 扩充（接口见 routes/blockwords.js，表见 db.js 的 blockword_hits）。
// 只管我方发出去的文字，客户发来的不查。开关和词表在设置的 blockwords 里，关着或词表为空时什么都不做。
// 在哪里查（每处的调用在各自的文件里，找 ctx.blockwords）：
// - 后台发消息（operator）、发文件的说明文字（file）：wa/service.js 的 operatorSend / operatorSendFile，命中返回 400，不发；
// - 通知号码上转发、/d 发草稿（relay）：wa/service.js 的 handleNotifyReply，命中不发，回执里说明；
// - 自动回复（bot）：wa/service.js 的 processPending，命中不发，按「回复被拦截」转人工；
// - 外联开场消息（campaign）：outreach/store.js 建任务时查（命中 400），发之前再查一次（建任务后才加的词，命中就暂停任务）；
// - 一键翻译的原文（translate）：wa/translate.js 的 translateForConversation，命中不翻译；
// - 机主在手机上发的（phone）：wa/service.js 的 archiveOwner，已经发出去了拦不住，只记下来提醒管理员。
// 发给管理员自己的通知和 F3 回执不查（不是发给客户的）。
// AI 发言检查（blockwords/conduct.js）发现的也记在这里（detector=ai），只提醒、不拦；弹窗只弹屏蔽词命中和 AI 发现的严重问题，
// 轻微的只进列表。AI 发现的管理员可以标「误报」。
import { NO_NUMBER_NAMES } from '../accounts.js';
import { llmConfigured } from '../settings.js';
import { badRequest, clip, HttpError, newId, notFound, nowIso, safeJsonParse } from '../util.js';
import { checkExpandRequest, parseExpandOutput } from './expand.js';
import { compileList, findHits } from './match.js';

export const HIT_SOURCES = ['operator', 'file', 'translate', 'bot', 'relay', 'campaign', 'phone'];
/** 「谁」的筛选里不对应具体成员的三种 */
export const WHO_SOURCES = ['bot', 'phone', 'relay'];
/** 记录里的原文最多存多少字（和消息表一样） */
const MAX_TEXT = 10000;
/** 弹窗一次最多带几条没处理的（先弹最早的） */
export const ALERT_LIMIT = 20;
const MAX_PAGE_SIZE = 200;
/** 列表的处理状态：pending 没处理、acked 已处理（不含误报）、false_positive 标了误报的 */
const HIT_STATUSES = ['', 'pending', 'acked', 'false_positive'];
export const DETECTORS = ['word', 'ai'];
export const SEVERITIES = ['severe', 'mild'];
/** 弹窗要的：屏蔽词命中和 AI 发现的严重问题（和 db.js 的 blockword_hits_alert 索引条件一字不差，才用得上索引） */
const ALERT_WHERE = "acked_at IS NULL AND (detector = 'word' OR severity = 'severe')";

/** 「a」「b」，多于 5 个只写前 5 个 */
export function quoteWords(words) {
  const shown = words.slice(0, 5).map((w) => `「${w}」`).join('');
  return words.length > 5 ? `${shown}等 ${words.length} 个` : shown;
}

const SUBJECT = { operator: '该消息', file: '文件说明', translate: '该文本', relay: '该消息', campaign: '开场消息', bot: '回复' };
const RESULT = { file: '文件未发送', translate: '未翻译', campaign: '任务未创建' };

/** 给发送人看的提示：「这条消息里有屏蔽词「xxx」，没有发出去，管理员会收到提醒」 */
export function hitMessage(source, words) {
  return `${SUBJECT[source] || '该消息'}含屏蔽词${quoteWords(words)}，${RESULT[source] || '未发送'}，管理员将收到提醒`;
}

function rowToHit(r) {
  return {
    id: r.id,
    ts: r.ts,
    source: r.source,
    blocked: !!r.blocked,
    accountId: r.account_id ?? null,
    accountName: r.account_name || '',
    conversationId: r.conversation_id ?? null,
    contactName: r.contact_name || '',
    campaignId: r.campaign_id ?? null,
    campaignName: r.campaign_name || '',
    userId: r.user_id ?? null,
    userName: r.user_name || '',
    words: safeJsonParse(r.words, []),
    ranges: safeJsonParse(r.ranges, []),
    text: r.text,
    ackedAt: r.acked_at ?? null,
    ackedById: r.acked_by_id ?? null,
    ackedByName: r.acked_by_name || '',
    // AI 发言检查的几项（屏蔽词命中的为 null / 空）
    detector: r.detector || 'word',
    severity: r.severity ?? null,
    category: r.category ?? null,
    reason: r.reason || '',
    quote: r.quote || '',
    stage: r.stage ?? null,
    messageId: r.message_id ?? null,
    falsePositiveAt: r.false_positive_at ?? null,
    falsePositiveById: r.false_positive_by_id ?? null,
    falsePositiveByName: r.false_positive_by_name || '',
  };
}

/** 查询参数里的时间：ISO 时间字符串，转成库里的格式；空的返回 '' */
function isoParam(v, field) {
  if (v === undefined || v === null || v === '') return '';
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw badRequest(`${field} 必须是时间（ISO 格式）`);
  return new Date(t).toISOString();
}

/** @param {any} ctx */
export function createBlockwords(ctx) {
  const { db } = ctx;

  /**
   * 行 → 记录，并按 user_id 查发送人现在的状态 userDisabled：停用了 true、启用中 false；
   * 不是成员发的（机器人、机主手机、通知号码）或成员已经删了为 null。弹窗按这个决定显不显示「停用这个业务员」。
   * 一页最多几百行，按主键逐个查，同一个人只查一次
   */
  const userDisabledStmt = db.prepare('SELECT disabled FROM users WHERE id = ?');
  function toHits(rows) {
    const state = new Map();
    return rows.map((r) => {
      const h = rowToHit(r);
      if (h.userId && !state.has(h.userId)) {
        const u = userDisabledStmt.get(h.userId);
        state.set(h.userId, u ? !!u.disabled : null);
      }
      h.userDisabled = h.userId ? state.get(h.userId) : null;
      return h;
    });
  }
  const toHit = (row) => toHits([row])[0];

  /** 开着而且有词时返回编译好的词表，否则 null */
  function compiled() {
    const b = ctx.getSettings().blockwords;
    if (!b?.enabled || !b.words?.length) return null;
    return compileList(b.words);
  }

  /**
   * 记一条命中。号名、联系人名、发送人名按当时的存一份。
   * @param {{source:string, blocked?:boolean, accountId?:string|null, accountName?:string, conversationId?:string|null,
   *   campaign?:{id:string|null, name:string}|null, user?:{id:string, name?:string, email?:string}|null, text:string,
   *   hits:{word:string, ranges:[number, number][]}[]}} p accountName：不是一个号时（建外联任务选了几个号）直接给名字
   */
  function record({ source, blocked = true, accountId = null, accountName = '', conversationId = null, campaign = null, user = null, text, hits }) {
    const body = clip(text, MAX_TEXT);
    const ranges = hits.flatMap((h) => h.ranges).filter(([, e]) => e <= body.length);
    return insert(
      { source, accountId, accountName, conversationId, campaign, user, text: body },
      { blocked: blocked ? 1 : 0, words: JSON.stringify(hits.map((h) => h.word)), ranges: JSON.stringify(ranges) },
    );
  }

  /** 写一行（record、recordAi 共用）：号名、联系人名、发送人名按当时的存一份；extra 是各自的列 */
  function insert({ source, accountId = null, accountName = '', conversationId = null, campaign = null, user = null, text }, extra) {
    const conv = conversationId
      ? db.prepare('SELECT account_id, channel, contact_name, contact_number, chat_id FROM conversations WHERE id = ?').get(conversationId)
      : null;
    const accId = accountId || conv?.account_id || null;
    const acc = accId ? ctx.accounts.get(accId) : null;
    // LINE、Telegram 的客户没有号码，没名字时记「LINE 用户」「Telegram 用户」（不记用户 id）
    const contact = conv
      ? conv.contact_name || (conv.contact_number ? `+${conv.contact_number}` : NO_NUMBER_NAMES[conv.channel] || conv.chat_id || '')
      : '';
    const id = newId();
    const row = {
      id,
      ts: nowIso(),
      source,
      account_id: accId,
      account_name: clip(accountName || acc?.name || '', 200),
      conversation_id: conversationId,
      contact_name: clip(contact, 100),
      campaign_id: campaign?.id ?? null,
      campaign_name: clip(campaign?.name || '', 100),
      user_id: user?.id ?? null,
      user_name: clip(user ? user.name || user.email || '' : '', 100),
      text,
      ...extra,
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO blockword_hits(${cols.join(', ')}) VALUES(${cols.map((c) => `@${c}`).join(', ')})`).run(row);
    return id;
  }

  /**
   * 记一条 AI 发言检查发现的问题（只提醒，blocked 记 0）。verdict 是 conduct-prompts.js 的 normalizeConduct 校验过的
   * {level:'mild'|'severe', category, reason, quote}；stage：pre 一键翻译时发现、还没发出，post 发出后检查发现的。
   * 原文里找得到 quote 时记下它的位置，前端标出来。
   * @param {{source:string, stage:'pre'|'post', accountId?:string|null, conversationId?:string|null, campaign?:{id:string|null, name:string}|null,
   *   user?:{id:string, name?:string, email?:string}|null, text:string, messageId?:string|null, verdict:{level:string, category:string, reason:string, quote:string}}} p
   */
  function recordAi({ source, stage, accountId = null, conversationId = null, campaign = null, user = null, text, messageId = null, verdict }) {
    const body = clip(text, MAX_TEXT);
    const at = verdict.quote ? body.indexOf(verdict.quote) : -1;
    return insert(
      { source, accountId, conversationId, campaign, user, text: body },
      {
        blocked: 0,
        words: '[]',
        ranges: JSON.stringify(at >= 0 ? [[at, at + verdict.quote.length]] : []),
        detector: 'ai',
        severity: verdict.level,
        category: verdict.category || 'other',
        reason: verdict.reason || '',
        quote: verdict.quote || '',
        stage,
        message_id: messageId,
      },
    );
  }

  /**
   * 检查一段要发出的文字。开着、命中了就记一条，返回 {id, words}；没开、没命中返回 null。
   * blocked=false 用于已经发出去的（手机上发的），只提醒。
   */
  function check(text, info) {
    const list = compiled();
    if (!list || typeof text !== 'string' || !text) return null;
    const hits = findHits(list, text);
    if (!hits.length) return null;
    const id = record({ ...info, text, hits });
    return { id, words: hits.map((h) => h.word) };
  }

  /** 检查并在命中时抛 400（code blockword_hit），提示按 info.source 写 */
  function guard(text, info) {
    const h = check(text, info);
    if (h) throw new HttpError(400, 'blockword_hit', hitMessage(info.source, h.words));
  }

  return {
    check,
    guard,
    recordAi,

    /** 弹窗用：还没处理的屏蔽词命中和 AI 发现的严重问题（轻微的不弹），最早的在前，最多 ALERT_LIMIT 条，另给总数 */
    alerts() {
      const total = db.prepare(`SELECT COUNT(*) n FROM blockword_hits WHERE ${ALERT_WHERE}`).get().n;
      const items = total
        ? toHits(db.prepare(`SELECT * FROM blockword_hits WHERE ${ALERT_WHERE} ORDER BY ts, rowid LIMIT ?`).all(ALERT_LIMIT))
        : [];
      return { total, items };
    },

    /** 「知道了」：记下是谁处理的；别人已经处理过的不改，照样返回这条 */
    ack(id, user) {
      db.prepare('UPDATE blockword_hits SET acked_at = ?, acked_by_id = ?, acked_by_name = ? WHERE id = ? AND acked_at IS NULL').run(
        nowIso(),
        user?.id ?? null,
        clip(user ? user.name || user.email || '' : '', 100),
        id,
      );
      const row = db.prepare('SELECT * FROM blockword_hits WHERE id = ?').get(id);
      if (!row) throw notFound('记录不存在');
      return toHit(row);
    },

    /**
     * 「误报」：只有 AI 发现的能标。同时算已处理（还没人点「知道了」的，记成这位管理员处理的）；标了不能撤销，
     * 重复标照样返回这条
     */
    falsePositive(id, user) {
      const row = db.prepare('SELECT detector FROM blockword_hits WHERE id = ?').get(id);
      if (!row) throw notFound('记录不存在');
      if (row.detector !== 'ai') throw badRequest('仅 AI 发言检查的结果可标记为误报', 'not_ai_hit');
      const now = nowIso();
      const by = user?.id ?? null;
      const name = clip(user ? user.name || user.email || '' : '', 100);
      db.prepare(
        `UPDATE blockword_hits SET false_positive_at = ?, false_positive_by_id = ?, false_positive_by_name = ?,
           acked_by_id = CASE WHEN acked_at IS NULL THEN ? ELSE acked_by_id END,
           acked_by_name = CASE WHEN acked_at IS NULL THEN ? ELSE acked_by_name END,
           acked_at = COALESCE(acked_at, ?)
         WHERE id = ? AND false_positive_at IS NULL`,
      ).run(now, by, name, by, name, now, id);
      return toHit(db.prepare('SELECT * FROM blockword_hits WHERE id = ?').get(id));
    },

    /**
     * 历史记录，新到旧，服务端分页。status：pending 没处理 / acked 已处理（不含误报）/ false_positive 标了误报的；
     * detector：word 屏蔽词 / ai AI 发言检查；severity：severe / mild（只对 AI 发现的有意义）；who：成员 id，或 bot、phone、relay；
     * from、to：ISO 时间（含 from，不含 to）。另给 senders（记录里出现过的成员，筛选用）。
     */
    list(q = {}) {
      const status = String(q.status ?? '');
      if (!HIT_STATUSES.includes(status)) throw badRequest('status 只能是 pending、acked 或 false_positive');
      const detector = String(q.detector ?? '');
      if (detector && !DETECTORS.includes(detector)) throw badRequest('detector 只能是 word 或 ai');
      const severity = String(q.severity ?? '');
      if (severity && !SEVERITIES.includes(severity)) throw badRequest('severity 只能是 severe 或 mild');
      const who = String(q.who ?? '');
      if (who.length > 100) throw badRequest('who 无效');
      const from = isoParam(q.from, 'from');
      const to = isoParam(q.to, 'to');
      const page = Number(q.page ?? 1);
      const size = Number(q.pageSize ?? 50);
      if (!Number.isInteger(page) || page < 1) throw badRequest('page 必须是从 1 开始的整数');
      if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) throw badRequest(`pageSize 必须是 1–${MAX_PAGE_SIZE} 的整数`);
      const where = [];
      const params = [];
      if (status === 'pending') where.push('acked_at IS NULL');
      if (status === 'acked') where.push('acked_at IS NOT NULL AND false_positive_at IS NULL');
      if (status === 'false_positive') where.push('false_positive_at IS NOT NULL');
      if (detector) {
        where.push('detector = ?');
        params.push(detector);
      }
      if (severity) {
        where.push('severity = ?');
        params.push(severity);
      }
      if (WHO_SOURCES.includes(who)) {
        where.push('source = ?');
        params.push(who);
      } else if (who) {
        where.push('user_id = ?');
        params.push(who);
      }
      if (from) {
        where.push('ts >= ?');
        params.push(from);
      }
      if (to) {
        where.push('ts < ?');
        params.push(to);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) n FROM blockword_hits ${w}`).get(...params).n;
      const items = toHits(
        db.prepare(`SELECT * FROM blockword_hits ${w} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size),
      );
      const senders = db
        .prepare('SELECT user_id id, MAX(user_name) name FROM blockword_hits WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY name')
        .all();
      return { total, page, pageSize: size, items, senders };
    },

    /**
     * AI 扩充：用回复模型按种子词生成候选（不存）。返回 {candidates}，每个 {word, language, seed, risk, reason, forced}。
     * 已有的词 = 这次带来的（设置页里还没保存的）+ 已保存的，去重用。
     */
    async expand(body) {
      const req = checkExpandRequest(body);
      const s = ctx.getSettings();
      if (!llmConfigured(s, ctx.config)) throw new HttpError(400, 'llm_not_configured', '未配置模型，请前往「设置 → AI 模型」填写');
      const existing = [...new Set([...req.existing, ...(s.blockwords?.words || [])])];
      let data;
      try {
        data = await ctx.ai.expandBlockwords({ seeds: req.seeds, languages: req.languages, existing });
      } catch (err) {
        throw new HttpError(502, 'llm_error', `扩充失败：${err?.message || err}`);
      }
      try {
        return { candidates: parseExpandOutput(data, { ...req, existing }) };
      } catch (err) {
        throw new HttpError(502, 'llm_bad_output', `扩充失败：${err?.message || err}。请重试或更换模型`);
      }
    },
  };
}
