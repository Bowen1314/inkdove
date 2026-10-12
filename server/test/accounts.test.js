import assert from 'node:assert/strict';
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

describe('F8 agent 只能看分给自己的号', () => {
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
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('号列表、health、会话列表只含自己的号', async () => {
    assert.deepEqual((await as('GET', '/api/accounts')).body.map((x) => x.id), [mine.id]);
    const health = (await t.req('GET', '/api/health', { cookie: agent.cookie })).body;
    assert.deepEqual(health.accounts.map((x) => x.id), [mine.id]);
    const convs = (await as('GET', '/api/wa/conversations')).body;
    assert.ok(convs.length >= 1);
    assert.ok(convs.every((c) => c.accountId === mine.id));
  });

  it('别人的号和会话：一律 403（不论存不存在）', async () => {
    const cp = convPath(convIdOf(other, CUSTOMER));
    const cases = [
      ['GET', `/api/accounts/${other.id}`],
      ['PUT', `/api/accounts/${other.id}`, { autoReply: false }],
      ['POST', `/api/accounts/${other.id}/waha/start`],
      ['GET', `/api/accounts/${other.id}/waha/qr`],
      ['POST', `/api/accounts/${other.id}/waha/logout`],
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

  it('自己的号：能改自动回复、范围、名单、通知，能扫码；改名、代理、删除 403', async () => {
    const ok = await as('PUT', `/api/accounts/${mine.id}`, { autoReply: false, scope: 'allowlist', allowlist: ['8613700000001'], persona: 'p' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.scope, 'allowlist');
    assert.equal((await as('POST', `/api/accounts/${mine.id}/waha/start`)).status, 200);
    for (const body of [{ name: '改名' }, { waha: { proxy: { enabled: true } } }]) {
      const r = await as('PUT', `/api/accounts/${mine.id}`, body);
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal((await as('DELETE', `/api/accounts/${mine.id}`)).status, 403);
    assert.equal((await as('POST', `/api/accounts/${mine.id}/proxy/test`)).status, 403);
    assert.equal((await as('POST', '/api/accounts', { name: 'x', channel: 'waha' })).status, 403);
    await t.req('PUT', `/api/accounts/${mine.id}`, { body: { autoReply: true, scope: 'all', allowlist: [] } });
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

  it('分配新号后立即可见；取消分配后立即 403', async () => {
    await t.req('PUT', `/api/users/${agent.user.id}`, { body: { accountIds: [mine.id, other.id] } });
    assert.equal((await as('GET', `/api/accounts/${other.id}`)).status, 200);
    assert.equal((await as('GET', convPath(convIdOf(other, CUSTOMER)))).status, 200);
    await t.req('PUT', `/api/users/${agent.user.id}`, { body: { accountIds: [mine.id] } });
    assert.equal((await as('GET', `/api/accounts/${other.id}`)).status, 403);
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
      assert.equal(acc.autoReply, true);
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
