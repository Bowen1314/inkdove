// Telegram 扫码登录（tguser，个人帐号经 mtcute 登录）：api_id / api_hash 的校验、页面上不露 api_hash；扫码登录（二维码会换、
// 扫了以后 working、第一次登录不拉以前的消息）；验证码登录（手机号校验、验证码输错还能再输、接着两步验证）；
// 两步验证（输错还能再输，密码不存）；登录超时；收消息（客户的、在手机上发的、
// 墨鸽发出去推回来的、群和机器人等不收）；改消息；删除通知（只有消息 id）；撤回（没有时限）；媒体；人工发文字和文件；
// 用登录态重连（补收停机期间的）；登录失效；退出登录；删号；外联；导出导入；
// 操作日志和日志里不带 api_hash、二维码、手机号、验证码、密码和用户 id。
// 全部对着假的客户端（和 tguser.js 的 createMtcuteClient 一样的接口），不连 Telegram
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { TgUserError } from '../src/wa/tguser.js';
import { TooLargeError } from '../src/wa/waha.js';
import { fakeJpeg, filesForm, makePdf } from './fixtures.js';
import { convIdOf, convPath, getConv, getMessages, startApp, TINY_PNG, waitDecided, waitFor } from './helpers.js';

/** 不像真 api_hash 的假值（拼起来，免得被当成泄露的密钥拦下） */
const API_HASH = ['0123456789abcdef', 'fedcba9876543210'].join('');
const QR_TOKEN = 'QRTOKENFAKE';
const ME = { id: '5000000001', name: 'Bowen Rui', username: 'bowen_r' };
/** 验证码登录用的手机号（页面上那种带空格、括号的写法）和规范化以后的 */
const PHONE = '+1 (415) 555-0134';
const PHONE_E164 = '+14155550134';
const LOGIN_CODE = '864209';
const WRONG_CODE = '135797';

/**
 * 假的扫码登录客户端。
 * - 登录态：sessions 里记着登录过的登录态文件 → 自己（{needPassword: true} 表示扫完码还没输两步验证密码）；restore 时按这个返回
 * - loginQr：先给一个二维码（login.refresh() 再换一个），等测试调 login.scan()；state.twoFa 设了时要输对密码；
 *   signal 中止时抛 signal.reason。登录成功时像真客户端一样写登录态文件（主文件和 -wal）
 * - loginPhone：state.phoneError 设了时直接抛（手机号被拒）；否则说验证码发到了 App（5 位），等输对 LOGIN_CODE，
 *   state.twoFa 设了时再要密码；收到的手机号记在 c.phone
 * - sendText、sendFile 从 5001 开始编消息 id（用户帐号的消息 id 在所有私聊里是同一个序列）；deleteFail 时删除报错
 * - openFile、download：files 里登记的；已知大小超过上限的抛 TooLargeError，不记 openFile
 * - logOut：logOutFail 时报错（连不上 Telegram）；restore：restoreFails 大于 0 时报连不上（每次减一）
 */
function fakeTgUser() {
  const state = {
    clients: [],
    sessions: new Map(),
    files: new Map(),
    twoFa: '',
    phoneError: null,
    nextId: 5000,
    qrSeq: 0,
    deleteFail: false,
    logOutFail: false,
    restoreFails: 0,
  };
  async function factory(o) {
    const c = { o, calls: [], closed: false, login: null };
    const call = (name, ...args) => c.calls.push({ name, args });
    const loggedIn = async () => {
      await fs.promises.writeFile(o.storagePath, 'session');
      await fs.promises.writeFile(`${o.storagePath}-wal`, 'wal');
      state.sessions.set(o.storagePath, ME);
      return ME;
    };
    const askPassword = async (password, onPasswordInvalid) => {
      for (;;) {
        const pw = await password();
        call('passwordAttempt');
        if (pw === state.twoFa) return;
        await onPasswordInvalid();
      }
    };
    Object.assign(c, {
      async restore() {
        call('restore');
        if (state.restoreFails > 0) {
          state.restoreFails--;
          throw new TgUserError('无法连接 Telegram：timeout');
        }
        return state.sessions.get(o.storagePath) ?? null;
      },
      loginQr({ onQr, onScanned, password, onPasswordInvalid, signal }) {
        call('loginQr');
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          const refresh = () => onQr(`tg://login?token=${QR_TOKEN}${++state.qrSeq}`, Date.now() + 30_000);
          c.login = {
            refresh,
            async scan() {
              onScanned();
              try {
                if (state.twoFa) await askPassword(password, onPasswordInvalid);
                resolve(await loggedIn());
              } catch (err) {
                reject(err);
              }
            },
          };
          refresh();
        });
      },
      loginPhone({ phone, onCodeSent, code, onCodeInvalid, password, onPasswordInvalid, signal }) {
        call('loginPhone');
        c.phone = phone;
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          (async () => {
            await new Promise((r) => setTimeout(r, 10));
            if (state.phoneError) throw state.phoneError;
            onCodeSent({ via: 'app', length: 5 });
            for (;;) {
              const got = await code();
              call('codeAttempt', got);
              if (got === LOGIN_CODE) break;
              await onCodeInvalid();
            }
            if (state.twoFa) await askPassword(password, onPasswordInvalid);
            return loggedIn();
          })().then(resolve, reject);
        });
      },
      async checkPassword({ password, onPasswordInvalid }) {
        call('checkPassword');
        await askPassword(password, onPasswordInvalid);
        return loggedIn();
      },
      async sendText(chatId, text) {
        const id = ++state.nextId;
        call('sendText', chatId, text, String(id));
        return String(id);
      },
      async sendFile(chatId, file, opts) {
        const id = ++state.nextId;
        call('sendFile', chatId, { ...file, ...opts }, String(id));
        return String(id);
      },
      async deleteMessages(chatId, ids) {
        call('deleteMessages', chatId, ids);
        if (state.deleteFail) throw new TgUserError('不能删除这条消息', { code: 'MESSAGE_DELETE_FORBIDDEN' });
      },
      async readHistory(chatId, maxId) {
        call('readHistory', chatId, maxId);
      },
      async sendTyping(chatId) {
        call('sendTyping', chatId);
      },
      openFile(fileId, { fileSize = null, maxBytes } = {}) {
        if (Number.isFinite(fileSize) && maxBytes && fileSize > maxBytes) throw new TooLargeError(fileSize, maxBytes);
        call('openFile', fileId);
        const buf = state.files.get(fileId);
        if (!buf) throw new TgUserError('文件不存在');
        return Readable.from([buf]);
      },
      async download(fileId) {
        call('download', fileId);
        const buf = state.files.get(fileId);
        if (!buf) throw new TgUserError('文件不存在');
        return buf;
      },
      async logOut() {
        call('logOut');
        if (state.logOutFail) throw new TgUserError('无法连接 Telegram：timeout');
        state.sessions.delete(o.storagePath);
      },
      async close() {
        call('close');
        c.closed = true;
      },
    });
    state.clients.push(c);
    return c;
  }
  return {
    state,
    factory,
    /** 某个号最新的客户端 */
    of: (acc) => state.clients.filter((c) => c.o.storagePath.endsWith(`${acc.id}.session`)).at(-1),
    /** 客户端上某个方法的调用 */
    named: (c, name) => c.calls.filter((x) => x.name === name),
  };
}

let mid = 1000;
const person = (id, first, last = '') => ({ id: String(id), first, last });
const nowSec = () => Math.floor(Date.now() / 1000);
/** toPlainMessage 给的那种消息：peer 是私聊的对方；out 是自己发的（手机等其他设备上，或者墨鸽发出去推回来的） */
const pm = (peer, content = {}, o = {}) => ({
  message_id: o.id ?? ++mid,
  date: nowSec(),
  out: !!o.out,
  service: !!o.service,
  scheduled: !!o.scheduled,
  chat: { type: 'private', id: peer.id, first_name: peer.first, last_name: peer.last, username: '', is_bot: false, is_self: false, is_deleted: false, ...o.chat },
  text: '',
  ...content,
});

const KB = { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' };
const MARIA = person(9000000201, 'Maria', 'Ivanova');
const LENA = person(9000000202, 'Lena');
const GROUP = person(-1001234567890, '');
const BOTU = person(9000000300, 'Some Bot');
const SERVICE = person(777000, 'Telegram');
const PASSWORDS = ['correct-horse-9', 'wrong-pass-1', 'pw-restart-1'];

/** dataDir 里有没有文件含这段文字，有的话返回文件路径 */
function dataDirHas(dir, s) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (fs.readFileSync(p).includes(s)) return p;
  }
  return null;
}

describe('Telegram 扫码登录', () => {
  let t;
  let fake;
  let acc;
  let agent;
  let client;
  let replyId;
  const cid = (p) => convIdOf(acc, p.id);
  const api = (sub) => `/api/accounts/${acc.id}/telegram/${sub}`;
  const status = async (cookie) => (await t.req('GET', `/api/accounts/${acc.id}`, cookie ? { cookie } : {})).body.status;
  const waitState = (want) =>
    waitFor(
      async () => {
        const s = await status();
        return s.state === want ? s : null;
      },
      { message: `号迟迟没有到 ${want}` },
    );
  const sessionPath = () => path.join(t.dataDir, 'telegram', `${acc.id}.session`);
  const sessionGone = () => !fs.existsSync(sessionPath()) && !fs.existsSync(`${sessionPath()}-wal`);
  /** 点扫码登录、扫码（没开两步验证时直接 working），返回新的客户端 */
  async function loginByQr() {
    const r = await t.req('POST', api('login'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitState('scan_qr');
    const c = fake.of(acc);
    await c.login.scan();
    await waitState('working');
    return c;
  }

  before(async () => {
    fake = fakeTgUser();
    t = await startApp({ options: { tgUserClientFactory: fake.factory, tgUserRetryMs: 100 } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: KB });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: 'TG 扫码号', channel: 'tguser', autoReply: true });
    agent = await t.addMember({ email: 'tgu-agent@example.com', accountIds: [acc.id] });
  });
  after(async () => {
    await t.close();
  });

  it('没填 api_id / api_hash：not_configured，不能扫码；格式错误 400；页面上只说 api_hash 设没设', async () => {
    assert.equal((await status()).state, 'not_configured');
    const no = await t.req('POST', api('login'));
    assert.equal(no.status, 400);
    assert.equal(no.body.code, 'not_configured');
    const put = (telegram) => t.req('PUT', `/api/accounts/${acc.id}`, { body: { telegram } });
    assert.equal((await put({ apiId: '12ab' })).body.code, 'bad_api_id');
    assert.equal((await put({ apiHash: 'xyz' })).body.code, 'bad_api_hash');
    assert.equal((await put({ botToken: '1:abc' })).status, 400);
    const ok = await put({ apiId: 1234567, apiHash: API_HASH.toUpperCase() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.telegram, { apiId: '1234567', apiHashSet: true });
    assert.equal(t.ctx.accounts.get(acc.id).telegram.apiHash, API_HASH);
    assert.ok(!JSON.stringify((await t.req('GET', '/api/accounts')).body).includes(API_HASH));
    const st = await status();
    assert.equal(st.state, 'logged_out');
    assert.equal(st.error, null);
    assert.equal(fake.state.clients.length, 0, '没登录过的号不起客户端');
    assert.equal((await t.req('POST', api('login'), { cookie: agent.cookie })).status, 403, '业务员不能扫码登录');
    // 机器人号没有这些接口和字段
    const bot = await t.createAccount({ name: 'TG 机器人', channel: 'tgbot' });
    assert.equal((await t.req('POST', `/api/accounts/${bot.id}/telegram/login`)).body.code, 'wrong_channel');
    assert.equal((await t.req('POST', `/api/accounts/${bot.id}/telegram/logout`)).body.code, 'wrong_channel');
    assert.equal((await t.req('PUT', `/api/accounts/${bot.id}`, { body: { telegram: { apiId: '1' } } })).status, 400);
    await t.req('DELETE', `/api/accounts/${bot.id}`);
  });

  it('扫码登录：scan_qr，二维码（SVG）会换、只给管理员；扫了以后 working，显示登录的是谁；第一次登录不拉以前的消息', async () => {
    const r = await t.req('POST', api('login'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await waitState('scan_qr');
    client = fake.of(acc);
    assert.equal(client.o.apiId, 1234567);
    assert.equal(client.o.apiHash, API_HASH);
    assert.equal(client.o.catchUp, false, '第一次登录不拉以前的消息');
    assert.equal(client.o.storagePath, sessionPath());
    assert.equal(fs.statSync(path.dirname(sessionPath())).mode & 0o777, 0o700, '登录态目录只给自己');
    assert.equal(fs.statSync(sessionPath()).mode & 0o777, 0o600, '登录态文件只给自己');
    assert.equal(st.telegram.qrVersion, 1);
    assert.ok(Date.parse(st.telegram.qrExpiresAt) > Date.now());
    assert.equal(st.telegram.me, null);
    assert.ok(!JSON.stringify(st).includes(QR_TOKEN), '状态里没有二维码的内容');

    const qr = await t.req('GET', api('qr'));
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(qr.headers.get('cache-control'), 'no-store');
    assert.match(Buffer.from(qr.body).toString(), /^<svg/);
    assert.equal((await t.req('GET', api('qr'), { cookie: agent.cookie })).status, 403);
    client.login.refresh();
    assert.equal((await status()).telegram.qrVersion, 2);
    // 正在扫码时再点一次：原样，不重来
    assert.equal((await t.req('POST', api('login'))).status, 200);
    assert.equal(fake.state.clients.length, 1);

    await client.login.scan();
    const ok = await waitState('working');
    assert.deepEqual(ok.telegram, {
      me: { name: 'Bowen Rui', username: 'bowen_r' },
      qrVersion: null,
      qrExpiresAt: null,
      loginMethod: null,
      codeVia: null,
      codeLength: null,
    });
    assert.equal(ok.error, null);
    assert.equal((await t.req('GET', api('qr'))).status, 404);
    const again = await t.req('POST', api('login'));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_logged_in');
  });

  it('客户发文字：建会话，名字取 Telegram 上的；先显示「正在输入」再回复、标已读；撤回没有时限', async () => {
    await client.o.onMessage(pm(MARIA, { text: '保温杯多少钱' }, { id: 101 }));
    const msgs = await waitDecided(t, cid(MARIA), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    const sent = await waitFor(() => fake.named(client, 'sendText').find((c) => c.args[0] === MARIA.id));
    assert.match(sent.args[1], /59 元/);
    replyId = sent.args[2];
    await waitFor(() => fake.named(client, 'readHistory').length);
    assert.deepEqual(fake.named(client, 'readHistory').at(-1).args, [MARIA.id, '101']);
    assert.ok(fake.named(client, 'sendTyping').some((c) => c.args[0] === MARIA.id));
    const conv = await getConv(t, cid(MARIA));
    assert.equal(conv.contactName, 'Maria Ivanova');
    assert.equal(conv.channel, 'tguser');
    const out = (await getMessages(t, cid(MARIA))).find((m) => m.direction === 'out');
    assert.ok(Date.parse(out.revocableUntil) > Date.now() + 10 * 365 * 24 * 3600 * 1000, '撤回没有时限');
  });

  it('群和频道、机器人、收藏夹（自己）、Telegram 官方通知、服务消息、定时消息、已注销的帐号都不收', async () => {
    const cases = [
      [pm(GROUP, { text: '群里的' }, { chat: { type: 'other' } }), 'ignored_non_private'],
      [pm(BOTU, { text: '我是机器人' }, { chat: { is_bot: true } }), 'ignored_bot'],
      [pm(person(ME.id, 'Bowen'), { text: '收藏夹' }, { chat: { is_self: true } }), 'ignored_self'],
      [pm(SERVICE, { text: '登录码 12345' }), 'ignored_service'],
      [pm(LENA, {}, { service: true }), 'ignored_service'],
      [pm(LENA, { text: '定时发的' }, { scheduled: true }), 'ignored_scheduled'],
      [pm(LENA, { text: '已注销' }, { chat: { is_deleted: true } }), 'ignored_deleted'],
    ];
    for (const [p, want] of cases) assert.equal(await client.o.onMessage(p), want, p.text);
    for (const p of [GROUP, BOTU, SERVICE, LENA]) assert.equal(await getConv(t, cid(p)), null);
  });

  it('在手机上自己发的存成手机发的；墨鸽发出去推回来的（同一个消息 id）不重复存', async () => {
    const replyText = fake.named(client, 'sendText').find((c) => c.args[2] === replyId).args[1];
    assert.equal(await client.o.onMessage(pm(MARIA, { text: replyText }, { id: Number(replyId), out: true })), 'ignored_echo');
    await client.o.onMessage(pm(MARIA, { text: '我是本人，稍等' }, { id: 102, out: true }));
    const out = (await getMessages(t, cid(MARIA))).filter((m) => m.direction === 'out');
    assert.deepEqual(
      out.map((m) => [m.author, m.text === replyText ? '回复' : m.text]),
      [
        ['bot', '回复'],
        ['owner', '我是本人，稍等'],
      ],
    );
    assert.equal(out[1].via, 'phone');
    assert.ok(out[1].revocableUntil, '手机上发的也能撤回');
  });

  it('改消息：客户改的、自己在手机上改的都换成改后的；群里的、对不上的不改', async () => {
    await client.o.onEdit(pm(MARIA, { text: '保温杯多少钱？蓝色的' }, { id: 101 }));
    await client.o.onEdit(pm(MARIA, { text: '我是本人，马上回您' }, { id: 102, out: true }));
    assert.equal(await client.o.onEdit(pm(GROUP, { text: '群里改的' }, { id: 101, chat: { type: 'other' } })), 'ignored_non_private');
    assert.equal(await client.o.onEdit(pm(MARIA, { text: '对不上的' }, { id: 9999 })), 'ignored_edit_unknown');
    const msgs = await getMessages(t, cid(MARIA));
    const cust = msgs.find((m) => m.direction === 'in');
    assert.equal(cust.text, '保温杯多少钱？蓝色的');
    assert.deepEqual(cust.edited.history.map((h) => h.text), ['保温杯多少钱']);
    const own = msgs.find((m) => m.via === 'phone');
    assert.equal(own.text, '我是本人，马上回您');
    assert.deepEqual(own.edited.history.map((h) => h.text), ['我是本人，稍等']);
  });

  it('人工发文字、图片（带说明，按图片发）、文件（原样）', async () => {
    const r = await t.req('POST', `${convPath(cid(MARIA))}/send`, { body: { text: '您好，我是店长' } });
    assert.equal(r.body.status, 'sent', JSON.stringify(r.body));
    assert.deepEqual(fake.named(client, 'sendText').at(-1).args.slice(0, 2), [MARIA.id, '您好，我是店长']);
    const up = await t.req('POST', '/api/files', {
      body: filesForm([
        { name: 'cup.png', buffer: TINY_PNG, type: 'image/png' },
        { name: 'price.pdf', buffer: makePdf('price list'), type: 'application/pdf' },
      ]),
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const png = up.body.find((f) => f.filename === 'cup.png');
    const pdf = up.body.find((f) => f.filename === 'price.pdf');
    const p = await t.req('POST', `${convPath(cid(MARIA))}/send-file`, { body: { fileId: png.id, caption: '看图' } });
    assert.equal(p.body.status, 'sent', JSON.stringify(p.body));
    const [chat, photo] = fake.named(client, 'sendFile').at(-1).args;
    assert.equal(chat, MARIA.id);
    assert.equal(photo.asPhoto, true);
    assert.equal(photo.caption, '看图');
    assert.ok(photo.buffer.equals(TINY_PNG));
    const d = await t.req('POST', `${convPath(cid(MARIA))}/send-file`, { body: { fileId: pdf.id } });
    assert.equal(d.body.status, 'sent', JSON.stringify(d.body));
    const doc = fake.named(client, 'sendFile').at(-1).args[1];
    assert.equal(doc.asPhoto, false);
    assert.equal(doc.filename, 'price.pdf');
    assert.equal(doc.mime, 'application/pdf');
    assert.equal(doc.caption, '');
  });

  it('撤回：对双方删除；Telegram 报错时不标撤回', async () => {
    const out = (await getMessages(t, cid(MARIA))).filter((m) => m.direction === 'out' && m.text === '您好，我是店长').at(-1);
    const sentId = fake.named(client, 'sendText').find((c) => c.args[1] === '您好，我是店长').args[2];
    fake.state.deleteFail = true;
    const bad = await t.req('POST', `${convPath(cid(MARIA))}/messages/${out.id}/revoke`, { body: {} });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, 'telegram_error');
    assert.match(bad.body.error, /不能删除/);
    assert.equal((await getMessages(t, cid(MARIA))).find((m) => m.id === out.id).revoked, null);
    fake.state.deleteFail = false;
    const ok = await t.req('POST', `${convPath(cid(MARIA))}/messages/${out.id}/revoke`, { body: {} });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.revoked.by, 'member');
    assert.deepEqual(fake.named(client, 'deleteMessages').at(-1).args, [MARIA.id, [sentId]]);
  });

  it('删除通知（只有消息 id）：客户删的标「客户已撤回」，在手机上删的标手机上撤回；对不上的不管', async () => {
    const r = await client.o.onDelete([101, 102, 99999]);
    assert.equal(r[2], 'ignored_revoke_unknown');
    const msgs = await getMessages(t, cid(MARIA));
    assert.equal(msgs.find((m) => m.direction === 'in').revoked.by, 'customer');
    assert.equal(msgs.find((m) => m.via === 'phone').revoked.by, 'phone');
  });

  it('客户发的图片、文件经客户端下载存下；已知大小超过上限的不下载', async () => {
    const jpeg = fakeJpeg('tguser photo');
    const pdf = makePdf('tguser quote');
    fake.state.files.set('ph-1', jpeg);
    fake.state.files.set('doc-1', pdf);
    await client.o.onMessage(pm(LENA, { photo: [{ file_id: 'ph-1', file_size: jpeg.length }] }));
    await client.o.onMessage(pm(LENA, { document: { file_id: 'doc-1', file_size: pdf.length, mime_type: 'application/pdf', file_name: 'quote.pdf' } }));
    await client.o.onMessage(pm(LENA, { video: { file_id: 'vid-huge', file_size: 500 * 1024 * 1024, mime_type: 'video/mp4', duration: 10 } }));
    const msgs = await waitFor(async () => {
      const list = (await getMessages(t, cid(LENA))).filter((m) => m.direction === 'in' && m.media);
      return list.length === 3 && list.every((m) => m.media.stored !== 'pending') ? list : null;
    });
    const [img, doc, video] = msgs;
    assert.equal(img.text, '[图片]');
    assert.equal(img.media.stored, 'ok', JSON.stringify(img.media));
    assert.equal(img.media.mime, 'image/jpeg');
    const got = await t.req('GET', `${convPath(cid(LENA))}/messages/${img.id}/media`);
    assert.equal(got.status, 200);
    assert.ok(Buffer.from(got.body).equals(jpeg));
    assert.equal(doc.media.stored, 'ok', JSON.stringify(doc.media));
    assert.equal(doc.media.mime, 'application/pdf');
    assert.equal(video.media.stored, 'too_large');
    assert.ok(!fake.named(client, 'openFile').some((c) => c.args[0] === 'vid-huge'), '已知大小超过上限的不去下');
  });

  it('外联群发不能选扫码登录的号', async () => {
    const form = new FormData();
    form.append('file', new Blob(['+86 138 0013 8000'], { type: 'text/plain' }), 'numbers.txt');
    form.append('name', 'TG 外联');
    form.append('mode', 'single');
    form.append('accountIds', JSON.stringify([acc.id]));
    form.append('message', '你好');
    form.append('defaultCountry', 'CN');
    const r = await t.req('POST', '/api/campaigns', { body: form });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'telegram_unsupported');
    assert.match(r.body.error, /扫码登录的个人帐号/);
  });

  it('全局代理开关变了：用登录态重连（补收停机期间的消息）；扫完码还没输两步验证密码时重连，接着要密码', async () => {
    const old = client;
    await t.ctx.wa.tgUserProxyChanged();
    const st = await waitState('working');
    client = fake.of(acc);
    assert.notEqual(client, old);
    assert.ok(old.closed);
    assert.equal(client.o.catchUp, true, '用登录态重连时补收停机期间的消息');
    assert.equal(fake.named(client, 'restore').length, 1);
    assert.deepEqual(st.telegram.me, { name: 'Bowen Rui', username: 'bowen_r' });

    fake.state.sessions.set(sessionPath(), { needPassword: true });
    fake.state.twoFa = 'pw-restart-1';
    await t.ctx.wa.tgUserProxyChanged();
    await waitState('password');
    client = fake.of(acc);
    const r = await t.req('POST', api('password'), { body: { password: 'pw-restart-1' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitState('working');
    assert.equal(fake.named(client, 'checkPassword').length, 1);
    fake.state.twoFa = '';
  });

  it('用登录态重连时无法连接 Telegram：failed，说明会自动重试，登录态留着；过一会儿自己连上', async () => {
    fake.state.restoreFails = 2;
    await t.ctx.wa.tgUserProxyChanged();
    const st = await waitState('failed');
    assert.match(st.error, /无法连接 Telegram.*秒后自动重试/);
    assert.ok(fs.existsSync(sessionPath()), '登录态留着');
    await waitState('working');
    client = fake.of(acc);
    assert.equal(fake.state.restoreFails, 0);
    assert.equal(fake.named(client, 'restore').length, 1);
  });

  it('登录失效（比如在手机上结束了墨鸽）：logged_out、说明原因，删掉登录态；发消息失败', async () => {
    client.o.onAuthLost(new TgUserError('登录失效', { code: 'AUTH_KEY_UNREGISTERED', authLost: true }));
    const st = await waitState('logged_out');
    assert.match(st.error, /登录已失效/);
    await waitFor(sessionGone, { message: '登录态没删掉' });
    assert.ok(client.closed);
    const r = await t.req('POST', `${convPath(cid(MARIA))}/send`, { body: { text: '还在吗' } });
    assert.equal(r.body.status, 'failed');
    assert.match(r.body.error, /未登录/);
    // 没有登录态：改号时不会自己连
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { name: 'TG 扫码号' } });
    assert.equal(fake.of(acc), client);
  });

  it('开了两步验证：扫码后要密码，输错 400 还能再输，输对了 working；密码不存', async () => {
    fake.state.twoFa = 'correct-horse-9';
    await t.req('POST', api('login'));
    await waitState('scan_qr');
    client = fake.of(acc);
    assert.equal(client.o.catchUp, false);
    const scanning = client.login.scan();
    await waitState('password');
    assert.equal((await t.req('GET', api('qr'))).status, 404);
    assert.equal((await t.req('POST', api('password'), { body: { password: '' } })).status, 400);
    assert.equal((await t.req('POST', api('password'), { body: { password: 'wrong-pass-1' }, cookie: agent.cookie })).status, 403);
    const wrong = await t.req('POST', api('password'), { body: { password: 'wrong-pass-1' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'wrong_password');
    assert.equal((await status()).state, 'password');
    const right = await t.req('POST', api('password'), { body: { password: 'correct-horse-9' } });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    await scanning;
    await waitState('working');
    const late = await t.req('POST', api('password'), { body: { password: 'correct-horse-9' } });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'not_waiting_password');
    fake.state.twoFa = '';
    for (const pw of PASSWORDS) assert.equal(dataDirHas(t.dataDir, pw), null, `密码存进了文件`);
  });

  it('验证码登录：已登录的 409；手机号格式错误、被 Telegram 拒了 400；验证码发出后 code，输错 400 还能再输，输对了 working', async () => {
    const byPhone = (body, cookie) => t.req('POST', api('login'), { body, ...(cookie ? { cookie } : {}) });
    const sendCode = (code, cookie) => t.req('POST', api('code'), { body: { code }, ...(cookie ? { cookie } : {}) });
    const already = await byPhone({ phone: PHONE });
    assert.equal(already.status, 409);
    assert.equal(already.body.code, 'already_logged_in');
    await t.req('POST', api('logout'));
    for (const phone of ['12345', '+1 415', 14155550134, '+1 415 555 0134 ext 9']) {
      assert.equal((await byPhone({ phone })).body.code, 'bad_phone', String(phone));
    }
    assert.equal((await byPhone({ phone: PHONE }, agent.cookie)).status, 403, '业务员不能登录');
    assert.equal((await sendCode(LOGIN_CODE)).body.code, 'not_waiting_code');

    fake.state.phoneError = new TgUserError('该手机号未注册 Telegram', { code: 'PHONE_NUMBER_UNOCCUPIED' });
    const rejected = await byPhone({ phone: PHONE });
    fake.state.phoneError = null;
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'login_failed');
    assert.match(rejected.body.error, /未注册/);
    assert.equal((await status()).state, 'logged_out');
    assert.ok(sessionGone());

    // 等验证码发出去才返回：返回时已经在 code，说明发到了哪；手机号不给页面
    const r = await byPhone({ phone: PHONE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    client = fake.of(acc);
    assert.equal(client.phone, PHONE_E164);
    assert.equal(client.o.catchUp, false);
    const st = await status();
    assert.equal(st.state, 'code');
    assert.deepEqual(st.telegram, { me: null, qrVersion: null, qrExpiresAt: null, loginMethod: 'phone', codeVia: 'app', codeLength: 5 });
    assert.ok(!JSON.stringify(st).includes('4155550134'));
    assert.equal((await t.req('GET', api('qr'))).status, 404);

    assert.equal((await sendCode('')).status, 400);
    assert.equal((await sendCode('x'.repeat(65))).status, 400);
    assert.equal((await sendCode(LOGIN_CODE, agent.cookie)).status, 403);
    const wrong = await sendCode(WRONG_CODE);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'wrong_code');
    assert.equal((await status()).state, 'code');
    // 带空格、短横线的照样认
    const right = await sendCode(LOGIN_CODE.replace(/(\d{3})/, '$1 - '));
    assert.equal(right.status, 200, JSON.stringify(right.body));
    await waitState('working');
    assert.deepEqual(
      fake.named(client, 'codeAttempt').map((x) => x.args[0]),
      [WRONG_CODE, LOGIN_CODE],
    );
    assert.equal((await status()).telegram.loginMethod, null);
    const late = await sendCode(LOGIN_CODE);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'not_waiting_code');
  });

  it('验证码登录：重新获取换新的客户端；开了两步验证时验证码对了进 password，输对密码 working', async () => {
    await t.req('POST', api('logout'));
    fake.state.twoFa = 'correct-horse-9';
    assert.equal((await t.req('POST', api('login'), { body: { phone: PHONE } })).status, 200);
    const first = fake.of(acc);
    assert.equal((await t.req('POST', api('login'), { body: { phone: PHONE } })).status, 200);
    client = fake.of(acc);
    assert.notEqual(client, first, '重新获取验证码重新开始');
    assert.ok(first.closed);
    assert.equal((await status()).state, 'code');
    const code = await t.req('POST', api('code'), { body: { code: LOGIN_CODE } });
    assert.equal(code.status, 200, JSON.stringify(code.body));
    assert.equal((await status()).state, 'password');
    const pw = await t.req('POST', api('password'), { body: { password: 'correct-horse-9' } });
    assert.equal(pw.status, 200, JSON.stringify(pw.body));
    await waitState('working');
    fake.state.twoFa = '';
  });

  it('退出登录：从 Telegram 退出、删掉登录态；退出时连不上 Telegram 也删掉，提示去手机上结束；正在扫码的直接停下', async () => {
    assert.equal((await t.req('POST', api('logout'), { cookie: agent.cookie })).status, 403, '业务员不能退出登录');
    assert.ok(fs.existsSync(sessionPath()));
    const r = await t.req('POST', api('logout'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status.state, 'logged_out');
    assert.equal(r.body.status.error, null);
    assert.equal(fake.named(client, 'logOut').length, 1);
    assert.ok(client.closed);
    assert.ok(sessionGone());

    client = await loginByQr();
    fake.state.logOutFail = true;
    const bad = await t.req('POST', api('logout'));
    fake.state.logOutFail = false;
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /设置 → 设备/);
    assert.ok(client.closed);
    assert.ok(sessionGone());
    assert.equal((await status()).state, 'logged_out');

    await t.req('POST', api('login'));
    await waitState('scan_qr');
    client = fake.of(acc);
    const stop = await t.req('POST', api('logout'));
    assert.equal(stop.status, 200);
    assert.equal(stop.body.status.state, 'logged_out');
    assert.ok(client.closed);
    assert.equal(fake.named(client, 'logOut').length, 0, '没登录上的不用从 Telegram 退出');
    assert.ok(sessionGone());
  });

  it('导出带 api_id 和 api_hash（登录态不导出）；导入的号要重新扫码', async () => {
    const ex = await t.req('GET', '/api/accounts/export');
    assert.equal(ex.status, 200);
    const item = ex.body.accounts.find((a) => a.channel === 'tguser');
    assert.deepEqual(item.telegram, { apiId: '1234567', apiHash: API_HASH });
    const fd = new FormData();
    fd.append('file', new Blob([JSON.stringify({ ...ex.body, accounts: [{ ...item, name: 'TG 扫码二号' }] })], { type: 'application/json' }), 'inkdove-accounts.json');
    const ok = await t.req('POST', '/api/accounts/import', { body: fd });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.created.length, 1);
    const created = t.ctx.accounts.get(ok.body.created[0].id);
    assert.equal(created.channel, 'tguser');
    assert.deepEqual(created.telegram, { apiId: '1234567', apiHash: API_HASH });
    assert.equal((await t.req('GET', `/api/accounts/${created.id}`)).body.status.state, 'logged_out');
    await t.req('DELETE', `/api/accounts/${created.id}`);
  });

  it('操作日志：扫码登录、验证码登录、两步验证、退出登录都记，api_hash 只记已设置；api_hash、二维码、手机号、验证码、密码、用户 id 不出现在接口和日志里', async () => {
    const rows = t.ctx.db.prepare("SELECT action, summary FROM audit_logs WHERE action LIKE 'account.telegram_%'").all();
    assert.ok(rows.some((a) => a.action === 'account.telegram_login' && /Telegram 扫码登录/.test(a.summary)));
    assert.ok(rows.some((a) => a.action === 'account.telegram_login' && /Telegram 验证码登录/.test(a.summary)));
    assert.ok(rows.some((a) => a.action === 'account.telegram_code' && /登录验证码/.test(a.summary)));
    assert.ok(rows.some((a) => a.action === 'account.telegram_password' && /两步验证密码/.test(a.summary)));
    assert.ok(rows.some((a) => a.action === 'account.telegram_logout' && /退出了 Telegram 登录/.test(a.summary)));
    const row = t.ctx.db.prepare("SELECT * FROM audit_logs WHERE action = 'account.update' AND changes LIKE '%telegram.apiHash%' ORDER BY seq DESC LIMIT 1").get();
    const change = JSON.parse(row.changes).find((c) => c.field === 'telegram.apiHash');
    assert.deepEqual(change, { field: 'telegram.apiHash', label: 'Telegram api_hash', secret: true, note: '已设置' });
    const audit = JSON.stringify(t.ctx.db.prepare("SELECT * FROM audit_logs WHERE action <> 'account.export'").all());
    const secrets = [API_HASH, QR_TOKEN, '4155550134', LOGIN_CODE, WRONG_CODE, ...PASSWORDS];
    for (const s of secrets) assert.ok(!audit.includes(s), `操作日志里出现了 ${s === API_HASH ? 'api_hash' : s}`);
    assert.equal(dataDirHas(t.dataDir, '4155550134'), null, '手机号存进了文件');
    for (const s of [...secrets, MARIA.id, LENA.id, ME.id]) {
      assert.ok(!t.log.lines.some((l) => l.includes(s)), `日志里出现了 ${s === API_HASH ? 'api_hash' : s}`);
    }
  });

  it('删号：从 Telegram 退出，删掉登录态', async () => {
    client = await loginByQr();
    const r = await t.req('DELETE', `/api/accounts/${acc.id}`);
    assert.equal(r.status, 200);
    assert.equal(fake.named(client, 'logOut').length, 1);
    assert.ok(client.closed);
    assert.ok(sessionGone());
  });
});

describe('Telegram 扫码登录：太久没完成', () => {
  it('二维码、验证码、两步验证太久没完成：停下、删掉半截的登录态，状态里说明，要登录时再点', async () => {
    const fake = fakeTgUser();
    const t = await startApp({ options: { tgUserClientFactory: fake.factory, tgUserLoginTimeoutMs: 400 } });
    try {
      await t.login();
      const acc = await t.createAccount({ name: 'TG 超时', channel: 'tguser', telegram: { apiId: '1234567', apiHash: API_HASH } });
      const sessionPath = path.join(t.dataDir, 'telegram', `${acc.id}.session`);
      const status = async () => (await t.req('GET', `/api/accounts/${acc.id}`)).body.status;
      const timedOut = () =>
        waitFor(
          async () => {
            const s = await status();
            return s.state === 'logged_out' && s.error ? s : null;
          },
          { message: '扫码登录没有超时' },
        );
      await t.req('POST', `/api/accounts/${acc.id}/telegram/login`);
      const st = await timedOut();
      assert.match(st.error, /未完成/);
      assert.ok(fake.of(acc).closed);
      assert.ok(!fs.existsSync(sessionPath));
      assert.equal((await t.req('GET', `/api/accounts/${acc.id}/telegram/qr`)).status, 404);

      // 扫了码、一直不输两步验证密码
      fake.state.twoFa = 'never-typed-1';
      await t.req('POST', `/api/accounts/${acc.id}/telegram/login`);
      await waitFor(async () => (await status()).state === 'scan_qr');
      fake.of(acc).login.scan();
      await waitFor(async () => (await status()).state === 'password');
      assert.match((await timedOut()).error, /未完成/);
      assert.ok(fake.of(acc).closed);
      assert.ok(!fs.existsSync(sessionPath));
      const late = await t.req('POST', `/api/accounts/${acc.id}/telegram/password`, { body: { password: 'never-typed-1' } });
      assert.equal(late.status, 409);

      // 验证码发出去了、一直不输
      fake.state.twoFa = '';
      const sent = await t.req('POST', `/api/accounts/${acc.id}/telegram/login`, { body: { phone: PHONE } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal((await status()).state, 'code');
      assert.match((await timedOut()).error, /未完成/);
      assert.ok(fake.of(acc).closed);
      assert.ok(!fs.existsSync(sessionPath));
      const lateCode = await t.req('POST', `/api/accounts/${acc.id}/telegram/code`, { body: { code: LOGIN_CODE } });
      assert.equal(lateCode.status, 409);
    } finally {
      await t.close();
    }
  });
});
