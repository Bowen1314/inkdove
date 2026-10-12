import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import nodemailer from 'nodemailer';
import { smtpOptions } from '../src/email.js';
import { F3_USAGE_FOOTER } from '../src/wa/notify.js';
import {
  aiHooks,
  convIdOf,
  convPath,
  getConv,
  sleep,
  startApp,
  startFakeWaha,
  waitDecided,
  waitFor,
  wahaSend,
} from './helpers.js';

const NOTIFY_NUMBER = '8613900000000';
const NOTIFY_CHAT = `${NOTIFY_NUMBER}@c.us`;
const SMTP = { host: 'smtp.example.com', port: 465, secure: true, user: 'bot@example.com', password: 'smtp-secret' };

/** 用 nodemailer 的 jsonTransport 代替真实 SMTP，记录发出的邮件和连接参数 */
function mailStub() {
  const mail = { sent: [], opts: [], fail: false };
  mail.create = (opts) => {
    mail.opts.push(opts);
    const tr = nodemailer.createTransport({ jsonTransport: true });
    return {
      async sendMail(m) {
        if (mail.fail) throw new Error('SMTP 连接被拒绝');
        const info = await tr.sendMail(m);
        mail.sent.push(JSON.parse(info.message));
        return info;
      },
      close() {},
    };
  };
  return mail;
}

/** 假 Resend：mode = ok | 422 | 403domain | 429once | 429always（错误体按 https://resend.com/docs/api-reference/errors） */
async function startFakeResend() {
  const state = { requests: [], mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    state.requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (state.mode === '422') {
      return json(422, {
        statusCode: 422,
        name: 'invalid_parameter',
        message: 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.',
      });
    }
    if (state.mode === '403domain') {
      return json(403, { statusCode: 403, name: 'validation_error', message: 'The example.com domain is not verified. Please, add and verify your domain.' });
    }
    if (state.mode === '429always' || (state.mode === '429once' && state.requests.length % 2 === 1)) {
      return json(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }, { 'retry-after': '1' });
    }
    json(200, { id: `49a3999c-0ce1-4ea6-ab68-afcd6dc2e79${state.requests.length}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/emails`,
    state,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

let seq = 0;
const newChat = () => `86135${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('转人工通知（按号；邮件走全局 SMTP）', () => {
  let t;
  let fake;
  let mail;
  let hooks;
  let acc;
  const send = (from, body, extra) => wahaSend(t, acc, from, body, extra);
  const cid = (chat) => convIdOf(acc, chat);
  const notices = () => fake.sentTo(NOTIFY_CHAT);
  before(async () => {
    fake = await startFakeWaha();
    mail = mailStub();
    hooks = await aiHooks();
    t = await startApp({
      env: { KBWA_WAHA_URL: fake.url },
      options: { createMailTransport: mail.create, aiOverrides: hooks.overrides },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', {
      body: { reply: { debounceSeconds: 0.05 }, email: { provider: 'smtp', from: 'KBWA <bot@example.com>', smtp: SMTP } },
    });
    acc = await t.createAccount({
      name: '销售一号',
      autoReply: true,
      notify: { email: { enabled: true, to: ['boss@example.com'] }, whatsapp: { enabled: true, number: `+${NOTIFY_NUMBER}` } },
    });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('客户要人工：不给客户发消息；WhatsApp + 邮件通知，含号名、客户、原因、最近消息、链接和 F3 用法；通知 id 记下来', async () => {
    const chat = newChat();
    const number = chat.replace('@c.us', '');
    const before = notices().length;
    await send(chat, '你好', { pushName: '李女士' });
    await waitDecided(t, cid(chat), 1);
    await send(chat, '我要找人工客服');
    const msgs = await waitDecided(t, cid(chat), 2);
    assert.equal(msgs.filter((m) => m.direction === 'in').at(-1).botDecision, 'handoff');
    await waitFor(() => notices().length === before + 1 && mail.sent.length >= 1);
    assert.equal(fake.sentTo(chat).length, 1, '只有之前那句寒暄，转人工时没给客户发消息');
    const notice = notices().at(-1);
    assert.equal(notice.session, acc.waha.sessionName, '通知由这个号自己发出');
    const wa = notice.text;
    const link = `https://kb.example.com/whatsapp?chat=${encodeURIComponent(cid(chat))}`;
    assert.match(wa, new RegExp(`^\\[待人工\\] 客户 \\+${number}：`));
    assert.ok(wa.includes('号：销售一号'), wa);
    assert.ok(wa.includes(`客户：李女士（+${number}）`), wa);
    assert.ok(wa.includes('原因：客户要求人工'), wa);
    assert.ok(wa.includes('- 你好') && wa.includes('- 我要找人工客服'), wa);
    assert.ok(wa.includes(link), wa);
    assert.ok(wa.endsWith(F3_USAGE_FOOTER), wa);
    const row = t.ctx.db.prepare('SELECT * FROM notice_messages WHERE external_id = ?').get(notice.id);
    assert.equal(row.conversation_id, cid(chat));
    assert.equal(row.account_id, acc.id);
    const email = mail.sent.at(-1);
    assert.match(email.subject, new RegExp(`^\\[待人工\\] 客户 \\+${number}：`));
    assert.deepEqual(email.to.map((x) => x.address), ['boss@example.com']);
    assert.equal(email.from.address, 'bot@example.com');
    assert.equal(email.from.name, 'KBWA');
    assert.ok(email.text.includes(link));
    assert.ok(!email.text.includes(F3_USAGE_FOOTER), '邮件里不带 WhatsApp 用法');
    const opts = mail.opts.at(-1);
    assert.equal(opts.host, 'smtp.example.com');
    assert.equal(opts.port, 465);
    assert.equal(opts.secure, true);
    assert.deepEqual(opts.auth, { user: 'bot@example.com', pass: 'smtp-secret' });
    assert.ok(!t.log.lines.some((l) => l.includes('smtp-secret')), '日志里没有 SMTP 密码');
  });

  it('needsHuman 保持期间不重复通知；恢复机器人后再次触发会再通知', async () => {
    const chat = newChat();
    const before = notices().length;
    await send(chat, '我要人工');
    await waitDecided(t, cid(chat), 1);
    await waitFor(() => notices().length === before + 1);
    await send(chat, '', { hasMedia: true, media: { mimetype: 'image/png' } });
    await waitDecided(t, cid(chat), 2);
    await sleep(200);
    assert.equal(notices().length, before + 1);
    await t.req('POST', `${convPath(cid(chat))}/bot`, { body: { paused: false } });
    await send(chat, '还是要人工');
    await waitDecided(t, cid(chat), 3);
    await waitFor(() => notices().length === before + 2);
  });

  it('客户问 are you a bot：转人工并通知，原因可读', async () => {
    const chat = newChat();
    const before = notices().length;
    await send(chat, 'are you a bot?');
    const msgs = await waitDecided(t, cid(chat), 1);
    assert.equal(msgs[0].botDecision, 'handoff');
    assert.equal(msgs[0].decisionReason, '客户问是不是机器人');
    await waitFor(() => notices().length === before + 1);
    assert.ok(notices().at(-1).text.includes('原因：客户问是不是机器人'));
    assert.equal(fake.sentTo(chat).length, 0);
  });

  it('被拦截（blocked）：通知和 decisionReason 里写拦截规则的说明', async () => {
    const chat = newChat();
    const before = notices().length;
    hooks.generate = ({ entries }) => ({ category: 'business', reply: '保温杯 A100 现在只要 49 元', usedEntryIds: [entries[0].id], reason: '资料里有' });
    try {
      await send(chat, '保温杯多少钱');
      const msgs = await waitDecided(t, cid(chat), 1);
      assert.equal(msgs[0].botDecision, 'blocked');
      assert.match(msgs[0].decisionReason, /^价格数字对不上资料：回复里的「49 元」/);
      await waitFor(() => notices().length === before + 1);
    } finally {
      hooks.generate = null;
    }
    assert.ok(notices().at(-1).text.includes('原因：价格数字对不上资料'));
    assert.equal(fake.sentTo(chat).length, 0);
    assert.equal((await getConv(t, cid(chat))).botPaused, true);
  });

  it('离题不通知', async () => {
    const chat = newChat();
    const before = notices().length;
    await send(chat, '帮我写代码');
    const msgs = await waitDecided(t, cid(chat), 1);
    assert.equal(msgs[0].botDecision, 'offtopic');
    await sleep(200);
    assert.equal(notices().length, before);
    const conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, false);
    assert.equal(conv.botPaused, false);
  });

  it('通知号码发来的消息不进会话列表、不触发自动回复', async () => {
    await send(NOTIFY_CHAT, '保温杯多少钱');
    await sleep(250);
    assert.equal(await getConv(t, cid(NOTIFY_CHAT)), null);
    // 通知本身可能带草稿（F2a，里面会引用价格），这里只看有没有机器人回复
    assert.ok(!fake.sentTo(NOTIFY_CHAT).some((m) => /59 元/.test(m.text) && !m.text.startsWith('[待人工]')));
    // 关掉 WhatsApp 通知后，通知号码按黑名单处理：不存档、不回复
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: false } } } });
    const n = fake.state.sent.length;
    await send(NOTIFY_CHAT, '保温杯多少钱');
    await sleep(250);
    assert.equal(await getConv(t, cid(NOTIFY_CHAT)), null);
    assert.equal(fake.state.sent.length, n);
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: true } } } });
  });

  it('邮件失败不影响 WhatsApp 通知，失败只写日志（最多 2 次）', async () => {
    const chat = newChat();
    const before = notices().length;
    const opts = mail.opts.length;
    mail.fail = true;
    try {
      await send(chat, '我要人工');
      await waitDecided(t, cid(chat), 1);
      await waitFor(() => notices().length === before + 1);
      await waitFor(() => mail.opts.length === opts + 2);
    } finally {
      mail.fail = false;
    }
    await sleep(100);
    assert.equal(mail.opts.length, opts + 2, '邮件最多尝试 2 次');
    assert.ok(t.log.lines.some((l) => l.includes('邮件') && l.includes('SMTP 连接被拒绝')));
  });

  it('POST /api/accounts/:id/notify/test：按启用的通道各发一条，未启用为 null', async () => {
    const before = notices().length;
    const r = await t.req('POST', `/api/accounts/${acc.id}/notify/test`);
    assert.deepEqual(r.body, { email: { ok: true, error: null }, whatsapp: { ok: true, error: null } });
    assert.equal(notices().length, before + 1);
    assert.match(mail.sent.at(-1).subject, /测试通知/);
    assert.deepEqual(mail.sent.at(-1).to.map((x) => x.address), ['boss@example.com']);
    mail.fail = true;
    const f = await t.req('POST', `/api/accounts/${acc.id}/notify/test`);
    mail.fail = false;
    assert.equal(f.body.email.ok, false);
    assert.match(f.body.email.error, /SMTP/);
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { email: { enabled: false }, whatsapp: { enabled: false } } } });
    const none = await t.req('POST', `/api/accounts/${acc.id}/notify/test`);
    assert.deepEqual(none.body, { email: null, whatsapp: null });
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { email: { enabled: true }, whatsapp: { enabled: true } } } });
  });

  it('POST /api/settings/email/test：SMTP 发一封测试邮件；收件地址不对返回 ok:false；HTTP 都是 200', async () => {
    const r = await t.req('POST', '/api/settings/email/test', { body: { to: 'someone@example.com' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(mail.sent.at(-1).to.map((x) => x.address), ['someone@example.com']);
    assert.match(mail.sent.at(-1).subject, /测试邮件/);
    const bad = await t.req('POST', '/api/settings/email/test', { body: { to: 'not-an-email' } });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    mail.fail = true;
    const f = await t.req('POST', '/api/settings/email/test', { body: { to: 'someone@example.com' } });
    mail.fail = false;
    assert.equal(f.status, 200);
    assert.equal(f.body.ok, false);
    assert.match(f.body.error, /SMTP 连接被拒绝/);
  });

  it('发信密钥不回传；SMTP 参数：secure=true 走 SMTPS，false 强制 STARTTLS', async () => {
    const s = await t.req('GET', '/api/settings');
    assert.deepEqual(s.body.email.smtp, { host: 'smtp.example.com', port: 465, secure: true, user: 'bot@example.com', passwordSet: true });
    assert.ok(!JSON.stringify(s.body).includes('smtp-secret'));
    const a = smtpOptions({ host: 'h', port: 465, secure: true, user: 'u', password: 'p' });
    assert.equal(a.secure, true);
    assert.equal(a.requireTLS, false);
    const b = smtpOptions({ host: 'h', port: 587, secure: false, user: 'u', password: 'p' });
    assert.equal(b.secure, false);
    assert.equal(b.requireTLS, true);
    assert.equal(b.port, 587);
  });
});

describe('发信方式（F10）', () => {
  it('没配发信方式时：开启号的邮件通知返回 400 email_not_configured；只改收件人可以；测试邮件 ok:false', async () => {
    const t = await startApp();
    try {
      await t.login();
      const acc = await t.createAccount();
      const r = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { email: { enabled: true, to: ['a@example.com'] } } } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'email_not_configured');
      const ok = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { email: { to: ['a@example.com'] } } } });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body.notify.email, { enabled: false, to: ['a@example.com'] });
      const test = await t.req('POST', '/api/settings/email/test', { body: { to: 'a@example.com' } });
      assert.equal(test.status, 200);
      assert.equal(test.body.ok, false);
      assert.match(test.body.error, /发信方式/);
      // 配好后可以开启
      await t.req('PUT', '/api/settings', { body: { email: { provider: 'smtp', from: 'bot@example.com', smtp: { host: 'smtp.example.com' } } } });
      const on = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { email: { enabled: true } } } });
      assert.equal(on.status, 200);
      assert.equal(on.body.notify.email.enabled, true);
      // 全局改回不发邮件后，已开着的号再保存别的设置不报错
      await t.req('PUT', '/api/settings', { body: { email: { provider: null } } });
      assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { persona: 'x', notify: { email: { enabled: true } } } })).status, 200);
    } finally {
      await t.close();
    }
  });

  describe('Resend API', () => {
    let t;
    let resend;
    let fake;
    let acc;
    before(async () => {
      resend = await startFakeResend();
      fake = await startFakeWaha();
      t = await startApp({ env: { KBWA_RESEND_API_URL: resend.url, KBWA_WAHA_URL: fake.url }, options: { resendRetryDelayMs: 10 } });
      await t.login();
      await t.req('PUT', '/api/settings', {
        body: { reply: { debounceSeconds: 0.05 }, email: { provider: 'resend', from: 'KBWA <bot@example.com>', resend: { apiKey: 're_test_key_1234' } } },
      });
    });
    after(async () => {
      await t.close();
      await resend.close();
      await fake.close();
    });

    it('测试邮件：POST /emails，Bearer key，JSON 体 {from, to[], subject, text}', async () => {
      const r = await t.req('POST', '/api/settings/email/test', { body: { to: 'boss@example.com' } });
      assert.deepEqual(r.body, { ok: true });
      const req = resend.state.requests.at(-1);
      assert.equal(req.method, 'POST');
      assert.equal(req.path, '/emails');
      assert.equal(req.headers.authorization, 'Bearer re_test_key_1234');
      assert.match(req.headers['content-type'], /^application\/json/);
      assert.deepEqual(Object.keys(req.body).sort(), ['from', 'subject', 'text', 'to']);
      assert.equal(req.body.from, 'KBWA <bot@example.com>');
      assert.deepEqual(req.body.to, ['boss@example.com']);
      assert.match(req.body.subject, /测试邮件/);
      assert.ok(req.body.text.length > 0);
    });

    it('422 / 403：返回可读的报错（含 Resend 的原文和中文提示），HTTP 仍是 200', async () => {
      resend.state.mode = '422';
      try {
        const r = await t.req('POST', '/api/settings/email/test', { body: { to: 'boss@example.com' } });
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, false);
        assert.match(r.body.error, /Resend 返回 422 invalid_parameter/);
        assert.match(r.body.error, /Invalid `from` field/);
        assert.match(r.body.error, /发件人格式/);
        resend.state.mode = '403domain';
        const d = await t.req('POST', '/api/settings/email/test', { body: { to: 'boss@example.com' } });
        assert.equal(d.body.ok, false);
        assert.match(d.body.error, /Resend 返回 403 validation_error/);
        assert.match(d.body.error, /domain is not verified/);
        assert.match(d.body.error, /Domains 里验证/);
      } finally {
        resend.state.mode = 'ok';
      }
    });

    it('429：重试一次；连续 429 报错', async () => {
      resend.state.requests.length = 0;
      resend.state.mode = '429once';
      try {
        const r = await t.req('POST', '/api/settings/email/test', { body: { to: 'boss@example.com' } });
        assert.deepEqual(r.body, { ok: true });
        assert.equal(resend.state.requests.length, 2);
        resend.state.requests.length = 0;
        resend.state.mode = '429always';
        const f = await t.req('POST', '/api/settings/email/test', { body: { to: 'boss@example.com' } });
        assert.equal(f.body.ok, false);
        assert.match(f.body.error, /429/);
        assert.equal(resend.state.requests.length, 2, '只重试一次');
      } finally {
        resend.state.mode = 'ok';
      }
    });

    it('转人工通知邮件走 Resend，发给号配置的收件人；不同号的收件人互不影响', async () => {
      await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
      acc = await t.createAccount({ name: '一号', autoReply: true, notify: { email: { enabled: true, to: ['one@example.com'] } } });
      const acc2 = await t.createAccount({ name: '二号', autoReply: true, notify: { email: { enabled: true, to: ['two@example.com', 'boss@example.com'] } } });
      await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
      await t.req('POST', `/api/accounts/${acc2.id}/waha/start`);
      resend.state.requests.length = 0;
      const chat = newChat();
      await wahaSend(t, acc, chat, '我要人工');
      await waitDecided(t, convIdOf(acc, chat), 1);
      await waitFor(() => resend.state.requests.length === 1);
      assert.deepEqual(resend.state.requests[0].body.to, ['one@example.com']);
      assert.match(resend.state.requests[0].body.subject, /^\[待人工\]/);
      assert.ok(resend.state.requests[0].body.text.includes('号：一号'));
      await wahaSend(t, acc2, chat, '我要人工');
      await waitDecided(t, convIdOf(acc2, chat), 1);
      await waitFor(() => resend.state.requests.length === 2);
      assert.deepEqual(resend.state.requests[1].body.to, ['two@example.com', 'boss@example.com']);
      assert.ok(resend.state.requests[1].body.text.includes('号：二号'));
    });

    it('API key 不回传（只有 apiKeySet 和末 4 位），也不进日志', async () => {
      const s = await t.req('GET', '/api/settings');
      assert.deepEqual(s.body.email.resend, { apiKeySet: true, apiKeyLast4: '1234' });
      assert.equal(s.body.email.provider, 'resend');
      assert.ok(!JSON.stringify(s.body).includes('re_test_key_1234'));
      assert.ok(!t.log.lines.some((l) => l.includes('re_test_key_1234')));
      assert.equal((await t.req('PUT', '/api/settings', { body: { email: { provider: 'mailgun' } } })).status, 400);
    });
  });
});
