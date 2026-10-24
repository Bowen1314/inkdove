import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { kvGet, kvSet, openDb } from '../src/db.js';
import {
  ADMIN_EMAIL,
  convIdOf,
  convPath,
  getConv,
  getMessages,
  PASSWORD,
  quietLog,
  sleep,
  startApp,
  startFakeWaha,
  waitDecided,
  waitFor,
  WAHA_SECRET,
  wahaSend,
  ZERO_HUMANIZE,
} from './helpers.js';

const CUSTOMER = '8613711112222@c.us';

describe('F7 多个号：数据互不串', () => {
  let t;
  let fake;
  let a;
  let b;
  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    a = await t.createAccount({
      name: '一号',
      autoReply: true,
      blocklist: ['8613700000001'],
      notify: { whatsapp: { enabled: true, number: '8613900000001' } },
    });
    b = await t.createAccount({ name: '二号', autoReply: true, notify: { whatsapp: { enabled: true, number: '8613900000002' } } });
    await t.req('POST', `/api/accounts/${a.id}/waha/start`);
    await t.req('POST', `/api/accounts/${b.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('新建号：各自的 sessionName 和中继端口；name、channel 校验', async () => {
    assert.notEqual(a.waha.sessionName, b.waha.sessionName);
    const ports = t.ctx.db.prepare('SELECT relay_port FROM accounts WHERE id IN (?, ?)').all(a.id, b.id).map((r) => r.relay_port);
    assert.equal(new Set(ports).size, 2);
    assert.equal((await t.req('POST', '/api/accounts', { body: { name: '', channel: 'waha' } })).status, 400);
    assert.equal((await t.req('POST', '/api/accounts', { body: { name: 'x', channel: 'telegram' } })).status, 400);
    assert.equal((await t.req('PUT', `/api/accounts/${a.id}`, { body: { channel: 'meta' } })).status, 400, 'channel 创建后不能改');
    const ro = await t.req('PUT', `/api/accounts/${a.id}`, { body: { waha: { sessionName: 'hack' } } });
    assert.equal(ro.body.waha.sessionName, a.waha.sessionName, 'sessionName 只读，提交了也不改');
    const list = (await t.req('GET', '/api/accounts')).body;
    assert.deepEqual(list.map((x) => x.name), ['一号', '二号']);
    const health = (await t.req('GET', '/api/health')).body;
    assert.deepEqual(health.accounts.map((x) => [x.name, x.state]), [['一号', 'working'], ['二号', 'working']]);
  });

  it('同一个客户找两个号：两个会话，id 带号前缀，消息不串；webhook 按 session 名路由', async () => {
    await wahaSend(t, a, CUSTOMER, '保温杯多少钱');
    await wahaSend(t, b, CUSTOMER, '你好');
    const ma = await waitDecided(t, convIdOf(a, CUSTOMER), 1);
    const mb = await waitDecided(t, convIdOf(b, CUSTOMER), 1);
    assert.deepEqual(ma.filter((m) => m.direction === 'in').map((m) => m.text), ['保温杯多少钱']);
    assert.deepEqual(mb.filter((m) => m.direction === 'in').map((m) => m.text), ['你好']);
    await waitFor(() => fake.sentTo(CUSTOMER).length === 2);
    const viaA = fake.sentTo(CUSTOMER).filter((m) => m.session === a.waha.sessionName);
    const viaB = fake.sentTo(CUSTOMER).filter((m) => m.session === b.waha.sessionName);
    assert.equal(viaA.length, 1);
    assert.match(viaA[0].text, /59 元/);
    assert.equal(viaB.length, 1);
    const ca = await getConv(t, convIdOf(a, CUSTOMER));
    assert.equal(ca.accountName, '一号');
    assert.equal((await getConv(t, convIdOf(b, CUSTOMER))).accountName, '二号');
    const onlyB = (await t.req('GET', `/api/wa/conversations?accountId=${b.id}`)).body;
    assert.ok(onlyB.every((c) => c.accountId === b.id));
    assert.ok(onlyB.some((c) => c.id === convIdOf(b, CUSTOMER)));
  });

  it('黑名单按号：一号拉黑的号码，二号照常处理', async () => {
    const x = '8613700000001@c.us';
    await wahaSend(t, a, x, '保温杯多少钱');
    await wahaSend(t, b, x, '保温杯多少钱');
    await waitDecided(t, convIdOf(b, x), 1);
    await sleep(200);
    assert.equal(await getConv(t, convIdOf(a, x)), null);
    assert.ok(await getConv(t, convIdOf(b, x)));
  });

  it('通知按号：一号的转人工只由一号发给一号的通知号码', async () => {
    const chat = '8613700000005@c.us';
    await wahaSend(t, a, chat, '我要人工');
    await waitDecided(t, convIdOf(a, chat), 1);
    await waitFor(() => fake.sentTo('8613900000001@c.us').length === 1);
    await sleep(100);
    assert.equal(fake.sentTo('8613900000001@c.us')[0].session, a.waha.sessionName);
    assert.equal(fake.sentTo('8613900000002@c.us').length, 0);
    // 一号的通知号码发给二号的消息，对二号来说是普通客户
    await wahaSend(t, b, '8613900000001@c.us', '保温杯多少钱');
    const m = await waitDecided(t, convIdOf(b, '8613900000001@c.us'), 1);
    assert.equal(m[0].botDecision, 'replied');
  });

  it('回复上限按号和会话计：一号的会话到上限不影响二号', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { maxBotRepliesPerChatPerHour: 1 } } });
    try {
      const chat = '8613700000006@c.us';
      await wahaSend(t, a, chat, '保温杯多少钱');
      await waitDecided(t, convIdOf(a, chat), 1);
      await wahaSend(t, a, chat, '保温杯多少钱？');
      const ma = await waitDecided(t, convIdOf(a, chat), 2);
      assert.equal(ma.filter((m) => m.direction === 'in').at(-1).botDecision, 'handoff');
      await wahaSend(t, b, chat, '保温杯多少钱');
      const mb = await waitDecided(t, convIdOf(b, chat), 1);
      assert.equal(mb[0].botDecision, 'replied');
    } finally {
      await t.req('PUT', '/api/settings', { body: { reply: { maxBotRepliesPerChatPerHour: 20 } } });
    }
  });

  it('persona 按号，空时用全局', async () => {
    let seen = [];
    const orig = t.ctx.ai.generate;
    t.ctx.ai.generate = (args) => {
      seen.push(args.persona);
      return orig(args);
    };
    try {
      await t.req('PUT', '/api/settings', { body: { reply: { persona: '全局人设' } } });
      await t.req('PUT', `/api/accounts/${b.id}`, { body: { persona: '二号人设' } });
      await wahaSend(t, a, '8613700000007@c.us', '保温杯多少钱');
      await waitDecided(t, convIdOf(a, '8613700000007@c.us'), 1);
      await wahaSend(t, b, '8613700000007@c.us', '保温杯多少钱');
      await waitDecided(t, convIdOf(b, '8613700000007@c.us'), 1);
      assert.deepEqual(seen, ['全局人设', '二号人设']);
    } finally {
      t.ctx.ai.generate = orig;
    }
  });

  it('删除号：先登出再删 WAHA session；会话和消息保留，accountName 为（已删除）；不能再从这个会话发消息', async () => {
    const agent = await t.addMember({ email: 'del-agent@example.com', accountIds: [a.id, b.id] });
    const name = b.waha.sessionName;
    const r = await t.req('DELETE', `/api/accounts/${b.id}`);
    assert.equal(r.status, 200);
    const paths = fake.state.requests.map((q) => `${q.method} ${q.path}`);
    const logout = paths.lastIndexOf(`POST /api/sessions/${name}/logout`);
    const del = paths.lastIndexOf(`DELETE /api/sessions/${name}`);
    assert.ok(logout >= 0 && del > logout, '先 logout 再 DELETE');
    assert.equal(fake.state.sessions.has(name), false);
    assert.equal((await t.req('GET', `/api/accounts/${b.id}`)).status, 404);
    const conv = await getConv(t, convIdOf(b, CUSTOMER));
    assert.equal(conv.accountName, '（已删除）');
    assert.equal(conv.accountId, b.id);
    const msgs = await getMessages(t, convIdOf(b, CUSTOMER));
    assert.ok(msgs.length >= 2);
    const send = await t.req('POST', `${convPath(convIdOf(b, CUSTOMER))}/send`, { body: { text: 'hi' } });
    assert.equal(send.status, 400);
    assert.equal(send.body.code, 'account_deleted');
    // 删掉的号的 webhook 不再处理
    await wahaSend(t, b, CUSTOMER, '还在吗');
    await sleep(200);
    assert.equal((await getMessages(t, convIdOf(b, CUSTOMER))).length, msgs.length);
    // 从成员的 accountIds 里移除
    const users = (await t.req('GET', '/api/users')).body;
    assert.deepEqual(users.find((u) => u.id === agent.user.id).accountIds, [a.id]);
    assert.deepEqual((await t.req('GET', '/api/health')).body.accounts.map((x) => x.id), [a.id]);
  });
});

describe('F8 agent 只能看分给自己的号，和号上分给自己的会话', () => {
  let t;
  let fake;
  let mine;
  let other;
  let agent;
  const as = (method, p, body) => t.req(method, p, { body, cookie: agent.cookie });
  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    mine = await t.createAccount({ name: '我的号', autoReply: true });
    other = await t.createAccount({ name: '别人的号', autoReply: true });
    await t.req('POST', `/api/accounts/${mine.id}/waha/start`);
    await t.req('POST', `/api/accounts/${other.id}/waha/start`);
    agent = await t.addMember({ email: 'agent@example.com', name: '小李', accountIds: [mine.id] });
    await wahaSend(t, mine, CUSTOMER, '我要人工');
    await wahaSend(t, other, CUSTOMER, '我要人工');
    await waitDecided(t, convIdOf(mine, CUSTOMER), 1);
    await waitDecided(t, convIdOf(other, CUSTOMER), 1);
    // 按客户分配：新会话一律未分配，管理员把自己号上的这个会话分给他
    const r = await t.req('PUT', `${convPath(convIdOf(mine, CUSTOMER))}/assignee`, { body: { userId: agent.user.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('号列表、health 只含自己的号；会话列表只含分给自己的会话', async () => {
    assert.deepEqual((await as('GET', '/api/accounts')).body.map((x) => x.id), [mine.id]);
    const health = (await t.req('GET', '/api/health', { cookie: agent.cookie })).body;
    assert.deepEqual(health.accounts.map((x) => x.id), [mine.id]);
    const convs = (await as('GET', '/api/wa/conversations')).body;
    assert.deepEqual(convs.map((c) => c.id), [convIdOf(mine, CUSTOMER)]);
    assert.equal(convs[0].assignee.id, agent.user.id);
  });

  it('别人的号和会话：一律 403（不论存不存在）', async () => {
    const cp = convPath(convIdOf(other, CUSTOMER));
    const cases = [
      ['GET', `/api/accounts/${other.id}`],
      ['PUT', `/api/accounts/${other.id}`, { autoReply: false }],
      ['POST', `/api/accounts/${other.id}/waha/start`],
      ['GET', `/api/accounts/${other.id}/waha/qr`],
      ['POST', `/api/accounts/${other.id}/waha/logout`],
      ['POST', `/api/accounts/${other.id}/waha/request-code`, { phoneNumber: '+86 138 1234 5678' }],
      ['POST', `/api/accounts/${other.id}/notify/test`],
      ['GET', '/api/accounts/no-such-account'],
      ['GET', `/api/wa/conversations?accountId=${other.id}`],
      ['GET', cp],
      ['GET', `${cp}/messages`],
      ['POST', `${cp}/send`, { text: 'hi' }],
      ['POST', `${cp}/bot`, { paused: false }],
    ];
    for (const [m, p, body] of cases) {
      const r = await as(m, p, body);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.code, 'forbidden', `${m} ${p}`);
    }
    assert.equal(fake.sentTo(CUSTOMER).filter((x) => x.session === other.waha.sessionName).length, 0);
  });

  it('自己的号：只能看；改设置、扫码、改名、代理、删除一律 403', async () => {
    assert.equal((await as('GET', `/api/accounts/${mine.id}`)).status, 200);
    for (const body of [{ autoReply: false }, { scope: 'allowlist', allowlist: ['8613700000001'] }, { persona: 'p' }, { name: '改名' }, { waha: { proxy: { enabled: true } } }]) {
      const r = await as('PUT', `/api/accounts/${mine.id}`, body);
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal((await as('POST', `/api/accounts/${mine.id}/waha/start`)).status, 403);
    assert.equal((await as('DELETE', `/api/accounts/${mine.id}`)).status, 403);
    assert.equal((await as('POST', `/api/accounts/${mine.id}/proxy/test`)).status, 403);
    assert.equal((await as('POST', '/api/accounts', { name: 'x', channel: 'waha' })).status, 403);
    const acc = t.ctx.accounts.get(mine.id);
    assert.equal(acc.replyMode, 'auto');
    assert.equal(acc.scope, 'all');
    assert.equal(acc.persona, '');
  });

  it('agent 从后台发的消息记下 sentBy，via=admin', async () => {
    const r = await as('POST', `${convPath(convIdOf(mine, CUSTOMER))}/send`, { text: '您好，我是小李' });
    assert.equal(r.status, 200);
    assert.equal(r.body.via, 'admin');
    assert.equal(r.body.sentByUserId, agent.user.id);
    assert.equal(r.body.sentByName, '小李');
    const msgs = await getMessages(t, convIdOf(mine, CUSTOMER));
    const out = msgs.find((m) => m.id === r.body.id);
    assert.equal(out.sentByName, '小李');
    const bot = await as('POST', `${convPath(convIdOf(mine, CUSTOMER))}/bot`, { paused: false });
    assert.equal(bot.status, 200);
  });

  it('分配新号后号立即可见，号上的会话要再分给他才可见；去掉号后立即 403，他在这个号上负责的会话变成未分配', async () => {
    const cp = convPath(convIdOf(other, CUSTOMER));
    await t.req('PUT', `/api/users/${agent.user.id}`, { body: { accountIds: [mine.id, other.id] } });
    assert.equal((await as('GET', `/api/accounts/${other.id}`)).status, 200);
    assert.equal((await as('GET', cp)).status, 403, '有号的权限但会话没分给他');
    assert.equal((await t.req('PUT', `${cp}/assignee`, { body: { userId: agent.user.id } })).status, 200);
    assert.equal((await as('GET', cp)).status, 200);
    await t.req('PUT', `/api/users/${agent.user.id}`, { body: { accountIds: [mine.id] } });
    assert.equal((await as('GET', `/api/accounts/${other.id}`)).status, 403);
    assert.equal((await as('GET', cp)).status, 403);
    assert.equal((await getConv(t, convIdOf(other, CUSTOMER))).assignee, null);
  });
});

describe('第一期数据迁移', () => {
  it('第一期的 WAHA 通道 → 号「默认号」：沿用 session 名，旧会话挂到这个号下，旧 SMTP 挪到全局发信方式', async () => {
    const fake = await startFakeWaha();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-legacy-'));
    const db = openDb(dataDir);
    kvSet(db, 'settings', {
      llm: { format: 'openai', baseUrl: '', apiKey: '', model: '', distillModel: '' },
      reply: { autoReply: true, persona: '老人设', debounceSeconds: 0.05, scope: 'all', allowlist: [], blocklist: ['8613700000009'], maxBotRepliesPerChatPerHour: 20 },
      channel: { type: 'waha', waha: { proxy: { enabled: true, protocol: 'http', host: '10.0.0.8', port: 3128, username: '', password: '' } } },
      notify: {
        email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, user: 'bot@example.com', password: 'old-smtp-pw', to: ['boss@example.com'] },
        whatsapp: { enabled: true, number: '8613900000000' },
      },
    });
    const now = new Date().toISOString();
    db.prepare("INSERT INTO conversations(id, channel, contact_name, contact_number, created_at, updated_at) VALUES(?, 'waha', '老客户', '8613700000008', ?, ?)").run(
      '8613700000008@c.us',
      now,
      now,
    );
    db.prepare(
      "INSERT INTO messages(id, conversation_id, direction, author, text, ts, status, bot_decision) VALUES('m1', '8613700000008@c.us', 'in', 'customer', '旧消息', ?, 'received', 'replied')",
    ).run(now);
    db.close();
    const config = loadConfig({
      INKDOVE_DATA_DIR: dataDir,
      INKDOVE_LLM_MOCK: '1',
      INKDOVE_ADMIN_EMAIL: ADMIN_EMAIL,
      INKDOVE_ADMIN_PASSWORD: PASSWORD,
      INKDOVE_SESSION_SECRET: 'x',
      INKDOVE_WAHA_WEBHOOK_SECRET: WAHA_SECRET,
      INKDOVE_WAHA_URL: fake.url,
      INKDOVE_WAHA_SESSION: 'shop',
      INKDOVE_PROXY_RELAY_PORT_BASE: '29900',
    });
    const log = quietLog();
    const created = createApp(config, { log, webDist: path.join(dataDir, 'no-web'), relayBindHost: '127.0.0.1', humanize: ZERO_HUMANIZE });
    try {
      await created.ready;
      const accs = created.ctx.accounts.list();
      assert.equal(accs.length, 1);
      const acc = accs[0];
      assert.equal(acc.name, '默认号');
      assert.equal(acc.sessionName, 'shop');
      assert.equal(acc.replyMode, 'auto', '第一期开着自动回复 → auto');
      assert.deepEqual(acc.blocklist, ['8613700000009']);
      assert.equal(acc.waha.proxy.host, '10.0.0.8');
      assert.deepEqual(acc.notify, { email: { enabled: true, to: ['boss@example.com'] }, whatsapp: { enabled: true, number: '8613900000000' } });
      const s = kvGet(created.ctx.db, 'settings');
      assert.equal(s.channel, undefined);
      assert.equal(s.notify, undefined);
      assert.equal(s.reply.autoReply, undefined);
      assert.equal(s.reply.persona, '老人设');
      assert.equal(s.email.provider, 'smtp');
      assert.equal(s.email.smtp.password, 'old-smtp-pw');
      assert.equal(s.email.smtp.secure, false);
      const conv = created.ctx.db.prepare('SELECT * FROM conversations').get();
      assert.equal(conv.id, `${acc.id}:8613700000008@c.us`);
      assert.equal(conv.account_id, acc.id);
      assert.equal(conv.chat_id, '8613700000008@c.us');
      assert.equal(created.ctx.db.prepare('SELECT conversation_id FROM messages').get().conversation_id, conv.id);
      assert.ok(log.lines.some((l) => l.includes('迁移成号「默认号」')));
      // 只跑一次
      const { migrateLegacy } = await import('../src/accounts.js');
      assert.equal(migrateLegacy(created.ctx.db, created.ctx.accounts, log, config), null);
    } finally {
      await created.close();
      await fake.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('号码配置导出 / 导入（admin）', () => {
  let t;
  let agent;
  let wahaAcc;
  let metaAcc;
  const EMAIL = { provider: 'smtp', from: 'bot@example.com', smtp: { host: 'smtp.example.com' } };
  const EXPORT_KEYS = ['allowlist', 'blocklist', 'channel', 'line', 'meta', 'name', 'notify', 'persona', 'replyMode', 'scope', 'telegram', 'waha'];
  const fileOf = (doc, raw) => {
    const fd = new FormData();
    fd.append('file', new Blob([raw ?? JSON.stringify(doc)], { type: 'application/json' }), 'inkdove-accounts.json');
    return fd;
  };
  const importInto = (app, doc, o = {}) => app.req('POST', '/api/accounts/import', { body: fileOf(doc, o.raw), cookie: o.cookie });
  const exportOf = async (app) => {
    const r = await app.req('GET', '/api/accounts/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const countOf = (app) => app.ctx.accounts.list().length;
  const docOf = (accounts) => ({ format: 'inkdove-accounts', version: 1, exportedAt: new Date().toISOString(), accounts });
  const wahaItem = (name, extra = {}) => ({ name, channel: 'waha', waha: null, meta: null, ...extra });

  before(async () => {
    t = await startApp();
    await t.login();
    await t.req('PUT', '/api/settings', { body: { email: EMAIL } });
    wahaAcc = await t.createAccount({
      name: '销售一号',
      autoReply: true,
      persona: '你是销售小王，说话简洁',
      scope: 'allowlist',
      allowlist: ['8613800000001', '8613800000002'],
      blocklist: ['8613900000009'],
      waha: { proxy: { enabled: true, protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'px-user', password: 'px-secret-1' } },
      notify: { email: { enabled: true, to: ['boss@example.com'] }, whatsapp: { enabled: true, number: '+86 138 0000 0003' } },
    });
    metaAcc = await t.createAccount({
      name: '官方号',
      channel: 'meta',
      autoReply: true,
      meta: { phoneNumberId: '1234567890', apiVersion: 'v25.0', verifyToken: 'verify-xyz', accessToken: 'EAAG-token-abc', appSecret: 'app-secret-abc' },
    });
    agent = await t.addMember({ email: 'agent-export@example.com', name: '小王', accountIds: [wahaAcc.id, metaAcc.id] });
  });
  after(async () => {
    await t.close();
  });

  it('导出：附件文件名、不缓存；带密钥明文，不带 id、session 名、状态和时间', async () => {
    const r = await t.req('GET', '/api/accounts/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="inkdove-accounts-\d{8}\.json"$/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const doc = r.body;
    assert.equal(doc.format, 'inkdove-accounts');
    assert.equal(doc.version, 1);
    assert.ok(!Number.isNaN(Date.parse(doc.exportedAt)));
    assert.equal(r.headers.get('content-disposition').slice(-14, -6), doc.exportedAt.slice(0, 10).replace(/-/g, ''));
    assert.deepEqual(doc.accounts.map((a) => a.name), ['销售一号', '官方号']);
    for (const a of doc.accounts) assert.deepEqual(Object.keys(a).sort(), EXPORT_KEYS);
    const [w, m] = doc.accounts;
    assert.deepEqual(w.waha, {
      proxy: { enabled: true, useGlobal: false, protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'px-user', password: 'px-secret-1' },
    });
    assert.equal(w.meta, null);
    assert.deepEqual(w.notify, { email: { enabled: true, to: ['boss@example.com'] }, whatsapp: { enabled: true, number: '8613800000003' } });
    assert.deepEqual(m.meta, {
      phoneNumberId: '1234567890',
      apiVersion: 'v25.0',
      verifyToken: 'verify-xyz',
      accessToken: 'EAAG-token-abc',
      appSecret: 'app-secret-abc',
    });
    assert.equal(m.waha, null);
    const text = JSON.stringify(doc);
    for (const s of [wahaAcc.id, metaAcc.id, wahaAcc.waha.sessionName, 'sessionName', 'status', 'createdAt', 'passwordSet', 'webhookUrl', 'agent-export']) {
      assert.ok(!text.includes(s), `导出文件不该包含 ${s}`);
    }
    // 日志只记人和数量，不记密钥
    assert.ok(t.log.lines.some((l) => l.includes(ADMIN_EMAIL) && l.includes('导出了号码配置')));
    assert.ok(!t.log.lines.some((l) => l.includes('px-secret-1') || l.includes('EAAG-token-abc')));
  });

  it('agent 导出和导入都是 403，什么都不建', async () => {
    const before = countOf(t);
    const e = await t.req('GET', '/api/accounts/export', { cookie: agent.cookie });
    assert.equal(e.status, 403);
    assert.equal(e.body.code, 'forbidden');
    const i = await importInto(t, docOf([wahaItem('agent 想建的号')]), { cookie: agent.cookie });
    assert.equal(i.status, 403);
    assert.equal(countOf(t), before);
  });

  it('导出再导入到另一个实例：配置原样还原（新 id、新 session 名、不启动 WAHA），密钥能用', async () => {
    const doc = await exportOf(t);
    const fake = await startFakeWaha({ initialStatus: 'SCAN_QR_CODE' });
    const t2 = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    try {
      await t2.login();
      // 先配好发信方式：邮件通知原样保留，也不该有任何 notices（没配时的行为见下一个用例）
      await t2.req('PUT', '/api/settings', { body: { email: EMAIL } });
      const r = await importInto(t2, doc);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.skipped, []);
      assert.deepEqual(r.body.created.map((c) => c.name), ['销售一号', '官方号']);
      assert.ok(r.body.created.every((c) => !('notices' in c)));
      const [w2, m2] = r.body.created;
      assert.ok(![wahaAcc.id, metaAcc.id].includes(w2.id) && ![wahaAcc.id, metaAcc.id].includes(m2.id));
      assert.ok(t2.log.lines.some((l) => l.includes(ADMIN_EMAIL) && l.includes('新建 2 个，跳过 0 个')));

      // 再导出一次，和原来的逐字段相同
      assert.deepEqual((await exportOf(t2)).accounts, doc.accounts);

      // WAHA 没被动过（不建 session、不启动）
      assert.deepEqual(fake.state.requests.filter((q) => q.method !== 'GET'), []);
      const wv = (await t2.req('GET', `/api/accounts/${w2.id}`)).body;
      assert.equal(wv.waha.sessionName, `inkdove_${w2.id}`);
      assert.notEqual(wv.waha.sessionName, wahaAcc.waha.sessionName);
      assert.equal(wv.waha.proxy.passwordSet, true);
      assert.equal(t2.ctx.accounts.get(w2.id).waha.proxy.password, 'px-secret-1');

      const mv = (await t2.req('GET', `/api/accounts/${m2.id}`)).body;
      assert.equal(mv.meta.accessTokenSet, true);
      assert.equal(mv.meta.appSecretSet, true);
      assert.equal(mv.meta.webhookUrl, `https://kb.example.com/webhooks/meta/${m2.id}`);
      assert.equal(mv.status.state, 'configured');
      // verify token 和 app secret 在新号上能用
      const ok = await t2.req('GET', `/webhooks/meta/${m2.id}?hub.mode=subscribe&hub.verify_token=verify-xyz&hub.challenge=4242`, { auth: false });
      assert.equal(ok.status, 200);
      assert.equal(ok.body, '4242');
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      const sig = (secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
      const post = (secret) =>
        t2.req('POST', `/webhooks/meta/${m2.id}`, {
          body: raw,
          auth: false,
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(secret) },
        });
      assert.equal((await post('app-secret-abc')).status, 200);
      assert.equal((await post('wrong-secret')).status, 401);

      // 成员分配不导出：新实例里只有 admin
      assert.equal((await t2.req('GET', '/api/users')).body.length, 1);
    } finally {
      await t2.close();
      await fake.close();
    }
  });

  it('发信方式没配时导入：开了邮件通知的号自动关掉邮件通知（收件人保留）并在 notices 里说明，其余照常导入', async () => {
    const doc = await exportOf(t);
    assert.equal(doc.accounts[0].notify.email.enabled, true);
    const t3 = await startApp();
    try {
      await t3.login();
      const r = await importInto(t3, doc);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.skipped, []);
      assert.deepEqual(r.body.created.map((c) => c.name), ['销售一号', '官方号']);
      const [w3, m3] = r.body.created;
      assert.deepEqual(w3.notices, ['没配发信方式，已关掉邮件通知']);
      assert.ok(!('notices' in m3), 'Meta 号没开邮件通知，不该有 notices');
      assert.equal(countOf(t3), 2);

      // 只关了邮件通知：收件人还在，微信/WhatsApp 通知和其他配置不受影响
      const w = t3.ctx.accounts.get(w3.id);
      assert.deepEqual(w.notify.email, { enabled: false, to: ['boss@example.com'] });
      assert.deepEqual(w.notify.whatsapp, { enabled: true, number: '8613800000003' });
      assert.equal(w.waha.proxy.password, 'px-secret-1');
      assert.equal(w.replyMode, 'auto');
      assert.equal(t3.ctx.accounts.get(m3.id).notify.email.enabled, false);

      // 其他校验错误仍然整体 400（即使同一批里有号开了邮件通知），一个都不建
      const bad = { name: '坏号', channel: 'waha', notify: { email: { enabled: true, to: ['not-an-email'] } } };
      const e = await importInto(t3, docOf([doc.accounts[0], bad]));
      assert.equal(e.status, 400);
      assert.match(e.body.error, /^第 2 个号（坏号）：/);
      assert.equal(countOf(t3), 2);

      // 配好发信方式后再导入同一个文件：邮件通知照原样开着，没有 notices
      await t3.req('PUT', '/api/settings', { body: { email: EMAIL } });
      const r2 = await importInto(t3, doc);
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      assert.ok(r2.body.created.every((c) => !('notices' in c)));
      assert.deepEqual(t3.ctx.accounts.get(r2.body.created[0].id).notify.email, { enabled: true, to: ['boss@example.com'] });
    } finally {
      await t3.close();
    }
  });

  it('同一个文件再导入一次：Meta 号 phoneNumberId 重复的跳过并说明原因，扫码号照建（名称可以重复）', async () => {
    const doc = await exportOf(t);
    const before = countOf(t);
    const r = await importInto(t, doc);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.created.map((c) => c.name), ['销售一号']);
    assert.equal(r.body.skipped.length, 1);
    assert.equal(r.body.skipped[0].name, '官方号');
    assert.match(r.body.skipped[0].reason, /1234567890/);
    assert.match(r.body.skipped[0].reason, /「官方号」/);
    assert.equal(countOf(t), before + 1);
    assert.equal(t.ctx.accounts.list().filter((a) => a.name === '销售一号').length, 2);
  });

  it('文件里两个 Meta 号 phoneNumberId 相同：只建前一个；phoneNumberId 为空的不算重复', async () => {
    const meta = (name, phoneNumberId) => ({ name, channel: 'meta', meta: { phoneNumberId } });
    const r = await importInto(t, docOf([meta('甲', '5550001'), meta('乙', '5550001'), meta('丙', ''), meta('丁', '')]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.created.map((c) => c.name), ['甲', '丙', '丁']);
    assert.equal(r.body.skipped.length, 1);
    assert.equal(r.body.skipped[0].name, '乙');
    assert.match(r.body.skipped[0].reason, /文件里前面的号「甲」/);
    // 缺的字段按新建号的默认值
    const yi = t.ctx.accounts.get(r.body.created[0].id);
    assert.equal(yi.replyMode, 'off');
    assert.equal(yi.meta.apiVersion, t.ctx.accounts.get(r.body.created[1].id).meta.apiVersion);
  });

  it('不是导出文件、版本不对、accounts 不是数组、没传文件：400，什么都不建', async () => {
    const before = countOf(t);
    const cases = [
      [{ raw: '{不是 JSON' }, 'bad_format'],
      [{ doc: [] }, 'bad_format'],
      [{ doc: { format: 'something-else', version: 1, accounts: [] } }, 'bad_format'],
      [{ doc: { format: 'inkdove-accounts', version: 2, accounts: [wahaItem('新版本的号')] } }, 'unsupported_version'],
      [{ doc: { format: 'inkdove-accounts', accounts: [] } }, 'unsupported_version'],
      [{ doc: { format: 'inkdove-accounts', version: 1, accounts: {} } }, 'bad_format'],
    ];
    for (const [c, code] of cases) {
      const r = await importInto(t, c.doc, { raw: c.raw });
      assert.equal(r.status, 400, JSON.stringify(c));
      assert.equal(r.body.code, code, JSON.stringify(c));
    }
    // 带 BOM 的文件能读
    const bom = await importInto(t, null, { raw: `﻿${JSON.stringify(docOf([]))}` });
    assert.equal(bom.status, 200);
    assert.deepEqual(bom.body, { created: [], skipped: [] });
    const none = await t.req('POST', '/api/accounts/import', { body: new FormData() });
    assert.equal(none.status, 400);
    assert.equal(countOf(t), before);
  });

  it('有一个号不合法就整体 400：说明第几个号、哪个字段，一个都不建', async () => {
    const before = countOf(t);
    const ok = wahaItem('好号');
    const cases = [
      [{ channel: 'waha' }, /^第 2 个号：name 不能为空$/],
      [{ name: 42, channel: 'waha' }, /^第 2 个号：name 必须是字符串$/],
      ['不是对象', /^第 2 个号：必须是对象$/],
      [{ name: '坏号', channel: 'telegram' }, /^第 2 个号（坏号）：channel /],
      [{ name: '坏号', channel: 'waha', scope: 'some' }, /^第 2 个号（坏号）：scope /],
      [{ name: '坏号', channel: 'waha', waha: { proxy: { enabled: true, host: '', port: null } } }, /^第 2 个号（坏号）：启用代理时必须填写 host 和 port$/],
      [{ name: '坏号', channel: 'waha', waha: { proxy: { port: 70000 } } }, /^第 2 个号（坏号）：proxy\.port /],
      [{ name: '坏号', channel: 'waha', meta: { phoneNumberId: '1' } }, /^第 2 个号（坏号）：meta 只有 Meta 号才有/],
      [{ name: '坏号', channel: 'meta', waha: { proxy: {} } }, /^第 2 个号（坏号）：waha 只有扫码号才有/],
      [{ name: '坏号', channel: 'meta', meta: { phoneNumberId: 'abc' } }, /^第 2 个号（坏号）：phoneNumberId 只能是数字$/],
      [{ name: '坏号', channel: 'meta', meta: { accessToken: 123 } }, /^第 2 个号（坏号）：meta\.accessToken 必须是字符串$/],
      [{ name: '坏号', channel: 'waha', notify: { email: { to: ['not-an-email'] } } }, /^第 2 个号（坏号）：/],
    ];
    for (const [bad, re] of cases) {
      const r = await importInto(t, docOf([ok, bad, wahaItem('后面的好号')]));
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.body.error, re);
    }
    assert.equal(countOf(t), before);
  });
});
