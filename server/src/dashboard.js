// F12 管理员数据看板：GET /api/dashboard 一次返回全部数据（结构和各字段的算法见 SPEC-phase2 F12「接口」）。
// 只读已经记下的表（decisions、llm_calls、handoffs、messages、leads、campaign_recipients…），不调模型。
//
// 时间：时间段和日期分组都按请求的 tz（IANA 时区）。SQLite 不认识 IANA 时区，所以 SQL 先按 UTC 的 15 分钟分桶聚合，
// 再在 JS 里用 Intl 把每个桶换算成当地的日期、星期和小时。现行时区的偏移和夏令时切换都是 15 分钟的整数倍，
// 一个桶里的记录在当地一定落在同一天、同一小时。30 天最多 2880 个桶，不在 JS 里遍历消息。
//
// 导入的历史消息（messages.via = 'import'）不算入站消息、不算新客户、不进热力图：时间是旧的，也不是服务期间收到的。
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { DELETED_ACCOUNT_NAME } from './accounts.js';
import { codeLabel, LEAD_STAGES, leadStageLabel, LLM_PURPOSES, purposeLabel, RESPONDER_KINDS } from './codes.js';
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

/**
 * 校验查询参数。range 不传按 7d，不是 today|7d|30d 返回 400；tz 不传按 UTC，传了但 Intl 不认识返回 400；
 * accountId 不传或为空表示全部号（号删了也照样按它筛，数据还在）。
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
  return { range, tz, accountId };
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
const bucketOf = (col) => `CAST(strftime('%s', ${col}) AS INTEGER) / ${BUCKET_SECONDS}`;
// 入站消息：客户发的，不含导入的历史消息（助手的概况工具 assistant/tools.js 用同一个口径）
export const INBOUND = (m) => `${m}.direction = 'in' AND ${m}.author = 'customer' AND COALESCE(${m}.via, '') <> 'import'`;

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
   * @param {{range:string, tz:string, accountId:string|null}} q parseDashboardQuery 的结果
   */
  async function build({ range, tz, accountId }) {
    const nowMs = clock();
    const r = resolveRange(range, tz, nowMs);
    const P = {
      from: r.from,
      to: r.to,
      acc: accountId,
      now: r.to,
      since30: new Date(nowMs - UNUSED_ENTRY_DAYS * 86400_000).toISOString(),
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
        WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')}
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
               WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')})
          GROUP BY f.conversation_id)
        WHERE first_ts >= @from AND COALESCE(first_via, '') <> 'import'`,
    ).n;

    // ---- 处理记录：按号、结果、code 计数 ----
    const decisionRows = all(
      `SELECT account_id AS acc, decision, code, COUNT(*) AS n FROM decisions
        WHERE ts >= @from AND ts <= @to AND ${accEq('account_id')}
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
        GROUP BY decision, b`,
    )) {
      const day = trendMap.get(toLocal(row.b).date);
      if (day) day[row.decision] += row.n;
    }

    // ---- 转人工记录：本时间段内开始的 ----
    const handoffRows = all(
      `SELECT started_at, first_response_at, first_responder_kind AS kind, first_responder_user_id AS userId FROM handoffs
        WHERE started_at >= @from AND started_at <= @to AND ${accEq('account_id')}`,
    );
    const responseMinutes = (h) => Math.max(0, (Date.parse(h.first_response_at) - Date.parse(h.started_at)) / 60000);
    const responded = handoffRows.filter((h) => h.first_response_at && Number.isFinite(Date.parse(h.first_response_at)));

    // ---- 待处理（实时） ----
    const openByAccount = new Map(
      all(`SELECT account_id AS acc, COUNT(*) AS n FROM conversations WHERE needs_human = 1 AND ${accEq('account_id')} GROUP BY account_id`).map(
        (row) => [row.acc, row.n],
      ),
    );
    const openNeedsHuman = [...openByAccount.values()].reduce((a, b) => a + b, 0);

    const kpi = {
      inboundMessages,
      newCustomers,
      autoReplyRate: rateOf(turns),
      turns,
      handoffs: handoffRows.length,
      openNeedsHuman,
      medianResponseMinutes: median(responded.map(responseMinutes)),
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
    const stageCounts = new Map(all(`SELECT stage, COUNT(*) AS n FROM leads WHERE ${accEq('account_id')} GROUP BY stage`).map((x) => [x.stage, x.n]));
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
           SELECT l.id AS lead_id, l.stage FROM leads l WHERE ${accEq('l.account_id')}
           UNION ALL
           SELECT h.lead_id, h.stage FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id WHERE ${accEq('l.account_id')})
         GROUP BY lead_id)`,
    );
    const funnel = FUNNEL_STAGES.map((stage, i) => ({ stage, label: leadStageLabel(stage), reached: funnelRow[`r${i}`] }));
    // 国家：按会话的联系人号码解析（先按号码合并再解析，号码少时很快）
    const countryCounts = new Map();
    for (const row of all(
      `SELECT COALESCE(c.contact_number, '') AS number, COUNT(*) AS n
         FROM leads l LEFT JOIN conversations c ON c.id = l.conversation_id
        WHERE ${accEq('l.account_id')} GROUP BY number`,
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
    const manualRows = all(
      `SELECT m.sent_by_user_id AS userId, MAX(m.sent_by_name) AS name, COUNT(*) AS n
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'out' AND m.author = 'operator' AND m.via = 'admin' AND m.status = 'sent'
          AND m.sent_by_user_id IS NOT NULL AND m.ts >= @from AND m.ts <= @to AND ${accEq('c.account_id')}
        GROUP BY m.sent_by_user_id`,
    );
    const manualByUser = new Map(manualRows.map((x) => [x.userId, x]));
    const minutesBy = (pred) => responded.filter(pred).map(responseMinutes);
    const handledBy = (pred) => responded.filter(pred).length;
    const userStats = (userId) => {
      const isUser = (h) => h.kind === 'admin_ui' && h.userId === userId;
      return { handled: handledBy(isUser), medianResponseMinutes: median(minutesBy(isUser)), manualMessages: manualByUser.get(userId)?.n || 0 };
    };
    const users = db.prepare('SELECT id, email, name FROM users ORDER BY created_at, rowid').all();
    const known = new Set(users.map((u) => u.id));
    // 已经删掉的成员：期间有过首次回复或后台消息的也列出来，名字取消息上记的发送人
    const goneIds = new Set([
      ...responded.filter((h) => h.kind === 'admin_ui' && h.userId && !known.has(h.userId)).map((h) => h.userId),
      ...manualRows.filter((x) => !known.has(x.userId)).map((x) => x.userId),
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
      };
    };
    const members = [
      ...users.map((u) => ({ userId: u.id, name: u.name || u.email, kind: 'user', ...userStats(u.id) })),
      ...[...goneIds].map((id) => ({
        userId: id,
        name: manualByUser.get(id)?.name || DELETED_MEMBER_NAME,
        kind: 'user',
        ...userStats(id),
      })),
      kindRow('phone', 'phone'),
      kindRow('relay', 'whatsapp_relay'),
    ];

    // ---- 成本（不按号筛选；和会话有关的调用按号筛，不属于任何号的调用照算） ----
    const cost = llmCostSummary(db, ctx.getSettings().pricing, P);

    // ---- 挡掉的白嫖 ----
    const abuse = {
      offtopic: codeCounts(abuseOfftopic, 'offtopic'),
      blocked: codeCounts(abuseBlocked, 'blocked'),
      // 实时：现在还在静默中的会话
      mutedConversations: get(`SELECT COUNT(*) AS n FROM conversations WHERE muted_until > @now AND ${accEq('account_id')}`).n,
    };

    // ---- 外联：本时间段内发出的，回复、拒绝按这些人算 ----
    const outreachRows = all(
      `SELECT account_id AS acc, COUNT(*) AS sent, SUM(replied_at IS NOT NULL) AS replied, SUM(declined_at IS NOT NULL) AS declined
         FROM campaign_recipients
        WHERE status = 'sent' AND sent_at >= @from AND sent_at <= @to AND ${accEq('account_id')}
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
    };
  }

  return { build };
}
