// Telegram 扫码登录的号从 my.telegram.org 自动取 api_id / api_hash：认页面（新旧两版、已有应用、新建表单、认不出）；
// 发验证码（手机号格式、带着登录页给的 cookie、太频繁）；交验证码（填错还能再填、没获取先交、已有应用直接用、
// 没有就新建、简称被占换一个、新建被拒、认不出页面、登录没成功、连不上）；权限；操作日志和日志里不带手机号、验证码、api_hash。
// 全部对着假的 my.telegram.org，不连外网
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { parseAppsPage } from '../src/wa/mytelegram.js';
import { startApp } from './helpers.js';

/** 不像真 api_hash 的假值（拼起来，免得被当成泄露的密钥拦下） */
const API_HASH = ['0123456789abcdef', 'fedcba9876543210'].join('');
const FORM_HASH = ['aaaabbbbccccdddd', 'eeeeffff00001111'].join('');
const PHONE = '+8613800000000';
const CODE = 'Xy7Kq2Lm9Pd';

/** 改版后的应用页：值在标签后面，api_hash 遮着（data-value）；表单里还有个同样 32 位的隐藏 hash，别认错 */
const appPage = (app) => `<!DOCTYPE html><html><head><title>App configuration</title></head><body>
<form id="app_edit_form"><input type="hidden" name="hash" value="${FORM_HASH}">
<div class="kv"><span class="k">App api_id</span><div class="v"><strong>${app.apiId}</strong><button class="icon-btn" data-copy="${app.apiId}"></button></div></div>
<div class="kv"><span class="k">App api_hash</span><div class="v masked" id="hashv" data-value="${app.apiHash}"><span class="vv">••••••••</span></div>
<button class="icon-btn" data-reveal="#hashv"></button><button class="icon-btn" data-copy="${app.apiHash}"></button></div>
<div class="kv"><span class="k">Production configuration</span><div class="v">149.154.167.50:443 · DC 2</div></div>
</form></body></html>`;

const createPage = () => `<!DOCTYPE html><html><head><title>Create new application</title></head><body>
<p>Once created, you will get your api_id and api_hash here.</p>
<form class="card" id="app_create_form"><input type="hidden" name="hash" value="${FORM_HASH}">
<div class="field"><input id="app_title" name="app_title"><div class="hint"><span class="count">0 / 255</span></div></div>
<div class="field"><input id="app_shortname" name="app_shortname"></div><input name="app_url">
${['android', 'ios', 'wp', 'bb', 'desktop', 'web', 'ubp', 'other'].map((p) => `<label class="chip"><input type="radio" name="app_platform" value="${p}"></label>`).join('')}
<textarea id="app_desc" name="app_desc"></textarea><button type="submit">Create application</button></form></body></html>`;

/**
 * 假的 my.telegram.org：/auth 给 stel_ssid，发验证码要带着它；登录成功给 stel_token；/apps 没登录跳去 /auth；
 * 开关：flood（太频繁）、createFail（新建只回 ERROR）、takenOnce（简称被占一次）、page（/apps 换成这一页）、
 * noToken（登录说成功但不给 cookie）、delayMs（发验证码慢一点）
 */
async function startFakeMyTelegram() {
  const st = {
    calls: /** @type {any[]} */ ([]),
    app: /** @type {any} */ (null),
    hashes: new Map(),
    tokens: new Set(),
    flood: false,
    createFail: false,
    takenOnce: false,
    noToken: false,
    page: '',
    delayMs: 0,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const form = Object.fromEntries(new URLSearchParams(body));
    const cookies = Object.fromEntries(
      String(req.headers.cookie || '')
        .split(/;\s*/)
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]),
    );
    st.calls.push({ method: req.method, path: url.pathname, form, cookies, ua: req.headers['user-agent'] });
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const toAuth = () => {
      res.writeHead(302, { location: '/auth?to=apps' });
      res.end();
    };
    const authed = st.tokens.has(cookies.stel_token);

    if (req.method === 'GET' && url.pathname === '/auth') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'stel_ssid=ssid123; path=/; HttpOnly' });
      return res.end('<html><title>Authorization</title></html>');
    }
    if (url.pathname === '/auth/send_password') {
      if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
      if (st.flood) return json(400, { text: 'Sorry, too many tries. Please try again later.' });
      if (!/^\+\d{6,15}$/.test(form.phone || '')) return json(400, { text: 'Invalid phone number' });
      if (cookies.stel_ssid !== 'ssid123') return json(400, { text: 'Please enable cookies' });
      const h = `rh${st.hashes.size}`;
      st.hashes.set(h, form.phone);
      return json(200, { random_hash: h });
    }
    if (url.pathname === '/auth/login') {
      if (st.flood) return json(400, { text: 'Sorry, too many tries. Please try again later.' });
      if (st.hashes.get(form.random_hash) !== form.phone) return json(400, { text: 'Invalid hash' });
      if (form.password !== CODE) return json(400, { text: 'Invalid confirmation code!' });
      if (st.noToken) return json(200, true);
      const tok = `tok${st.tokens.size}`;
      st.tokens.add(tok);
      return json(200, true, { 'set-cookie': `stel_token=${tok}; path=/; HttpOnly; Secure` });
    }
    if (url.pathname === '/apps') {
      if (!authed) return toAuth();
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(st.page || (st.app ? appPage(st.app) : createPage()));
    }
    if (url.pathname === '/apps/create') {
      if (!authed) return toAuth();
      if (form.hash !== FORM_HASH) return json(400, { text: 'Invalid hash' });
      if (st.createFail) return json(400, { text: 'ERROR' });
      if (st.takenOnce) {
        st.takenOnce = false;
        return json(400, { text: 'This short name is already taken', field: 'app_shortname' });
      }
      if ((form.app_title || '').trim().length < 5) return json(400, { text: 'At least 5 characters', field: 'app_title' });
      if (!/^[A-Za-z0-9 ]{5,32}$/.test(form.app_shortname || '')) return json(400, { text: 'Bad short name', field: 'app_shortname' });
      st.app = { apiId: '24681357', apiHash: API_HASH, ...form };
      res.writeHead(200);
      return res.end('');
    }
    if (url.pathname === '/auth/logout') {
      st.tokens.delete(cookies.stel_token);
      res.writeHead(302, { location: '/auth', 'set-cookie': 'stel_token=deleted; path=/' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    st,
    url: `http://127.0.0.1:${addr.port}`,
    paths: () => st.calls.map((c) => `${c.method} ${c.path}`),
    reset() {
      Object.assign(st, { calls: [], app: null, flood: false, createFail: false, takenOnce: false, noToken: false, page: '', delayMs: 0 });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const noTelegram = () => {
  throw new Error('这个测试不该连 Telegram');
};

describe('认 my.telegram.org 的应用页', () => {
  it('改版后的页面：读出 api_id 和 api_hash，不把表单里的隐藏 hash 当成 api_hash', () => {
    assert.deepEqual(parseAppsPage(appPage({ apiId: '24681357', apiHash: API_HASH })), { apiId: '24681357', apiHash: API_HASH });
  });

  it('旧版页面（标签后面的 span 里）也认得；api_hash 统一成小写', () => {
    const old = `<label for="app_id" class="col-md-4 text-right control-label">App api_id:</label>
      <div class="col-md-7"><span class="form-control input-xlarge uneditable-input" onclick="this.select();"><strong>1234567</strong></span></div>
      <label for="app_hash" class="col-md-4 text-right control-label">App api_hash:</label>
      <div class="col-md-7"><span class="form-control input-xlarge uneditable-input" onclick="this.select();">${API_HASH.toUpperCase()}</span></div>`;
    assert.deepEqual(parseAppsPage(old), { apiId: '1234567', apiHash: API_HASH });
  });

  it('标签认不出时，复制按钮上只有一个数字、一个 32 位十六进制就用它们', () => {
    const html = `<div><button data-copy="7654321"></button><button data-copy="${API_HASH}"></button><b>编号</b><b>密钥</b></div>`;
    assert.deepEqual(parseAppsPage(html), { apiId: '7654321', apiHash: API_HASH });
  });

  it('新建表单：带出隐藏字段和可选平台；说明文字里的 api_id 不当成已有应用', () => {
    assert.deepEqual(parseAppsPage(createPage()), {
      create: { hidden: { hash: FORM_HASH }, platforms: ['android', 'ios', 'wp', 'bb', 'desktop', 'web', 'ubp', 'other'] },
    });
    const old = `<form role="form" id="app_create_form" method="post" action="/apps/create"><input type='hidden' name='hash' value='abc123'/>
      <input type="radio" name="app_platform" value="android"> <input type="radio" name="app_platform" value="other"></form>`;
    assert.deepEqual(parseAppsPage(old), { create: { hidden: { hash: 'abc123' }, platforms: ['android', 'other'] } });
  });

  it('都认不出：null', () => {
    assert.equal(parseAppsPage('<html><title>Something new</title><p>api_id</p></html>'), null);
  });
});

describe('Telegram 扫码登录：从 my.telegram.org 自动取 api_id', () => {
  let t;
  let mt;
  let acc;
  const code = (body, o) => t.req('POST', `/api/accounts/${acc.id}/telegram/api/code`, { body, ...o });
  const apply = (body, o) => t.req('POST', `/api/accounts/${acc.id}/telegram/api/apply`, { body, ...o });
  const clearApi = () => t.req('PUT', `/api/accounts/${acc.id}`, { body: { telegram: { apiId: '', apiHash: '' } } });

  before(async () => {
    mt = await startFakeMyTelegram();
    t = await startApp({ env: { INKDOVE_MY_TELEGRAM_URL: mt.url }, options: { tgUserClientFactory: noTelegram } });
    await t.login();
    acc = await t.createAccount({ name: 'TG 自动取', channel: 'tguser' });
  });
  after(async () => {
    await t.close();
    await mt.close();
  });
  beforeEach(async () => {
    mt.reset();
    await clearApi();
  });

  it('手机号不带国家区号、不是号码：400，不去请求', async () => {
    for (const phone of ['13800000000', '+86 abc', '', 123]) {
      const r = await code({ phone });
      assert.equal(r.status, 400, String(phone));
      assert.equal(r.body.code, 'bad_phone');
    }
    assert.deepEqual(mt.paths(), []);
  });

  it('没获取验证码就交：400 no_code', async () => {
    const r = await apply({ code: CODE });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'no_code');
  });

  it('还没有应用：发验证码（带着登录页的 cookie）→ 填错再填 → 新建一个 Inkdove 应用，存进这个号，退出 my.telegram.org', async () => {
    const r = await code({ phone: '+86 138-0000-0000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mt.paths(), ['GET /auth', 'POST /auth/send_password']);
    assert.equal(mt.st.calls[1].form.phone, PHONE);
    assert.match(mt.st.calls[1].ua, /^Inkdove /);

    const wrong = await apply({ code: 'Wrong12345' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'bad_code');

    const ok = await apply({ code: ` ${CODE} ` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.created, true);
    assert.equal(ok.body.account.telegram.apiId, '24681357');
    assert.equal(ok.body.account.telegram.apiHashSet, true);
    assert.ok(!JSON.stringify(ok.body).includes(API_HASH), '接口里出现了 api_hash');
    assert.equal(ok.body.account.status.state, 'logged_out');
    assert.deepEqual(t.ctx.accounts.get(acc.id).telegram, { apiId: '24681357', apiHash: API_HASH });

    const create = mt.st.calls.find((c) => c.path === '/apps/create');
    assert.equal(create.form.hash, FORM_HASH);
    assert.equal(create.form.app_title, 'Inkdove');
    assert.match(create.form.app_shortname, /^inkdove\d{6}$/);
    assert.equal(create.form.app_platform, 'desktop');
    assert.ok(mt.st.calls.find((c) => c.path === '/auth/logout'), '没退出 my.telegram.org');
    assert.equal(mt.st.tokens.size, 0);

    // 验证码用过就作废
    assert.equal((await apply({ code: CODE })).body.code, 'no_code');
  });

  it('已经有应用：直接读出来用，不新建', async () => {
    mt.st.app = { apiId: '1357924', apiHash: API_HASH };
    await code({ phone: PHONE });
    const ok = await apply({ code: CODE });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.created, false);
    assert.equal(t.ctx.accounts.get(acc.id).telegram.apiId, '1357924');
    assert.ok(!mt.paths().includes('POST /apps/create'));
  });

  it('简称被占：换一个再建', async () => {
    mt.st.takenOnce = true;
    await code({ phone: PHONE });
    const ok = await apply({ code: CODE });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const names = mt.st.calls.filter((c) => c.path === '/apps/create').map((c) => c.form.app_shortname);
    assert.equal(names.length, 2);
  });

  it('新建被拒（只回 ERROR）：502 说明原因和手动的路，号没填上，验证码作废', async () => {
    mt.st.createFail = true;
    await code({ phone: PHONE });
    const r = await apply({ code: CODE });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'my_telegram_failed');
    assert.match(r.body.error, /ERROR/);
    assert.match(r.body.error, /API development tools/);
    assert.equal(t.ctx.accounts.get(acc.id).telegram.apiId, '');
    assert.ok(mt.paths().includes('GET /auth/logout'));
    assert.equal((await apply({ code: CODE })).body.code, 'no_code');
  });

  it('页面认不出（改版了）：502 让用户自己去复制', async () => {
    mt.st.page = '<html><title>Brand new</title></html>';
    await code({ phone: PHONE });
    const r = await apply({ code: CODE });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /改版/);
  });

  it('登录说成功但没登录上（打开应用页被跳去登录页）：502 让重新获取', async () => {
    mt.st.noToken = true;
    await code({ phone: PHONE });
    const r = await apply({ code: CODE });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /重新获取验证码/);
  });

  it('太频繁：429', async () => {
    mt.st.flood = true;
    const r = await code({ phone: PHONE });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'my_telegram_flood');
  });

  it('上一步还没完成又点：409', async () => {
    mt.st.delayMs = 300;
    const [a, b] = await Promise.all([code({ phone: PHONE }), new Promise((r) => setTimeout(r, 50)).then(() => code({ phone: PHONE }))]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 409);
  });

  it('只有 admin；只有扫码登录的号', async () => {
    const m = await t.addMember({ email: 'tg-agent@example.com', accountIds: [acc.id] });
    assert.equal((await code({ phone: PHONE }, { cookie: m.cookie })).status, 403);
    assert.equal((await apply({ code: CODE }, { cookie: m.cookie })).status, 403);
    const bot = await t.createAccount({ name: 'TG 机器人', channel: 'tgbot' });
    const r = await t.req('POST', `/api/accounts/${bot.id}/telegram/api/code`, { body: { phone: PHONE } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'wrong_channel');
    await t.req('DELETE', `/api/accounts/${bot.id}`);
  });

  it('操作日志记了两步；手机号、验证码、api_hash 不出现在操作日志、日志和数据目录里', async () => {
    mt.st.app = { apiId: '1357924', apiHash: API_HASH };
    await code({ phone: PHONE });
    await apply({ code: CODE });
    const rows = t.ctx.db.prepare("SELECT action, summary FROM audit_logs WHERE action LIKE 'account.telegram_api_%'").all();
    assert.ok(rows.some((a) => a.action === 'account.telegram_api_code' && /my\.telegram\.org 获取了验证码/.test(a.summary)));
    assert.ok(rows.some((a) => a.action === 'account.telegram_api_apply' && /取得了 api_id 和 api_hash/.test(a.summary)));
    const audit = JSON.stringify(t.ctx.db.prepare('SELECT * FROM audit_logs').all());
    const secrets = [PHONE, '13800000000', CODE, API_HASH];
    for (const s of secrets) {
      assert.ok(!audit.includes(s), `操作日志里出现了 ${s}`);
      assert.ok(!t.log.lines.some((l) => l.includes(s)), `日志里出现了 ${s}`);
    }
    // 数据库里只有号的配置存着 api_hash（本来就要存），手机号和验证码哪儿都没有
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(t.dataDir)) {
      const buf = fs.readFileSync(f);
      for (const s of [PHONE, '13800000000', CODE]) assert.ok(!buf.includes(s), `${path.basename(f)} 里出现了 ${s}`);
    }
  });
});

describe('Telegram 扫码登录：连不上 my.telegram.org', () => {
  it('502，提示国内要开全局代理', async () => {
    const t = await startApp({ env: { INKDOVE_MY_TELEGRAM_URL: 'http://127.0.0.1:1' }, options: { tgUserClientFactory: noTelegram } });
    try {
      await t.login();
      const acc = await t.createAccount({ name: 'TG 连不上', channel: 'tguser' });
      const r = await t.req('POST', `/api/accounts/${acc.id}/telegram/api/code`, { body: { phone: PHONE } });
      assert.equal(r.status, 502);
      assert.equal(r.body.code, 'my_telegram_unreachable');
      assert.match(r.body.error, /设置 → 代理/);
    } finally {
      await t.close();
    }
  });
});
