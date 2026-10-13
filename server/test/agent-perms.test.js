// 业务员（agent）权限收紧：号级别的东西只给管理员。每一条都是 agent 403、admin 200；agent 读号时看不到 verifyToken 和通知收件人。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp, startFakeWaha } from './helpers.js';

describe('业务员权限收紧（号级设置、连接操作、线索导出只给 admin）', () => {
  let t;
  let fake;
  let agent;
  let wahaAcc;
  let metaAcc;
  const as = (method, p, body) => t.req(method, p, { body, cookie: agent.cookie });
  /** 假 WAHA 收到的这个号的写操作数 */
  const wahaOps = (acc) =>
    fake.state.requests.filter((r) => r.method !== 'GET' && (r.path.includes(acc.waha.sessionName) || r.body?.name === acc.waha.sessionName)).length;

  before(async () => {
    // 扫码号停在等扫码，二维码和配对码才拿得到
    fake = await startFakeWaha({ initialStatus: 'SCAN_QR_CODE' });
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url }, options: { wahaPairWaitMs: 300 } });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { email: { provider: 'smtp', from: 'bot@example.com', smtp: { host: 'smtp.example.com' } } } });
    wahaAcc = await t.createAccount({
      name: '扫码号',
      notify: { email: { enabled: true, to: ['boss@example.com'] }, whatsapp: { enabled: true, number: '+86 139 0000 0001' } },
    });
    metaAcc = await t.createAccount({
      name: '官方号',
      channel: 'meta',
      meta: { phoneNumberId: '1234567890', verifyToken: 'verify-xyz', accessToken: 'EAAG-token', appSecret: 'app-secret' },
      notify: { email: { enabled: true, to: ['sales@example.com'] }, whatsapp: { enabled: false, number: '8613900000002' } },
    });
    agent = await t.addMember({ email: 'perm-agent@example.com', name: '小吴', accountIds: [wahaAcc.id, metaAcc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('agent 读号（列表和详情）：meta.verifyToken 为 null，通知的邮箱和号码不返回（开关还在）；admin 都看得到', async () => {
    const list = (await as('GET', '/api/accounts')).body;
    assert.deepEqual(list.map((a) => a.id).sort(), [wahaAcc.id, metaAcc.id].sort());
    for (const a of [...list, (await as('GET', `/api/accounts/${metaAcc.id}`)).body, (await as('GET', `/api/accounts/${wahaAcc.id}`)).body]) {
      if (a.meta) assert.equal(a.meta.verifyToken, null);
      assert.deepEqual(a.notify.email.to, []);
      assert.equal(a.notify.whatsapp.number, '');
    }
    const m = (await as('GET', `/api/accounts/${metaAcc.id}`)).body;
    assert.equal(m.meta.phoneNumberId, '1234567890');
    assert.equal(m.notify.email.enabled, true);
    const w = (await as('GET', `/api/accounts/${wahaAcc.id}`)).body;
    assert.equal(w.notify.whatsapp.enabled, true);
    const text = JSON.stringify(list);
    for (const s of ['verify-xyz', 'boss@example.com', 'sales@example.com', '8613900000001', '8613900000002']) assert.ok(!text.includes(s), s);

    const am = (await t.req('GET', `/api/accounts/${metaAcc.id}`)).body;
    assert.equal(am.meta.verifyToken, 'verify-xyz');
    assert.deepEqual(am.notify.email.to, ['sales@example.com']);
    const aw = (await t.req('GET', '/api/accounts')).body.find((a) => a.id === wahaAcc.id);
    assert.equal(aw.notify.whatsapp.number, '8613900000001');
    assert.deepEqual(aw.notify.email.to, ['boss@example.com']);
  });

  it('PUT /api/accounts/:id：agent 改什么都 403（回复方式、人设、范围、名单、通知），什么都没改；admin 200', async () => {
    const before = JSON.stringify(t.ctx.accounts.get(wahaAcc.id));
    const bodies = [
      { replyMode: 'auto' },
      { autoReply: true },
      { persona: '新人设' },
      { scope: 'allowlist' },
      { allowlist: ['8613700000001'] },
      { blocklist: ['8613700000009'] },
      { notify: { email: { to: ['me@example.com'] } } },
      { notify: { email: { enabled: false } } },
      { notify: { whatsapp: { number: '8613700000002' } } },
      { notify: { whatsapp: { enabled: false } } },
      {},
    ];
    for (const body of bodies) {
      const r = await as('PUT', `/api/accounts/${wahaAcc.id}`, body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal(r.body.code, 'forbidden');
    }
    assert.equal(JSON.stringify(t.ctx.accounts.get(wahaAcc.id)), before);
    for (const body of bodies) {
      const r = await t.req('PUT', `/api/accounts/${wahaAcc.id}`, { body });
      assert.equal(r.status, 200, JSON.stringify(body));
    }
    const acc = t.ctx.accounts.get(wahaAcc.id);
    assert.equal(acc.replyMode, 'auto');
    assert.equal(acc.persona, '新人设');
    assert.deepEqual(acc.notify, { email: { enabled: false, to: ['me@example.com'] }, whatsapp: { enabled: false, number: '8613700000002' } });
    const meta = await as('PUT', `/api/accounts/${metaAcc.id}`, { meta: { verifyToken: 'x' } });
    assert.equal(meta.status, 403);
  });

  it('POST /api/accounts/:id/notify/test：agent 403，admin 200', async () => {
    const r = await as('POST', `/api/accounts/${metaAcc.id}/notify/test`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
    const ok = await t.req('POST', `/api/accounts/${wahaAcc.id}/notify/test`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('扫码连接、取二维码、配对码、登出：agent 403 且不碰 WAHA；admin 200', async () => {
    const n = wahaOps(wahaAcc);
    const cases = [
      ['POST', 'waha/start'],
      ['GET', 'waha/qr'],
      ['POST', 'waha/request-code', { phoneNumber: '+86 138 1234 5678' }],
      ['POST', 'waha/logout'],
    ];
    for (const [m, p, body] of cases) {
      const r = await as(m, `/api/accounts/${wahaAcc.id}/${p}`, body);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.code, 'forbidden', `${m} ${p}`);
    }
    assert.equal(wahaOps(wahaAcc), n, 'agent 的请求没有到 WAHA');
    for (const [m, p, body] of cases) {
      const r = await t.req(m, `/api/accounts/${wahaAcc.id}/${p}`, { body });
      assert.equal(r.status, 200, `${m} ${p} ${JSON.stringify(r.body).slice(0, 200)}`);
      if (p === 'waha/qr') assert.match(r.headers.get('content-type'), /^image\/png/);
    }
    assert.ok(wahaOps(wahaAcc) > n, 'admin 的请求到了 WAHA');
  });

  it('GET /api/leads/export.csv：agent 403（不论带不带筛选），admin 200；agent 仍能看线索列表', async () => {
    for (const q of ['', `?accountId=${wahaAcc.id}`, '?stage=inquiry']) {
      const r = await as('GET', `/api/leads/export.csv${q}`);
      assert.equal(r.status, 403, q);
      assert.equal(r.body.code, 'forbidden');
    }
    const ok = await t.req('GET', '/api/leads/export.csv');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/csv/);
    assert.equal((await as('GET', '/api/leads')).status, 200);
  });
});
