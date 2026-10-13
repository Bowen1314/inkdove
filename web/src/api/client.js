import { toast } from '../ui/toastBus.js';

export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

let unauthorizedHandler = null;
/** App 注册：收到 401（未登录）时跳登录页。 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

const STATUS_TEXT = {
  400: '请求内容有误，请检查后重试',
  401: '登录已过期，请重新登录',
  403: '没有权限执行此操作',
  404: '要找的内容不存在或已被删除',
  409: '操作冲突，请刷新后重试',
  413: '文件太大，无法上传',
  429: '操作太频繁，请稍后再试',
  500: '服务器出错了，请稍后重试',
  502: '服务暂时不可用，请稍后重试',
  503: '服务暂时不可用，请稍后重试',
  504: '服务器响应超时，请稍后重试',
};

function buildUrl(path, query) {
  if (!query) return path;
  const qs = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    qs.append(k, String(v));
  });
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * 统一请求封装。
 * @param {string} method
 * @param {string} path
 * @param {{body?: any, form?: FormData, query?: Record<string, any>, silent?: boolean, signal?: AbortSignal}} [opts]
 *   silent=true：出错时不弹 toast（轮询、登录页等自己处理错误的场景）。401 跳登录始终生效（登录接口本身除外）。
 */
export async function request(method, path, opts = {}) {
  const { body, form, query, silent = false, signal } = opts;
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal };
  if (form) {
    init.body = form; // 不手动设置 Content-Type，让浏览器带 boundary
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(buildUrl(path, query), init);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const err = new ApiError('无法连接到服务器，请检查网络后重试', 0, 'network');
    if (!silent) toast.error(err.message);
    throw err;
  }

  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (res.ok) return data;

  const code = (data && data.code) || `http_${res.status}`;
  const message = (data && data.error) || STATUS_TEXT[res.status] || `请求失败（${res.status}）`;
  const err = new ApiError(message, res.status, code, data);

  // 只有"未登录"（code=unauthorized 或没有 code）才跳登录页；
  // 改密码时当前密码错误之类的 401（如 bad_credentials）按普通错误处理，不能把人踢出去
  if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/branding' && (!data?.code || data.code === 'unauthorized')) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw err;
  }
  if (!silent) toast.error(message);
  throw err;
}

const enc = (id) => encodeURIComponent(id);
const get = (p, o) => request('GET', p, o);
const post = (p, body, o) => request('POST', p, { ...o, body: body === undefined ? {} : body });
const put = (p, body, o) => request('PUT', p, { ...o, body });
const del = (p, o) => request('DELETE', p, o);

export const api = {
  // 认证（F8）
  login: (email, password) => post('/api/auth/login', { email, password }, { silent: true }),
  logout: () => post('/api/auth/logout', {}, { silent: true }),
  /** → {user: User} */
  me: () => get('/api/auth/me', { silent: true }),
  changePassword: (currentPassword, newPassword) =>
    post('/api/auth/password', { currentPassword, newPassword }, { silent: true }),
  health: (o) => get('/api/health', o),

  // 邀请和重置（不需要登录）
  getInvite: (token) => get(`/api/invites/${enc(token)}`, { silent: true }),
  acceptInvite: (token, { name, password }) =>
    post(`/api/invites/${enc(token)}/accept`, name === undefined ? { password } : { name, password }, { silent: true }),

  // 成员（admin）
  listUsers: (o) => get('/api/users', o),
  createUser: ({ email, name, role, accountIds }) => post('/api/users', { email, name, role, accountIds }),
  updateUser: (id, patch) => put(`/api/users/${enc(id)}`, patch),
  deleteUser: (id) => del(`/api/users/${enc(id)}`),
  userResetLink: (id) => post(`/api/users/${enc(id)}/reset-link`, {}),
  /** 把 :id 负责的全部会话转给 toUserId → {moved, skipped}；skipped 是目标没有对应号权限、保持原样的会话数 */
  transferUserConversations: (id, toUserId, o) => post(`/api/users/${enc(id)}/transfer`, { toUserId }, o),

  // 全局设置（admin）
  getSettings: (o) => get('/api/settings', o),
  putSettings: (patch, o) => put('/api/settings', patch, o),
  testLlm: () => post('/api/settings/llm/test', {}),
  testEmail: (to) => post('/api/settings/email/test', { to }),

  // 资料
  listSources: (o) => get('/api/sources', o),
  uploadSources: (files) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    return request('POST', '/api/sources/upload', { form });
  },
  addUrlSource: ({ url, crawl, maxPages }) =>
    post('/api/sources/url', crawl ? { url, crawl: true, maxPages } : { url, crawl: false }),
  addTextSource: ({ name, text }) => post('/api/sources/text', { name, text }),
  getSource: (id) => get(`/api/sources/${enc(id)}`),
  deleteSource: (id) => del(`/api/sources/${enc(id)}`),

  // 产品资料库（F15）：浏览、下载两种角色都能用；上传、修改、删除、重新生成描述只有 admin
  /** → SendableFile[]，按添加时间倒序；status: active | disabled */
  listFiles: ({ q, status } = {}, o) => get('/api/files', { ...o, query: { q, status } }),
  /** multipart：字段 files 可多个（一次最多 20 个），另带 addToKb → SendableFile[] */
  uploadFiles: (files, { addToKb = true } = {}, o) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    form.append('addToKb', addToKb ? 'true' : 'false');
    return request('POST', '/api/files', { ...o, form });
  },
  getFile: (id, o) => get(`/api/files/${enc(id)}`, o),
  /** patch: {name?, description?, tags?, status?}；改了 description 后端会把 descriptionStatus 记为 manual */
  updateFile: (id, patch, o) => put(`/api/files/${enc(id)}`, patch, o),
  deleteFile: (id) => del(`/api/files/${enc(id)}`),
  /** 重新生成描述 → SendableFile（descriptionStatus 变成 pending） */
  describeFile: (id, o) => post(`/api/files/${enc(id)}/describe`, {}, o),
  /** 下载地址：后端带 Content-Disposition: attachment，直接给 <a href download> 用 */
  fileDownloadUrl: (id) => `/api/files/${enc(id)}/download`,

  // 蒸馏（界面上叫"整理知识库"）
  startDistill: ({ mode, sourceIds }) =>
    post('/api/distill', sourceIds && sourceIds.length ? { mode, sourceIds } : { mode }),
  listJobs: (o) => get('/api/distill/jobs', o),
  getJob: (id, o) => get(`/api/distill/jobs/${enc(id)}`, o),
  cancelJob: (id) => post(`/api/distill/jobs/${enc(id)}/cancel`, {}),

  // 知识库
  getProfile: (o) => get('/api/kb/profile', o),
  putProfile: (patch) => put('/api/kb/profile', patch),
  listEntries: ({ q, type, status } = {}, o) => get('/api/kb/entries', { ...o, query: { q, type, status } }),
  /** entry 可带 origin:"manual"|"conversation" 和 sourceRefs（F2b） */
  createEntry: (entry) => post('/api/kb/entries', entry),
  updateEntry: (id, patch) => put(`/api/kb/entries/${enc(id)}`, patch),
  deleteEntry: (id) => del(`/api/kb/entries/${enc(id)}`),
  kbStats: (o) => get('/api/kb/stats', o),
  listGaps: (status = 'open', o) => get('/api/kb/gaps', { ...o, query: { status } }),
  answerGap: (id, answer) => post(`/api/kb/gaps/${enc(id)}/answer`, { answer }),
  dismissGap: (id) => post(`/api/kb/gaps/${enc(id)}/dismiss`, {}),
  ask: (message, history) => post('/api/kb/ask', { message, history }),

  // 红线体检（F5，admin）
  /** → {runId}。已有体检在跑：409 code=job_running；没配模型：400 code=llm_not_configured */
  startRedteam: (o) => post('/api/redteam/run', {}, o),
  /** 最近 10 次，不含明细（results）→ Run[] */
  listRedteamRuns: (o) => get('/api/redteam/runs', o),
  /** → {id, status, progress:{done,total}, summary, results[], startedAt, finishedAt, error} */
  getRedteamRun: (id, o) => get(`/api/redteam/runs/${enc(id)}`, o),
  cancelRedteamRun: (id, o) => post(`/api/redteam/runs/${enc(id)}/cancel`, {}, o),

  // 看板（F12，admin）：range 取 today | 7d | 30d；accountId 空为全部号码；tz 是浏览器的 IANA 时区
  /** → {range, kpi, handoffReasons, kb, leads, trend, accounts, members, cost, abuse, heatmap, outreach}，结构见 SPEC-phase2 F12 */
  getDashboard: ({ range, accountId, tz } = {}, o) => get('/api/dashboard', { ...o, query: { range, accountId, tz } }),

  // 在线更新（admin）
  /**
   * → {current, latest:{version, name, url, publishedAt, notes}|null, available, checkedAt, error, checkEnabled,
   *    updater:{configured, reachable?}, image, pinned}。notes 是 release 正文，按纯文本显示
   */
  getUpdate: (o) => get('/api/update', o),
  /** 立即检查（60 秒内查过就直接给上次的结果）→ 同 getUpdate。关闭了检查：400 code=update_check_disabled */
  checkUpdate: (o) => post('/api/update/check', {}, o),
  /**
   * 先备份数据库，再让更新助手拉新镜像、重建容器 → {ok, from, to, backup}。
   * 400 updater_not_configured | no_update | image_pinned，409 update_in_progress，500 backup_failed，502 updater_failed
   */
  applyUpdate: (o) => post('/api/update/apply', {}, o),

  // WhatsApp 号码（F7）
  listAccounts: (o) => get('/api/accounts', o),
  createAccount: ({ name, channel }) => post('/api/accounts', { name, channel }),
  getAccount: (id, o) => get(`/api/accounts/${enc(id)}`, o),
  putAccount: (id, patch, o) => put(`/api/accounts/${enc(id)}`, patch, o),
  deleteAccount: (id) => del(`/api/accounts/${enc(id)}`),
  /** 号码配置导出（admin）→ {format, version, exportedAt, accounts}，含密钥明文 */
  exportAccounts: () => get('/api/accounts/export'),
  /** 号码配置导入（admin，multipart 字段 file）→ {created:[{id,name}], skipped:[{name,reason}]} */
  importAccounts: (file, o) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request('POST', '/api/accounts/import', { ...o, form });
  },
  wahaStart: (id) => post(`/api/accounts/${enc(id)}/waha/start`, {}),
  wahaLogout: (id) => post(`/api/accounts/${enc(id)}/waha/logout`, {}),
  wahaQrUrl: (id, t = Date.now()) => `/api/accounts/${enc(id)}/waha/qr?t=${t}`,
  /** 手机号配对码 → {code}。phoneNumber 原样提交（带国家码），由服务端规范化和校验 */
  wahaRequestCode: (id, phoneNumber, o) => post(`/api/accounts/${enc(id)}/waha/request-code`, { phoneNumber }, o),
  testProxy: (id, o) => post(`/api/accounts/${enc(id)}/proxy/test`, {}, o),
  testNotify: (id) => post(`/api/accounts/${enc(id)}/notify/test`, {}),

  // 会话（id 形如 <accountId>:<chatId>，一律 encodeURIComponent）
  /** assignee：空为全部可见的、me、none（仅 admin）、<userId>（仅 admin） */
  listConversations: ({ accountId, assignee } = {}, o) => get('/api/wa/conversations', { ...o, query: { accountId, assignee } }),
  listMessages: (id, o) => get(`/api/wa/conversations/${enc(id)}/messages`, o),
  // 按客户分配（admin）：userId 为 null 表示取消分配
  /** → Conversation */
  setConversationAssignee: (id, userId, o) => put(`/api/wa/conversations/${enc(id)}/assignee`, { userId }, o),
  /** 最多 500 个 → {updated, skipped:[{id, code}]}，code: not_found | assignee_no_account_access | unchanged */
  assignConversations: (conversationIds, userId, o) => post('/api/wa/conversations/assign', { conversationIds, userId }, o),
  /** 分配历史，新到旧 → [{id, from, to, by, reason, at}]，from/to/by 为 {id, name} 或 null */
  listAssignments: (id, o) => get(`/api/wa/conversations/${enc(id)}/assignments`, o),

  // 客户线索（F6）：agent 只能看、改自己号的线索，服务端按权限过滤
  /** query: {q, stage, accountId}，空值不带 → Lead[]（也兼容 {leads: Lead[]}） */
  listLeads: (query, o) => get('/api/leads', { ...o, query }),
  getLead: (id, o) => get(`/api/leads/${enc(id)}`, o),
  /** patch 只放改过的字段（name/company/country/email/interest/quantity/stage/summary），后端记进 manualFields → Lead */
  updateLead: (id, patch, o) => put(`/api/leads/${enc(id)}`, patch, o),
  deleteLead: (id) => del(`/api/leads/${enc(id)}`),
  /** 立即重新提取（要调模型，可能要几秒）→ Lead */
  refreshLead: (id, o) => post(`/api/leads/${enc(id)}/refresh`, {}, o),
  /** 导出 CSV 的下载地址，带上当前筛选；后端带 Content-Disposition，直接给 <a href download> 用 */
  leadsExportUrl: ({ q, stage, accountId } = {}) => buildUrl('/api/leads/export.csv', { q, stage, accountId }),

  // 主动外联（F11）：agent 只看得到、只能操作自己建的任务，服务端按权限过滤
  /** → Campaign[]（也兼容 {campaigns: Campaign[]}） */
  listCampaigns: (o) => get('/api/campaigns', o),
  /** → Campaign（也兼容 {campaign}） */
  getCampaign: (id, o) => get(`/api/campaigns/${enc(id)}`, o),
  /**
   * multipart：file（.txt）、name、mode、accountIds（JSON 数组字符串）、message、defaultCountry，
   * 有 Meta 号时再带 metaTemplateName、metaTemplateLanguage（空值不带）。
   * → {campaign, preview:{valid, invalidLines:[{line, raw}], skipped:{<reason>: count}}}。缺模板：400 code=template_required
   */
  createCampaign: ({ file, name, mode, accountIds, message, metaTemplateName, metaTemplateLanguage, defaultCountry }, o) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('name', name);
    form.append('mode', mode);
    form.append('accountIds', JSON.stringify(accountIds || []));
    form.append('message', message);
    form.append('defaultCountry', defaultCountry);
    if (metaTemplateName) form.append('metaTemplateName', metaTemplateName);
    if (metaTemplateLanguage) form.append('metaTemplateLanguage', metaTemplateLanguage);
    return request('POST', '/api/campaigns', { ...o, form });
  },
  startCampaign: (id, o) => post(`/api/campaigns/${enc(id)}/start`, {}, o),
  pauseCampaign: (id, o) => post(`/api/campaigns/${enc(id)}/pause`, {}, o),
  resumeCampaign: (id, o) => post(`/api/campaigns/${enc(id)}/resume`, {}, o),
  cancelCampaign: (id, o) => post(`/api/campaigns/${enc(id)}/cancel`, {}, o),
  /** 只能删 draft、cancelled、done */
  deleteCampaign: (id, o) => del(`/api/campaigns/${enc(id)}`, o),
  /**
   * 收件人分页，page 从 1 开始。status 取 pending | sent | replied | declined | failed | skipped，空为全部
   * （replied、declined 是按 repliedAt、declinedAt 筛的虚拟值，sent 指已发未回复）
   * → {recipients: Recipient[], total, page, pageSize}（也兼容 {items} 或直接给数组）
   */
  listCampaignRecipients: (id, { status, page, pageSize } = {}, o) =>
    get(`/api/campaigns/${enc(id)}/recipients`, { ...o, query: { status, page, pageSize } }),

  sendMessage:(id, text) => post(`/api/wa/conversations/${enc(id)}/send`, { text }),
  /** F15：人工发文件，发完会话进入 botPaused → Message（attachment 有值） */
  sendFile: (id, fileId, caption, o) =>
    post(`/api/wa/conversations/${enc(id)}/send-file`, caption ? { fileId, caption } : { fileId }, o),
  setBotPaused: (id, paused) => post(`/api/wa/conversations/${enc(id)}/bot`, { paused }),
  /** 输入框一键翻译成客户的语言（只翻译，不发送、不改会话）→ {text, language}，language 是中文语言名 */
  translateText: (id, text, o) => post(`/api/wa/conversations/${enc(id)}/translate`, { text }, o),
  /** F2b：人工消息改写成条目草稿，不落库 → {type, title, content, tags} */
  kbDraft: (convId, messageId) =>
    post(`/api/wa/conversations/${enc(convId)}/messages/${enc(messageId)}/kb-draft`, {}),

  /** 用表单里当前（可能未保存）的值拉模型列表。总是 200 → {ok:true, models:[{id, label?}]} | {ok:false, error} */
  listLlmModels: (body) => post('/api/settings/llm/models', body),

  // 品牌（网站名称和 Logo）
  /** 公开接口，不用登录 → {title, logoUrl}；失败由调用方静默回退到默认值 */
  getBranding: () => get('/api/branding', { silent: true }),
  /** 上传和移除都立即生效，返回完整设置（和 GET /api/settings 一样） */
  uploadBrandLogo: (file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request('POST', '/api/settings/branding/logo', { form });
  },
  deleteBrandLogo: () => del('/api/settings/branding/logo'),
};
