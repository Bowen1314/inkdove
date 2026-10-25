import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ADMIN_EMAIL, PASSWORD, quietLog, startApp } from './helpers.js';

const BASE_ENV = { INKDOVE_ADMIN_EMAIL: 'admin@example.com', INKDOVE_SESSION_SECRET: 'x', INKDOVE_WAHA_WEBHOOK_SECRET: 'y' };

describe('配置', () => {
  it('缺 INKDOVE_ADMIN_EMAIL 或 INKDOVE_ADMIN_PASSWORD 拒绝启动；密码少于 12 字符拒绝启动', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, INKDOVE_ADMIN_PASSWORD: 'short' }), /至少 12/);
    assert.throws(() => loadConfig({ ...BASE_ENV, INKDOVE_ADMIN_EMAIL: '', INKDOVE_ADMIN_PASSWORD: 'long-enough-pass' }), /INKDOVE_ADMIN_EMAIL/);
    assert.throws(() => loadConfig({ ...BASE_ENV }), /INKDOVE_ADMIN_PASSWORD/);
    assert.throws(() => loadConfig({ ...BASE_ENV, INKDOVE_ADMIN_EMAIL: 'not-an-email', INKDOVE_ADMIN_PASSWORD: 'long-enough-pass' }), /邮箱/);
    assert.throws(() => loadConfig({ INKDOVE_ADMIN_EMAIL: 'a@example.com', INKDOVE_ADMIN_PASSWORD: 'long-enough-pass' }), /INKDOVE_SESSION_SECRET/);
    assert.throws(
      () => loadConfig({ ...BASE_ENV, INKDOVE_ADMIN_PASSWORD: 'long-enough-pass', INKDOVE_PROXY_RELAY_PORT_BASE: '80' }),
      /INKDOVE_PROXY_RELAY_PORT_BASE/,
    );
  });

  it('不读取通用名的 LLM 环境变量；中继默认端口 18000、主机名 inkdove', () => {
    const c = loadConfig({
      ...BASE_ENV,
      INKDOVE_ADMIN_PASSWORD: 'long-enough-pass',
      LLM_API_KEY: 'should-not-be-read',
      OPENAI_API_KEY: 'should-not-be-read',
      LLM_BASE_URL: 'http://evil',
    });
    assert.equal(c.llmInit.apiKey, '');
    assert.equal(c.llmInit.baseUrl, '');
    assert.equal(c.proxyRelayPortBase, 18000);
    assert.equal(c.proxyRelayHost, 'inkdove');
    assert.equal(c.resendApiUrl, 'https://api.resend.com/emails');
  });

  it('第一次启动建 admin；之后改环境变量不影响已有账号', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-boot-'));
    const env = (pw) =>
      loadConfig({ ...BASE_ENV, INKDOVE_ADMIN_EMAIL: 'Boss@Example.com', INKDOVE_ADMIN_PASSWORD: pw, INKDOVE_DATA_DIR: dataDir, INKDOVE_LLM_MOCK: '1' });
    const log = quietLog();
    const a = createApp(env('first-password-1'), { log, relayBindHost: '127.0.0.1' });
    await a.ready;
    const rows = a.ctx.db.prepare('SELECT email, role, name, password_hash FROM users').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'boss@example.com');
    assert.equal(rows[0].role, 'admin');
    assert.match(rows[0].password_hash, /^scrypt\$/);
    assert.ok(!rows[0].password_hash.includes('first-password-1'));
    assert.ok(log.lines.some((l) => l.includes('已创建第一个管理员')));
    await a.close();
    const b = createApp(env('second-password-2'), { log, relayBindHost: '127.0.0.1' });
    await b.ready;
    const again = b.ctx.db.prepare('SELECT password_hash FROM users').all();
    assert.equal(again.length, 1);
    assert.equal(again[0].password_hash, rows[0].password_hash, '已有账号不受新环境变量影响');
    await b.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('登录和会话', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  it('health 不需要登录；没登录时 accounts 为空', async () => {
    const r = await t.req('GET', '/api/health', { auth: false });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['accounts', 'llmConfigured', 'mock', 'ok', 'version']);
    assert.equal(r.body.mock, true);
    assert.deepEqual(r.body.accounts, []);
  });

  it('未登录访问受保护接口返回 401 unauthorized', async () => {
    for (const p of ['/api/kb/entries', '/api/settings', '/api/auth/me', '/api/wa/conversations', '/api/users', '/api/accounts']) {
      const r = await t.req('GET', p, { auth: false });
      assert.equal(r.status, 401, p);
      assert.deepEqual(r.body, { error: '未登录', code: 'unauthorized' });
    }
  });

  it('邮箱不存在和密码错误都返回 401 bad_credentials，提示相同', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.201' };
    const a = await t.req('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong-password' }, auth: false, headers: ip });
    const b = await t.req('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password' }, auth: false, headers: ip });
    assert.equal(a.status, 401);
    assert.equal(a.body.code, 'bad_credentials');
    assert.deepEqual(a.body, b.body);
  });

  it('登录成功下发 httpOnly + SameSite=Lax 的签名 cookie，30 天；邮箱不分大小写；me 返回 User', async () => {
    const res = await t.login(ADMIN_EMAIL.toUpperCase());
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /^inkdove_session=[^;]+\.[^;]+;/);
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Max-Age=2592000/);
    const body = await res.json();
    assert.equal(body.user.email, ADMIN_EMAIL);
    assert.ok(!('profile' in body.user) && !('stylePrompt' in body.user), '登录返回不带个人话术和「我的资料」');
    const me = await t.req('GET', '/api/auth/me');
    assert.deepEqual(Object.keys(me.body.user).sort(), [
      'accountIds',
      'createdAt',
      'disabled',
      'email',
      'id',
      'lastLoginAt',
      'name',
      'pending',
      'profile',
      'role',
      'stylePrompt',
    ]);
    assert.deepEqual(me.body.user.profile, { displayName: '', jobTitle: '', contactPhone: '', contactEmail: '', bio: '' });
    assert.equal(me.body.user.role, 'admin');
    assert.equal(me.body.user.pending, false);
    assert.ok(me.body.user.lastLoginAt);
    assert.ok(!JSON.stringify(me.body).includes('scrypt'));
  });

  it('篡改签名的 cookie 无效', async () => {
    const forged = `${t.cookie.slice(0, -3)}abc`;
    const r = await t.req('GET', '/api/auth/me', { auth: false, headers: { cookie: forged } });
    assert.equal(r.status, 401);
  });

  it('同一 IP 每分钟失败 5 次后 429（正确密码也拒绝）；别的 IP 不受影响', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.77' };
    for (let i = 0; i < 5; i++) {
      const r = await t.req('POST', '/api/auth/login', { body: { email: `x${i}@example.com`, password: `bad-${i}` }, auth: false, headers: ip });
      assert.equal(r.status, 401);
    }
    const blocked = await t.req('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: PASSWORD }, auth: false, headers: ip });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'rate_limited');
    const other = await t.req('POST', '/api/auth/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD },
      auth: false,
      headers: { 'x-forwarded-for': '203.0.113.78' },
    });
    assert.equal(other.status, 200);
  });

  it('同一邮箱每分钟失败 5 次后 429（换 IP 也一样）', async () => {
    const m = await t.addMember({ email: 'victim@example.com' });
    for (let i = 0; i < 5; i++) {
      const r = await t.req('POST', '/api/auth/login', {
        body: { email: 'victim@example.com', password: `bad-${i}` },
        auth: false,
        headers: { 'x-forwarded-for': `203.0.113.${100 + i}` },
      });
      assert.equal(r.status, 401);
    }
    const blocked = await t.req('POST', '/api/auth/login', {
      body: { email: 'victim@example.com', password: m.password },
      auth: false,
      headers: { 'x-forwarded-for': '203.0.113.120' },
    });
    assert.equal(blocked.status, 429);
  });

  it('退出后 cookie 失效', async () => {
    const r = await t.req('POST', '/api/auth/logout');
    assert.deepEqual(r.body, { ok: true });
    const me = await t.req('GET', '/api/auth/me');
    assert.equal(me.status, 401);
  });
});

describe('成员：邀请、重置、停用、最后一个 admin', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(() => t.close());

  const tokenOf = (url) => url.split('/invite/')[1];

  it('邀请：inviteUrl 格式、预览、接受后直接登录；token 只能用一次', async () => {
    const r = await t.req('POST', '/api/users', { body: { email: 'Agent1@Example.com', name: '小王', role: 'agent', accountIds: [] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.inviteUrl, /^https:\/\/kb\.example\.com\/invite\/[A-Za-z0-9_-]{30,}$/);
    assert.equal(r.body.user.email, 'agent1@example.com');
    assert.equal(r.body.user.pending, true);
    const token = tokenOf(r.body.inviteUrl);
    // token 只存哈希
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM invites WHERE token_hash = ?').get(token).n, 0);
    const info = await t.req('GET', `/api/invites/${token}`, { auth: false });
    assert.deepEqual(info.body, { email: 'agent1@example.com', name: '小王', role: 'agent', kind: 'invite' });
    // 没激活前不能登录
    const early = await t.req('POST', '/api/auth/login', { body: { email: 'agent1@example.com', password: 'whatever-123' }, auth: false });
    assert.equal(early.status, 401);
    const weak = await t.req('POST', `/api/invites/${token}/accept`, { body: { password: 'short' }, auth: false });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.code, 'weak_password');
    const ok = await t.req('POST', `/api/invites/${token}/accept`, { body: { name: '王小明', password: 'agent-password-1' }, auth: false });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, '王小明');
    assert.equal(ok.body.user.pending, false);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const me = await t.req('GET', '/api/auth/me', { cookie });
    assert.equal(me.body.user.email, 'agent1@example.com');
    const again = await t.req('POST', `/api/invites/${token}/accept`, { body: { password: 'agent-password-2' }, auth: false });
    assert.equal(again.status, 404);
    assert.equal((await t.req('GET', `/api/invites/${token}`, { auth: false })).status, 404);
    assert.equal((await t.req('GET', '/api/invites/not-a-real-token-xxxxxxxxxxxxxxxx', { auth: false })).status, 404);
  });

  it('过期的邀请失效；重复邮箱 409；参数不对 400', async () => {
    const r = await t.req('POST', '/api/users', { body: { email: 'late@example.com', name: '晚到', role: 'agent' } });
    const token = tokenOf(r.body.inviteUrl);
    t.ctx.db.prepare('UPDATE invites SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), r.body.user.id);
    assert.equal((await t.req('GET', `/api/invites/${token}`, { auth: false })).status, 404);
    assert.equal((await t.req('POST', `/api/invites/${token}/accept`, { body: { password: 'late-password-1' }, auth: false })).status, 404);
    const dup = await t.req('POST', '/api/users', { body: { email: 'LATE@example.com', name: 'x', role: 'agent' } });
    assert.equal(dup.status, 409);
    for (const body of [
      { email: 'bad', name: 'x', role: 'agent' },
      { email: 'ok1@example.com', name: 'x', role: 'owner' },
      { email: 'ok2@example.com', name: 'x', role: 'agent', accountIds: ['no-such-account'] },
    ]) {
      assert.equal((await t.req('POST', '/api/users', { body })).status, 400, JSON.stringify(body));
    }
  });

  it('重置密码：生成 reset 链接，旧密码失效、旧会话失效，新密码能登录', async () => {
    const m = await t.addMember({ email: 'reset@example.com', name: '要重置的人' });
    const link = await t.req('POST', `/api/users/${m.user.id}/reset-link`);
    assert.match(link.body.resetUrl, /^https:\/\/kb\.example\.com\/invite\//);
    const token = tokenOf(link.body.resetUrl);
    const info = await t.req('GET', `/api/invites/${token}`, { auth: false });
    assert.equal(info.body.kind, 'reset');
    const ok = await t.req('POST', `/api/invites/${token}/accept`, { body: { password: 'brand-new-pass-1' }, auth: false });
    assert.equal(ok.status, 200);
    assert.equal((await t.req('GET', '/api/auth/me', { cookie: m.cookie })).status, 401, '旧会话失效');
    await assert.rejects(t.loginAs('reset@example.com', m.password));
    await t.loginAs('reset@example.com', 'brand-new-pass-1');
  });

  it('改密码：当前密码错误 400；改完这个人的其他会话失效，当前会话保留', async () => {
    const m = await t.addMember({ email: 'pw@example.com' });
    const other = await t.loginAs('pw@example.com', m.password);
    const bad = await t.req('POST', '/api/auth/password', { cookie: m.cookie, body: { currentPassword: 'nope', newPassword: 'another-pass-1' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'wrong_password');
    const weak = await t.req('POST', '/api/auth/password', { cookie: m.cookie, body: { currentPassword: m.password, newPassword: 'short' } });
    assert.equal(weak.body.code, 'weak_password');
    const ok = await t.req('POST', '/api/auth/password', { cookie: m.cookie, body: { currentPassword: m.password, newPassword: 'another-pass-1' } });
    assert.equal(ok.status, 200);
    assert.equal((await t.req('GET', '/api/auth/me', { cookie: m.cookie })).status, 200);
    assert.equal((await t.req('GET', '/api/auth/me', { cookie: other })).status, 401);
  });

  it('停用后会话立即失效，再登录 403 account_disabled；启用后可以登录', async () => {
    const m = await t.addMember({ email: 'off@example.com' });
    const r = await t.req('PUT', `/api/users/${m.user.id}`, { body: { disabled: true } });
    assert.equal(r.body.disabled, true);
    assert.equal((await t.req('GET', '/api/auth/me', { cookie: m.cookie })).status, 401);
    const login = await t.req('POST', '/api/auth/login', { body: { email: 'off@example.com', password: m.password }, auth: false });
    assert.equal(login.status, 403);
    assert.equal(login.body.code, 'account_disabled');
    assert.equal((await t.req('POST', `/api/users/${m.user.id}/reset-link`)).status, 400);
    await t.req('PUT', `/api/users/${m.user.id}`, { body: { disabled: false } });
    await t.loginAs('off@example.com', m.password);
  });

  it('不能删除、停用或降级最后一个启用中的 admin；有第二个 admin 后可以', async () => {
    const me = (await t.req('GET', '/api/auth/me')).body.user;
    for (const [method, body] of [
      ['PUT', { role: 'agent' }],
      ['PUT', { disabled: true }],
      ['DELETE', undefined],
    ]) {
      const r = await t.req(method, `/api/users/${me.id}`, { body });
      assert.equal(r.status, 400, method);
      assert.equal(r.body.code, 'last_admin');
    }
    const second = await t.addMember({ email: 'admin2@example.com', role: 'admin' });
    const demote = await t.req('PUT', `/api/users/${second.user.id}`, { body: { role: 'agent' } });
    assert.equal(demote.status, 200);
    assert.equal(demote.body.role, 'agent');
    await t.req('PUT', `/api/users/${second.user.id}`, { body: { role: 'admin' } });
    // 还没激活的 admin 不算"启用中"
    const pending = await t.req('POST', '/api/users', { body: { email: 'pending-admin@example.com', name: 'p', role: 'admin' } });
    assert.equal(pending.body.user.pending, true);
    const del = await t.req('DELETE', `/api/users/${second.user.id}`);
    assert.equal(del.status, 200);
    assert.equal((await t.req('GET', '/api/auth/me', { cookie: second.cookie })).status, 401, '删除后会话失效');
    assert.equal((await t.req('DELETE', `/api/users/${me.id}`)).body.code, 'last_admin');
  });

  it('成员列表含 pending 状态；密码哈希不出现在接口里', async () => {
    const r = await t.req('GET', '/api/users');
    assert.ok(r.body.some((u) => u.pending === true));
    assert.ok(r.body.some((u) => u.email === ADMIN_EMAIL && u.role === 'admin'));
    assert.ok(!JSON.stringify(r.body).includes('scrypt'));
  });
});

describe('权限：agent 调 admin 接口返回 403', () => {
  let t;
  let agent;
  before(async () => {
    t = await startApp();
    await t.login();
    const acc = await t.createAccount({ name: '号 A' });
    agent = await t.addMember({ email: 'agent@example.com', accountIds: [acc.id] });
    agent.acc = acc;
  });
  after(() => t.close());

  it('设置、成员、资料、整理、知识库增删改、缺口、号的新建删除、代理、Meta 凭证 → 403 forbidden', async () => {
    const id = agent.acc.id;
    const cases = [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings', { reply: { persona: 'x' } }],
      ['POST', '/api/settings/email/test', { to: 'a@example.com' }],
      ['GET', '/api/users'],
      ['POST', '/api/users', { email: 'x@example.com', name: 'x', role: 'agent' }],
      ['GET', '/api/sources'],
      ['GET', '/api/distill/jobs'],
      ['POST', '/api/distill', {}],
      ['POST', '/api/kb/entries', { type: 'faq', title: 'q', content: 'a' }],
      ['PUT', '/api/kb/profile', { companyName: 'x' }],
      ['GET', '/api/kb/gaps'],
      ['POST', '/api/accounts', { name: 'x', channel: 'waha' }],
      ['DELETE', `/api/accounts/${id}`],
      ['PUT', `/api/accounts/${id}`, { name: '改名' }],
      ['PUT', `/api/accounts/${id}`, { waha: { proxy: { enabled: false } } }],
      ['POST', `/api/accounts/${id}/proxy/test`],
    ];
    for (const [method, p, body] of cases) {
      const r = await t.req(method, p, { cookie: agent.cookie, body });
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.deepEqual(r.body, { error: '无权限', code: 'forbidden' });
    }
  });

  it('agent 能浏览条目和画像、看统计、测试对话', async () => {
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '价格 59 元' } });
    for (const p of ['/api/kb/entries', '/api/kb/profile', '/api/kb/stats', '/api/auth/me']) {
      assert.equal((await t.req('GET', p, { cookie: agent.cookie })).status, 200, p);
    }
    const ask = await t.req('POST', '/api/kb/ask', { cookie: agent.cookie, body: { message: '保温杯多少钱' } });
    assert.equal(ask.body.decision, 'replied');
  });
});

describe('全局设置（F7 / F10 之后的结构）', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(() => t.close());

  it('GET 返回规格里的结构和默认值', async () => {
    const r = await t.req('GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      llm: { format: 'openai', baseUrl: '', model: '', distillModel: '', apiKeySet: false, apiKeyLast4: null },
      embedding: { enabled: false, source: 'llm', format: 'openai', baseUrl: '', model: '', apiKeySet: false, apiKeyLast4: null },
      rerank: { enabled: false, baseUrl: '', model: '', apiKeySet: false, apiKeyLast4: null },
      reply: { persona: '', debounceSeconds: 4, maxBotRepliesPerChatPerHour: 20, humanize: true },
      media: { voice: false, image: false, mediaModel: '', transcribeModel: '' },
      leads: { enabled: true },
      email: {
        provider: null,
        from: '',
        smtp: { host: '', port: 465, secure: true, user: '', passwordSet: false },
        resend: { apiKeySet: false, apiKeyLast4: null },
      },
      branding: { title: '', logoSet: false, logoUrl: null },
      pricing: [],
      outreach: { dailyCapPerAccount: 30, minIntervalSeconds: 90, maxIntervalSeconds: 240, windowStart: '09:00', windowEnd: '20:00' },
      suggest: { companyPrompt: '' },
      translation: {
        mode: 'ai',
        provider: 'deepl',
        fallbackToAi: true,
        providers: {
          deepl: { ready: false, apiKeySet: false, apiKeyLast4: null },
          deeplx: { ready: false, urlSet: false, urlDisplay: '', tokenSet: false, tokenLast4: null },
          azure: { ready: false, apiKeySet: false, apiKeyLast4: null, region: '', endpoint: '' },
          google: { ready: false, apiKeySet: false, apiKeyLast4: null },
          tencent: { ready: false, secretIdSet: false, secretIdLast4: null, secretKeySet: false, secretKeyLast4: null, region: 'ap-guangzhou' },
          baidu: { ready: false, appIdSet: false, appIdLast4: null, appKeySet: false, appKeyLast4: null },
          volcengine: { ready: false, accessKeyIdSet: false, accessKeyIdLast4: null, secretAccessKeySet: false, secretAccessKeyLast4: null },
          libretranslate: { ready: false, url: '', apiKeySet: false, apiKeyLast4: null },
        },
      },
      blockwords: { enabled: false, words: [], aiCheck: false },
      proxy: { enabled: false, source: 'subscription', node: '', bypass: [], subscriptionUrlSet: false },
      webhookBase: 'https://kb.example.com',
    });
  });

  it('PUT 部分更新；密钥只写不回传', async () => {
    const r = await t.req('PUT', '/api/settings', {
      body: {
        llm: { apiKey: 'sk-secret-ABCD', model: 'gpt-x', format: 'anthropic' },
        reply: { persona: '客服小王', humanize: false },
        email: { provider: 'resend', from: 'Inkdove <notify@example.com>', resend: { apiKey: 're_secret_WXYZ' }, smtp: { password: 'smtp-pass', port: 587, secure: false } },
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.llm.apiKeySet, true);
    assert.equal(r.body.llm.apiKeyLast4, 'ABCD');
    assert.equal(r.body.reply.persona, '客服小王');
    assert.equal(r.body.reply.humanize, false);
    assert.deepEqual(r.body.email.resend, { apiKeySet: true, apiKeyLast4: 'WXYZ' });
    assert.equal(r.body.email.smtp.passwordSet, true);
    assert.equal(r.body.email.smtp.port, 587);
    const all = JSON.stringify((await t.req('GET', '/api/settings')).body);
    for (const secret of ['sk-secret-ABCD', 'smtp-pass', 're_secret_WXYZ']) assert.ok(!all.includes(secret), secret);
    const cleared = await t.req('PUT', '/api/settings', { body: { llm: { apiKey: '' } } });
    assert.equal(cleared.body.llm.apiKeySet, false);
  });

  it('非法值返回 400', async () => {
    for (const body of [
      { reply: { debounceSeconds: -1 } },
      { reply: { humanize: 'yes' } },
      { llm: { format: 'claude' } },
      { email: { provider: 'sendgrid' } },
      { email: { smtp: { port: 70000 } } },
    ]) {
      const r = await t.req('PUT', '/api/settings', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.error && r.body.code);
    }
  });

  it('mock 模式下测试模型连接成功；未知接口 404', async () => {
    const r = await t.req('POST', '/api/settings/llm/test');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.model, 'mock');
    const nope = await t.req('GET', '/api/nope');
    assert.equal(nope.status, 404);
    assert.equal(nope.body.code, 'not_found');
    // 第一期的接口已删除（/api/settings/proxy/test 现在是全局代理的测试，见 global-proxy.test.js）
    for (const p of ['/api/wa/status', '/api/settings/notify/test', '/api/wa/waha/start']) {
      const m = p.endsWith('status') ? 'GET' : 'POST';
      assert.equal((await t.req(m, p)).status, 404, p);
    }
  });
});
