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
 * 启动一个测试实例（临时 DATA_DIR，INKDOVE_LLM_MOCK=1）。
 * @param {{env?: Record<string,string>, options?: object}} [p]
 */
export async function startApp({ env = {}, options = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-test-'));
  const config = loadConfig({
    INKDOVE_DATA_DIR: dataDir,
    INKDOVE_LLM_MOCK: '1',
    INKDOVE_ADMIN_EMAIL: ADMIN_EMAIL,
    INKDOVE_ADMIN_PASSWORD: PASSWORD,
    INKDOVE_SESSION_SECRET: 'test-session-secret',
    INKDOVE_WAHA_WEBHOOK_SECRET: WAHA_SECRET,
    INKDOVE_PUBLIC_BASE_URL: 'https://kb.example.com',
    INKDOVE_WAHA_URL: 'http://127.0.0.1:9', // 默认指向一个连不上的端口
    INKDOVE_PROXY_RELAY_PORT_BASE: String(relayPortBase()),
    // 在线更新：默认不查 GitHub（update.test.js 自己打开，并指向假 GitHub）
    INKDOVE_UPDATE_CHECK: '0',
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
    wahaPollMs: 20,
    // 进入 WORKING 后立刻导入已有聊天
    historyImportDelayMs: 0,
    // F6：不启动客户线索的定时扫描，要测时手动调 ctx.leads.scan()
    leadsScanIntervalMs: 0,
    // F11：外联不启动定时检查（要测时手动调 ctx.outreach.tick()），两条之间不等
    outreachTickMs: 0,
    outreachIntervalMs: () => 0,
    // 在线更新：不启动定时检查，GitHub 指向连不上的端口，绝不访问外网
    updateCheckIntervalMs: 0,
    githubApiUrl: 'http://127.0.0.1:9',
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
/**
 * 构造 WAHA message 事件（session 填号的 waha.sessionName）。
 * fromMe（F12 的 message.any）按 GOWS 的形状（session.gows.core.ts 的 toWAMessage）：from 是聊天对象，私聊的 to 是 null，
 * 原始消息 _data.Info.Chat 是聊天对象（@s.whatsapp.net）。source 是 WAHA 标的来源（api / app），不给就不带。
 */
export function wahaMessage({ id, from, body = '', fromMe = false, timestamp, hasMedia = false, media = null, to, session, pushName, replyTo, source } = {}) {
  msgSeq++;
  const info = {
    ...(pushName ? { PushName: pushName } : {}),
    ...(fromMe ? { Chat: String(from || '').replace(/@c\.us$/, '@s.whatsapp.net'), IsFromMe: true } : {}),
  };
  return {
    id: `evt_${msgSeq}`,
    timestamp: Date.now(),
    event: 'message',
    session,
    engine: 'GOWS',
    payload: {
      id: id || `${fromMe}_${from}_MSG${msgSeq}${Date.now()}`,
      timestamp: timestamp ?? Math.floor(Date.now() / 1000),
      from,
      fromMe,
      to: to !== undefined ? to : fromMe ? null : '19990000000@c.us',
      ...(source ? { source } : {}),
      body,
      hasMedia,
      media,
      ...(replyTo ? { replyTo } : {}),
      _data: Object.keys(info).length ? { Info: info } : {},
    },
  };
}

let historySeq = 0;
/**
 * WAHA 聊天记录里的一条消息（GET /api/<session>/chats/<chatId>/messages 的元素），形状按 GOWS 2026.9.2 实测：
 * to 是 null（fromMe 的也是），media 是 null（downloadMedia=false），所以聊天对象只能从 chat id 取。
 * fromMe 的 from 填机主自己的号，_data 里的 PushName 也是机主的名字。timestamp 是秒。
 */
export function wahaHistoryMessage({ chatId, id, timestamp, body = '', fromMe = false, hasMedia = false, pushName = '' } = {}) {
  historySeq++;
  return {
    id: id || `${fromMe}_${chatId}_HIST${historySeq}`,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000) - 86400,
    from: fromMe ? '19990000000@c.us' : chatId,
    fromMe,
    source: 'app',
    body,
    to: null,
    participant: null,
    hasMedia,
    media: null,
    ack: fromMe ? 3 : 1,
    ackName: fromMe ? 'READ' : 'SERVER',
    replyTo: null,
    location: null,
    vCards: null,
    _data: { Info: { PushName: pushName || (fromMe ? 'Shop Owner' : '') } },
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
 * 手机号配对码：POST /api/<session>/auth/request-code 只在 SCAN_QR_CODE 时给码（否则 422，文案同 GOWS），state.codeError
 * 设成 {status, message} 时强制出错。给过码的 session 记 halfCreds（残留的半截登录凭证）：之后 start 直接 FAILED，
 * 只有 logout 能清掉。登录态还在（有 me）的 session，start 回到 WORKING。
 * 以下两点按 GOWS 2026.9.2 实测：start 一个已经在运行的 session 什么也不做，照常返回会话；logout 后 session
 * 自己重启（先 STARTING，几十毫秒后 SCAN_QR_CODE，中间被 stop 了就不再变）。
 * 关联后导入已有聊天：state.chats 里放 session 名 → [{id, name, messages: [WAMessage]}]（默认没有聊天），
 * GET /api/<session>/chats、/chats/overview、/chats/<chatId>/messages 的返回形状按 GOWS 2026.9.2 实测；
 * state.failChatList 为真时聊天列表返回 500，state.failChatMessages 里的 chat id 读消息返回 500，state.chatListDelayMs 让聊天列表晚点返回。
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
    /** F15：file.url 时去拉的地址的基址（测试里设成 inkdove 实例的 base） */
    fetchBase: null,
    /** F4：/api/files/<路径> → {buffer, mime} */
    files: new Map(),
    requireKey: null,
    /** 配对码申请 {session, phoneNumber} */
    codeRequests: [],
    /** 设成 {status, message} 时 request-code 返回这个错误 */
    codeError: null,
    /** 已有聊天：session 名 → [{id, name, messages}] */
    chats: new Map(),
    failChatList: false,
    failChatMessages: new Set(),
    /** 聊天列表晚这么多毫秒再返回（测"同一个号同时只跑一次"） */
    chatListDelayMs: 0,
    /** sendText 晚这么多毫秒再返回（F12：测回声比 API 响应先到）；收到请求时记进 sendStarted */
    sendDelayMs: 0,
    sendStarted: [],
    /** F11 查号 GET /api/contacts/check-exists 的请求 {phone, session} */
    checks: [],
    /** 这些号码（纯数字）查号返回 numberExists=false */
    notOnWhatsapp: new Set(),
    /** 号码 → 查号返回的 chatId（比如 <lid>@lid）；没有的返回 <号码>@c.us */
    checkChatIds: {},
    /** 为真时查号返回 500 */
    failCheckExists: false,
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
        if (s.status === 'STOPPED' || s.status === 'FAILED') {
          s.status = s.halfCreds ? 'FAILED' : s.me ? 'WORKING' : state.initialStatus;
        }
        return json(201, s);
      }
      if (req.method === 'POST' && action === 'stop') {
        s.status = 'STOPPED';
        return json(201, s);
      }
      if (req.method === 'POST' && action === 'logout') {
        s.status = 'STARTING';
        s.me = null;
        s.halfCreds = false;
        setTimeout(() => {
          if (s.status === 'STARTING') s.status = 'SCAN_QR_CODE';
        }, 30);
        return json(201, s);
      }
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[2] === 'auth' && parts[3] === 'request-code') {
      state.codeRequests.push({ session: parts[1], phoneNumber: body?.phoneNumber });
      if (state.codeError) return json(state.codeError.status, { message: state.codeError.message });
      const s = state.sessions.get(parts[1]);
      if (!s) return json(404, { message: 'Session not found' });
      if (s.status !== 'SCAN_QR_CODE') {
        return json(422, { message: `Can request code only in SCAN_QR_CODE status. The current status is ${s.status}` });
      }
      s.halfCreds = true;
      return json(201, { code: 'LDYW-LWV8' });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[2] === 'auth' && parts[3] === 'qr') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(TINY_PNG);
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[2] === 'chats') {
      const chats = state.chats.get(parts[1]) || [];
      const limit = Number(u.searchParams.get('limit')) || chats.length;
      const newestFirst = (c) => [...(c.messages || [])].sort((a, b) => b.timestamp - a.timestamp);
      const tsOf = (c) => newestFirst(c)[0]?.timestamp ?? null;
      if (parts.length === 3) {
        if (state.chatListDelayMs) await sleep(state.chatListDelayMs);
        if (state.failChatList) return json(500, { message: 'chats failed' });
        return json(200, chats.slice(0, limit).map((c) => ({ id: c.id, name: c.name ?? null, conversationTimestamp: tsOf(c) })));
      }
      if (parts.length === 4 && parts[3] === 'overview') {
        // 实测：顶层 name 是 null，名字在 _chat.name
        return json(
          200,
          chats.slice(0, limit).map((c) => ({
            id: c.id,
            name: null,
            picture: null,
            lastMessage: newestFirst(c)[0] || null,
            _chat: { id: c.id, name: c.name ?? null, conversationTimestamp: tsOf(c) },
          })),
        );
      }
      if (parts.length === 5 && parts[4] === 'messages') {
        if (state.failChatMessages.has(parts[3])) return json(500, { message: `messages failed for ${parts[3]}` });
        const chat = chats.find((c) => c.id === parts[3]);
        return json(200, chat ? newestFirst(chat).slice(0, limit) : []);
      }
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
    // F11 查号：形状按文档 https://waha.devlike.pro/docs/how-to/contacts/（numberExists、chatId）
    if (req.method === 'GET' && u.pathname === '/api/contacts/check-exists') {
      const phone = u.searchParams.get('phone');
      state.checks.push({ phone, session: u.searchParams.get('session') });
      if (state.failCheckExists) return json(500, { message: 'check-exists failed' });
      if (state.notOnWhatsapp.has(phone)) return json(200, { numberExists: false });
      return json(200, { numberExists: true, chatId: state.checkChatIds[phone] || `${phone}@c.us` });
    }
    if (req.method === 'POST' && u.pathname === '/api/sendText') {
      state.sendStarted.push(body);
      if (state.sendDelayMs) await sleep(state.sendDelayMs);
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
 * F11：假 Graph API（Meta）。记录请求；发消息返回 wamid.SENT<n>；state.fail 为真时返回 400（Graph 的错误形状）。
 */
export async function startFakeMeta() {
  const state = { requests: [], fail: false };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    state.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (state.fail) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Template name does not exist in the translation', code: 132001 } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.SENT${state.requests.length}` }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    /** 发出去的模板消息 */
    templates: (to) => state.requests.filter((r) => r.body?.type === 'template' && (!to || r.body.to === to)),
    /** 发出去的文本消息 */
    texts: (to) => state.requests.filter((r) => r.body?.type === 'text' && (!to || r.body.to === to)),
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
