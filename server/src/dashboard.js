// F12 管理员数据看板：GET /api/dashboard 一次返回全部数据（结构和各字段的算法见 SPEC-phase2 F12「接口」）。
// 只读已经记下的表（decisions、llm_calls、handoffs、messages、leads、campaign_recipients…），不调模型。
//
// 时间：时间段和日期分组都按请求的 tz（IANA 时区）。SQLite 不认识 IANA 时区，所以 SQL 先按 UTC 的 15 分钟分桶聚合，
// 再在 JS 里用 Intl 把每个桶换算成当地的日期、星期和小时。现行时区的偏移和夏令时切换都是 15 分钟的整数倍，
// 一个桶里的记录在当地一定落在同一天、同一小时。30 天最多 2880 个桶，不在 JS 里遍历消息。
//
// 导入的历史消息（messages.via = 'import'）不算入站消息、不算新客户、不进热力图：时间是旧的，也不是服务期间收到的。
//
// 推荐回复采纳（drafts）和它的列表（GET /api/dashboard/drafts）读 draft_outcomes（reply/draft-outcomes.js 记的）。
//
// 平均回复时间（kpi.avgReplyMinutes，成员表每人一列）按「客户等人工回复的一轮」算，见 replyTurns。
//
// 按业务员筛选（assigneeId）：只算现在分给这个成员的会话（conversations.assignee_id，'unassigned' 是未分配的）。
// 按的是现在的负责人：会话改派后，它以前的消息、处理记录也跟着算到新负责人名下。知识库和成本不按业务员筛选。
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { DELETED_ACCOUNT_NAME } from './accounts.js';
import { codeLabel, LEAD_STAGES, leadStageLabel, LLM_PURPOSES, purposeLabel, RESPONDER_KINDS } from './codes.js';
import { DRAFT_KINDS, DRAFT_OUTCOMES, DRAFT_PENDING_MS, UNUSED_OUTCOMES } from './reply/draft-outcomes.js';
import { DRAFT_PROMPT_VERSION } from './reply/prompt-version.js';
import { badRequest, safeJsonParse } from './util.js';

/** range → 含今天在内的自然日数 */
export const DASHBOARD_RANGES = { today: 1, '7d': 7, '30d': 30 };
export const DEFAULT_RANGE = '7d';
/** 没带 tz 时用 UTC（前端取不到浏览器时区时不带） */
export const DEFAULT_TZ = 'UTC';
/** 漏斗的阶段顺序；after_sales 和 other 不进漏斗 */
export const FUNNEL_STAGES = ['inquiry', 'sample', 'negotiation', 'order_intent'];
/** unusedEntries：最近多少天没被引用（固定 30 天，不随 range 变） */
export const UNUSED_ENTRY_DAYS = 30;
/** 号的连接状态缓存多久（看板刷新不每次都去问 WAHA） */
const ACCOUNT_STATE_MAX_AGE_MS = 30_000;
const BUCKET_SECONDS = 15 * 60;
const DELETED_MEMBER_NAME = '已删除的成员';
const UNKNOWN_COUNTRY = '未知';

// ---------------- 参数 ----------------

/** 时区名能不能用；能用时返回规范写法（asia/shanghai → Asia/Shanghai），不能用返回 null */
export function canonicalTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 100) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** 按业务员筛选时表示「未分配」的值 */
export const UNASSIGNED = 'unassigned';

/**
 * 校验查询参数。range 不传按 7d，不是 today|7d|30d 返回 400；tz 不传按 UTC，传了但 Intl 不认识返回 400；
 * accountId 不传或为空表示全部号（号删了也照样按它筛，数据还在）。
 * assigneeId 不传或为空表示全部业务员，'unassigned' 是未分配的会话，其余当成员 id（成员停用、删了也照样筛，不报错）。
 * @param {Record<string, unknown>} q req.query
 */
export function parseDashboardQuery(q = {}) {
  const range = q.range === undefined || q.range === '' ? DEFAULT_RANGE : q.range;
  if (typeof range !== 'string' || !Object.hasOwn(DASHBOARD_RANGES, range)) {
    throw badRequest('range 只能是 today、7d 或 30d', 'invalid_range');
  }
  let tz = DEFAULT_TZ;
  if (q.tz !== undefined && q.tz !== '') {
    tz = canonicalTz(q.tz);
    if (!tz) throw badRequest('tz 不是可用的 IANA 时区（例如 Asia/Shanghai）', 'invalid_tz');
  }
  let accountId = null;
  if (q.accountId !== undefined && q.accountId !== '') {
    if (typeof q.accountId !== 'string' || q.accountId.length > 200) throw badRequest('accountId 不正确');
    accountId = q.accountId;
  }
  let assigneeId = null;
  if (q.assigneeId !== undefined && q.assigneeId !== '') {
    if (typeof q.assigneeId !== 'string' || q.assigneeId.length > 200) throw badRequest('assigneeId 不正确', 'invalid_assignee');
    assigneeId = q.assigneeId;
  }
  return { range, tz, accountId, assigneeId };
}

/** 推荐回复列表（GET /api/dashboard/drafts）每页默认几条、最多几条 */
export const DRAFT_LIST_LIMIT = 20;
export const DRAFT_LIST_MAX = 50;
/**
 * 推荐回复列表的筛选 → 算哪些结果。all 是改了再发和没用的，不含没发（没发的多半是没人看，说明不了推荐好不好）
 */
export const DRAFT_LIST_FILTERS = {
  all: ['edited', 'own', 'dismissed', 'replaced'],
  edited: ['edited'],
  own: ['own'],
  dismissed: ['dismissed'],
  replaced: ['replaced'],
  unsent: ['unsent'],
};

/**
 * 推荐回复列表的参数：range、tz、accountId、assigneeId 同看板；filter 不传按 all；cursor 是上一页返回的 nextCursor；limit 1–50，默认 20
 * @param {Record<string, unknown>} q req.query
 */
export function parseDraftListQuery(q = {}) {
  const base = parseDashboardQuery(q);
  const filter = q.filter === undefined || q.filter === '' ? 'all' : q.filter;
  if (typeof filter !== 'string' || !Object.hasOwn(DRAFT_LIST_FILTERS, filter)) {
    throw badRequest(`filter 只能是 ${Object.keys(DRAFT_LIST_FILTERS).join('、')}`, 'invalid_filter');
  }
  let cursor = null;
  if (q.cursor !== undefined && q.cursor !== '') {
    const raw = typeof q.cursor === 'string' && q.cursor.length <= 200 ? q.cursor : '';
    const cut = raw.lastIndexOf('|');
    if (cut <= 0 || cut === raw.length - 1) throw badRequest('cursor 不正确', 'invalid_cursor');
    cursor = { at: raw.slice(0, cut), id: raw.slice(cut + 1) };
  }
  let limit = DRAFT_LIST_LIMIT;
  if (q.limit !== undefined && q.limit !== '') {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > DRAFT_LIST_MAX) throw badRequest(`limit 只能是 1–${DRAFT_LIST_MAX}`, 'invalid_limit');
  }
  return { ...base, filter, cursor, limit };
}

// ---------------- 时区换算（Intl，不引依赖） ----------------

const formatters = new Map();
function partsFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** 某一刻（毫秒）在 tz 的当地时间 {y, m, d, h, mi, s} */
export function zonedParts(ms, tz) {
  const o = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

/** tz 在某一刻比 UTC 快多少毫秒 */
function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - whole;
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/** tz 里某一天（y-m-d）的第一刻（UTC 毫秒）。夏令时恰好在 0 点切换、0 点不存在时，取当天最早存在的时刻 */
export function localDayStart(y, m, d, tz) {
  const want = Date.UTC(y, m - 1, d);
  const a = want - offsetMs(want, tz);
  const b = want - offsetMs(a, tz);
  const sameDay = (t) => {
    const p = zonedParts(t, tz);
    return p.y === y && p.m === m && p.d === d;
  };
  const hits = [a, b].filter(sameDay);
  return hits.length ? Math.min(...hits) : b;
}

/**
 * 时间段：today 是 tz 当天 0 点到现在；7d / 30d 是含今天在内往前 7 / 30 个自然日（按 tz），从第一天 0 点到现在。
 * dates 是这几天的当地日期 YYYY-MM-DD（trend 每天一行，没数据的也有）。
 */
export function resolveRange(range, tz, nowMs) {
  const days = DASHBOARD_RANGES[range];
  const today = zonedParts(nowMs, tz);
  const dates = [];
  let first = null;
  for (let i = days - 1; i >= 0; i--) {
    const u = new Date(Date.UTC(today.y, today.m - 1, today.d - i));
    const parts = [u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()];
    if (!first) first = parts;
    dates.push(ymd(...parts));
  }
  const fromMs = localDayStart(...first, tz);
  return { fromMs, toMs: nowMs, from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString(), dates };
}

/** 15 分钟桶号 → 当地 {date, weekday(周一 0), hour} */
function bucketMapper(tz) {
  const cache = new Map();
  return (bucket) => {
    let v = cache.get(bucket);
    if (!v) {
      const p = zonedParts(Number(bucket) * BUCKET_SECONDS * 1000, tz);
      v = { date: ymd(p.y, p.m, p.d), weekday: (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7, hour: p.h };
      cache.set(bucket, v);
    }
    return v;
  };
}

// ---------------- 小工具 ----------------

/** 中位数（偶数个取中间两个的平均）；空数组 null。分钟数保留两位小数 */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(v * 100) / 100;
}

/** 比率：分母 0 时 null */
const ratio = (num, den) => (den > 0 ? num / den : null);
const roundUsd = (v) => Math.round(v * 1e6) / 1e6;

let regionNames = null;
/** 国家代码 → 中文国名（Node 自带的 ICU）；取不到时用代码本身 */
function countryName(code) {
  try {
    regionNames ??= new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

/** 会话的联系人号码（不带 + 的国际号码）→ 国家代码；空号码（@lid 换算不出来的）或解析不出国家的返回 null */
export function countryOfNumber(digits) {
  const s = String(digits || '').replace(/\D+/g, '');
  if (!s) return null;
  try {
    return parsePhoneNumberFromString(`+${s}`)?.country || null;
  } catch {
    return null;
  }
}

// JSON 数组列（used_entry_ids、sent_file_ids）展开成行；坏数据当空数组，免得 json_each 报错
const jsonArr = (col) => `json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END)`;
// 按号筛选：@acc 为 NULL 时不筛
const accEq = (col) => `(@acc IS NULL OR ${col} = @acc)`;

/**
 * 按业务员筛选的 SQL 片段（参数 @asg）。不筛时是 1，查询和原来一样；筛的时候：
 * - col(c)：会话表的 assignee_id 列（查询里已经 JOIN 了会话，或者就是查会话表）
 * - conv(col)：别的表的 conversation_id 列，要求它指向分给这个人的会话（会话删了的不算，conversation_id 为空的也不算）
 * @param {string|null} asg parseDashboardQuery 的 assigneeId
 */
export function assigneeScope(asg) {
  if (!asg) return { col: () => '1', conv: () => '1' };
  const cond = (col) => (asg === UNASSIGNED ? `${col} IS NULL` : `${col} = @asg`);
  return { col: cond, conv: (col) => `${col} IN (SELECT id FROM conversations WHERE ${cond('assignee_id')})` };
}
const bucketOf = (col) => `CAST(strftime('%s', ${col}) AS INTEGER) / ${BUCKET_SECONDS}`;
// 入站消息：客户发的，不含导入的历史消息（助手的概况工具 assistant/tools.js 用同一个口径）
export const INBOUND = (m) => `${m}.direction = 'in' AND ${m}.author = 'customer' AND COALESCE(${m}.via, '') <> 'import'`;
// 草稿的结果：还没定、起草已经超过 24 小时的（定时清理还没轮到）按没发算，看板只读不写；还没到 24 小时的为 NULL（还没定）
const DRAFT_OC = (d) => `CASE WHEN ${d}outcome IS NOT NULL THEN ${d}outcome WHEN ${d}created_at < @pendingBefore THEN 'unsent' END`;
const jsonLen = (col) => `CASE WHEN json_valid(${col}) THEN json_array_length(${col}) ELSE 0 END`;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** 一组草稿的计数：总数、还没定的、定了的、各结果、改了再发的改动比例之和 */
function draftGroup() {
  return { total: 0, pending: 0, decided: 0, outcomes: Object.fromEntries(Object.keys(DRAFT_OUTCOMES).map((k) => [k, 0])), editSum: 0, editN: 0 };
}
function addDraftRow(g, row) {
  g.total += row.n;
  if (!row.oc) {
    g.pending += row.n;
    return;
  }
  g.decided += row.n;
  if (Object.hasOwn(g.outcomes, row.oc)) g.outcomes[row.oc] += row.n;
  if (row.oc === 'edited') {
    g.editSum += row.er || 0;
    g.editN += row.ern || 0;
  }
}
/** 比率的分母是定了的（还没定的不算）；avgEditRatio 是改了再发的平均改动比例 */
function finishDraftGroup({ editSum, editN, ...g }) {
  const unused = UNUSED_OUTCOMES.reduce((n, k) => n + g.outcomes[k], 0);
  return {
    ...g,
    unused,
    usedRate: ratio(g.outcomes.used, g.decided),
    editedRate: ratio(g.outcomes.edited, g.decided),
    unusedRate: ratio(unused, g.decided),
    avgEditRatio: editN ? round3(editSum / editN) : null,
  };
}

/**
 * 看板的推荐回复采纳：本时间段内起草的推荐回复和转人工草稿，按结果、类型、模型 + 提示词版本、每天统计。不按成员分；
 * 按业务员筛选时只算分给他的会话里的草稿。
 * @param {import('better-sqlite3').Database} db
 * @param {{from:string, to:string, acc:string|null, asg?:string|null, pendingBefore:string}} P
 * @param {(bucket:number) => {date:string}} toLocal
 * @param {string[]} dates
 */
export function draftSummary(db, P, toLocal, dates) {
  const where = `created_at >= @from AND created_at <= @to AND ${accEq('account_id')} AND ${assigneeScope(P.asg).conv('conversation_id')}`;
  const rows = db
    .prepare(
      `SELECT kind, model, prompt_version AS pv, ${DRAFT_OC('')} AS oc, COUNT(*) AS n, SUM(edit_ratio) AS er, COUNT(edit_ratio) AS ern,
              MIN(created_at) AS firstAt, MAX(created_at) AS lastAt, SUM(${jsonLen('file_ids')}) AS fs, SUM(${jsonLen('sent_file_ids')}) AS fsent
         FROM draft_outcomes WHERE ${where}
        GROUP BY kind, model, pv, oc`,
    )
    .all(P);
  const total = draftGroup();
  const kinds = new Map(Object.keys(DRAFT_KINDS).map((k) => [k, draftGroup()]));
  const versions = new Map();
  const files = { suggested: 0, sent: 0 };
  for (const row of rows) {
    addDraftRow(total, row);
    if (!kinds.has(row.kind)) kinds.set(row.kind, draftGroup());
    addDraftRow(kinds.get(row.kind), row);
    const key = JSON.stringify([row.kind, row.model, row.pv]);
    if (!versions.has(key)) {
      versions.set(key, { kind: row.kind, model: row.model, promptVersion: row.pv, firstAt: row.firstAt, lastAt: row.lastAt, g: draftGroup() });
    }
    const v = versions.get(key);
    if (row.firstAt < v.firstAt) v.firstAt = row.firstAt;
    if (row.lastAt > v.lastAt) v.lastAt = row.lastAt;
    addDraftRow(v.g, row);
    files.suggested += row.fs || 0;
    files.sent += row.fsent || 0;
  }
  const kindOrder = Object.keys(DRAFT_KINDS);
  const orderOf = (k) => (kindOrder.includes(k) ? kindOrder.indexOf(k) : kindOrder.length);
  const trendMap = new Map(dates.map((date) => [date, { date, used: 0, edited: 0, unused: 0, pending: 0 }]));
  for (const row of db
    .prepare(`SELECT ${bucketOf('created_at')} AS b, ${DRAFT_OC('')} AS oc, COUNT(*) AS n FROM draft_outcomes WHERE ${where} GROUP BY b, oc`)
    .all(P)) {
    const day = trendMap.get(toLocal(row.b).date);
    if (!day) continue;
    if (!row.oc) day.pending += row.n;
    else if (row.oc === 'used' || row.oc === 'edited') day[row.oc] += row.n;
    else day.unused += row.n;
  }
  return {
    ...finishDraftGroup(total),
    files,
    byKind: [...kinds]
      .map(([kind, g]) => ({ kind, label: DRAFT_KINDS[kind] || kind, ...finishDraftGroup(g) }))
      .sort((a, b) => orderOf(a.kind) - orderOf(b.kind)),
    byVersion: [...versions.values()]
      .map(({ g, ...v }) => ({ ...v, label: DRAFT_KINDS[v.kind] || v.kind, ...finishDraftGroup(g) }))
      .sort((a, b) => orderOf(a.kind) - orderOf(b.kind) || String(b.lastAt).localeCompare(String(a.lastAt))),
    trend: [...trendMap.values()],
    currentPromptVersion: DRAFT_PROMPT_VERSION,
  };
}

/**
 * 模型调用的次数、token 和按设置里的单价估算的费用（看板的 cost，助手的用量工具也用它，口径一致）。
 * 不按号筛选时 acc 为 null；按号筛时和会话有关的调用按号筛，不属于任何号的调用照算。没配单价的模型费用记 null。
 * @param {import('better-sqlite3').Database} db
 * @param {{model:string, inputPerMillion:number, outputPerMillion:number}[]} pricingList 设置里的 pricing
 * @param {{from:string, to:string, acc:string|null}} p
 */
export function llmCostSummary(db, pricingList, { from, to, acc }) {
  const pricing = new Map((pricingList || []).map((p) => [p.model, p]));
  const purposes = new Map();
  const cost = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null, byPurpose: [] };
  for (const row of db
    .prepare(
      `SELECT purpose, model, COUNT(*) AS calls, SUM(input_tokens) AS inTok, SUM(output_tokens) AS outTok FROM llm_calls
        WHERE ts >= @from AND ts <= @to AND (@acc IS NULL OR account_id IS NULL OR account_id = @acc)
        GROUP BY purpose, model`,
    )
    .all({ from, to, acc })) {
    if (!purposes.has(row.purpose)) {
      purposes.set(row.purpose, {
        purpose: row.purpose,
        label: purposeLabel(row.purpose),
        calls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: 0,
        priced: true,
      });
    }
    const p = purposes.get(row.purpose);
    p.calls += row.calls;
    cost.calls += row.calls;
    if (row.inTok != null) {
      p.inputTokens = (p.inputTokens || 0) + row.inTok;
      cost.inputTokens += row.inTok;
    }
    if (row.outTok != null) {
      p.outputTokens = (p.outputTokens || 0) + row.outTok;
      cost.outputTokens += row.outTok;
    }
    const price = row.model == null ? null : pricing.get(String(row.model).trim());
    if (!price) {
      p.priced = false;
      continue;
    }
    const usd = ((row.inTok || 0) * price.inputPerMillion + (row.outTok || 0) * price.outputPerMillion) / 1e6;
    p.costUsd += usd;
    cost.estimatedCostUsd = (cost.estimatedCostUsd || 0) + usd;
  }
  if (cost.estimatedCostUsd != null) cost.estimatedCostUsd = roundUsd(cost.estimatedCostUsd);
  const purposeOrder = Object.keys(LLM_PURPOSES);
  const orderOf = (p) => (purposeOrder.includes(p) ? purposeOrder.indexOf(p) : purposeOrder.length);
  cost.byPurpose = [...purposes.values()]
    .sort((a, b) => b.calls - a.calls || orderOf(a.purpose) - orderOf(b.purpose))
    .map(({ priced, costUsd, ...p }) => ({ ...p, costUsd: priced ? roundUsd(costUsd) : null }));
  return cost;
}

// ---------------- 平均回复时间 ----------------

/**
 * 客户等人工回复的一轮一轮（平均回复时间用）的 SQL。
 *
 * 一个会话里的消息按 (ts, seq) 排成一串，只留客户看得到的：客户发的消息，和我方发出去了的消息（status = 'sent'）。
 * 导入的历史消息（via = 'import'）、外联群发（via = 'campaign'）、发送失败的都不进这一串，就当没有。
 * 通知号上的提醒存在 notice_messages，本来就不在 messages 里。撤回了的消息照样在（发出去过，对方看到过）。
 *
 * - 一轮从一条客户消息开始，条件是它前面那条不是客户消息（我方回过之后客户发的第一条，或者会话里的第一条）；
 *   客户连着发的几条算同一轮，等待时间从第一条算。
 * - 一轮在它后面我方发的第一条消息结束。是人发的（后台 author=operator、via=admin；WhatsApp 转发 operator、via=whatsapp；
 *   机主手机上发的 owner、via=phone；早期没记 via 的 operator 也算）就是一次人工回复；是机器人自动回复的，这一轮不算
 *   （不是人回的）；后面还没有我方消息的是「还没回」。
 * - 一轮的开始落在本时间段内才算，回复可以晚于时间段结束。
 *
 * 实现：只看本时间段内有客户消息（不含导入的）的会话（messages_direction_ts），逐个会话按 messages_conv 取它的消息
 * （CROSS JOIN 定死顺序，+m.direction 不让它改走按方向的索引）；LAG 标出每一轮的开头和结尾，只留这些行再用 LEAD 把
 * 开头和后面紧跟的结尾配成一对。按号、按业务员筛选在选会话这一步。
 * @param {string|null} asg 按业务员筛选（assigneeScope）
 */
export function replyTurnsSql(asg) {
  const S = assigneeScope(asg);
  return `
WITH convs AS (
  SELECT DISTINCT m.conversation_id AS id FROM messages m JOIN conversations c ON c.id = m.conversation_id
   WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')} AND ${S.col('c.assignee_id')}
),
line AS (
  SELECT m.conversation_id AS cid, m.ts, m.seq, m.via, m.sent_by_user_id AS uid, m.sent_by_name AS uname,
         CASE WHEN m.direction = 'in' THEN 'c' WHEN m.author IN ('operator', 'owner') THEN 'h' ELSE 'b' END AS k
    FROM convs v CROSS JOIN messages m ON m.conversation_id = v.id
   WHERE COALESCE(m.via, '') NOT IN ('import', 'campaign')
     AND ((+m.direction = 'in' AND m.author = 'customer') OR (+m.direction = 'out' AND m.status = 'sent'))
),
marked AS (
  SELECT *, LAG(k) OVER (PARTITION BY cid ORDER BY ts, seq) AS pk FROM line
),
edges AS (
  SELECT * FROM marked WHERE (k = 'c' AND (pk IS NULL OR pk <> 'c')) OR (k <> 'c' AND pk = 'c')
),
paired AS (
  SELECT k, ts, LEAD(ts) OVER w AS rts, LEAD(k) OVER w AS rk, LEAD(via) OVER w AS rvia, LEAD(uid) OVER w AS ruid, LEAD(uname) OVER w AS runame
    FROM edges WINDOW w AS (PARTITION BY cid ORDER BY ts, seq)
)
SELECT ts AS start, rts AS reply, rk AS kind, rvia AS via, ruid AS userId, runame AS userName
  FROM paired WHERE k = 'c' AND ts >= @from AND ts <= @to`;
}

/**
 * 本时间段内开始的每一轮：{start, reply, kind, via, userId, userName}。kind：h 人工回复、b 机器人先回了（不算）、
 * null 还没回（reply 也是 null）。via、userId、userName 是那条回复的。
 * @param {import('better-sqlite3').Database} db
 * @param {{from:string, to:string, acc:string|null, asg?:string|null}} P
 */
export function replyTurns(db, P) {
  return db.prepare(replyTurnsSql(P.asg)).all({ from: P.from, to: P.to, acc: P.acc, ...(P.asg ? { asg: P.asg } : {}) });
}

/** 一组等待分钟数 → {avgReplyMinutes, medianReplyMinutes, replyTurns}，没有时平均和中位都是 null */
function replyStats(minutes) {
  return {
    avgReplyMinutes: minutes.length ? Math.round((minutes.reduce((a, b) => a + b, 0) / minutes.length) * 100) / 100 : null,
    medianReplyMinutes: median(minutes),
    replyTurns: minutes.length,
  };
}

/**
 * replyTurns 的结果汇总：全部的平均、中位，还没回的轮数；按回复人分：后台成员（userId）、手机回复、WhatsApp 转发。
 * 等待时间小于 0（手机和服务器时间差一点）按 0 算。
 */
export function summarizeReplyTurns(turns) {
  const all = [];
  const byUser = new Map();
  const names = new Map();
  const phone = [];
  const relay = [];
  let unreplied = 0;
  for (const t of turns) {
    if (!t.kind) {
      unreplied++;
      continue;
    }
    if (t.kind !== 'h') continue;
    const min = Math.max(0, (Date.parse(t.reply) - Date.parse(t.start)) / 60000);
    if (!Number.isFinite(min)) continue;
    all.push(min);
    if (t.via === 'phone') phone.push(min);
    else if (t.via === 'whatsapp') relay.push(min);
    else if (t.userId) {
      if (!byUser.has(t.userId)) byUser.set(t.userId, []);
      byUser.get(t.userId).push(min);
      if (t.userName) names.set(t.userId, t.userName);
    }
  }
  const of = (list) => replyStats(list || []);
  return { total: { ...of(all), unrepliedTurns: unreplied }, user: (id) => of(byUser.get(id)), userIds: [...byUser.keys()], names, phone: of(phone), relay: of(relay) };
}

// ---------------- 看板 ----------------

/**
 * @param {any} ctx
 * @param {{now?: () => number}} [opts] now 是测试注入的时钟
 */
export function createDashboard(ctx, opts = {}) {
  const { db } = ctx;
  const clock = opts.now || Date.now;

  /** 号的连接状态（和 /api/health 一样，取不到记 failed） */
  async function accountState(acc) {
    try {
      return (await ctx.wa.getStatus(acc, { maxAgeMs: ACCOUNT_STATE_MAX_AGE_MS, timeoutMs: 2000 })).state;
    } catch {
      return 'failed';
    }
  }

  /**
   * @param {{range:string, tz:string, accountId:string|null, assigneeId?:string|null}} q parseDashboardQuery 的结果
   */
  async function build({ range, tz, accountId, assigneeId = null }) {
    const nowMs = clock();
    const r = resolveRange(range, tz, nowMs);
    const S = assigneeScope(assigneeId);
    const P = {
      from: r.from,
      to: r.to,
      acc: accountId,
      asg: assigneeId,
      now: r.to,
      since30: new Date(nowMs - UNUSED_ENTRY_DAYS * 86400_000).toISOString(),
      pendingBefore: new Date(nowMs - DRAFT_PENDING_MS).toISOString(),
    };
    const all = (sql) => db.prepare(sql).all(P);
    const get = (sql) => db.prepare(sql).get(P);
    const toLocal = bucketMapper(tz);

    const accountList = ctx.accounts.list().filter((a) => !accountId || a.id === accountId);
    const accountNames = new Map(ctx.accounts.list().map((a) => [a.id, a.name]));
    // 连接状态要问 WAHA，和下面的 SQL 并行
    const statesPromise = Promise.all(accountList.map(accountState));

    // ---- 入站消息：总数、按号、热力图（一次按号 + 桶聚合） ----
    const inboundRows = all(
      `SELECT c.account_id AS acc, ${bucketOf('m.ts')} AS b, COUNT(*) AS n
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')} AND ${S.col('c.assignee_id')}
        GROUP BY c.account_id, b`,
    );
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    const inboundByAccount = new Map();
    let inboundMessages = 0;
    for (const row of inboundRows) {
      inboundMessages += row.n;
      inboundByAccount.set(row.acc, (inboundByAccount.get(row.acc) || 0) + row.n);
      const t = toLocal(row.b);
      heatmap[t.weekday][t.hour] += row.n;
    }

    // ---- 新客户：会话里最早的一条客户消息落在本时间段内，并且不是导入的 ----
    // 只看本时间段内有实时入站消息的会话；最早那条按全部客户消息（含导入的）取，导入过历史聊天的老客户不算新客户。
    // f.via 是 MIN(f.ts) 那一行的值（SQLite 的聚合裸列语义）
    const newCustomers = get(
      `SELECT COUNT(*) AS n FROM (
         SELECT MIN(f.ts) AS first_ts, f.via AS first_via
           FROM messages f
          WHERE f.direction = 'in' AND f.author = 'customer'
            AND f.conversation_id IN (
              SELECT m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
               WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')} AND ${S.col('c.assignee_id')})
          GROUP BY f.conversation_id)
        WHERE first_ts >= @from AND COALESCE(first_via, '') <> 'import'`,
    ).n;

    // ---- 处理记录：按号、结果、code 计数 ----
    const decisionRows = all(
      `SELECT account_id AS acc, decision, code, COUNT(*) AS n FROM decisions
        WHERE ts >= @from AND ts <= @to AND ${accEq('account_id')} AND ${S.conv('conversation_id')}
        GROUP BY account_id, decision, code`,
    );
    const turns = { replied: 0, handoff: 0, blocked: 0, offtopic: 0 };
    const turnsByAccount = new Map();
    const reasons = new Map();
    const abuseOfftopic = new Map();
    const abuseBlocked = new Map();
    for (const row of decisionRows) {
      if (Object.hasOwn(turns, row.decision)) {
        turns[row.decision] += row.n;
        if (!turnsByAccount.has(row.acc)) turnsByAccount.set(row.acc, { replied: 0, handoff: 0, blocked: 0 });
        const ta = turnsByAccount.get(row.acc);
        if (Object.hasOwn(ta, row.decision)) ta[row.decision] += row.n;
      }
      if (row.decision === 'handoff' || row.decision === 'blocked') {
        const key = `${row.decision}|${row.code}`;
        const prev = reasons.get(key)?.count || 0;
        reasons.set(key, { code: row.code, label: codeLabel(row.decision, row.code), decision: row.decision, count: prev + row.n });
      }
      const abuse = row.decision === 'offtopic' ? abuseOfftopic : row.decision === 'blocked' ? abuseBlocked : null;
      if (abuse) abuse.set(row.code, (abuse.get(row.code) || 0) + row.n);
    }
    const rateOf = (t) => ratio(t.replied, t.replied + t.handoff + t.blocked);
    const byCount = (a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code));
    const codeCounts = (map, decision) =>
      [...map].map(([code, count]) => ({ code, label: codeLabel(decision, code), count })).sort(byCount);

    // ---- 每日趋势：按桶聚合后换算成当地日期 ----
    const trendMap = new Map(r.dates.map((date) => [date, { date, replied: 0, handoff: 0, blocked: 0, offtopic: 0 }]));
    for (const row of all(
      `SELECT decision, ${bucketOf('ts')} AS b, COUNT(*) AS n FROM decisions
        WHERE ts >= @from AND ts <= @to AND decision IN ('replied', 'handoff', 'blocked', 'offtopic') AND ${accEq('account_id')}
          AND ${S.conv('conversation_id')}
        GROUP BY decision, b`,
    )) {
      const day = trendMap.get(toLocal(row.b).date);
      if (day) day[row.decision] += row.n;
    }

    // ---- 转人工记录：本时间段内开始的 ----
    const handoffRows = all(
      `SELECT started_at, first_response_at, first_responder_kind AS kind, first_responder_user_id AS userId FROM handoffs
        WHERE started_at >= @from AND started_at <= @to AND ${accEq('account_id')} AND ${S.conv('conversation_id')}`,
    );
    const responseMinutes = (h) => Math.max(0, (Date.parse(h.first_response_at) - Date.parse(h.started_at)) / 60000);
    const responded = handoffRows.filter((h) => h.first_response_at && Number.isFinite(Date.parse(h.first_response_at)));

    // ---- 待处理（实时） ----
    const openByAccount = new Map(
      all(
        `SELECT account_id AS acc, COUNT(*) AS n FROM conversations
          WHERE needs_human = 1 AND ${accEq('account_id')} AND ${S.col('assignee_id')} GROUP BY account_id`,
      ).map(
        (row) => [row.acc, row.n],
      ),
    );
    const openNeedsHuman = [...openByAccount.values()].reduce((a, b) => a + b, 0);

    // ---- 平均回复时间：本时间段内开始的每一轮客户等人工回复（见 replyTurnsSql） ----
    const reply = summarizeReplyTurns(replyTurns(db, P));

    const kpi = {
      inboundMessages,
      newCustomers,
      autoReplyRate: rateOf(turns),
      turns,
      handoffs: handoffRows.length,
      openNeedsHuman,
      // 转人工到首次人工回复的中位数（只算转人工记录）
      medianResponseMinutes: median(responded.map(responseMinutes)),
      // 客户等人工回复的平均、中位分钟数，算了几轮（机器人先回了的不算），还有几轮还没人回
      ...reply.total,
    };

    const handoffReasons = [...reasons.values()].sort(byCount);

    // ---- 知识库（不按号筛选） ----
    const kb = {
      topGaps: all(
        `SELECT g.id AS gapId, g.question, COUNT(*) AS count FROM gap_hits h JOIN gaps g ON g.id = h.gap_id
          WHERE h.ts >= @from AND h.ts <= @to AND g.status = 'open'
          GROUP BY g.id ORDER BY count DESC, g.created_at LIMIT 10`,
      ),
      topEntries: all(
        `SELECT e.id AS entryId, e.title, COUNT(*) AS count
           FROM decisions d, ${jsonArr('d.used_entry_ids')} j JOIN entries e ON e.id = j.value
          WHERE d.decision = 'replied' AND d.ts >= @from AND d.ts <= @to
          GROUP BY e.id ORDER BY count DESC, e.title LIMIT 10`,
      ),
      // 最近 30 天任何一条处理记录都没引用过的启用中条目
      unusedEntries: get(
        `SELECT COUNT(*) AS n FROM entries WHERE status = 'active' AND id NOT IN (
           SELECT j.value FROM decisions d, ${jsonArr('d.used_entry_ids')} j WHERE d.ts >= @since30 AND j.value IS NOT NULL)`,
      ).n,
      activeEntries: get(`SELECT COUNT(*) AS n FROM entries WHERE status = 'active'`).n,
      lastRedteam: null,
      // 机器人发出的文件（decisions.sentFileIds）按本时间段计数；后台人工发的文件不在 decisions 里
      topFiles: all(
        `SELECT f.id AS fileId, f.name, COUNT(*) AS count
           FROM decisions d, ${jsonArr('d.sent_file_ids')} j JOIN files f ON f.id = j.value
          WHERE d.ts >= @from AND d.ts <= @to
          GROUP BY f.id ORDER BY count DESC, f.name LIMIT 5`,
      ),
    };
    const rt = get(`SELECT id, finished_at, summary FROM redteam_runs WHERE status = 'done' ORDER BY finished_at DESC LIMIT 1`);
    if (rt) {
      const s = safeJsonParse(rt.summary, {}) || {};
      kb.lastRedteam = {
        runId: rt.id,
        finishedAt: rt.finished_at,
        redlineFailed: Number(s.redlineFailed) || 0,
        legitRefused: Number(s.legitRefused) || 0,
      };
    }

    // ---- 客户线索：stages、funnel、countries 是当前的线索（不按时间段），products 按本时间段的回复 ----
    const stageCounts = new Map(
      all(`SELECT stage, COUNT(*) AS n FROM leads WHERE ${accEq('account_id')} AND ${S.conv('conversation_id')} GROUP BY stage`).map((x) => [
        x.stage,
        x.n,
      ]),
    );
    const stages = [
      ...Object.keys(LEAD_STAGES).map((stage) => ({ stage, label: leadStageLabel(stage), count: stageCounts.get(stage) || 0 })),
      ...[...stageCounts]
        .filter(([stage]) => !Object.hasOwn(LEAD_STAGES, stage))
        .map(([stage, count]) => ({ stage, label: leadStageLabel(stage), count })),
    ];
    // 每条线索到过的最高阶段（历史 + 当前阶段），-1 表示没进过漏斗
    const rankCase = (col) => `CASE ${col} ${FUNNEL_STAGES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE -1 END`;
    const funnelRow = get(
      `SELECT ${FUNNEL_STAGES.map((_, i) => `COALESCE(SUM(top >= ${i}), 0) AS r${i}`).join(', ')} FROM (
         SELECT lead_id, MAX(${rankCase('stage')}) AS top FROM (
           SELECT l.id AS lead_id, l.stage FROM leads l WHERE ${accEq('l.account_id')} AND ${S.conv('l.conversation_id')}
           UNION ALL
           SELECT h.lead_id, h.stage FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id
            WHERE ${accEq('l.account_id')} AND ${S.conv('l.conversation_id')})
         GROUP BY lead_id)`,
    );
    const funnel = FUNNEL_STAGES.map((stage, i) => ({ stage, label: leadStageLabel(stage), reached: funnelRow[`r${i}`] }));
    // 国家：按会话的联系人号码解析（先按号码合并再解析，号码少时很快）
    const countryCounts = new Map();
    for (const row of all(
      `SELECT COALESCE(c.contact_number, '') AS number, COUNT(*) AS n
         FROM leads l LEFT JOIN conversations c ON c.id = l.conversation_id
        WHERE ${accEq('l.account_id')} AND ${S.conv('l.conversation_id')} GROUP BY number`,
    )) {
      const code = countryOfNumber(row.number);
      countryCounts.set(code, (countryCounts.get(code) || 0) + row.n);
    }
    const countries = [...countryCounts]
      .map(([code, count]) => ({ code, name: code ? countryName(code) : UNKNOWN_COUNTRY, count }))
      .sort((a, b) => b.count - a.count || (a.code ? 0 : 1) - (b.code ? 0 : 1) || String(a.code).localeCompare(String(b.code)))
      .slice(0, 10);
    const products = all(
      `SELECT e.id AS entryId, e.title, COUNT(*) AS count
         FROM decisions d, ${jsonArr('d.used_entry_ids')} j JOIN entries e ON e.id = j.value
        WHERE d.decision = 'replied' AND e.type = 'product' AND d.ts >= @from AND d.ts <= @to AND ${accEq('d.account_id')}
          AND ${S.conv('d.conversation_id')}
        GROUP BY e.id ORDER BY count DESC, e.title LIMIT 10`,
    );

    // ---- 号码表 ----
    const states = await statesPromise;
    const accounts = accountList.map((a, i) => {
      const t = turnsByAccount.get(a.id) || { replied: 0, handoff: 0, blocked: 0 };
      return {
        id: a.id,
        name: a.name,
        state: states[i],
        inbound: inboundByAccount.get(a.id) || 0,
        autoReplyRate: rateOf(t),
        openNeedsHuman: openByAccount.get(a.id) || 0,
      };
    });

    // ---- 成员：按转人工记录的首次回复人统计，外加手机回复、WhatsApp 转发两行 ----
    // handled、medianResponseMinutes 是转人工记录的；avgReplyMinutes、medianReplyMinutes、replyTurns 是谁回的那一轮（后台按发送人）
    const manualRows = all(
      `SELECT m.sent_by_user_id AS userId, MAX(m.sent_by_name) AS name, COUNT(*) AS n
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'out' AND m.author = 'operator' AND m.via = 'admin' AND m.status = 'sent'
          AND m.sent_by_user_id IS NOT NULL AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')} AND ${S.col('c.assignee_id')}
        GROUP BY m.sent_by_user_id`,
    );
    const manualByUser = new Map(manualRows.map((x) => [x.userId, x]));
    const minutesBy = (pred) => responded.filter(pred).map(responseMinutes);
    const handledBy = (pred) => responded.filter(pred).length;
    const userStats = (userId) => {
      const isUser = (h) => h.kind === 'admin_ui' && h.userId === userId;
      return {
        handled: handledBy(isUser),
        medianResponseMinutes: median(minutesBy(isUser)),
        manualMessages: manualByUser.get(userId)?.n || 0,
        ...reply.user(userId),
      };
    };
    const users = db.prepare('SELECT id, email, name FROM users ORDER BY created_at, rowid').all();
    const known = new Set(users.map((u) => u.id));
    // 已经删掉的成员：期间有过首次回复、后台消息或回复过一轮的也列出来，名字取消息上记的发送人
    const goneIds = new Set([
      ...responded.filter((h) => h.kind === 'admin_ui' && h.userId && !known.has(h.userId)).map((h) => h.userId),
      ...manualRows.filter((x) => !known.has(x.userId)).map((x) => x.userId),
      ...reply.userIds.filter((id) => !known.has(id)),
    ]);
    const kindRow = (kind, responderKind) => {
      const pred = (h) => h.kind === responderKind;
      return {
        userId: null,
        name: RESPONDER_KINDS[responderKind],
        kind,
        handled: handledBy(pred),
        medianResponseMinutes: median(minutesBy(pred)),
        manualMessages: null,
        ...reply[kind],
      };
    };
    let members = [
      ...users.map((u) => ({ userId: u.id, name: u.name || u.email, kind: 'user', ...userStats(u.id) })),
      ...[...goneIds].map((id) => ({
        userId: id,
        name: manualByUser.get(id)?.name || reply.names.get(id) || DELETED_MEMBER_NAME,
        kind: 'user',
        ...userStats(id),
      })),
      kindRow('phone', 'phone'),
      kindRow('relay', 'whatsapp_relay'),
    ];
    // 按业务员筛选时只留这些会话里有动静的行（谁回过他的客户），选中的那个成员总留着
    if (assigneeId) {
      members = members.filter((m) => m.userId === assigneeId || m.handled > 0 || m.manualMessages > 0 || m.replyTurns > 0);
    }

    // ---- 成本（不按号筛选；和会话有关的调用按号筛，不属于任何号的调用照算） ----
    const cost = llmCostSummary(db, ctx.getSettings().pricing, P);

    // ---- 挡掉的白嫖 ----
    const abuse = {
      offtopic: codeCounts(abuseOfftopic, 'offtopic'),
      blocked: codeCounts(abuseBlocked, 'blocked'),
      // 实时：现在还在静默中的会话
      mutedConversations: get(
        `SELECT COUNT(*) AS n FROM conversations WHERE muted_until > @now AND ${accEq('account_id')} AND ${S.col('assignee_id')}`,
      ).n,
    };

    // ---- 外联：本时间段内发出的，回复、拒绝按这些人算 ----
    const outreachRows = all(
      `SELECT account_id AS acc, COUNT(*) AS sent, SUM(replied_at IS NOT NULL) AS replied, SUM(declined_at IS NOT NULL) AS declined
         FROM campaign_recipients
        WHERE status = 'sent' AND sent_at >= @from AND sent_at <= @to AND ${accEq('account_id')} AND ${S.conv('conversation_id')}
        GROUP BY account_id ORDER BY sent DESC, account_id`,
    );
    const sum = (k) => outreachRows.reduce((n, x) => n + x[k], 0);
    const sent = sum('sent');
    const outreach = {
      sent,
      replied: sum('replied'),
      replyRate: ratio(sum('replied'), sent),
      declined: sum('declined'),
      declineRate: ratio(sum('declined'), sent),
      byAccount: outreachRows.map((x) => ({
        accountId: x.acc,
        name: accountNames.get(x.acc) ?? DELETED_ACCOUNT_NAME,
        sent: x.sent,
        replied: x.replied,
        declined: x.declined,
      })),
    };

    // ---- 推荐回复采纳：本时间段内起草的（不按成员分；按业务员筛选时只算分给他的会话） ----
    const drafts = draftSummary(db, P, toLocal, r.dates);

    return {
      range: { from: r.from, to: r.to, tz },
      kpi,
      handoffReasons,
      kb,
      leads: { stages, funnel, countries, products },
      trend: [...trendMap.values()],
      accounts,
      members,
      cost,
      abuse,
      heatmap,
      outreach,
      drafts,
    };
  }

  /**
   * 推荐回复列表（改得多的和没用的）：本时间段内起草的，最新的在前，一页 limit 条。每条带客户的问题、草稿、实际发出的文字、
   * 引用的条目、建议的文件和发出的那条消息（能不能「存进知识库」）。
   * @param {ReturnType<typeof parseDraftListQuery>} q
   * @returns {{items:any[], nextCursor:string|null}}
   */
  function listDrafts({ range, tz, accountId, assigneeId = null, filter, cursor, limit }) {
    const nowMs = clock();
    const r = resolveRange(range, tz, nowMs);
    const P = {
      from: r.from,
      to: r.to,
      acc: accountId,
      asg: assigneeId,
      pendingBefore: new Date(nowMs - DRAFT_PENDING_MS).toISOString(),
      cAt: cursor?.at ?? null,
      cId: cursor?.id ?? null,
      limit: limit + 1,
    };
    const wanted = DRAFT_LIST_FILTERS[filter].map((o) => `'${o}'`).join(', ');
    const rows = db
      .prepare(
        `SELECT d.*, ${DRAFT_OC('d.')} AS oc, c.id AS conv_exists, c.contact_name, c.contact_number
           FROM draft_outcomes d LEFT JOIN conversations c ON c.id = d.conversation_id
          WHERE d.created_at >= @from AND d.created_at <= @to AND ${accEq('d.account_id')} AND ${assigneeScope(assigneeId).conv('d.conversation_id')}
            AND ${DRAFT_OC('d.')} IN (${wanted})
            AND (@cAt IS NULL OR d.created_at < @cAt OR (d.created_at = @cAt AND d.id < @cId))
          ORDER BY d.created_at DESC, d.id DESC LIMIT @limit`,
      )
      .all(P);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const arr = (v) => {
      const x = safeJsonParse(v, []);
      return Array.isArray(x) ? x.filter((id) => typeof id === 'string') : [];
    };
    const lookup = (sql, ids) => (ids.size ? new Map(db.prepare(sql).all(JSON.stringify([...ids])).map((x) => [x.id, x])) : new Map());
    const entryIds = new Set(page.flatMap((x) => arr(x.entry_ids)));
    const fileIds = new Set(page.flatMap((x) => arr(x.file_ids)));
    const msgIds = new Set(page.map((x) => x.sent_message_id).filter(Boolean));
    const entries = lookup('SELECT id, title FROM entries WHERE id IN (SELECT value FROM json_each(?))', entryIds);
    const files = lookup('SELECT id, name FROM files WHERE id IN (SELECT value FROM json_each(?))', fileIds);
    const msgs = lookup('SELECT id, author, text, revoked_at FROM messages WHERE id IN (SELECT value FROM json_each(?))', msgIds);
    const accountNames = new Map(ctx.accounts.list().map((a) => [a.id, a.name]));
    const items = page.map((x) => {
      const sentFiles = new Set(arr(x.sent_file_ids));
      const m = x.sent_message_id ? msgs.get(x.sent_message_id) : null;
      return {
        id: x.id,
        conversationId: x.conversation_id,
        conversationExists: !!x.conv_exists,
        contactName: x.contact_name || '',
        contactNumber: x.contact_number || '',
        accountId: x.account_id,
        accountName: x.account_id ? accountNames.get(x.account_id) ?? DELETED_ACCOUNT_NAME : null,
        kind: x.kind,
        kindLabel: DRAFT_KINDS[x.kind] || x.kind,
        followUp: !!x.follow_up,
        createdAt: x.created_at,
        question: x.question,
        text: x.text,
        entries: arr(x.entry_ids).map((id) => ({ id, title: entries.get(id)?.title ?? null, deleted: !entries.has(id) })),
        files: arr(x.file_ids).map((id) => ({ id, name: files.get(id)?.name ?? null, deleted: !files.has(id), sent: sentFiles.has(id) })),
        outcome: x.oc,
        outcomeLabel: DRAFT_OUTCOMES[x.oc] || x.oc,
        outcomeAt: x.outcome_at,
        editRatio: x.edit_ratio,
        sentText: x.sent_text,
        // 发出的那条人工消息：撤回了的结果照旧，只是不能再存进知识库
        sentMessage: m
          ? {
              id: m.id,
              revoked: !!m.revoked_at,
              canSaveToKb: m.author === 'operator' && !m.revoked_at && !!String(m.text || '').trim() && !!x.conv_exists,
            }
          : null,
        model: x.model,
        promptVersion: x.prompt_version,
      };
    });
    const last = page[page.length - 1];
    return { items, nextCursor: more && last ? `${last.created_at}|${last.id}` : null };
  }

  return { build, listDrafts };
}
