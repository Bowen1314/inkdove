// 操作日志的目录：哪些接口记、怎么用一句中文说清楚、改了哪些字段。中间件（audit/middleware.js）按方法和路径（/api 后面那段）
// 找到这里的一条规则：
// - skip：不记。给客户发消息（发文字、发文件）不记；页面打开时自动发的请求（推荐回复的中文意思）也不记
// - anonymous：没登录也能调的接口（登录、接受邀请），操作人由规则自己给
// - before(x)：接口执行之前从库里读出要比较的对象（同步，better-sqlite3），读出来的都先复制一份
// - run(x)：接口返回之后给出 {summary, target?, changes?, actor?}；返回 null 不记
// 没列出来的 POST / PUT / PATCH / DELETE 由兜底规则记成「其他」，只记方法和去掉 id 的路径（以后新加的接口不会漏记）。
// 只读的 GET 不记，导出除外（号码配置导出含密钥明文、客户线索导出 CSV）。
// summary 里的 {了} 成功时换成「了」、失败时去掉：「删除了知识条目」/「删除知识条目」，失败原因另外记在结果里。
// 规则绝不读整个请求体：只在少数地方取单个字段（登录的邮箱、分给谁、整理方式），密码、密钥、消息正文一概不碰；
// 改了什么一律比较改之前和改之后从库里读出的对象（audit/diff.js），密钥只记「已修改」。
import crypto from 'node:crypto';
import { DELETED_ACCOUNT_NAME } from '../accounts.js';
import { normalizeEmail, PROFILE_FIELDS } from '../auth.js';
import { LEAD_STAGES } from '../codes.js';
import { kvGet } from '../db.js';
import { NODES_KEY } from '../proxy/index.js';
import { FIELD_LABELS, getTranslationProvider, TRANSLATION_PROVIDERS } from '../translate/index.js';
import { safeJsonParse } from '../util.js';
import { clipText, diffFields, diffObjects, fieldChange, safeUrl } from './diff.js';

/** 操作类型（action 的前缀）→ 中文，筛选和列表用 */
export const CATEGORIES = {
  auth: '登录和账号',
  member: '成员',
  account: '号码',
  conversation: '会话',
  kb: '知识库',
  file: '产品资料',
  lead: '客户线索',
  campaign: '主动外联',
  settings: '设置',
  system: '在线更新',
  other: '其他',
};

/** 操作对象的类型 → 中文 */
export const TARGET_TYPES = {
  user: '成员',
  account: '号',
  conversation: '会话',
  entry: '知识条目',
  gap: '知识缺口',
  profile: '企业画像',
  source: '知识库资料',
  job: '整理任务',
  run: '红线体检',
  file: '产品资料',
  lead: '客户线索',
  campaign: '外联任务',
  settings: '设置',
  update: '版本',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_LABELS = { admin: '管理员', agent: '业务员' };
const CHANNEL_LABELS = { waha: '扫码连接', meta: 'Meta 官方接口' };
const STATUS_VALUES = { active: '启用中', disabled: '已停用' };

/* ---------------- 小工具 ---------------- */

/** 「名字」：截到 60 字，像网址的去掉账号密码和查询参数 */
const q = (s) => `「${clipText(safeUrl(String(s ?? '')).replace(/\s+/g, ' ').trim(), 60)}」`;
const clone = (v) => (v === undefined || v === null ? v : structuredClone(v));
const str = (v) => (typeof v === 'string' ? v : '');

/** 改动的简短说明（拼在 summary 后面）：最多 3 项，多了写「等 N 项」 */
export function brief(changes, max = 3) {
  if (!changes?.length) return '';
  const one = (c) => (c.from !== undefined || c.to !== undefined ? `${c.label} ${c.from ?? ''} → ${c.to ?? ''}` : `${c.label}${c.note ?? ''}`);
  return `：${changes.slice(0, max).map(one).join('；')}${changes.length > max ? ` 等 ${changes.length} 项` : ''}`;
}

/** 测试类接口（HTTP 200，结果在 body.ok 里）的结果 */
const testResult = (x) => (!x.ok || typeof x.body?.ok !== 'boolean' ? '' : x.body.ok ? '（结果：通过）' : '（结果：没通过）');

/* ---------------- 读对象 ---------------- */

const userRow = (ctx, id) => (id ? ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(String(id)) : undefined);
const userName = (u) => (u ? u.name || u.email || u.id : '');
const actorOf = (u) => (u ? { id: u.id, name: u.name || '', email: u.email || '', role: u.role || null } : null);
const userTarget = (u, id) => ({ type: 'user', id: u?.id ?? id ?? null, name: userName(u) || null });

const accountName = (ctx, id) => ctx.accounts.get(String(id))?.name ?? DELETED_ACCOUNT_NAME;
const accountTarget = (acc, id) => ({ type: 'account', id: acc?.id ?? id ?? null, name: acc?.name ?? null });

const conv = (ctx, id) => clone(ctx.wa.getConversation(String(id)));
const convName = (c) => (c ? c.contactName || c.contactNumber || c.id : '');
const convTarget = (c, id) => ({ type: 'conversation', id: c?.id ?? id ?? null, name: convName(c) || null });

const leadName = (l) => (l ? l.name || l.contactName || l.contactNumber || l.company || l.id : '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------------- 字段说明 ---------------- */

const MEMBER_FIELDS = (ctx) => [
  ['name', { label: '名字' }],
  ['role', { label: '角色', values: ROLE_LABELS }],
  ['accountIds', { label: '能用的号', kind: 'list', item: (id) => accountName(ctx, id) }],
  ['disabled', { label: '状态', on: '已停用', off: '启用中' }],
];
const memberView = (r) =>
  r ? { name: r.name, email: r.email, role: r.role, accountIds: safeJsonParse(r.account_ids, []), disabled: !!r.disabled } : null;

const SELF_PROFILE_FIELDS = Object.entries(PROFILE_FIELDS).map(([k, f]) => [k, { label: f.label, ...(f.multiline ? { kind: 'text' } : {}) }]);
const selfProfile = (r) => (r ? Object.fromEntries(Object.entries(PROFILE_FIELDS).map(([k, f]) => [k, r[f.column] ?? ''])) : null);

/** 号的设置：没列出的字段按路径和值的类型兜底（像密钥的照样只记已修改） */
const ACCOUNT_SPECS = {
  name: { label: '名称' },
  replyMode: { label: '回复方式', values: { off: '人工回复', auto: '自动回复' } },
  persona: { label: 'persona（语气和身份）', kind: 'text' },
  scope: { label: '回复范围', values: { all: '全部客户', allowlist: '只回白名单' } },
  allowlist: { label: '白名单', kind: 'list' },
  blocklist: { label: '黑名单', kind: 'list' },
  'waha.proxy.enabled': { label: 'IP 代理', on: '开', off: '关' },
  'waha.proxy.useGlobal': { label: '用全局代理', on: '开', off: '关' },
  'waha.proxy.protocol': { label: '代理协议' },
  'waha.proxy.host': { label: '代理地址' },
  'waha.proxy.port': { label: '代理端口' },
  'waha.proxy.username': { label: '代理用户名' },
  'waha.proxy.password': { label: '代理密码', kind: 'secret' },
  'meta.phoneNumberId': { label: 'Phone Number ID' },
  'meta.apiVersion': { label: 'Graph API 版本' },
  'meta.verifyToken': { label: 'Verify Token', kind: 'secret' },
  'meta.accessToken': { label: 'Access Token', kind: 'secret' },
  'meta.appSecret': { label: 'App Secret', kind: 'secret' },
  'notify.email.enabled': { label: '邮件通知' },
  'notify.email.to': { label: '通知邮箱', kind: 'list' },
  'notify.whatsapp.enabled': { label: 'WhatsApp 通知' },
  'notify.whatsapp.number': { label: '通知号码' },
};
const ACCOUNT_SKIP = ['id', 'channel', 'sessionName', 'createdAt', 'wahaConfigHash', 'relay', 'autoReply'];

const SETTINGS_SPECS = {
  'llm.format': { label: '回复模型 · 接口格式', values: { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini 原生' } },
  'llm.baseUrl': { label: '回复模型 · 接口地址' },
  'llm.apiKey': { label: '回复模型 · API 密钥', kind: 'secret' },
  'llm.model': { label: '回复模型' },
  'llm.distillModel': { label: '整理知识库用的模型' },
  'embedding.enabled': { label: '按意思搜知识库' },
  'embedding.source': { label: '向量服务' },
  'embedding.format': { label: '向量服务 · 接口格式', values: { openai: 'OpenAI 兼容', gemini: 'Gemini 原生' } },
  'embedding.baseUrl': { label: '向量服务 · 接口地址' },
  'embedding.apiKey': { label: '向量服务 · API 密钥', kind: 'secret' },
  'embedding.model': { label: '向量模型' },
  'reply.persona': { label: '默认 persona（语气和身份）', kind: 'text' },
  'reply.debounceSeconds': { label: '等客户说完再回（秒）' },
  'reply.maxBotRepliesPerChatPerHour': { label: '每个会话每小时最多自动回复' },
  'reply.humanize': { label: '回复像真人' },
  'media.voice': { label: '识别语音' },
  'media.image': { label: '识别图片' },
  'media.mediaModel': { label: '识别用的模型' },
  'media.transcribeModel': { label: '语音转写模型' },
  'leads.enabled': { label: '自动提取客户线索' },
  'email.provider': { label: '发信方式', values: { smtp: 'SMTP', resend: 'Resend' }, empty: '不发信' },
  'email.from': { label: '发件人' },
  'email.smtp.host': { label: 'SMTP 服务器' },
  'email.smtp.port': { label: 'SMTP 端口' },
  'email.smtp.secure': { label: 'SMTP 加密方式', on: 'SSL', off: 'STARTTLS' },
  'email.smtp.user': { label: 'SMTP 用户名' },
  'email.smtp.password': { label: 'SMTP 密码', kind: 'secret' },
  'email.resend.apiKey': { label: 'Resend API key', kind: 'secret' },
  'branding.title': { label: '网站名称' },
  pricing: { label: '模型单价', kind: 'json', count: (v) => `${Array.isArray(v) ? v.length : 0} 行` },
  'outreach.dailyCapPerAccount': { label: '外联 · 每个号每天最多发' },
  'outreach.minIntervalSeconds': { label: '外联 · 最短间隔（秒）' },
  'outreach.maxIntervalSeconds': { label: '外联 · 最长间隔（秒）' },
  'outreach.windowStart': { label: '外联 · 发送时段开始' },
  'outreach.windowEnd': { label: '外联 · 发送时段结束' },
  'suggest.companyPrompt': { label: '公司话术', kind: 'text' },
  'translation.mode': { label: '翻译方式', values: { ai: 'AI 翻译', api: '翻译 API' } },
  'translation.provider': { label: '翻译服务', values: Object.fromEntries(TRANSLATION_PROVIDERS.map((p) => [p.id, p.label])) },
  'translation.fallbackToAi': { label: '翻译接口出错时改用 AI 翻译' },
  // 粘贴的 Clash 配置不在设置里（只存解析出的节点，原文不存），比不出来：节点换没换另外记（proxyNodeChanges）
  'proxy.enabled': { label: '全局代理' },
  'proxy.source': { label: '全局代理 · 节点来源', values: { subscription: '订阅地址', config: '粘贴 Clash 配置' } },
  'proxy.subscriptionUrl': { label: '全局代理 · 订阅地址', kind: 'secret' },
  'proxy.node': { label: '全局代理 · 节点', empty: '自动（选最快的）' },
  'proxy.bypass': { label: '全局代理 · 不走代理的地址', kind: 'list' },
};
/** Logo 只由上传接口改（单独记），这里不比 */
const SETTINGS_SKIP = ['branding.logo'];

const PROXY_NODE_LABELS = { subscription: '全局代理 · 订阅的节点', config: '全局代理 · 粘贴的 Clash 配置' };

/** 全局代理两种来源的节点：只取个数和解析时间（节点里有机场的服务器地址和密码，一概不往外拿） */
function proxyNodeStamps(ctx) {
  const v = kvGet(ctx.db, NODES_KEY, null);
  const one = (x) => (x ? { count: Array.isArray(x.proxies) ? x.proxies.length : 0, updatedAt: x.updatedAt ?? null } : null);
  return { subscription: one(v?.subscription), config: one(v?.config) };
}

/** 节点换过的来源（解析时间变了）各记一项说明：已设置 / 已更新（N 个节点）/ 已清空 */
function proxyNodeChanges(a, b) {
  const out = [];
  for (const k of ['subscription', 'config']) {
    const x = a?.[k] ?? null;
    const y = b?.[k] ?? null;
    if ((x?.updatedAt ?? null) === (y?.updatedAt ?? null)) continue;
    const note = !y ? '已清空' : `${x ? '已更新' : '已设置'}（${y.count} 个节点）`;
    out.push({ field: `proxy.${k}Nodes`, label: PROXY_NODE_LABELS[k], note });
  }
  return out;
}

/** 设置字段的说明。翻译服务的字段按各家的字段表来：secret / secretUrl 一律只记已修改（appId、accessKeyId、服务地址这些名字不像密钥的也算） */
function settingsSpecOf(path) {
  if (SETTINGS_SPECS[path]) return SETTINGS_SPECS[path];
  const m = /^translation\.providers\.([^.]+)\.([^.]+)$/.exec(path);
  if (m) {
    const p = getTranslationProvider(m[1]);
    const f = p?.fields.find((x) => x.key === m[2]);
    const label = `${p?.label ?? m[1]} · ${FIELD_LABELS[m[2]] ?? m[2]}`;
    // 不认识的服务或字段也当密钥，宁可少记
    return { label, ...(!f || f.type === 'secret' || f.type === 'secretUrl' ? { kind: 'secret' } : {}) };
  }
  return undefined;
}

const KB_PROFILE_FIELDS = [
  ['companyName', { label: '公司名称' }],
  ['summary', { label: '公司简介', kind: 'text' }],
  ['offerings', { label: '产品与服务', kind: 'text' }],
  ['contact', { label: '联系方式', kind: 'text' }],
  ['hours', { label: '营业时间' }],
  ['languages', { label: '服务语言' }],
  ['other', { label: '其他说明', kind: 'text' }],
];
const ENTRY_FIELDS = [
  ['type', { label: '类型', values: { faq: '常见问答', product: '产品服务', policy: '政策条款', fact: '基本信息' } }],
  ['title', { label: '标题' }],
  ['content', { label: '内容', kind: 'text' }],
  ['tags', { label: '标签', kind: 'list' }],
  ['status', { label: '状态', values: STATUS_VALUES }],
];
const FILE_FIELDS = [
  ['name', { label: '名称' }],
  ['description', { label: '描述', kind: 'text' }],
  ['tags', { label: '标签', kind: 'list' }],
  ['status', { label: '状态', values: STATUS_VALUES }],
];
const LEAD_FIELDS = [
  ['name', { label: '名字' }],
  ['company', { label: '公司' }],
  ['country', { label: '国家' }],
  ['email', { label: '邮箱' }],
  ['interest', { label: '意向产品' }],
  ['quantity', { label: '数量' }],
  ['stage', { label: '阶段', values: LEAD_STAGES }],
  ['summary', { label: '摘要', kind: 'text' }],
];

/** CSV 里有几行数据（不算表头；引号里的换行不算） */
function csvRows(text) {
  let n = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 34) quoted = !quoted;
    else if (ch === 10 && !quoted) n++;
  }
  if (text.length && !text.endsWith('\n')) n++;
  return Math.max(0, n - 1);
}

/* ---------------- 规则 ---------------- */

/**
 * x：{ctx, auth, req, path（/api 后面那段）, params, before, body（接口返回的 JSON，只拿来取名字和个数，不存）, text（导出接口返回的文字）, ok, status}
 * @typedef {{m:string, p:string, a?:string, skip?:boolean, anonymous?:boolean, before?:(x:any)=>any, run?:(x:any)=>any}} AuditRule
 * @type {AuditRule[]}
 */
export const RULES = [
  /* ---------- 登录和账号 ---------- */
  {
    m: 'POST',
    p: '/auth/login',
    a: 'auth.login',
    anonymous: true,
    // 失败时操作人是这个邮箱对应的成员；不是成员的只记邮箱（不像邮箱的不记，免得把填错位置的密码记下来）。密码一个字都不碰
    before: ({ auth, req }) => {
      const email = normalizeEmail(str(req.body?.email));
      return { email, row: email ? clone(auth.getUserByEmail(email)) : undefined };
    },
    run: (x) => {
      if (x.status === 429) return null; // 尝试太多被限流，不再一条条记
      if (x.ok) return x.body?.user ? { actor: actorOf(x.body.user), summary: '登录' } : null;
      const { email, row } = x.before || {};
      const actor = row
        ? actorOf(row)
        : { id: null, name: '', email: !email ? '（没填邮箱）' : EMAIL_RE.test(email) && email.length <= 200 ? email : '（不是邮箱格式）', role: null };
      return { actor, summary: '登录失败' };
    },
  },
  { m: 'POST', p: '/auth/logout', a: 'auth.logout', run: () => ({ summary: '退出{了}登录' }) },
  {
    m: 'POST',
    p: '/auth/password',
    a: 'auth.password',
    run: (x) => ({
      summary: '修改{了}自己的登录密码',
      target: userTarget(x.req.user),
      changes: x.ok ? [{ field: 'password', label: '登录密码', secret: true, note: '已修改' }] : [],
    }),
  },
  {
    m: 'PUT',
    p: '/auth/me/profile',
    a: 'auth.profile',
    before: ({ ctx, auth, req }) => selfProfile(clone(userRow(ctx, auth.userFromReq(req)?.user.id))),
    run: (x) => {
      const changes = x.ok ? diffFields(x.before, selfProfile(userRow(x.ctx, x.req.user.id)), SELF_PROFILE_FIELDS) : [];
      return { summary: `修改{了}自己的「我的资料」${brief(changes)}`, target: userTarget(x.req.user), changes };
    },
  },
  {
    m: 'PUT',
    p: '/auth/me/style-prompt',
    a: 'auth.style_prompt',
    before: ({ ctx, auth, req }) => userRow(ctx, auth.userFromReq(req)?.user.id)?.style_prompt ?? '',
    run: (x) => {
      const c = x.ok ? fieldChange('stylePrompt', x.before, userRow(x.ctx, x.req.user.id)?.style_prompt ?? '', { label: '个人话术', kind: 'text' }) : null;
      const changes = c ? [c] : [];
      return { summary: `修改{了}自己的个人话术${brief(changes)}`, target: userTarget(x.req.user), changes };
    },
  },
  {
    m: 'POST',
    p: '/invites/:token/accept',
    a: 'auth.invite_accept',
    anonymous: true,
    // 链接里的 token 不记；只按它的哈希找到是谁的邀请或重置链接，找不到的（乱填的链接）不记
    before: ({ ctx, params }) => {
      const t = params.token;
      if (typeof t !== 'string' || t.length < 20 || t.length > 200) return null;
      const inv = ctx.db.prepare('SELECT user_id, kind FROM invites WHERE token_hash = ?').get(sha256(t));
      return inv ? { kind: inv.kind, row: clone(userRow(ctx, inv.user_id)) } : null;
    },
    run: (x) => {
      if (!x.before?.row) return null;
      const actor = actorOf(x.ok && x.body?.user ? x.body.user : x.before.row);
      const summary = x.before.kind === 'reset' ? '用重置链接重设{了}登录密码' : '接受{了}邀请，设置登录密码';
      return { actor, summary, target: userTarget(x.before.row) };
    },
  },

  /* ---------- 成员 ---------- */
  {
    m: 'POST',
    p: '/users',
    a: 'member.invite',
    run: (x) => {
      const u = x.body?.user;
      if (x.ok && u) return { summary: `邀请{了}成员${q(userName(u))}（${ROLE_LABELS[u.role] || u.role}）`, target: userTarget(u) };
      const email = normalizeEmail(str(x.req.body?.email));
      const name = EMAIL_RE.test(email) && email.length <= 200 ? email : '';
      return { summary: `邀请成员${name ? q(name) : ''}`, target: name ? { type: 'user', id: null, name } : null };
    },
  },
  {
    m: 'PUT',
    p: '/users/:id',
    a: 'member.update',
    before: ({ ctx, params }) => memberView(userRow(ctx, params.id)),
    run: (x) => {
      const after = memberView(userRow(x.ctx, x.params.id));
      const changes = x.ok && x.before && after ? diffFields(x.before, after, MEMBER_FIELDS(x.ctx)) : [];
      const name = userName(after || x.before) || x.params.id;
      const disabledTo = x.ok ? (x.before && after && x.before.disabled !== after.disabled ? after.disabled : null) : x.req.body?.disabled;
      const verb = disabledTo === true ? '停用{了}成员' : disabledTo === false ? '启用{了}成员' : '修改{了}成员';
      const rest = changes.filter((c) => c.field !== 'disabled');
      return { summary: `${verb}${q(name)}${brief(rest)}`, target: { type: 'user', id: x.params.id, name }, changes };
    },
  },
  {
    m: 'DELETE',
    p: '/users/:id',
    a: 'member.delete',
    before: ({ ctx, params }) => clone(userRow(ctx, params.id)),
    run: (x) => ({ summary: `删除{了}成员${q(userName(x.before) || x.params.id)}`, target: userTarget(x.before, x.params.id) }),
  },
  {
    m: 'POST',
    p: '/users/:id/transfer',
    a: 'member.transfer',
    before: ({ ctx, params }) => clone(userRow(ctx, params.id)),
    run: (x) => {
      const toId = str(x.req.body?.toUserId);
      const to = userName(userRow(x.ctx, toId)) || toId || '（没选人）';
      const from = userName(x.before) || x.params.id;
      const summary = x.ok
        ? `把成员${q(from)}负责的 ${x.body?.moved ?? 0} 个会话转给{了}${q(to)}${x.body?.skipped ? `（${x.body.skipped} 个对方没有号的权限，没转）` : ''}`
        : `把成员${q(from)}负责的会话转给${q(to)}`;
      return { summary, target: userTarget(x.before, x.params.id) };
    },
  },
  {
    m: 'POST',
    p: '/users/:id/reset-link',
    a: 'member.reset_link',
    before: ({ ctx, params }) => clone(userRow(ctx, params.id)),
    run: (x) => {
      const name = q(userName(x.before) || x.params.id);
      // 链接本身不记
      const summary = x.before?.password_hash ? `生成{了}成员${name}的重置密码链接` : `重新生成{了}成员${name}的邀请链接`;
      return { summary, target: userTarget(x.before, x.params.id) };
    },
  },

  /* ---------- 号码 ---------- */
  {
    m: 'POST',
    p: '/accounts',
    a: 'account.create',
    run: (x) =>
      x.ok && x.body?.id
        ? { summary: `新建{了}号${q(x.body.name)}（${CHANNEL_LABELS[x.body.channel] || x.body.channel}）`, target: accountTarget(x.body) }
        : { summary: '新建号' },
  },
  {
    m: 'GET',
    p: '/accounts/export',
    a: 'account.export',
    run: (x) => ({ summary: x.ok ? `导出{了}号码配置（${x.ctx.accounts.list().length} 个号，文件里有密钥明文）` : '导出号码配置' }),
  },
  {
    m: 'POST',
    p: '/accounts/import',
    a: 'account.import',
    run: (x) => {
      if (!x.ok) return { summary: '导入号码配置' };
      const created = Array.isArray(x.body?.created) ? x.body.created.length : 0;
      const skipped = Array.isArray(x.body?.skipped) ? x.body.skipped.length : 0;
      return { summary: `导入{了}号码配置：新建 ${created} 个号${skipped ? `，跳过 ${skipped} 个` : ''}` };
    },
  },
  {
    m: 'PUT',
    p: '/accounts/:id',
    a: 'account.update',
    before: ({ ctx, params }) => clone(ctx.accounts.get(params.id)),
    run: (x) => {
      const after = x.ctx.accounts.get(x.params.id);
      const changes = x.ok && x.before && after ? diffObjects(x.before, after, { specOf: (p) => ACCOUNT_SPECS[p], skip: ACCOUNT_SKIP }) : [];
      const acc = after || x.before;
      return { summary: `修改{了}号${q(acc?.name ?? x.params.id)}的设置${brief(changes)}`, target: accountTarget(acc, x.params.id), changes };
    },
  },
  {
    m: 'DELETE',
    p: '/accounts/:id',
    a: 'account.delete',
    before: ({ ctx, params }) => clone(ctx.accounts.get(params.id)),
    run: (x) => ({ summary: `删除{了}号${q(x.before?.name ?? x.params.id)}`, target: accountTarget(x.before, x.params.id) }),
  },
  ...[
    ['waha/start', 'account.waha_start', (n) => `启动{了}号${n}的扫码连接`],
    ['waha/logout', 'account.waha_logout', (n) => `让号${n}退出{了} WhatsApp 登录`],
    ['waha/request-code', 'account.waha_code', (n) => `为号${n}获取{了}手机号配对码`],
    ['proxy/test', 'account.proxy_test', (n) => `测试{了}号${n}的 IP 代理`],
    ['notify/test', 'account.notify_test', (n) => `给号${n}发{了}测试通知`],
  ].map(([sub, a, say]) => ({
    m: 'POST',
    p: `/accounts/:id/${sub}`,
    a,
    run: (x) => {
      const acc = x.ctx.accounts.get(x.params.id);
      return { summary: `${say(q(acc?.name ?? x.params.id))}${testResult(x)}`, target: accountTarget(acc, x.params.id) };
    },
  })),

  /* ---------- 会话 ---------- */
  // 给客户发消息不记
  { m: 'POST', p: '/wa/conversations/:id/send', skip: true },
  { m: 'POST', p: '/wa/conversations/:id/send-file', skip: true },
  // 推荐回复下面的中文意思：页面显示推荐回复时自动请求，不是人点的
  { m: 'POST', p: '/wa/conversations/:id/draft/translation', skip: true },
  {
    m: 'POST',
    p: '/wa/conversations/assign',
    a: 'conversation.assign_bulk',
    run: (x) => {
      const uid = x.req.body?.userId;
      const ids = x.req.body?.conversationIds;
      const n = x.ok ? x.body?.updated ?? 0 : Array.isArray(ids) ? ids.length : 0;
      const skipped = x.ok && Array.isArray(x.body?.skipped) ? x.body.skipped.length : 0;
      const to = typeof uid === 'string' && uid ? userName(userRow(x.ctx, uid)) || uid : null;
      const summary = to ? `批量把 ${n} 个会话分给{了}${q(to)}` : `批量取消{了} ${n} 个会话的分配`;
      return { summary: `${summary}${skipped ? `（跳过 ${skipped} 个）` : ''}`, target: to ? { type: 'user', id: uid, name: to } : null };
    },
  },
  {
    m: 'PUT',
    p: '/wa/conversations/:id/assignee',
    a: 'conversation.assign',
    before: ({ ctx, params }) => conv(ctx, params.id),
    run: (x) => {
      const c = x.before;
      const after = x.ok ? x.ctx.wa.getConversation(x.params.id) : null;
      const uid = x.req.body?.userId;
      const toName = x.ok ? userName(after?.assignee) || null : typeof uid === 'string' && uid ? userName(userRow(x.ctx, uid)) || uid : null;
      const name = q(convName(c) || x.params.id);
      const change = x.ok ? fieldChange('assignee', userName(c?.assignee) || null, toName, { label: '负责人', empty: '未分配' }) : null;
      return {
        summary: toName ? `把会话${name}分给{了}${q(toName)}` : `取消{了}会话${name}的分配`,
        target: convTarget(c, x.params.id),
        changes: change ? [change] : [],
      };
    },
  },
  {
    m: 'POST',
    p: '/wa/conversations/:id/bot',
    a: 'conversation.bot',
    before: ({ ctx, params }) => conv(ctx, params.id),
    run: (x) => {
      const paused = x.ok ? !!x.body?.botPaused : x.req.body?.paused === true;
      const name = q(convName(x.before) || x.params.id);
      return { summary: paused ? `暂停{了}会话${name}的机器人（人工接管）` : `恢复{了}会话${name}的机器人`, target: convTarget(x.before, x.params.id) };
    },
  },
  ...[
    ['POST', 'resolve', 'conversation.resolve', (n) => `把会话${n}标成{了}已处理`],
    ['DELETE', 'draft', 'conversation.draft_clear', (n) => `清掉{了}会话${n}的推荐回复和草稿`],
    ['POST', 'translate', 'conversation.translate', (n) => `在会话${n}里用{了}一键翻译`],
    ['POST', 'messages/:messageId/translation', 'conversation.message_translate', (n) => `把会话${n}里的一条消息翻译成{了}中文`],
    // 消息内容不记（发消息本身也不记），只记撤回了哪个会话里的
    ['POST', 'messages/:messageId/revoke', 'conversation.message_revoke', (n) => `撤回{了}会话${n}里的一条消息`],
    ['POST', 'suggest', 'conversation.suggest', (n) => `在会话${n}里要{了}一条推荐回复`],
    ['POST', 'messages/:messageId/kb-draft', 'conversation.kb_draft', (n) => `把会话${n}里的一条人工回复改写成{了}知识条目草稿`],
  ].map(([m, sub, a, say]) => ({
    m,
    p: `/wa/conversations/:id/${sub}`,
    a,
    before: ({ ctx, params }) => conv(ctx, params.id),
    run: (x) => ({ summary: say(q(convName(x.before) || x.params.id)), target: convTarget(x.before, x.params.id) }),
  })),

  /* ---------- 知识库 ---------- */
  {
    m: 'PUT',
    p: '/kb/profile',
    a: 'kb.profile',
    before: ({ ctx }) => clone(ctx.kb.getProfile()),
    run: (x) => {
      const changes = x.ok ? diffFields(x.before, x.ctx.kb.getProfile(), KB_PROFILE_FIELDS) : [];
      return { summary: `修改{了}企业画像${brief(changes)}`, target: { type: 'profile', id: null, name: '企业画像' }, changes };
    },
  },
  {
    m: 'POST',
    p: '/kb/entries',
    a: 'kb.entry_create',
    run: (x) =>
      x.ok && x.body?.id
        ? { summary: `新建{了}知识条目${q(x.body.title)}`, target: { type: 'entry', id: x.body.id, name: x.body.title } }
        : { summary: '新建知识条目' },
  },
  {
    m: 'PUT',
    p: '/kb/entries/:id',
    a: 'kb.entry_update',
    before: ({ ctx, params }) => clone(ctx.kb.getEntry(params.id)),
    run: (x) => {
      const after = x.ok ? x.ctx.kb.getEntry(x.params.id) : null;
      const changes = x.before && after ? diffFields(x.before, after, ENTRY_FIELDS) : [];
      const title = (after || x.before)?.title ?? x.params.id;
      return { summary: `修改{了}知识条目${q(title)}${brief(changes)}`, target: { type: 'entry', id: x.params.id, name: title }, changes };
    },
  },
  {
    m: 'DELETE',
    p: '/kb/entries/:id',
    a: 'kb.entry_delete',
    before: ({ ctx, params }) => clone(ctx.kb.getEntry(params.id)),
    run: (x) => ({
      summary: `删除{了}知识条目${q(x.before?.title ?? x.params.id)}`,
      target: { type: 'entry', id: x.params.id, name: x.before?.title ?? null },
    }),
  },
  { m: 'POST', p: '/kb/vectors/rebuild', a: 'kb.vectors_rebuild', run: () => ({ summary: '全部重算{了}知识库的向量' }) },
  { m: 'POST', p: '/kb/vectors/retry', a: 'kb.vectors_retry', run: () => ({ summary: '重试{了}知识库的向量计算' }) },
  ...[
    ['answer', 'kb.gap_answer', (n) => `回答{了}知识缺口${n}`],
    ['dismiss', 'kb.gap_dismiss', (n) => `忽略{了}知识缺口${n}`],
  ].map(([sub, a, say]) => ({
    m: 'POST',
    p: `/kb/gaps/:id/${sub}`,
    a,
    before: ({ ctx, params }) => clone(ctx.kb.getGap(params.id)),
    run: (x) => ({ summary: say(q(x.before?.question ?? x.params.id)), target: { type: 'gap', id: x.params.id, name: x.before?.question ?? null } }),
  })),
  // 问的内容不记
  { m: 'POST', p: '/kb/ask', a: 'kb.ask', run: () => ({ summary: '在知识库的测试对话里提{了}一个问题' }) },
  {
    m: 'POST',
    p: '/distill',
    a: 'kb.distill',
    run: (x) => {
      const mode = x.req.body?.mode === 'rebuild' ? '全部重建' : '增量整理';
      const ids = x.req.body?.sourceIds;
      const n = Array.isArray(ids) ? `，${ids.length} 份资料` : '';
      return { summary: `开始{了}整理知识库（${mode}${n}）`, target: x.body?.jobId ? { type: 'job', id: x.body.jobId, name: null } : null };
    },
  },
  {
    m: 'POST',
    p: '/distill/jobs/:id/cancel',
    a: 'kb.distill_cancel',
    run: (x) => ({ summary: '取消{了}知识库整理任务', target: { type: 'job', id: x.params.id, name: null } }),
  },
  {
    m: 'POST',
    p: '/redteam/run',
    a: 'kb.redteam_run',
    run: (x) => ({ summary: '开始{了}红线体检', target: x.body?.runId ? { type: 'run', id: x.body.runId, name: null } : null }),
  },
  {
    m: 'POST',
    p: '/redteam/runs/:id/cancel',
    a: 'kb.redteam_cancel',
    run: (x) => ({ summary: '取消{了}红线体检', target: { type: 'run', id: x.params.id, name: null } }),
  },
  {
    m: 'POST',
    p: '/sources/upload',
    a: 'kb.source_upload',
    run: (x) => {
      const list = x.ok && Array.isArray(x.body) ? x.body : [];
      if (!list.length) return { summary: '上传知识库资料' };
      return {
        summary: `上传{了} ${list.length} 份知识库资料：${list.slice(0, 5).map((s) => q(s.name)).join('、')}${list.length > 5 ? ' 等' : ''}`,
        target: list.length === 1 ? { type: 'source', id: list[0].id, name: list[0].name } : null,
      };
    },
  },
  ...[
    ['url', 'kb.source_url', '从网址添加{了}知识库资料'],
    ['text', 'kb.source_text', '粘贴文字添加{了}知识库资料'],
  ].map(([sub, a, say]) => ({
    m: 'POST',
    p: `/sources/${sub}`,
    a,
    run: (x) =>
      x.ok && x.body?.id
        ? { summary: `${say}${q(x.body.name)}`, target: { type: 'source', id: x.body.id, name: safeUrl(x.body.name) } }
        : { summary: say.replace('{了}', '') },
  })),
  {
    m: 'DELETE',
    p: '/sources/:id',
    a: 'kb.source_delete',
    before: ({ ctx, params }) => ctx.db.prepare('SELECT name FROM sources WHERE id = ?').get(params.id)?.name ?? null,
    run: (x) => ({ summary: `删除{了}知识库资料${q(x.before ?? x.params.id)}`, target: { type: 'source', id: x.params.id, name: x.before ? safeUrl(x.before) : null } }),
  },

  /* ---------- 产品资料 ---------- */
  {
    m: 'POST',
    p: '/files',
    a: 'file.upload',
    run: (x) => {
      const list = x.ok && Array.isArray(x.body) ? x.body : [];
      if (!list.length) return { summary: '上传产品资料' };
      return {
        summary: `上传{了} ${list.length} 个产品资料：${list.slice(0, 5).map((f) => q(f.name)).join('、')}${list.length > 5 ? ' 等' : ''}`,
        target: list.length === 1 ? { type: 'file', id: list[0].id, name: list[0].name } : null,
      };
    },
  },
  {
    m: 'PUT',
    p: '/files/:id',
    a: 'file.update',
    before: ({ ctx, params }) => clone(ctx.files.get(params.id)),
    run: (x) => {
      const after = x.ok ? x.ctx.files.get(x.params.id) : null;
      const changes = x.before && after ? diffFields(x.before, after, FILE_FIELDS) : [];
      const name = (after || x.before)?.name ?? x.params.id;
      return { summary: `修改{了}产品资料${q(name)}${brief(changes)}`, target: { type: 'file', id: x.params.id, name }, changes };
    },
  },
  ...[
    ['DELETE', '', 'file.delete', (n) => `删除{了}产品资料${n}`],
    ['POST', '/describe', 'file.describe', (n) => `重新生成{了}产品资料${n}的描述`],
  ].map(([m, sub, a, say]) => ({
    m,
    p: `/files/:id${sub}`,
    a,
    before: ({ ctx, params }) => clone(ctx.files.get(params.id)),
    run: (x) => ({ summary: say(q(x.before?.name ?? x.params.id)), target: { type: 'file', id: x.params.id, name: x.before?.name ?? null } }),
  })),

  /* ---------- 客户线索 ---------- */
  {
    m: 'GET',
    p: '/leads/export.csv',
    a: 'lead.export',
    run: (x) => {
      const qy = x.req.query || {};
      const filters = [
        typeof qy.accountId === 'string' && qy.accountId ? `号：${accountName(x.ctx, qy.accountId)}` : '',
        typeof qy.stage === 'string' && qy.stage ? `阶段：${LEAD_STAGES[qy.stage] ?? clipText(qy.stage, 20)}` : '',
        typeof qy.q === 'string' && qy.q.trim() ? `关键字：${clipText(qy.q.trim(), 40)}` : '',
      ].filter(Boolean);
      const changes = [{ field: 'filters', label: '筛选条件', to: filters.length ? filters.join('；') : '全部' }];
      return { summary: x.ok ? `导出{了} ${csvRows(x.text || '')} 条客户线索（CSV）` : '导出客户线索（CSV）', changes };
    },
  },
  {
    m: 'PUT',
    p: '/leads/:id',
    a: 'lead.update',
    before: ({ ctx, params }) => clone(ctx.leads.get(params.id)),
    run: (x) => {
      const after = x.ok ? x.ctx.leads.get(x.params.id) : null;
      const changes = x.before && after ? diffFields(x.before, after, LEAD_FIELDS) : [];
      const name = leadName(after || x.before) || x.params.id;
      return { summary: `修改{了}客户线索${q(name)}${brief(changes)}`, target: { type: 'lead', id: x.params.id, name }, changes };
    },
  },
  ...[
    ['DELETE', '', 'lead.delete', (n) => `删除{了}客户线索${n}`],
    ['POST', '/refresh', 'lead.refresh', (n) => `重新提取{了}客户线索${n}`],
  ].map(([m, sub, a, say]) => ({
    m,
    p: `/leads/:id${sub}`,
    a,
    before: ({ ctx, params }) => clone(ctx.leads.get(params.id)),
    run: (x) => {
      const name = leadName(x.before) || null;
      return { summary: say(q(name ?? x.params.id)), target: { type: 'lead', id: x.params.id, name } };
    },
  })),

  /* ---------- 主动外联 ---------- */
  {
    m: 'POST',
    p: '/campaigns',
    a: 'campaign.create',
    run: (x) => {
      const c = x.body?.campaign;
      if (!x.ok || !c) return { summary: '新建外联任务' };
      return { summary: `新建{了}外联任务${q(c.name)}（${x.body?.preview?.valid ?? 0} 个号码）`, target: { type: 'campaign', id: c.id, name: c.name } };
    },
  },
  ...[
    ['POST', '/start', 'campaign.start', '开始'],
    ['POST', '/pause', 'campaign.pause', '暂停'],
    ['POST', '/resume', 'campaign.resume', '继续'],
    ['POST', '/cancel', 'campaign.cancel', '取消'],
    ['DELETE', '', 'campaign.delete', '删除'],
  ].map(([m, sub, a, verb]) => ({
    m,
    p: `/campaigns/:id${sub}`,
    a,
    before: ({ ctx, params }) => ctx.db.prepare('SELECT name FROM campaigns WHERE id = ?').get(params.id)?.name ?? null,
    run: (x) => ({ summary: `${verb}{了}外联任务${q(x.before ?? x.params.id)}`, target: { type: 'campaign', id: x.params.id, name: x.before } }),
  })),

  /* ---------- 设置 ---------- */
  {
    m: 'PUT',
    p: '/settings',
    a: 'settings.update',
    before: ({ ctx }) => ({ settings: clone(ctx.getSettings()), nodes: proxyNodeStamps(ctx) }),
    run: (x) => {
      const changes =
        x.ok && x.before
          ? [
              ...diffObjects(x.before.settings, x.ctx.getSettings(), { specOf: settingsSpecOf, skip: SETTINGS_SKIP }),
              ...proxyNodeChanges(x.before.nodes, proxyNodeStamps(x.ctx)),
            ]
          : [];
      return { summary: `修改{了}设置${brief(changes)}`, target: { type: 'settings', id: null, name: '设置' }, changes };
    },
  },
  // 全局代理的测试、更新订阅、测速：成功失败都回 200，只记结果，不记错误信息和出口 IP
  { m: 'POST', p: '/settings/proxy/test', a: 'settings.proxy_test', run: (x) => ({ summary: `测试{了}全局代理${testResult(x)}` }) },
  {
    m: 'POST',
    p: '/settings/proxy/refresh',
    a: 'settings.proxy_refresh',
    // 订阅更新后选的节点没了会改回自动：比较更新前后的代理设置和节点
    before: ({ ctx }) => ({ proxy: clone(ctx.getSettings().proxy), nodes: proxyNodeStamps(ctx) }),
    run: (x) => {
      const changes =
        x.ok && x.before
          ? [
              ...diffObjects(x.before.proxy, x.ctx.getSettings().proxy, { specOf: settingsSpecOf, prefix: 'proxy' }),
              ...proxyNodeChanges(x.before.nodes, proxyNodeStamps(x.ctx)),
            ]
          : [];
      return { summary: `更新{了}全局代理的订阅${testResult(x)}${brief(changes)}`, changes };
    },
  },
  { m: 'POST', p: '/settings/proxy/delay', a: 'settings.proxy_delay', run: (x) => ({ summary: `给全局代理的节点测{了}速${testResult(x)}` }) },
  { m: 'POST', p: '/settings/llm/test', a: 'settings.llm_test', run: (x) => ({ summary: `测试{了}回复模型的连接${testResult(x)}` }) },
  { m: 'POST', p: '/settings/llm/models', a: 'settings.llm_models', run: (x) => ({ summary: `拉取{了}模型列表${testResult(x)}` }) },
  { m: 'POST', p: '/settings/embedding/test', a: 'settings.embedding_test', run: (x) => ({ summary: `测试{了}向量服务的连接${testResult(x)}` }) },
  {
    m: 'POST',
    p: '/settings/translation/test',
    a: 'settings.translation_test',
    run: (x) => {
      const p = getTranslationProvider(str(x.req.body?.provider));
      return { summary: `测试{了}翻译服务${p ? q(p.label) : ''}${testResult(x)}` };
    },
  },
  { m: 'POST', p: '/settings/branding/logo', a: 'settings.logo_upload', run: () => ({ summary: '上传{了}网站 Logo' }) },
  { m: 'DELETE', p: '/settings/branding/logo', a: 'settings.logo_remove', run: () => ({ summary: '移除{了}网站 Logo' }) },
  // 收件地址不记
  { m: 'POST', p: '/settings/email/test', a: 'settings.email_test', run: (x) => ({ summary: `发送{了}测试邮件${testResult(x)}` }) },

  /* ---------- 在线更新 ---------- */
  { m: 'POST', p: '/update/check', a: 'system.update_check', run: () => ({ summary: '检查{了}新版本' }) },
  {
    m: 'POST',
    p: '/update/apply',
    a: 'system.update_apply',
    run: (x) => ({
      summary: x.ok && x.body?.to ? `开始{了}在线更新（v${x.body.from} → v${x.body.to}）` : '开始在线更新',
      target: x.ok && x.body?.to ? { type: 'update', id: String(x.body.to), name: `v${x.body.to}` } : null,
    }),
  },
  {
    m: 'POST',
    p: '/update/schedule',
    a: 'system.update_schedule',
    run: (x) => {
      const s = x.ok ? x.body?.schedule : null;
      const when = s?.at ? `${String(s.at).slice(0, 16).replace('T', ' ')} UTC` : '';
      return {
        summary: s ? `预约{了}在线更新（${when}，更新到 v${s.targetVersion}）` : '预约在线更新',
        target: s ? { type: 'update', id: String(s.targetVersion), name: `v${s.targetVersion}` } : null,
      };
    },
  },
  { m: 'DELETE', p: '/update/schedule', a: 'system.update_unschedule', run: () => ({ summary: '取消{了}预约的在线更新' }) },
];

/* ---------------- 匹配 ---------------- */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 路径模板 → 正则（:name 匹配一段；和 Express 一样不分大小写、末尾的 / 可有可无） */
function compile(p) {
  const names = [];
  const src = p
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return escapeRe(seg);
    })
    .join('/');
  return { re: new RegExp(`^${src}/?$`, 'i'), names };
}

const COMPILED = RULES.map((r) => ({ ...r, ...compile(r.p) }));
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 兜底规则记的路径：像 id 的段（带数字、很长、或者带 . 以外的符号）换成 :id，免得把令牌之类记下来 */
export function sanitizePath(p) {
  return String(p)
    .split('/')
    .map((seg) => (seg && (/\d/.test(seg) || seg.length > 24 || /[^a-z._-]/i.test(seg)) ? ':id' : seg))
    .join('/')
    .slice(0, 200);
}

/** 兜底：没列出来的改动类接口 */
const FALLBACK = {
  a: 'other.unknown',
  // x.path 是进来时 /api 后面那段（出错时 Express 已经把 req.url 改回了完整地址）
  run: (x) => ({ summary: `调用{了}接口 ${x.req.method} /api${sanitizePath(x.path)}` }),
};

/**
 * 按方法和路径找规则：返回 {rule, params}；不记的（GET 里不是导出的、HEAD、OPTIONS）返回 null。
 * @param {string} method
 * @param {string} path /api 后面那段
 */
export function matchRule(method, path) {
  const m = String(method).toUpperCase();
  for (const r of COMPILED) {
    if (r.m !== m) continue;
    const hit = r.re.exec(path);
    if (!hit) continue;
    const params = {};
    r.names.forEach((n, i) => {
      params[n] = decode(hit[i + 1]);
    });
    return { rule: r, params };
  }
  return WRITE_METHODS.has(m) ? { rule: FALLBACK, params: {} } : null;
}
