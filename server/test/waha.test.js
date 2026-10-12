import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  convIdOf,
  convPath,
  getConv,
  getMessages,
  postWaha,
  sleep,
  startApp,
  startFakeWaha,
  TINY_PNG,
  waitDecided,
  WAHA_SECRET,
  wahaMessage,
  wahaSend,
} from './helpers.js';

const ENTRIES = [
  { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' },
  { type: 'policy', title: '退货政策', content: '收货 7 天内可无理由退货。' },
];

let phoneSeq = 0;
const newChat = () => `86138${String(Date.now() % 1e6).padStart(6, '0')}${++phoneSeq}@c.us`;

async function setup({ waha = {}, env = {}, account = {} } = {}) {
  const fake = await startFakeWaha(waha);
  const t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url, ...env } });
  await t.login();
  for (const e of ENTRIES) await t.req('POST', '/api/kb/entries', { body: e });
  await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.1 } } });
  const acc = await t.createAccount({ name: '销售小王', autoReply: true, ...account });
  const st = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  return { t, fake, acc };
}

describe('WAHA 号', () => {
  let t;
  let fake;
  let acc;
  const send = (from, body, extra) => wahaSend(t, acc, from, body, extra);
  const cid = (chat) => convIdOf(acc, chat);
  before(async () => {
    ({ t, fake, acc } = await setup());
  });
  after(async () => {
    await t.close();
    await fake.close();
  });
  beforeEach(async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.1, maxBotRepliesPerChatPerHour: 20 } } });
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { autoReply: true, scope: 'all', allowlist: [], blocklist: [] } });
  });

  it('新建的号：sessionName 由系统生成；start 建 session，webhook、events 和 HMAC key 正确', async () => {
    assert.match(acc.waha.sessionName, new RegExp(`^inkdove_${acc.id}$`));
    assert.equal(acc.meta, null);
    assert.deepEqual(acc.waha.proxy, { enabled: false, protocol: 'socks5', host: '', port: null, username: '', passwordSet: false });
    const create = fake.state.requests.find((r) => r.method === 'POST' && r.path === '/api/sessions');
    assert.ok(create);
    assert.equal(create.headers['x-api-key'], undefined, '未配置 key 时不带');
    assert.equal(create.body.name, acc.waha.sessionName);
    const [hook] = create.body.config.webhooks;
    assert.equal(hook.url, 'http://127.0.0.1:8794/webhooks/waha');
    assert.deepEqual(hook.events, ['message', 'session.status']);
    assert.deepEqual(hook.hmac, { key: WAHA_SECRET });
    assert.equal(create.body.config.proxy, undefined, '未启用代理时不带 proxy');
    const got = await t.req('GET', `/api/accounts/${acc.id}`);
    assert.deepEqual(got.body.status, { state: 'working', me: { id: '19990000000@c.us', pushName: 'Shop' }, error: null, lastWebhookAt: null });
    // 再 start 一次：配置没变，不重复 PUT
    const n = fake.state.requests.filter((r) => r.method === 'PUT').length;
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    assert.equal(fake.state.requests.filter((r) => r.method === 'PUT').length, n);
    const health = await t.req('GET', '/api/health');
    assert.deepEqual(health.body.accounts, [{ id: acc.id, name: '销售小王', channel: 'waha', state: 'working' }]);
  });

  it('HMAC：签名正确 200，错误或缺失 401；webhook 按 session 名找号，不认识的 session 忽略', async () => {
    const chat = newChat();
    const ok = await send(chat, '你好');
    assert.equal(ok.status, 200);
    const evt = wahaMessage({ from: chat, body: '你好', session: acc.waha.sessionName });
    const bad = await postWaha(t, evt, { signature: 'ab'.repeat(64) });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'bad_signature');
    const missing = await postWaha(t, evt, { sign: false });
    assert.equal(missing.status, 401);
    await waitDecided(t, cid(chat), 1);
    const msgs = await getMessages(t, cid(chat));
    assert.equal(msgs.filter((m) => m.direction === 'in').length, 1, '签名错误的没有入库');
    const other = newChat();
    await postWaha(t, wahaMessage({ from: other, body: '你好', session: 'someone_else' }));
    await sleep(200);
    assert.equal((await t.req('GET', '/api/wa/conversations')).body.some((c) => c.id.endsWith(other)), false);
    assert.ok((await t.req('GET', `/api/accounts/${acc.id}`)).body.status.lastWebhookAt);
  });

  it('忽略：自己发的、群聊、广播、频道、重复 id、过旧消息；非 message 事件不处理', async () => {
    const chat = newChat();
    const before = fake.state.sent.length;
    await send(chat, '你好', { fromMe: true });
    await send('120363000000000000@g.us', '你好');
    await send('status@broadcast', '你好');
    await send('120363000000000001@newsletter', '你好');
    await send(chat, '你好', { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    await postWaha(t, { ...wahaMessage({ from: chat, body: '你好', session: acc.waha.sessionName }), event: 'message.any' });
    await sleep(300);
    const convs = (await t.req('GET', '/api/wa/conversations')).body;
    assert.ok(!convs.some((c) => [chat, '120363000000000000@g.us', 'status@broadcast', '120363000000000001@newsletter'].map(cid).includes(c.id)));
    const dup = wahaMessage({ from: chat, body: '你好', id: `false_${chat}_DUP1`, session: acc.waha.sessionName });
    await postWaha(t, dup);
    await postWaha(t, dup);
    const msgs = await waitDecided(t, cid(chat), 1);
    await sleep(300);
    assert.equal(msgs.filter((m) => m.direction === 'in').length, 1);
    assert.equal(fake.sentTo(chat).length, 1);
    assert.equal(fake.state.sent.length, before + 1);
  });

  it('防抖：连发两条只回一次，两条都记 replied；会话带 accountId、accountName、draft', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.3 } } });
    const chat = newChat();
    await send(chat, '保温杯多少钱', { pushName: '王先生' });
    await sleep(100);
    await send(chat, '容量多大');
    const msgs = await waitDecided(t, cid(chat), 2);
    await sleep(400);
    const sent = fake.sentTo(chat);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session, acc.waha.sessionName);
    assert.match(sent[0].text, /59 元/);
    const inbound = msgs.filter((m) => m.direction === 'in');
    assert.deepEqual(inbound.map((m) => m.botDecision), ['replied', 'replied']);
    assert.deepEqual(inbound.map((m) => m.decisionReason), [null, null], 'replied 不带原因');
    const out = (await getMessages(t, cid(chat))).filter((m) => m.direction === 'out');
    assert.equal(out.length, 1);
    assert.equal(out[0].author, 'bot');
    assert.equal(out[0].confident, true);
    assert.equal(out[0].status, 'sent');
    assert.equal(out[0].via, null);
    assert.ok(out[0].usedEntryIds.length >= 1);
    const conv = await getConv(t, cid(chat));
    assert.equal(conv.id, `${acc.id}:${chat}`);
    assert.equal(conv.accountId, acc.id);
    assert.equal(conv.accountName, '销售小王');
    assert.equal(conv.contactName, '王先生');
    assert.equal(conv.contactNumber, chat.replace('@c.us', ''));
    assert.equal(conv.lastMessage.direction, 'out');
    assert.equal(conv.draft, null);
    assert.deepEqual(Object.keys(conv).sort(), [
      'accountId',
      'accountName',
      'botPaused',
      'contactName',
      'contactNumber',
      'draft',
      'id',
      'lastMessage',
      'mutedUntil',
      'needsHuman',
      'pendingReason',
      'updatedAt',
    ]);
    assert.equal(conv.pendingReason, null);
    const filtered = await t.req('GET', `/api/wa/conversations?accountId=${acc.id}`);
    assert.ok(filtered.body.some((c) => c.id === cid(chat)));
  });

  it('每会话每小时上限：达到后转人工（rate_limit），带原因，标 needsHuman 并暂停', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { maxBotRepliesPerChatPerHour: 2 } } });
    const chat = newChat();
    for (let i = 1; i <= 2; i++) {
      await send(chat, `保温杯价格 ${i}`);
      await waitDecided(t, cid(chat), i);
    }
    await send(chat, '保温杯价格 3');
    const msgs = await waitDecided(t, cid(chat), 3);
    const last = msgs.filter((m) => m.direction === 'in').at(-1);
    assert.equal(last.botDecision, 'handoff');
    assert.match(last.decisionReason, /回复次数超限/);
    assert.equal(fake.sentTo(chat).length, 2);
    const conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, true);
    assert.equal(conv.botPaused, true);
  });

  it('转人工：不给客户发消息，带原因（F9），标 needsHuman 并暂停；恢复机器人清掉 needsHuman', async () => {
    const chat = newChat();
    await send(chat, '我要找人工');
    const msgs = await waitDecided(t, cid(chat), 1);
    assert.equal(msgs[0].botDecision, 'handoff');
    assert.equal(msgs[0].decisionReason, '客户要求人工');
    await sleep(200);
    assert.equal(fake.sentTo(chat).length, 0);
    let conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, true);
    assert.equal(conv.botPaused, true);
    await send(chat, '保温杯多少钱');
    const m2 = await waitDecided(t, cid(chat), 2);
    const skipped = m2.filter((m) => m.direction === 'in').at(-1);
    assert.equal(skipped.botDecision, 'skipped');
    assert.match(skipped.decisionReason, /暂停/);
    const r = await t.req('POST', `${convPath(cid(chat))}/bot`, { body: { paused: false } });
    assert.equal(r.body.botPaused, false);
    assert.equal(r.body.needsHuman, false);
    conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, false);
    assert.equal((await t.req('POST', `${convPath(cid(chat))}/bot`, { body: { paused: 'x' } })).status, 400);
  });

  it('客户要折扣、离题：不回复；原因写在客户消息上', async () => {
    const chat = newChat();
    await send(chat, '能便宜点吗？有折扣吗');
    let msgs = await waitDecided(t, cid(chat), 1);
    assert.equal(msgs[0].botDecision, 'handoff');
    assert.equal(msgs[0].decisionReason, '客户要求打折');
    const chat2 = newChat();
    await send(chat2, '帮我写代码');
    msgs = await waitDecided(t, cid(chat2), 1);
    assert.equal(msgs[0].botDecision, 'offtopic');
    assert.match(msgs[0].decisionReason, /^离题：/);
    await sleep(150);
    assert.equal(fake.sentTo(chat).length + fake.sentTo(chat2).length, 0);
  });

  it('人工发送：via=admin、记下发送人，暂停机器人，立即发出；发送失败记 failed', async () => {
    const chat = newChat();
    await send(chat, '你好');
    await waitDecided(t, cid(chat), 1);
    const me = (await t.req('GET', '/api/auth/me')).body.user;
    const r = await t.req('POST', `${convPath(cid(chat))}/send`, { body: { text: '我是店长，稍后联系您' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.author, 'operator');
    assert.equal(r.body.via, 'admin');
    assert.equal(r.body.sentByUserId, me.id);
    assert.equal(r.body.sentByName, me.name);
    assert.equal(r.body.status, 'sent');
    assert.ok(fake.sentTo(chat).some((m) => m.text === '我是店长，稍后联系您'));
    assert.equal((await getConv(t, cid(chat))).botPaused, true);
    fake.state.failSend = true;
    const f = await t.req('POST', `${convPath(cid(chat))}/send`, { body: { text: '再试一次' } });
    fake.state.failSend = false;
    assert.equal(f.body.status, 'failed');
    assert.ok(f.body.error);
    assert.equal((await t.req('POST', `${convPath(cid(chat))}/send`, { body: { text: '' } })).status, 400);
    assert.equal((await t.req('POST', `${convPath(`${acc.id}:nope@c.us`)}/send`, { body: { text: 'x' } })).status, 404);
  });

  it('非文字消息：没 caption 存成 [图片]，记原因并标 needsHuman、不回复；有 caption 当文本处理', async () => {
    const chat = newChat();
    await send(chat, '', { hasMedia: true, media: { mimetype: 'image/jpeg', url: 'http://x/y.jpg' } });
    const msgs = await waitDecided(t, cid(chat), 1);
    assert.equal(msgs[0].text, '[图片]');
    assert.equal(msgs[0].botDecision, 'skipped');
    assert.match(msgs[0].decisionReason, /非文字消息/);
    const conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, true);
    assert.equal(conv.botPaused, false);
    const chat2 = newChat();
    await send(chat2, '保温杯这个多少钱', { hasMedia: true, media: { mimetype: 'image/jpeg' } });
    const m2 = await waitDecided(t, cid(chat2), 1);
    assert.equal(m2[0].botDecision, 'replied');
    assert.equal(fake.sentTo(chat2).length, 1);
  });

  it('自动回复关闭时只存档，记 skipped 和原因', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { autoReply: false } });
    const chat = newChat();
    await send(chat, '保温杯多少钱');
    const msgs = await waitDecided(t, cid(chat), 1);
    assert.equal(msgs[0].botDecision, 'skipped');
    assert.equal(msgs[0].decisionReason, '这个号没开自动回复');
    await sleep(150);
    assert.equal(fake.sentTo(chat).length, 0);
  });
});

describe('WAHA 黑白名单（按号）', () => {
  let t;
  let fake;
  let acc;
  const send = (from, body) => wahaSend(t, acc, from, body);
  const stored = async (chatId) => !!(await getConv(t, convIdOf(acc, chatId)));
  const setScope = (body) => t.req('PUT', `/api/accounts/${acc.id}`, { body });
  before(async () => {
    ({ t, fake, acc } = await setup({ waha: { lids: { '111111111111111@lid': '8613911112222', '222222222222222@lid': null } } }));
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('all + 黑名单：黑名单号码不存档不回复，其他照常；号码规范化', async () => {
    const r = await setScope({ scope: 'all', allowlist: [], blocklist: ['+86 137 0000 0001'] });
    assert.deepEqual(r.body.blocklist, ['8613700000001']);
    await send('8613700000001@c.us', '保温杯多少钱');
    await send('8613700000002@c.us', '保温杯多少钱');
    await waitDecided(t, convIdOf(acc, '8613700000002@c.us'), 1);
    await sleep(250);
    assert.equal(await stored('8613700000001@c.us'), false);
    assert.equal(fake.sentTo('8613700000001@c.us').length, 0);
    assert.equal(fake.sentTo('8613700000002@c.us').length, 1);
  });

  it('allowlist：只处理白名单；黑名单优先于白名单', async () => {
    await setScope({ scope: 'allowlist', allowlist: ['8613700000011', '8613700000012'], blocklist: ['8613700000012'] });
    await send('8613700000011@c.us', '保温杯多少钱');
    await send('8613700000012@c.us', '保温杯多少钱');
    await send('8613700000013@c.us', '保温杯多少钱');
    await waitDecided(t, convIdOf(acc, '8613700000011@c.us'), 1);
    await sleep(250);
    assert.equal(fake.sentTo('8613700000011@c.us').length, 1);
    assert.equal(await stored('8613700000012@c.us'), false, '黑名单优先');
    assert.equal(await stored('8613700000013@c.us'), false, '不在白名单的不存档');
  });

  it('@lid：能换算的按手机号匹配；换算不出时 allowlist 视为范围外、all 照常处理', async () => {
    await setScope({ scope: 'allowlist', allowlist: ['8613911112222'], blocklist: [] });
    await send('111111111111111@lid', '保温杯多少钱');
    await send('222222222222222@lid', '保温杯多少钱');
    await waitDecided(t, convIdOf(acc, '111111111111111@lid'), 1);
    await sleep(250);
    assert.equal((await getConv(t, convIdOf(acc, '111111111111111@lid'))).contactNumber, '8613911112222');
    assert.equal(fake.sentTo('111111111111111@lid').length, 1);
    assert.equal(await stored('222222222222222@lid'), false);
    assert.ok(fake.state.requests.some((r) => r.path === `/api/${acc.waha.sessionName}/lids/${encodeURIComponent('111111111111111@lid')}`));

    await setScope({ scope: 'all', allowlist: [], blocklist: ['8613911112222'] });
    await send('111111111111111@lid', '再问一下');
    await send('222222222222222@lid', '保温杯多少钱');
    await waitDecided(t, convIdOf(acc, '222222222222222@lid'), 1);
    await sleep(250);
    assert.equal(fake.sentTo('222222222222222@lid').length, 1, '换算不出时 all 模式照常处理');
    assert.ok(t.log.lines.some((l) => l.includes('222222222222222@lid') && l.includes('黑名单无法匹配')));
    const msgs = await getMessages(t, convIdOf(acc, '111111111111111@lid'));
    assert.equal(msgs.filter((m) => m.direction === 'in').length, 1, 'lid 换算出的号码在黑名单里，不存档');
  });
});

describe('WAHA 二维码、登出、代理、配置指纹', () => {
  it('二维码只在 scan_qr 状态返回 png，否则 409；登出调用 logout 和 stop', async () => {
    const { t, fake, acc } = await setup({ waha: { initialStatus: 'SCAN_QR_CODE' } });
    const name = acc.waha.sessionName;
    try {
      const st = await t.req('GET', `/api/accounts/${acc.id}`);
      assert.equal(st.body.status.state, 'scan_qr');
      const qr = await t.req('GET', `/api/accounts/${acc.id}/waha/qr`);
      assert.equal(qr.status, 200);
      assert.match(qr.headers.get('content-type'), /image\/png/);
      assert.deepEqual(qr.body, TINY_PNG);
      fake.state.sessions.get(name).status = 'WORKING';
      const no = await t.req('GET', `/api/accounts/${acc.id}/waha/qr`);
      assert.equal(no.status, 409);
      assert.equal(no.body.code, 'not_scan_qr');
      const out = await t.req('POST', `/api/accounts/${acc.id}/waha/logout`);
      assert.equal(out.status, 200);
      const paths = fake.state.requests.map((r) => `${r.method} ${r.path}`);
      assert.ok(paths.includes(`POST /api/sessions/${name}/logout`));
      assert.ok(paths.includes(`POST /api/sessions/${name}/stop`));
      assert.equal(out.body.state, 'stopped');
    } finally {
      await t.close();
      await fake.close();
    }
  });

  it('WAHA 连不上时 state 为 failed 并带 error；start 返回 502', async () => {
    const t = await startApp();
    try {
      await t.login();
      const acc = await t.createAccount();
      assert.equal(acc.status.state, 'failed');
      assert.ok(acc.status.error);
      const start = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
      assert.equal(start.status, 502);
    } finally {
      await t.close();
    }
  });

  it('http 代理：start 时写进 session 配置；改代理会 PUT 新配置；关掉后去掉 proxy；改别的不触发', async () => {
    const fake = await startFakeWaha();
    const t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url, INKDOVE_WAHA_API_KEY: 'waha-key' } });
    try {
      await t.login();
      const proxy = { enabled: true, protocol: 'http', host: 'host.docker.internal', port: 3128, username: 'user@corp', password: 'p/w#1' };
      const acc = await t.createAccount({ waha: { proxy } });
      const name = acc.waha.sessionName;
      assert.equal(fake.state.requests.filter((r) => r.method !== 'GET').length, 0, '没 start 过不建 session');
      await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
      const create = fake.state.requests.find((r) => r.method === 'POST' && r.path === '/api/sessions');
      assert.equal(create.headers['x-api-key'], 'waha-key');
      assert.deepEqual(create.body.config.proxy, {
        server: 'host.docker.internal:3128',
        username: encodeURIComponent('user@corp'),
        password: encodeURIComponent('p/w#1'),
      });
      const puts = () => fake.state.requests.filter((r) => r.method === 'PUT' && r.path === `/api/sessions/${name}`);
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { port: 8080 } } } });
      assert.equal(puts().length, 1);
      assert.equal(puts()[0].body.config.proxy.server, 'host.docker.internal:8080');
      assert.equal(puts()[0].body.config.webhooks[0].url, 'http://127.0.0.1:8794/webhooks/waha');
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { persona: 'x', autoReply: true } });
      assert.equal(puts().length, 1, '改别的设置不触发');
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: false } } } });
      assert.equal(puts().length, 2);
      assert.equal(puts().at(-1).body.config.proxy, undefined);
      const got = await t.req('GET', `/api/accounts/${acc.id}`);
      assert.equal(got.body.waha.proxy.passwordSet, true);
      assert.ok(!JSON.stringify(got.body).includes('p/w#1'));
    } finally {
      await t.close();
      await fake.close();
    }
  });

  it('配置指纹：WAHA 读回来的配置把密码打码时，重复 start 也不会每次都 PUT（只在配置变了时 PUT）', async () => {
    const fake = await startFakeWaha({ maskSecrets: true });
    const t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    try {
      await t.login();
      const acc = await t.createAccount({
        waha: { proxy: { enabled: true, protocol: 'http', host: '10.0.0.8', port: 3128, username: 'u', password: 'secret-pw' } },
      });
      const puts = () => fake.state.requests.filter((r) => r.method === 'PUT').length;
      for (let i = 0; i < 3; i++) assert.equal((await t.req('POST', `/api/accounts/${acc.id}/waha/start`)).status, 200);
      assert.equal(puts(), 0, '第一次 create，后面两次配置没变，不 PUT');
      const hash = t.ctx.db.prepare('SELECT waha_config_hash FROM accounts WHERE id = ?').get(acc.id).waha_config_hash;
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.ok(!hash.includes('secret-pw'));
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { password: 'new-secret' } } } });
      assert.equal(puts(), 1, '密码变了 PUT 一次');
      await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
      assert.equal(puts(), 1);
    } finally {
      await t.close();
      await fake.close();
    }
  });
});
