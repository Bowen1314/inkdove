import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const PASSWORD = 'test-password-123';
export const WAHA_SECRET = 'waha-webhook-secret';
/** F1 拟真等待全部注入成 0 */
export const ZERO_HUMANIZE = { preMs: () => 0, typingMs: () => 0, betweenMs: () => 0, fileGapMs: () => 0 };

export function quietLog() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { info: push('info'), warn: push('warn'), error: push('error'), lines };
}

/** 每个测试实例用不同的中继端口段，避免和别的实例撞 */
const relayPortBase = () => 20000 + Math.floor(Math.random() * 400) * 100;

/**
 * 启动一个测试实例（临时 DATA_DIR，KBWA_LLM_MOCK=1）。
 * @param {{env?: Record<string,string>, options?: object}} [p]
 */
export async function startApp({ env = {}, options = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwa-test-'));
  const config = loadConfig({
    KBWA_DATA_DIR: dataDir,
    KBWA_LLM_MOCK: '1',
    KBWA_ADMIN_EMAIL: ADMIN_EMAIL,
    KBWA_ADMIN_PASSWORD: PASSWORD,
    KBWA_SESSION_SECRET: 'test-session-secret',
    KBWA_WAHA_WEBHOOK_SECRET: WAHA_SECRET,
    KBWA_PUBLIC_BASE_URL: 'https://kb.example.com',
    KBWA_WAHA_URL: 'http://127.0.0.1:9', // 默认指向一个连不上的端口
    KBWA_PROXY_RELAY_PORT_BASE: String(relayPortBase()),
    ...env,
  });
  const log = quietLog();
  const created = createApp(config, {
    log,
    mockDelayMs: 0,
    webDist: path.join(dataDir, 'no-web'),
    relayBindHost: '127.0.0.1',
    humanize: ZERO_HUMANIZE,
    notifyRetryDelayMs: 10,
    ...options,
  });
  const { app, ctx, close } = created;
  await created.ready;
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function loginRaw(email, password) {
    return fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ email, password }),
    });
  }
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

  const t = {
    base,
    ctx,
    config,
    log,
    dataDir,
    get cookie() {
      return cookie;
    },
    /**
     * @param {string} method
     * @param {string} p
     * @param {{body?: any, headers?: Record<string,string>, auth?: boolean, cookie?: string}} [o]
     */
    async req(method, p, { body, headers = {}, auth = true, cookie: asCookie } = {}) {
      const h = { ...headers };
      if (asCookie) h.cookie = asCookie;
      else if (auth && cookie) h.cookie = cookie;
      let payload = body;
      if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        h['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + p, { method, headers: h, body: payload });
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) data = await res.json();
      else if (ct.startsWith('image/')) data = Buffer.from(await res.arrayBuffer());
      else data = await res.text();
      return { status: res.status, body: data, headers: res.headers };
    },
    /** 以 admin 登录，之后的请求默认带这个 cookie */
    async login(email = ADMIN_EMAIL, password = PASSWORD) {
      const res = await loginRaw(email, password);
      if (res.status !== 200) throw new Error(`login failed ${res.status}`);
      cookie = cookieOf(res);
      return res;
    },
    /** 登录另一个人，返回他的 cookie（不影响默认 cookie） */
    async loginAs(email, password) {
      const res = await loginRaw(email, password);
      if (res.status !== 200) throw new Error(`login ${email} failed ${res.status}`);
      return cookieOf(res);
    },
    /** admin 新建一个号，再按 patch 部分更新 */
    async createAccount({ name = '测试号', channel = 'waha', ...patch } = {}) {
      const r = await t.req('POST', '/api/accounts', { body: { name, channel } });
      if (r.status !== 200) throw new Error(`create account failed ${r.status} ${JSON.stringify(r.body)}`);
      if (!Object.keys(patch).length) return r.body;
      const u = await t.req('PUT', `/api/accounts/${r.body.id}`, { body: patch });
      if (u.status !== 200) throw new Error(`update account failed ${u.status} ${JSON.stringify(u.body)}`);
      return u.body;
    },
    /** admin 邀请一个成员并替他接受邀请，返回 {user, cookie, password} */
    async addMember({ email, name = '业务员', role = 'agent', accountIds = [], password = 'member-password-1' }) {
      const r = await t.req('POST', '/api/users', { body: { email, name, role, accountIds } });
      if (r.status !== 200) throw new Error(`invite failed ${r.status} ${JSON.stringify(r.body)}`);
      const token = r.body.inviteUrl.split('/invite/')[1];
      const a = await t.req('POST', `/api/invites/${token}/accept`, { body: { password }, auth: false });
      if (a.status !== 200) throw new Error(`accept failed ${a.status} ${JSON.stringify(a.body)}`);
      return { user: a.body.user, cookie: cookieOf({ headers: a.headers }), password };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}

/** 轮询直到 fn 返回真值 */
export async function waitFor(fn, { timeout = 4000, interval = 20, message = 'waitFor 超时' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(message);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WAHA webhook 签名：hex(HMAC-SHA512(key, raw body)) */
export const wahaSign = (raw, key = WAHA_SECRET) => crypto.createHmac('sha512', key).update(raw).digest('hex');

let msgSeq = 0;
/** 构造 WAHA message 事件（session 填号的 waha.sessionName） */
export function wahaMessage({ id, from, body = '', fromMe = false, timestamp, hasMedia = false, media = null, to, session, pushName, replyTo } = {}) {
  msgSeq++;
  return {
    id: `evt_${msgSeq}`,
    timestamp: Date.now(),
    event: 'message',
    session,
    engine: 'GOWS',
    payload: {
      id: id || `false_${from}_MSG${msgSeq}${Date.now()}`,
      timestamp: timestamp ?? Math.floor(Date.now() / 1000),
      from,
      fromMe,
      to: to || '19990000000@c.us',
      body,
      hasMedia,
      media,
      ...(replyTo ? { replyTo } : {}),
      _data: pushName ? { Info: { PushName: pushName } } : {},
    },
  };
}

/** 发送签过名的 WAHA webhook */
export async function postWaha(t, event, { sign = true, signature } = {}) {
  const raw = JSON.stringify(event);
  const headers = { 'content-type': 'application/json' };
  if (sign) headers['x-webhook-hmac'] = signature ?? wahaSign(raw);
  headers['x-webhook-hmac-algorithm'] = 'sha512';
  return t.req('POST', '/webhooks/waha', { body: raw, headers, auth: false });
}

/** 一个最小的 PNG（1x1） */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 假 WAHA：记录请求，模拟 sessions / sendText / sendSeen / presence / qr / lids 接口，
 * 以及 F15 的 sendImage / sendFile（file.url 时按真 WAHA 的做法去拉这个地址，拉的时候把主机换成 state.fetchBase）
 * 和 F4 的 /api/files/...（state.files 里放 路径 → {buffer, mime}，要求带 X-Api-Key 时设 state.requireKey）。
 * maskSecrets=true 时 GET session 返回的配置把代理密码和 HMAC key 打码（模拟 WAHA 读回来的配置不可比）。
 * @param {{initialStatus?: string, lids?: Record<string,string|null>, maskSecrets?: boolean}} [opts]
 */
export async function startFakeWaha({ initialStatus = 'WORKING', lids = {}, maskSecrets = false } = {}) {
  const state = {
    sessions: new Map(),
    sent: [],
    seen: [],
    presence: [],
    requests: [],
    lids,
    initialStatus,
    failSend: false,
    /** 只让发给这些 chatId 的 sendText 失败 */
    failChats: new Set(),
    sendCount: 0,
    /** 按顺序记下 seen / presence / send，检查拟真发送的顺序 */
    timeline: [],
    /** F15：发出去的文件 {kind:'image'|'file', chatId, file, caption, id, fetched?:{status, bytes}} */
    media: [],
    /** F15：file.url 时去拉的地址的基址（测试里设成 kbwa 实例的 base） */
    fetchBase: null,
    /** F4：/api/files/<路径> → {buffer, mime} */
    files: new Map(),
    requireKey: null,
  };
  const masked = (cfg) => {
    if (!maskSecrets || !cfg) return cfg;
    const c = structuredClone(cfg);
    if (c.proxy?.password) c.proxy.password = '***';
    for (const h of c.webhooks || []) if (h.hmac?.key) h.hmac.key = '***';
    return c;
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    state.requests.push({ method: req.method, path: u.pathname, query: u.search, body, headers: req.headers });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // /api/sessions...
    if (parts[0] === 'api' && parts[1] === 'sessions') {
      const name = parts[2];
      if (req.method === 'POST' && !name) {
        const s = { name: body.name, status: state.initialStatus, config: body.config, me: null };
        if (s.status === 'WORKING') s.me = { id: '19990000000@c.us', pushName: 'Shop' };
        state.sessions.set(body.name, s);
        return json(201, { ...s, config: masked(s.config) });
      }
      const s = state.sessions.get(name);
      if (!s) return json(404, { message: 'Session not found' });
      if (req.method === 'GET' && parts.length === 3) return json(200, { ...s, config: masked(s.config) });
      if (req.method === 'PUT' && parts.length === 3) {
        s.config = body.config;
        return json(200, { ...s, config: masked(s.config) });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        state.sessions.delete(name);
        return json(200, {});
      }
      const action = parts[3];
      if (req.method === 'POST' && action === 'start') {
        s.status = state.initialStatus;
        return json(201, s);
      }
      if (req.method === 'POST' && action === 'stop') {
        s.status = 'STOPPED';
        return json(201, s);
      }
      if (req.method === 'POST' && action === 'logout') {
        s.status = 'SCAN_QR_CODE';
        s.me = null;
        return json(201, s);
      }
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[2] === 'auth' && parts[3] === 'qr') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(TINY_PNG);
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[2] === 'lids') {
      const lid = parts[3];
      const pn = Object.prototype.hasOwnProperty.call(state.lids, lid) ? state.lids[lid] : null;
      return json(200, { lid, pn });
    }
    if (req.method === 'POST' && u.pathname === '/api/sendSeen') {
      state.seen.push(body);
      state.timeline.push({ kind: 'seen', chatId: body.chatId });
      return json(201, {});
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[2] === 'presence') {
      state.presence.push({ session: parts[1], ...body });
      state.timeline.push({ kind: body.presence, chatId: body.chatId });
      return json(201, {});
    }
    if (req.method === 'POST' && (u.pathname === '/api/sendImage' || u.pathname === '/api/sendFile')) {
      if (state.failSend || state.failChats.has(body.chatId)) return json(500, { message: 'send failed' });
      const kind = u.pathname === '/api/sendImage' ? 'image' : 'file';
      const entry = { kind, chatId: body.chatId, session: body.session, file: body.file, caption: body.caption };
      if (body.file?.url && state.fetchBase) {
        const target = new URL(body.file.url);
        const r = await fetch(`${state.fetchBase}${target.pathname}${target.search}`);
        const buf = Buffer.from(await r.arrayBuffer());
        entry.fetched = { status: r.status, bytes: buf.length, contentType: r.headers.get('content-type') };
        if (!r.ok) return json(500, { message: `download failed ${r.status}` });
      }
      state.sendCount++;
      entry.id = `true_${body.chatId}_FILE${state.sendCount}`;
      state.media.push(entry);
      state.timeline.push({ kind: `send_${kind}`, chatId: body.chatId, filename: body.file?.filename });
      return json(201, { id: entry.id });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/files/')) {
      if (state.requireKey && req.headers['x-api-key'] !== state.requireKey) return json(401, { message: 'Unauthorized' });
      const f = state.files.get(u.pathname.slice('/api/files/'.length));
      if (!f) return json(404, { message: 'file not found' });
      res.writeHead(200, { 'content-type': f.mime, 'content-length': f.buffer.length });
      return res.end(f.buffer);
    }
    if (req.method === 'POST' && u.pathname === '/api/sendText') {
      if (state.failSend || state.failChats.has(body.chatId)) return json(500, { message: 'send failed' });
      state.sendCount++;
      const id = `true_${body.chatId}_SENT${state.sendCount}`;
      state.sent.push({ ...body, id });
      state.timeline.push({ kind: 'send', chatId: body.chatId, text: body.text });
      return json(201, { id, body: body.text });
    }
    json(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    sentTo: (chatId) => state.sent.filter((m) => m.chatId === chatId),
    mediaTo: (chatId) => state.media.filter((m) => m.chatId === chatId),
    seenFor: (chatId) => state.seen.filter((m) => m.chatId === chatId),
    presenceFor: (chatId) => state.presence.filter((m) => m.chatId === chatId),
    timelineFor: (chatId) => state.timeline.filter((e) => e.chatId === chatId).map((e) => e.kind),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/**
 * 可替换的 AI 钩子：默认走 mock，测试里给 hooks.generate / hooks.review / hooks.draft … 赋值来控制输出，
 * 并统计调用次数（hooks.calls.<名字>），hooks.args.<名字> 记最后一次的参数。
 */
const HOOKED = ['generate', 'review', 'draft', 'kbDraft', 'describeImage', 'transcribe', 'describeFile'];
export async function aiHooks() {
  const { createMockAi } = await import('../src/ai/mock.js');
  const mock = createMockAi({ delayMs: 0 });
  const hooks = { calls: {}, args: {}, overrides: {} };
  for (const name of HOOKED) {
    hooks[name] = null;
    hooks.calls[name] = 0;
    hooks.overrides[name] = (args) => {
      hooks.calls[name]++;
      hooks.args[name] = args;
      return hooks[name] ? hooks[name](args, mock) : mock[name](args);
    };
  }
  return hooks;
}

/** 会话 id：<accountId>:<chatId> */
export const convIdOf = (acc, chatId) => `${acc.id}:${chatId}`;
export const convPath = (convId) => `/api/wa/conversations/${encodeURIComponent(convId)}`;

/** 等某会话里所有入站消息都有了 botDecision，返回消息列表 */
export async function waitDecided(t, convId, count = 1, timeout = 4000) {
  return waitFor(
    async () => {
      const r = await t.req('GET', `${convPath(convId)}/messages`);
      if (r.status !== 200) return null;
      const inbound = r.body.filter((m) => m.direction === 'in');
      return inbound.length >= count && inbound.every((m) => m.botDecision) ? r.body : null;
    },
    { timeout, message: `会话 ${convId} 的消息迟迟没有 botDecision` },
  );
}

/** 读会话的消息 */
export async function getMessages(t, convId, opts = {}) {
  return (await t.req('GET', `${convPath(convId)}/messages`, opts)).body;
}

/** 读单个会话（不存在返回 null） */
export async function getConv(t, convId) {
  const r = await t.req('GET', '/api/wa/conversations');
  return r.body.find((c) => c.id === convId) || null;
}

/** 某个号收到一条 WAHA 消息 */
export const wahaSend = (t, acc, from, body, extra = {}) => postWaha(t, wahaMessage({ from, body, session: acc.waha.sessionName, ...extra }));
