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

  // WhatsApp 号码（F7）
  listAccounts: (o) => get('/api/accounts', o),
  createAccount: ({ name, channel }) => post('/api/accounts', { name, channel }),
  getAccount: (id, o) => get(`/api/accounts/${enc(id)}`, o),
  putAccount: (id, patch, o) => put(`/api/accounts/${enc(id)}`, patch, o),
  deleteAccount: (id) => del(`/api/accounts/${enc(id)}`),
  wahaStart: (id) => post(`/api/accounts/${enc(id)}/waha/start`, {}),
  wahaLogout: (id) => post(`/api/accounts/${enc(id)}/waha/logout`, {}),
  wahaQrUrl: (id, t = Date.now()) => `/api/accounts/${enc(id)}/waha/qr?t=${t}`,
  testProxy: (id, o) => post(`/api/accounts/${enc(id)}/proxy/test`, {}, o),
  testNotify: (id) => post(`/api/accounts/${enc(id)}/notify/test`, {}),

  // 会话（id 形如 <accountId>:<chatId>，一律 encodeURIComponent）
  listConversations: ({ accountId } = {}, o) => get('/api/wa/conversations', { ...o, query: { accountId } }),
  listMessages: (id, o) => get(`/api/wa/conversations/${enc(id)}/messages`, o),

  // 客户线索（F6）
  listLeads: (query, o) => get('/api/leads', { ...o, query }),
  sendMessage: (id, text) => post(`/api/wa/conversations/${enc(id)}/send`, { text }),
  setBotPaused: (id, paused) => post(`/api/wa/conversations/${enc(id)}/bot`, { paused }),
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
