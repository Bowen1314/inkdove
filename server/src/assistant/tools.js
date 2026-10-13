// 首页 AI 助手的只读工具（assistant/agent.js 按模型的调用执行）。权限全部在这里按现有的判断过滤，模型拿不到超出权限的数据：
// - 会话、消息、线索按 auth.js 的 conversationScope / canAccessConversation（和会话列表、会话详情、线索接口同一套条件）：
//   管理员看全部；业务员只看分给自己、而且有这个号权限的会话；
// - 号按 canAccessAccount；成员和模型费用只有管理员能用（业务员拿到的工具列表里没有，硬调也返回没有权限）；
// - 知识库、产品资料库所有登录的人本来都能看（和 /api/kb/entries、/api/files 一样），只给启用中的。
// 工具不改任何数据、不发消息。
//
// 返回给模型的是 JSON 文字：所有字符串都过 escapeUntrusted（客户名字、线索字段、消息、条目……），客户发的消息再套上
// <customer_message>…</customer_message>（和回复提示词的包装一样），system prompt 写明这些是数据不是指令。
// 结果里的会话、知识条目、文件不给真实 id，给这次提问内的编号 ref（c1、e1、f1，见 createRefRegistry），回答只能引用这些编号。
// 结果超过 TOOL_RESULT_MAX_CHARS 时截断并告诉模型缩小范围；列表都有条数上限，先在数据层面少取。
import { DELETED_ACCOUNT_NAME } from '../accounts.js';
import { canAccessAccount, canAccessConversation, conversationScope, rowToUser } from '../auth.js';
import { LEAD_STAGES, leadStageLabel } from '../codes.js';
import { INBOUND, llmCostSummary, localDayStart, zonedParts } from '../dashboard.js';
import { fileSearchText } from '../files/store.js';
import { selectEntries } from '../kb/retrieve.js';
import { bm25Rank } from '../kb/search.js';
import { escapeUntrusted } from '../reply/prompts.js';
import { HttpError, clip, isPlainObject, safeJsonParse } from '../util.js';
import { assignedCounts } from '../wa/assign.js';

/** 一个工具结果最多多少字符（JSON 文字），超了截断 */
export const TOOL_RESULT_MAX_CHARS = 8000;
/** 按日期查时最多跨多少天 */
export const MAX_RANGE_DAYS = 92;
/** 知识库检索：返回的条目最多多少字、多少条（知识库总共不超过这么多字时全给） */
export const KB_RESULT_CHARS = 6000;
export const KB_RESULT_TOP_K = 8;
const LIST_DEFAULT = 10;
const LIST_MAX = 20;
const MESSAGES_DEFAULT = 20;
const MESSAGES_MAX = 40;
const MESSAGE_CHARS = 500;
/** 号的连接状态缓存多久（同看板） */
const ACCOUNT_STATE_MAX_AGE_MS = 30_000;

const ENTRY_TYPE_LABEL = { faq: '常见问答', product: '产品服务', policy: '政策条款', fact: '基本信息' };
const STATE_LABEL = {
  not_configured: '未连接',
  stopped: '已停止',
  starting: '正在启动',
  scan_qr: '等待扫码',
  working: '已连接',
  failed: '连接失败',
  configured: '已配置',
};
const CHANNEL_LABEL = { waha: '扫码连接', meta: 'Meta 官方接口' };
const REPLY_MODE_LABEL = { off: '人工回复', auto: '自动回复' };
const UNASSIGNED = '未分配';
const DELETED_MEMBER = '已删除的成员';

/** 工具参数不对、没权限之类：作为出错的工具结果告诉模型（模型可以改了再调） */
export class ToolError extends Error {}

// ---------------- 编号 ----------------

const REF_PREFIX = { conversation: 'c', entry: 'e', file: 'f' };

/**
 * 一次提问内的编号表：工具结果里出现的会话、条目、文件按出现顺序编成 c1、e1、f1……，同一个对象只编一次。
 * 回答里的 [[c1]] 只认这里有的编号（agent.js 收尾时再核对一遍权限）。
 */
export function createRefRegistry() {
  const byKey = new Map();
  const byId = new Map();
  const counters = { conversation: 0, entry: 0, file: 0 };
  return {
    /** @param {'conversation'|'entry'|'file'} kind */
    add(kind, id, label) {
      const k = `${kind}:${id}`;
      let key = byId.get(k);
      if (!key) {
        key = `${REF_PREFIX[kind]}${++counters[kind]}`;
        byId.set(k, key);
        byKey.set(key, { key, kind, id, label: clip(String(label ?? '').trim(), 80) });
      }
      return key;
    },
    /** @returns {{key:string, kind:string, id:string, label:string}|null} */
    get(key) {
      return byKey.get(String(key ?? '').trim()) || null;
    },
  };
}

// ---------------- 小工具 ----------------

/** 客户发的话：escDeep 时套上 <customer_message> */
class CustomerText {
  constructor(text) {
    this.text = String(text ?? '');
  }
}
const fromCustomer = (t) => new CustomerText(t);

/** 所有字符串过 escapeUntrusted；客户的话再套上 <customer_message>…</customer_message> */
export function escDeep(v) {
  if (v instanceof CustomerText) return `<customer_message>${escapeUntrusted(v.text)}</customer_message>`;
  if (typeof v === 'string') return escapeUntrusted(v);
  if (Array.isArray(v)) return v.map(escDeep);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escDeep(x)]));
  return v;
}

/** 超长截断，告诉模型怎么办 */
export function capResult(s, max = TOOL_RESULT_MAX_CHARS) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（结果太长，后面的已截掉。请缩小范围再查，比如加日期、号、关键词，或者把 limit 调小）`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = ({ y, m, d }) => `${y}-${pad2(m)}-${pad2(d)}`;

/** 某一刻在 tz 的日期 YYYY-MM-DD */
export const localDate = (ms, tz) => ymdOf(zonedParts(ms, tz));

/** ISO 时间 → tz 的「YYYY-MM-DD HH:mm」，空的返回空串 */
export function fmtLocal(iso, tz) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const p = zonedParts(ms, tz);
  return `${ymdOf(p)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

function parseYmd(s, field) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  const v = m && { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (!v || ymdOf(addDays(v, 0)) !== ymdOf(v)) throw new ToolError(`${field} 要写成 YYYY-MM-DD 的日期，比如 2026-10-01`);
  return v;
}

function addDays({ y, m, d }, n) {
  const u = new Date(Date.UTC(y, m - 1, d + n));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
}

const dayNumber = ({ y, m, d }) => Date.UTC(y, m - 1, d) / 86400_000;

/** 给进度显示用的日期说法：今天、昨天、10月3日、10月1日–10月7日 */
function rangeLabel(startDate, endDate, today) {
  const one = (s) => {
    if (s === today) return '今天';
    if (s === ymdOf(addDays(parseYmd(today, 'today'), -1))) return '昨天';
    const [, m, d] = s.split('-').map(Number);
    return `${m}月${d}日`;
  };
  return startDate === endDate ? one(startDate) : `${one(startDate)}–${one(endDate)}`;
}

/**
 * start_date / end_date（用户时区的 YYYY-MM-DD）→ 时间段。都不填是今天；只填一个就是那一天；最多 MAX_RANGE_DAYS 天。
 * 结束时间取 end_date 当天最后一刻和现在里早的那个（和看板一样算到现在）。
 */
export function resolveDates(args, env) {
  const today = localDate(env.nowMs, env.tz);
  const s = optStr(args, 'start_date', 20);
  const e = optStr(args, 'end_date', 20);
  const start = parseYmd(s || e || today, s ? 'start_date' : 'end_date');
  const end = parseYmd(e || s || today, e ? 'end_date' : 'start_date');
  const days = dayNumber(end) - dayNumber(start) + 1;
  if (days < 1) throw new ToolError('end_date 不能早于 start_date');
  if (days > MAX_RANGE_DAYS) throw new ToolError(`一次最多查 ${MAX_RANGE_DAYS} 天，请把时间段缩短`);
  const fromMs = localDayStart(start.y, start.m, start.d, env.tz);
  if (fromMs > env.nowMs) throw new ToolError('开始日期还没到');
  const endNext = addDays(end, 1);
  const toMs = Math.min(localDayStart(endNext.y, endNext.m, endNext.d, env.tz) - 1, env.nowMs);
  const startDate = ymdOf(start);
  const endDate = ymdOf(end);
  return {
    startDate,
    endDate,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    label: rangeLabel(startDate, endDate, today),
  };
}

function optStr(args, key, max = 200) {
  const v = args?.[key];
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new ToolError(`${key} 必须是字符串`);
  return String(v).trim().slice(0, max);
}

function optEnum(args, key, values, def) {
  const v = optStr(args, key, 40);
  if (!v) return def;
  if (!values.includes(v)) throw new ToolError(`${key} 只能是 ${values.join('、')} 之一`);
  return v;
}

function optInt(args, key, min, max, def) {
  const v = args?.[key];
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolError(`${key} 必须是整数`);
  return Math.min(max, Math.max(min, n));
}

/** account_id 参数：不存在、没权限都按同一句话拒绝 */
function accountOf(env, args) {
  const id = optStr(args, 'account_id', 200);
  if (!id) return null;
  const acc = env.ctx.accounts.get(id);
  if (!acc || !canAccessAccount(env.user, id)) {
    throw new ToolError('没有这个号，或者你没有这个号的权限。先用 list_accounts 查能看的号和它们的 id');
  }
  return acc;
}

/**
 * 会话的可见范围写成 SQL 条件（和 wa/service.js 的 listConversations、leads/store.js 的 list 同一套：
 * agent 是 assignee_id = 自己 AND account_id IN 自己的号；admin 不限）。alias 是 conversations 表的别名
 */
function scopeSql(user, alias) {
  const s = conversationScope(user);
  if (s.accountIds === null && s.assigneeId === null) return { sql: '1 = 1', params: {} };
  if (!s.accountIds.length) return { sql: '0 = 1', params: {} };
  const params = { scope_me: s.assigneeId };
  s.accountIds.forEach((id, i) => (params[`scope_a${i}`] = id));
  const list = s.accountIds.map((_, i) => `@scope_a${i}`).join(', ');
  return { sql: `(${alias}.assignee_id = @scope_me AND ${alias}.account_id IN (${list}))`, params };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** 会话的显示名：联系人名字，没有就用号码 */
export const contactLabel = (name, number) => name || (number ? `+${number}` : '未知联系人');

function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 消息是谁说的 */
function authorLabel(m) {
  if (m.author === 'customer') return '客户';
  if (m.author === 'bot') return '机器人';
  if (m.author === 'owner') return '手机回复';
  return m.sent_by_name ? `同事 ${m.sent_by_name}` : '人工';
}

/** 消息正文：没文字的用附件名 */
function messageText(m) {
  const text = String(m.text || '').trim();
  if (text) return clip(text, MESSAGE_CHARS);
  const att = safeJsonParse(m.attachment, null);
  return att?.filename ? `[文件] ${att.filename}` : '';
}

/** 消息 → {from, text, time}，客户说的话标成不可信 */
function messageView(m, tz) {
  const text = messageText(m);
  return { from: authorLabel(m), text: m.author === 'customer' ? fromCustomer(text) : text, time: fmtLocal(m.ts, tz) };
}

// ---------------- 各工具 ----------------

/** 概况：口径和看板一致（dashboard.js），业务员只算自己能看的会话 */
function runOverview(env, args) {
  const { ctx, user } = env;
  const r = resolveDates(args, env);
  const acc = accountOf(env, args);
  const groupBy = optEnum(args, 'group_by', ['none', 'account', 'member'], 'none');
  if (groupBy === 'member' && user.role !== 'admin') throw new ToolError('只有管理员能按成员分组');
  const scope = scopeSql(user, 'c');
  const inner = scopeSql(user, 'c2');
  const P = { from: r.from, to: r.to, acc: acc?.id ?? null, now: new Date(env.nowMs).toISOString(), ...scope.params };
  const key = (accCol) => (groupBy === 'account' ? accCol : groupBy === 'member' ? 'c.assignee_id' : "''");
  const filter = (accCol) => `(@acc IS NULL OR ${accCol} = @acc) AND ${scope.sql}`;
  const all = (sql) => ctx.db.prepare(sql).all(P);

  const FIELDS = [
    'newCustomers',
    'activeConversations',
    'inboundMessages',
    'outboundBot',
    'outboundManual',
    'autoReplies',
    'handoffs',
    'suggestions',
    'pendingNow',
  ];
  /** @type {Map<string|null, Record<string, number>>} */
  const groups = new Map();
  const g = (k) => {
    const id = k === '' ? '' : k ?? null;
    if (!groups.has(id)) groups.set(id, Object.fromEntries(FIELDS.map((f) => [f, 0])));
    return groups.get(id);
  };
  const add = (rows, map) => {
    for (const row of rows) for (const [field, col] of Object.entries(map)) g(row.k)[field] += Number(row[col]) || 0;
  };
  if (groupBy === 'none') g('');

  // 客户发来的消息、有客户消息的会话（不含导入的历史消息）
  add(
    all(
      `SELECT ${key('c.account_id')} AS k, COUNT(*) AS n, COUNT(DISTINCT m.conversation_id) AS convs
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND ${filter('c.account_id')}
        GROUP BY k`,
    ),
    { inboundMessages: 'n', activeConversations: 'convs' },
  );
  // 新客户：同看板（dashboard.js 的 newCustomers）——会话里最早的一条客户消息落在这段时间内、而且不是导入的
  add(
    all(
      `SELECT k, COUNT(*) AS n FROM (
         SELECT ${key('c.account_id')} AS k, MIN(f.ts) AS first_ts, f.via AS first_via
           FROM messages f JOIN conversations c ON c.id = f.conversation_id
          WHERE f.direction = 'in' AND f.author = 'customer'
            AND f.conversation_id IN (
              SELECT m.conversation_id FROM messages m JOIN conversations c2 ON c2.id = m.conversation_id
               WHERE ${INBOUND('m')} AND m.ts >= @from AND m.ts <= @to AND (@acc IS NULL OR c2.account_id = @acc) AND ${inner.sql})
          GROUP BY f.conversation_id)
        WHERE first_ts >= @from AND COALESCE(first_via, '') <> 'import'
        GROUP BY k`,
    ),
    { newCustomers: 'n' },
  );
  // 我方发出去的消息：机器人 / 人工（后台、手机、转发），不含导入的
  add(
    all(
      `SELECT ${key('c.account_id')} AS k, SUM(m.author = 'bot') AS bot, SUM(m.author <> 'bot') AS manual
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'out' AND m.status = 'sent' AND COALESCE(m.via, '') <> 'import'
          AND m.ts >= @from AND m.ts <= @to AND ${filter('c.account_id')}
        GROUP BY k`,
    ),
    { outboundBot: 'bot', outboundManual: 'manual' },
  );
  // 机器人自动回复的轮数（处理记录 replied，同看板的 turns.replied）
  add(
    all(
      `SELECT ${key('d.account_id')} AS k, COUNT(*) AS n
         FROM decisions d LEFT JOIN conversations c ON c.id = d.conversation_id
        WHERE d.decision = 'replied' AND d.ts >= @from AND d.ts <= @to AND ${filter('d.account_id')}
        GROUP BY k`,
    ),
    { autoReplies: 'n' },
  );
  // 转人工：这段时间内开始的（同看板的 handoffs）
  add(
    all(
      `SELECT ${key('h.account_id')} AS k, COUNT(*) AS n
         FROM handoffs h LEFT JOIN conversations c ON c.id = h.conversation_id
        WHERE h.started_at >= @from AND h.started_at <= @to AND ${filter('h.account_id')}
        GROUP BY k`,
    ),
    { handoffs: 'n' },
  );
  // 生成推荐回复的次数（模型调用记录里 purpose = suggest、成功的）
  add(
    all(
      `SELECT ${key('l.account_id')} AS k, COUNT(*) AS n
         FROM llm_calls l LEFT JOIN conversations c ON c.id = l.conversation_id
        WHERE l.purpose = 'suggest' AND l.ok = 1 AND l.ts >= @from AND l.ts <= @to AND ${filter('l.account_id')}
        GROUP BY k`,
    ),
    { suggestions: 'n' },
  );
  // 现在还待处理的会话（实时）
  add(
    all(
      `SELECT ${key('c.account_id')} AS k, COUNT(*) AS n FROM conversations c
        WHERE c.needs_human = 1 AND ${filter('c.account_id')}
        GROUP BY k`,
    ),
    { pendingNow: 'n' },
  );

  const totals = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const v of groups.values()) for (const f of FIELDS) totals[f] += v[f];
  const out = {
    range: { start_date: r.startDate, end_date: r.endDate, until: fmtLocal(r.to, env.tz), tz: env.tz },
    scope: user.role === 'admin' ? '全部会话' : '只算分给你的会话（你有权限的号里）',
    account: acc ? acc.name : '全部号',
    totals,
  };
  if (groupBy !== 'none') {
    const names =
      groupBy === 'account'
        ? new Map(ctx.accounts.list().map((a) => [a.id, a.name]))
        : new Map(ctx.db.prepare('SELECT id, name, email FROM users').all().map((u) => [u.id, u.name || u.email]));
    out.groups = [...groups.entries()]
      .map(([k, v]) => ({
        name: k === null ? (groupBy === 'member' ? UNASSIGNED : DELETED_ACCOUNT_NAME) : names.get(k) ?? (groupBy === 'member' ? DELETED_MEMBER : DELETED_ACCOUNT_NAME),
        ...v,
      }))
      .sort((a, b) => b.inboundMessages - a.inboundMessages || b.pendingNow - a.pendingNow || String(a.name).localeCompare(String(b.name)))
      .slice(0, 50);
  }
  return out;
}

/** 会话列表：先按条件在 SQL 里取一页 id（带 LIMIT），再按 id 取会话详情 */
function runSearchConversations(env, args) {
  const { ctx, user, tz } = env;
  const scope = scopeSql(user, 'c');
  const conds = [scope.sql];
  const P = { ...scope.params };
  const acc = accountOf(env, args);
  if (acc) {
    conds.push('c.account_id = @acc');
    P.acc = acc.id;
  }
  const status = optEnum(args, 'status', ['all', 'pending', 'bot_paused', 'muted'], 'all');
  if (status === 'pending') conds.push('c.needs_human = 1');
  else if (status === 'bot_paused') conds.push('c.bot_paused = 1');
  else if (status === 'muted') {
    conds.push('c.muted_until > @now');
    P.now = new Date(env.nowMs).toISOString();
  }
  const assignee = optStr(args, 'assignee', 100);
  if (assignee) {
    // 同 GET /api/wa/conversations：业务员只能是自己（本来就只看得到自己的），none 和别人只有管理员能用
    if (user.role !== 'admin' && assignee !== 'me' && assignee !== user.id) {
      throw new ToolError('业务员只能查分给自己的会话（本来就只看得到这些），不用传 assignee');
    }
    if (assignee === 'none') conds.push('c.assignee_id IS NULL');
    else {
      conds.push('c.assignee_id = @asg');
      P.asg = assignee === 'me' ? user.id : assignee;
    }
  }
  const keyword = optStr(args, 'keyword', 100);
  if (keyword) {
    P.kw = `%${escapeLike(keyword)}%`;
    const digits = keyword.replace(/[\s+\-()]/g, '');
    P.kwnum = /^\d{3,}$/.test(digits) ? `%${digits}%` : P.kw;
    conds.push(
      `(c.contact_name LIKE @kw ESCAPE '\\' OR c.contact_number LIKE @kwnum ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM messages k WHERE k.conversation_id = c.id AND k.text LIKE @kw ESCAPE '\\'))`,
    );
  }
  let range = null;
  if (optStr(args, 'start_date', 20) || optStr(args, 'end_date', 20)) {
    range = resolveDates(args, env);
    conds.push('c.updated_at >= @from AND c.updated_at <= @to');
    P.from = range.from;
    P.to = range.to;
  }
  const limit = optInt(args, 'limit', 1, LIST_MAX, LIST_DEFAULT);
  const offset = optInt(args, 'offset', 0, 10_000, 0);
  const where = conds.join(' AND ');
  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where}`).get(P).n;
  const ids = ctx.db
    .prepare(`SELECT c.id FROM conversations c WHERE ${where} ORDER BY c.updated_at DESC, c.rowid DESC LIMIT @limit OFFSET @offset`)
    .all({ ...P, limit, offset })
    .map((x) => x.id);
  const hitStmt = keyword
    ? ctx.db.prepare(
        `SELECT author, direction, text, ts, sent_by_name, attachment FROM messages
          WHERE conversation_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 1`,
      )
    : null;
  const items = [];
  for (const id of ids) {
    const c = ctx.wa.getConversation(id);
    // 再按会话级权限判断一遍（和 SQL 条件是同一套，双保险）
    if (!c || !canAccessConversation(user, c)) continue;
    const name = contactLabel(c.contactName, c.contactNumber);
    const item = {
      ref: env.refs.add('conversation', c.id, name),
      name,
      number: c.contactNumber ? `+${c.contactNumber}` : '',
      account: c.accountName,
      assignee: c.assignee ? c.assignee.name || c.assignee.email : UNASSIGNED,
      pending: c.needsHuman,
      ...(c.pendingReason ? { pendingReason: clip(c.pendingReason, 150) } : {}),
      botPaused: c.botPaused,
      muted: !!c.mutedUntil,
      lastActive: fmtLocal(c.updatedAt, tz),
      lastMessage: c.lastMessage
        ? {
            from: c.lastMessage.direction === 'in' ? '客户' : '我方',
            text: c.lastMessage.direction === 'in' ? fromCustomer(clip(c.lastMessage.text, 200)) : clip(c.lastMessage.text, 200),
            time: fmtLocal(c.lastMessage.ts, tz),
          }
        : null,
    };
    if (hitStmt) {
      const hit = hitStmt.get(id, P.kw);
      if (hit) item.matched = messageView(hit, tz);
    }
    items.push(item);
  }
  return {
    total,
    ...(range ? { range: { start_date: range.startDate, end_date: range.endDate } } : {}),
    items,
    hasMore: offset + ids.length < total,
  };
}

/** 一个会话最近的聊天记录 */
function runConversationMessages(env, args) {
  const { ctx, user, tz } = env;
  const ref = env.refs.get(optStr(args, 'conversation', 40));
  if (!ref || ref.kind !== 'conversation') {
    throw new ToolError('不认识这个会话编号。先用 search_conversations（或 search_leads）查到会话，再把结果里的 ref（如 c1）传进来');
  }
  const c = ctx.wa.getConversation(ref.id);
  if (!c || !canAccessConversation(user, c)) throw new ToolError('找不到这个会话，或者你没有权限查看');
  const limit = optInt(args, 'limit', 1, MESSAGES_MAX, MESSAGES_DEFAULT);
  const rows = ctx.db
    .prepare(
      `SELECT * FROM (SELECT author, direction, text, ts, status, sent_by_name, attachment, seq FROM messages
         WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
    )
    .all(c.id, limit);
  const name = contactLabel(c.contactName, c.contactNumber);
  return {
    conversation: {
      ref: env.refs.add('conversation', c.id, name),
      name,
      number: c.contactNumber ? `+${c.contactNumber}` : '',
      account: c.accountName,
      assignee: c.assignee ? c.assignee.name || c.assignee.email : UNASSIGNED,
      pending: c.needsHuman,
      ...(c.pendingReason ? { pendingReason: clip(c.pendingReason, 150) } : {}),
      botPaused: c.botPaused,
    },
    messages: rows.map((m) => ({ ...messageView(m, tz), ...(m.status === 'failed' ? { failed: true } : {}) })),
  };
}

/** 客户线索（leads/store.js 的 list，可见范围同线索接口） */
function runSearchLeads(env, args) {
  const { ctx, user, tz } = env;
  const acc = accountOf(env, args);
  const stage = optEnum(args, 'stage', Object.keys(LEAD_STAGES), '');
  const keyword = optStr(args, 'keyword', 100);
  const limit = optInt(args, 'limit', 1, LIST_MAX, LIST_DEFAULT);
  const offset = optInt(args, 'offset', 0, 10_000, 0);
  const scope = conversationScope(user);
  const list = ctx.leads.list({ accountIds: scope.accountIds, assigneeId: scope.assigneeId, accountId: acc?.id ?? null, stage, q: keyword });
  return {
    total: list.length,
    items: list.slice(offset, offset + limit).map((l) => {
      const name = l.name || contactLabel(l.contactName, l.contactNumber);
      return {
        conversation: env.refs.add('conversation', l.conversationId, name),
        name: l.name,
        contactName: l.contactName,
        number: l.contactNumber ? `+${l.contactNumber}` : '',
        company: l.company,
        country: l.country,
        email: l.email,
        interest: l.interest,
        quantity: l.quantity,
        stage: leadStageLabel(l.stage),
        summary: clip(l.summary, 300),
        account: l.accountName,
        lastContact: fmtLocal(l.lastContactAt, tz),
      };
    }),
    hasMore: offset + limit < list.length,
  };
}

/** 知识库：和回复用同一套挑条目的规则（kb/retrieve.js，开了向量检索也会按意思搜），但限得更小、不调模型改写 */
async function runSearchKnowledge(env, args) {
  const query = optStr(args, 'query', 300);
  if (!query) throw new ToolError('query 必填：写要找的关键词或一句话');
  const { entries, mode } = await selectEntries(env.ctx, { texts: [query], limitChars: KB_RESULT_CHARS, topK: KB_RESULT_TOP_K, rewrite: false });
  return {
    mode,
    items: entries.map((e) => ({
      ref: env.refs.add('entry', e.id, e.title),
      type: ENTRY_TYPE_LABEL[e.type] || e.type,
      title: e.title,
      content: clip(e.content, 1500),
      tags: e.tags || [],
    })),
    ...(entries.length ? {} : { note: '没找到相关条目。可以换个说法，或者换成知识库用的语言（比如英文）再查' }),
  };
}

/** 产品资料库：按文件名、描述、标签检索（BM25，同回复挑文件的打分），不填 query 就按发送次数列常用的 */
function runSearchFiles(env, args) {
  const query = optStr(args, 'query', 200);
  const limit = optInt(args, 'limit', 1, LIST_MAX, LIST_DEFAULT);
  const files = env.ctx.files.activeFiles();
  let picked;
  if (query) {
    picked = bm25Rank(query, files, fileSearchText).map((r) => r.doc);
    if (!picked.length) {
      const needle = query.toLowerCase();
      picked = files.filter((f) => fileSearchText(f).toLowerCase().includes(needle));
    }
  } else {
    picked = [...files].sort((a, b) => b.sendCount - a.sendCount || String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  return {
    total: picked.length,
    items: picked.slice(0, limit).map((f) => ({
      ref: env.refs.add('file', f.id, f.name),
      name: f.name,
      filename: f.filename,
      type: f.mime,
      size: fmtSize(f.size),
      description: clip(f.description, 400),
      tags: f.tags || [],
      sendCount: f.sendCount,
    })),
  };
}

/** 能看的号和状态（连接状态缓存 30 秒，同看板） */
async function runListAccounts(env) {
  const { ctx, user } = env;
  const list = ctx.accounts.list().filter((a) => canAccessAccount(user, a.id));
  const states = await Promise.all(
    list.map((a) =>
      ctx.wa.getStatus(a, { maxAgeMs: ACCOUNT_STATE_MAX_AGE_MS, timeoutMs: 2000 }).then(
        (s) => s.state,
        () => 'failed',
      ),
    ),
  );
  return {
    items: list.map((a, i) => ({
      id: a.id,
      name: a.name,
      channel: CHANNEL_LABEL[a.channel] || a.channel,
      state: STATE_LABEL[states[i]] || states[i],
      replyMode: REPLY_MODE_LABEL[a.replyMode] || a.replyMode,
    })),
  };
}

/** 成员和分配（只有管理员） */
function runListMembers(env) {
  const { ctx, tz } = env;
  const users = ctx.db.prepare('SELECT * FROM users ORDER BY created_at, rowid').all().map(rowToUser);
  const assigned = assignedCounts(ctx.db);
  const pending = new Map(
    ctx.db
      .prepare('SELECT assignee_id AS id, COUNT(*) AS n FROM conversations WHERE assignee_id IS NOT NULL AND needs_human = 1 GROUP BY assignee_id')
      .all()
      .map((r) => [r.id, r.n]),
  );
  const accountNames = new Map(ctx.accounts.list().map((a) => [a.id, a.name]));
  return {
    items: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role === 'admin' ? '管理员' : '业务员',
      status: u.disabled ? '已停用' : u.pending ? '还没接受邀请' : '正常',
      accounts: u.role === 'admin' ? ['全部号'] : u.accountIds.map((id) => accountNames.get(id)).filter(Boolean),
      assignedConversations: assigned.get(u.id) || 0,
      pendingConversations: pending.get(u.id) || 0,
      lastLogin: fmtLocal(u.lastLoginAt, tz),
    })),
    unassignedConversations: ctx.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE assignee_id IS NULL').get().n,
  };
}

/** 模型用量和费用（只有管理员，口径同看板的 cost） */
function runUsageCost(env, args) {
  const r = resolveDates(args, env);
  const cost = llmCostSummary(env.ctx.db, env.ctx.getSettings().pricing, { from: r.from, to: r.to, acc: null });
  return {
    range: { start_date: r.startDate, end_date: r.endDate, until: fmtLocal(r.to, env.tz), tz: env.tz },
    calls: cost.calls,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    estimatedCostUsd: cost.estimatedCostUsd,
    byPurpose: cost.byPurpose.map((p) => ({
      label: p.label,
      calls: p.calls,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      costUsd: p.costUsd,
    })),
    note: '费用按「设置」里填的模型单价估算（美元），没配单价的模型不算钱',
  };
}

// ---------------- 工具定义 ----------------

const dateProps = {
  start_date: { type: 'string', description: '开始日期，用户时区的 YYYY-MM-DD；不填是今天' },
  end_date: { type: 'string', description: '结束日期（含这一天），YYYY-MM-DD；不填和 start_date 相同' },
};
const accountProp = { account_id: { type: 'string', description: '只看这个号（id 用 list_accounts 查）；不填是全部能看的号' } };
const limitProp = (def, max) => ({ type: 'integer', minimum: 1, maximum: max, description: `返回几条，1–${max}，默认 ${def}` });
const offsetProp = { type: 'integer', minimum: 0, description: '跳过前几条（翻页用），默认 0' };

const safeLabel = (fn) => (args, env) => {
  try {
    return clip(fn(isPlainObject(args) ? args : {}, env), 60);
  } catch {
    return '正在查询';
  }
};

/**
 * 全部工具。adminOnly 的只给管理员；label 是查询进度里显示的话。description 写清参数和返回什么（模型照着用）。
 * @type {{name:string, adminOnly?:boolean, description:(user:any) => string, parameters:(user:any) => any,
 *   label:(args:any, env:any) => string, run:(env:any, args:any) => any}[]}
 */
const TOOLS = [
  {
    name: 'get_overview',
    description: (user) =>
      `查一段时间的概况数字（口径和数据看板一致）。${
        user.role === 'admin' ? '管理员统计全部会话。' : '业务员只统计分给自己的会话。'
      }参数：start_date、end_date 是用户时区的日期，都不填是今天，最多 ${MAX_RANGE_DAYS} 天；account_id 只看某个号；group_by：none 只给合计，account 按号分${
        user.role === 'admin' ? '，member 按会话负责人分' : ''
      }。返回 totals：newCustomers 新客户数（会话里第一条客户消息落在这段时间内，导入的历史聊天不算）、activeConversations 这段时间有客户发消息的会话数、inboundMessages 客户发来的消息数、outboundBot 机器人发出的消息数、outboundManual 人工发出的消息数（后台、手机、转发都算）、autoReplies 机器人自动回复的轮数、handoffs 转人工次数、suggestions 生成推荐回复的次数、pendingNow 现在还待处理的会话数（实时，不受日期影响）；groups 是分组后的同样字段；range.until 是统计截止的时间。`,
    parameters: (user) => ({
      type: 'object',
      properties: {
        ...dateProps,
        ...accountProp,
        group_by: {
          type: 'string',
          enum: user.role === 'admin' ? ['none', 'account', 'member'] : ['none', 'account'],
          description: '分组方式，默认 none',
        },
      },
    }),
    label: safeLabel((args, env) => `正在查：${resolveDates(args, env).label}的概况数字`),
    run: runOverview,
  },
  {
    name: 'search_conversations',
    description: (user) =>
      `查会话（按最近活动时间倒序）。${
        user.role === 'admin' ? '' : '业务员只查得到分给自己的会话。'
      }参数：status：all 全部（默认）、pending 待处理（等人工回复）、bot_paused 机器人已暂停、muted 静默中；account_id 只看某个号；${
        user.role === 'admin' ? 'assignee：me 分给我的、none 未分配的、或成员 id（用 list_members 查）；' : ''
      }keyword 按客户名字、号码或聊天内容里的文字找；start_date、end_date 按最近活动的日期筛（用户时区 YYYY-MM-DD）；limit 每次几条（默认 ${LIST_DEFAULT}，最多 ${LIST_MAX}）；offset 翻页。返回 total 符合条件的总数，items：ref（会话编号，回答里写 [[ref]] 引用；查聊天记录时传给 get_conversation_messages）、name、number、account 所属的号、assignee 负责人、pending 是否待处理、pendingReason 待处理原因、botPaused、muted、lastActive 最近活动时间、lastMessage 最近一条消息（from 谁说的、text、time）、matched 命中 keyword 的那条消息；hasMore 表示还有更多。`,
    parameters: (user) => ({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'bot_paused', 'muted'], description: '会话状态，默认 all' },
        ...accountProp,
        ...(user.role === 'admin' ? { assignee: { type: 'string', description: 'me、none 或成员 id' } } : {}),
        keyword: { type: 'string', description: '按客户名字、号码或聊天内容里的文字找' },
        ...dateProps,
        limit: limitProp(LIST_DEFAULT, LIST_MAX),
        offset: offsetProp,
      },
    }),
    label: safeLabel((args) => {
      const kw = optStr(args, 'keyword', 30);
      const st = { pending: '待处理的', bot_paused: '机器人已暂停的', muted: '静默中的' }[optStr(args, 'status', 20)] || '';
      return kw ? `正在查：包含「${kw}」的${st}会话` : `正在查：${st}会话`;
    }),
    run: runSearchConversations,
  },
  {
    name: 'get_conversation_messages',
    description: () =>
      `看一个会话最近的聊天记录。参数：conversation 必填，是 search_conversations 或 search_leads 结果里的会话编号 ref（如 c1）；limit 取最近几条（默认 ${MESSAGES_DEFAULT}，最多 ${MESSAGES_MAX}）。返回 conversation（name、number、account、assignee、pending 等）和 messages（按时间从早到晚：from 谁说的——客户、机器人、同事某某、手机回复；text；time；failed 表示发送失败）。`,
    parameters: () => ({
      type: 'object',
      properties: {
        conversation: { type: 'string', description: '会话编号，如 c1' },
        limit: limitProp(MESSAGES_DEFAULT, MESSAGES_MAX),
      },
      required: ['conversation'],
    }),
    label: safeLabel((args, env) => {
      const ref = env.refs.get(optStr(args, 'conversation', 40));
      return ref?.label ? `正在看：和 ${ref.label} 的聊天记录` : '正在看：聊天记录';
    }),
    run: runConversationMessages,
  },
  {
    name: 'search_leads',
    description: (user) =>
      `查客户线索（从聊天里整理出的客户信息）。${user.role === 'admin' ? '' : '业务员只查得到自己负责的会话的线索。'}参数：keyword 按名字、公司、国家、邮箱、意向产品、号码找；stage 阶段：${Object.entries(
        LEAD_STAGES,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join('、')}；account_id 只看某个号；limit（默认 ${LIST_DEFAULT}，最多 ${LIST_MAX}）；offset 翻页。返回 total 和 items（按最近联系时间倒序）：conversation（会话编号，回答里写 [[编号]] 引用）、name、contactName WhatsApp 昵称、number、company、country、email、interest 意向产品、quantity 数量、stage、summary、account、lastContact。`,
    parameters: () => ({
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词' },
        stage: { type: 'string', enum: Object.keys(LEAD_STAGES), description: '阶段' },
        ...accountProp,
        limit: limitProp(LIST_DEFAULT, LIST_MAX),
        offset: offsetProp,
      },
    }),
    label: safeLabel((args) => {
      const kw = optStr(args, 'keyword', 30);
      return kw ? `正在查：「${kw}」相关的客户线索` : '正在查：客户线索';
    }),
    run: runSearchLeads,
  },
  {
    name: 'search_knowledge',
    description: () =>
      '在知识库里找资料：产品、型号、价格、交期、起订量、付款、物流、售后、公司信息等，货源信息也在这里。参数：query 必填，写关键词或一句话；知识库可能是英文的，中文查不到时换成英文关键词再查一次。返回 items：ref（条目编号，回答里写 [[ref]] 引用）、type、title、content、tags；mode 为 all 表示知识库很小、给的是全部启用中的条目。只返回启用中的条目。',
    parameters: () => ({
      type: 'object',
      properties: { query: { type: 'string', description: '要找的关键词或一句话' } },
      required: ['query'],
    }),
    label: safeLabel((args) => `正在查知识库：${optStr(args, 'query', 30)}`),
    run: runSearchKnowledge,
  },
  {
    name: 'search_files',
    description: () =>
      `在产品资料库里找文件（产品目录、报价单、规格书、证书、图片等）。参数：query 按文件名、描述和标签找，不填就按发送次数列出常用的文件；limit（默认 ${LIST_DEFAULT}，最多 ${LIST_MAX}）。返回 total 和 items：ref（文件编号，回答里写 [[ref]] 引用）、name、filename、type、size、description 文件内容的描述、tags、sendCount 发给客户的次数。只返回启用中的文件。`,
    parameters: () => ({
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        limit: limitProp(LIST_DEFAULT, LIST_MAX),
      },
    }),
    label: safeLabel((args) => {
      const q = optStr(args, 'query', 30);
      return q ? `正在查产品资料：${q}` : '正在查：常用的产品资料';
    }),
    run: runSearchFiles,
  },
  {
    name: 'list_accounts',
    description: (user) =>
      `列出${user.role === 'admin' ? '全部' : '你有权限的'} WhatsApp 号和它们的状态。没有参数。返回 items：id（其他工具的 account_id 用它）、name、channel 接入方式、state 连接状态、replyMode 回复方式（人工回复或自动回复）。`,
    parameters: () => ({ type: 'object', properties: {} }),
    label: safeLabel(() => '正在查：号码状态'),
    run: runListAccounts,
  },
  {
    name: 'list_members',
    adminOnly: true,
    description: () =>
      '列出团队成员和各自负责的会话（只有管理员能用）。没有参数。返回 items：id（search_conversations 的 assignee 用它）、name、email、role、status（正常、已停用、还没接受邀请）、accounts 有权限的号、assignedConversations 负责的会话数、pendingConversations 其中待处理的数、lastLogin 最近登录时间；unassignedConversations 是还没分配的会话数。',
    parameters: () => ({ type: 'object', properties: {} }),
    label: safeLabel(() => '正在查：成员和分配'),
    run: runListMembers,
  },
  {
    name: 'get_usage_cost',
    adminOnly: true,
    description: () =>
      `查一段时间的模型调用次数、token 和估算费用（只有管理员能用，口径同数据看板的模型成本）。参数：start_date、end_date（用户时区 YYYY-MM-DD，不填是今天，最多 ${MAX_RANGE_DAYS} 天）。返回 calls、inputTokens、outputTokens、estimatedCostUsd（美元；为 null 表示用到的模型都没配单价）、byPurpose 按用途分（label、calls、inputTokens、outputTokens、costUsd）。`,
    parameters: () => ({ type: 'object', properties: { ...dateProps } }),
    label: safeLabel((args, env) => `正在查：${resolveDates(args, env).label}的模型用量和费用`),
    run: runUsageCost,
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 这个人能用的工具 → [{name, description, parameters}]（发给模型的定义） */
export function toolsFor(user) {
  return TOOLS.filter((t) => !t.adminOnly || user?.role === 'admin').map((t) => ({
    name: t.name,
    description: t.description(user),
    parameters: t.parameters(user),
  }));
}

/** 查询进度里显示的话 */
export function toolLabel(env, call) {
  const t = TOOLS_BY_NAME.get(call?.name);
  return t ? t.label(call.args, env) : '正在查询';
}

/**
 * 执行一次工具调用 → {content（给模型的文字）, isError}。不存在的工具、没权限、参数错都返回出错的结果，不抛错。
 * @param {{ctx:any, user:any, tz:string, nowMs:number, refs:ReturnType<typeof createRefRegistry>}} env
 * @param {{name:string, args:any, argsError?:string}} call
 */
export async function runTool(env, call) {
  const tool = TOOLS_BY_NAME.get(call?.name);
  if (!tool) return { content: escapeUntrusted(`没有这个工具：${clip(call?.name, 60)}`), isError: true };
  if (tool.adminOnly && env.user?.role !== 'admin') return { content: '没有权限：只有管理员能用这个工具', isError: true };
  if (call.argsError) return { content: `参数有误：${call.argsError}`, isError: true };
  try {
    const data = await tool.run(env, isPlainObject(call.args) ? call.args : {});
    return { content: capResult(JSON.stringify(escDeep(data))), isError: false };
  } catch (err) {
    if (err instanceof ToolError || err instanceof HttpError) return { content: escapeUntrusted(err.message), isError: true };
    env.ctx.log.warn(`[assistant] 工具 ${tool.name} 出错：${err?.stack || err}`);
    return { content: '查询出错了，可以换个条件再试', isError: true };
  }
}
