// Telegram 机器人和私人号（Bot API 的长轮询、business connection）：消息解析、积压消息不要、offset 存盘（重启后接着取）、
// 消息 id 按聊天区分、群和机器人不处理、媒体、发文字和文件、撤回、token 冲突和失效、私人号的绑定和连接、回声、删除通知、
// 换号主、外联、导出导入、操作日志和日志里不带 token 和用户 id。全部对着本地的假 Telegram 服务器
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseTelegramMessage } from '../src/wa/service.js';
import { fakeJpeg, filesForm, makePdf } from './fixtures.js';
import { convIdOf, convPath, getConv, getMessages, sleep, startApp, TINY_PNG, waitDecided, waitFor } from './helpers.js';

/** 不像真 token 的假值（拼起来，免得被当成泄露的密钥拦下） */
const tokenOf = (id) => [String(id), ['TEST', 'token', 'not', 'real', 'x'.repeat(20)].join('_')].join(':');

/**
 * 假 Telegram 服务器：POST /bot<token>/<方法>（JSON 或 multipart），GET /file/bot<token>/<file_path>。
 * - getUpdates：offset 为负时只留最后 -offset 条（前面的忘掉），为正时去掉比它小的；按 allowed_updates 过滤；
 *   没有新的、timeout > 0 时等到有新的或者超时（push 会叫醒）。bot.conflict 时返回 409
 * - sendMessage、sendPhoto、sendDocument：每个聊天各自从 1001 开始编消息 id（Telegram 的消息 id 只在一个聊天里唯一）；
 *   bot.blocked 里的聊天返回 403
 * - deleteMessage、deleteBusinessMessages：bot.deleteFail 时返回 400
 * - getFile：files 里登记的（tooBig 的返回 file is too big）
 * 没登记的、revoked 里的 token 返回 401
 */
async function startFakeTelegram() {
  const state = { requests: [], bots: new Map(), files: new Map(), revoked: new Set() };
  const waiters = new Set();
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const typeOf = (u) => Object.keys(u).find((k) => k !== 'update_id');
  const take = (b, offset, allowed) => {
    if (offset < 0) b.updates = b.updates.slice(offset);
    else if (offset > 0) b.updates = b.updates.filter((u) => u.update_id >= offset);
    if (Array.isArray(allowed) && allowed.length) b.updates = b.updates.filter((u) => allowed.includes(typeOf(u)));
    return b.updates.slice(0, 100);
  };
  const sentMessage = (b, chat, extra) => {
    const n = (b.chatSeq.get(chat) ?? 1000) + 1;
    b.chatSeq.set(chat, n);
    return { message_id: n, chat: { id: Number(chat), type: 'private' }, date: Math.floor(Date.now() / 1000), ...extra };
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const json = (status, obj) => {
      if (res.writableEnded || req.socket.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const fail = (code, description) => json(code, { ok: false, error_code: code, description });
    let m = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const token = decodeURIComponent(m[1]);
      state.requests.push({ token, method: 'file', path: m[2], body: null });
      if (!state.bots.has(token)) return fail(401, 'Unauthorized');
      const f = [...state.files.values()].find((x) => x.path === m[2]);
      if (!f) return fail(404, 'Not Found');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': f.buffer.length });
      return res.end(f.buffer);
    }
    m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return fail(404, 'Not Found');
    const token = decodeURIComponent(m[1]);
    const method = m[2];
    let body = {};
    let file = null;
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
      for (const [k, v] of form) {
        if (typeof v === 'string') body[k] = v;
        else file = { field: k, name: v.name, type: v.type, buffer: Buffer.from(await v.arrayBuffer()) };
      }
    } else if (raw.length) {
      body = JSON.parse(raw.toString());
    }
    const entry = { token, method, body, file, result: null };
    state.requests.push(entry);
    const b = state.bots.get(token);
    if (!b || state.revoked.has(token)) return fail(401, 'Unauthorized');
    const ok = (result) => {
      entry.result = result;
      json(200, { ok: true, result });
    };
    switch (method) {
      case 'getMe':
        return ok(b.me);
      case 'deleteWebhook':
        return ok(true);
      case 'getUpdates': {
        if (b.conflict) return fail(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running');
        const offset = Number(body.offset) || 0;
        let got = take(b, offset, body.allowed_updates);
        const timeout = Number(body.timeout) || 0;
        if (!got.length && timeout > 0) {
          await new Promise((resolve) => {
            const done = () => {
              waiters.delete(done);
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(done, timeout * 1000);
            waiters.add(done);
            res.on('close', done);
          });
          got = take(b, offset, body.allowed_updates);
        }
        return ok(got);
      }
      case 'sendMessage': {
        const chat = String(body.chat_id);
        if (b.blocked.has(chat)) return fail(403, 'Forbidden: bot was blocked by the user');
        return ok(sentMessage(b, chat, { text: body.text }));
      }
      case 'sendPhoto':
      case 'sendDocument':
        return ok(sentMessage(b, String(body.chat_id), { caption: body.caption }));
      case 'sendChatAction':
      case 'readBusinessMessage':
        return ok(true);
      case 'deleteMessage':
      case 'deleteBusinessMessages':
        if (b.deleteFail) return fail(400, "Bad Request: message can't be deleted");
        return ok(true);
      case 'getFile': {
        const f = state.files.get(body.file_id);
        if (!f) return fail(400, 'Bad Request: invalid file_id');
        if (f.tooBig) return fail(400, 'Bad Request: file is too big');
        return ok({ file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_size: f.buffer.length, file_path: f.path });
      }
      default:
        return fail(404, 'Not Found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const calls = (token, method) => state.requests.filter((r) => r.token === token && (!method || r.method === method));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    addBot(token, me) {
      const b = { me, updates: [], nextId: 100, chatSeq: new Map(), conflict: false, deleteFail: false, blocked: new Set() };
      state.bots.set(token, b);
      return b;
    },
    /** 给这个机器人排一条 update，返回它（带 update_id） */
    push(token, update) {
      const b = state.bots.get(token);
      const u = { update_id: b.nextId++, ...update };
      b.updates.push(u);
      wake();
      return u;
    },
    calls,
    /** 发给某个聊天的最后一次请求 */
    lastTo: (token, method, chatId) => calls(token, method).filter((r) => String(r.body.chat_id) === String(chatId)).at(-1),
    /** 等这条 update 处理完（下一次 getUpdates 的 offset 已经越过它） */
    consumed: (token, u) =>
      waitFor(() => calls(token, 'getUpdates').some((r) => Number(r.body.offset) > u.update_id), { message: `update ${u.update_id} 迟迟没处理完` }),
    close: () => {
      wake();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

let mid = 0;
const person = (id, first, last) => ({ id, is_bot: false, first_name: first, ...(last ? { last_name: last } : {}) });
const privateChat = (p) => ({ id: p.id, type: 'private', first_name: p.first_name, ...(p.last_name ? { last_name: p.last_name } : {}) });
const nowSec = () => Math.floor(Date.now() / 1000);
/** 机器人私聊里客户发的一条 message */
const botMsg = (from, content, o = {}) => ({
  message: { message_id: o.id ?? 10 + ++mid, from, chat: o.chat ?? privateChat(from), date: o.date ?? nowSec(), ...content },
});

const KB = { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' };
const IVAN = person(9000000101, 'Ivan', 'Petrov');
const ANNA = person(9000000102, 'Anna');
const OLGA = person(9000000103, 'Olga');

describe('Telegram 消息解析（单元）', () => {
  const msg = (content, chat = privateChat(IVAN)) => ({ message_id: 42, from: IVAN, chat, date: 1700000000, ...content });

  it('文字、名字、时间、引用；群和频道返回 null', () => {
    const m = parseTelegramMessage(msg({ text: ' 你好 ', reply_to_message: { message_id: 7 } }));
    assert.equal(m.channel, 'telegram');
    assert.equal(m.chatId, String(IVAN.id));
    assert.equal(m.externalId, '42');
    assert.equal(m.text, '你好');
    assert.equal(m.contactName, 'Ivan Petrov');
    assert.equal(m.timestampMs, 1700000000000);
    assert.equal(m.replyToId, '7');
    assert.equal(m.fromMe, false);
    assert.equal(m.media, null);
    assert.equal(parseTelegramMessage(msg({ text: 'x' }, { id: 5, type: 'private', username: 'ivan_p' })).contactName, '@ivan_p');
    assert.equal(parseTelegramMessage(msg({ text: 'x' }, { id: -100123, type: 'group', title: '群' })), null);
    assert.equal(parseTelegramMessage(msg({ text: 'x' }, { id: -100124, type: 'channel', title: '频道' })), null);
    assert.equal(parseTelegramMessage(null), null);
  });

  it('图片取最大的一张；语音、文件、超大视频；说明文字当正文', () => {
    const photo = parseTelegramMessage(
      msg({
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1000 },
          { file_id: 'big', file_unique_id: 'b', width: 1280, height: 1280, file_size: 90000 },
        ],
        caption: '这个型号',
      }),
    );
    assert.equal(photo.text, '这个型号');
    assert.equal(photo.mediaLabel, null);
    assert.deepEqual(
      { type: photo.media.type, id: photo.media.id, f4Type: photo.media.f4Type, mime: photo.media.mime, size: photo.media.size },
      { type: 'image', id: 'big', f4Type: 'image', mime: 'image/jpeg', size: 90000 },
    );
    const voice = parseTelegramMessage(msg({ voice: { file_id: 'v1', file_unique_id: 'v', duration: 3, mime_type: 'audio/ogg', file_size: 5000 } }));
    assert.equal(voice.mediaLabel, '[语音]');
    assert.deepEqual({ type: voice.media.type, f4Type: voice.media.f4Type, seconds: voice.media.seconds, mime: voice.media.mime }, { type: 'voice', f4Type: 'voice', seconds: 3, mime: 'audio/ogg' });
    const doc = parseTelegramMessage(msg({ document: { file_id: 'd1', file_unique_id: 'd', file_name: 'quote.pdf', mime_type: 'application/pdf', file_size: 1234 } }));
    assert.equal(doc.mediaLabel, '[文件]');
    assert.deepEqual({ type: doc.media.type, filename: doc.media.filename, f4Type: doc.media.f4Type }, { type: 'document', filename: 'quote.pdf', f4Type: null });
    const video = parseTelegramMessage(msg({ video: { file_id: 'vid', file_unique_id: 'x', duration: 9, width: 1, height: 1, mime_type: 'video/mp4', file_size: 30e6 } }));
    assert.equal(video.mediaLabel, '[视频]');
    assert.equal(video.media.size, 30e6);
  });

  it('贴纸、位置、联系人、投票记成标签', () => {
    assert.equal(parseTelegramMessage(msg({ sticker: { file_id: 'st', emoji: '👍' } })).mediaLabel, '[贴纸]');
    assert.equal(parseTelegramMessage(msg({ sticker: { file_id: 'st' } })).media, null);
    const venue = parseTelegramMessage(
      msg({ venue: { location: { latitude: 35.65, longitude: 139.74 }, title: '東京タワー', address: '東京都港区芝公園4-2-8' }, location: { latitude: 35.65, longitude: 139.74 } }),
    );
    assert.equal(venue.mediaLabel, '[位置] 東京タワー（東京都港区芝公園4-2-8）');
    assert.equal(parseTelegramMessage(msg({ location: { latitude: 35.65, longitude: 139.74 } })).mediaLabel, '[位置] 35.65, 139.74');
    assert.equal(parseTelegramMessage(msg({ contact: { phone_number: '79001234567', first_name: 'Anna' } })).mediaLabel, '[联系人] Anna +79001234567');
    assert.equal(parseTelegramMessage(msg({ poll: { id: 'p', question: '哪个颜色？', options: [] } })).mediaLabel, '[投票] 哪个颜色？');
  });
});

describe('Telegram 机器人', () => {
  const BOT_ID = 7000000001;
  const BOT = tokenOf(BOT_ID);
  const BOT2 = tokenOf(7000000004);
  const BOT_ME = { id: BOT_ID, is_bot: true, first_name: 'Inkdove Test', username: 'inkdove_test_bot', can_connect_to_business: false };
  let t;
  let tg;
  let bot;
  let acc;
  const cid = (p) => convIdOf(acc, String(p.id));
  const status = async () => (await t.req('GET', `/api/accounts/${acc.id}`)).body.status;

  before(async () => {
    tg = await startFakeTelegram();
    bot = tg.addBot(BOT, BOT_ME);
    tg.addBot(BOT2, { ...BOT_ME, id: 7000000004, username: 'inkdove_test2_bot' });
    t = await startApp({ env: { INKDOVE_TELEGRAM_API_URL: tg.url }, options: { tgPollTimeoutSec: 1, tgRetryMs: 20 } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: KB });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: 'TG 机器人', channel: 'tgbot' });
  });
  after(async () => {
    await t.close();
    await tg.close();
  });

  it('未填 token：not_configured，不连 Telegram；token 格式错误 400；不能开 WhatsApp 通知', async () => {
    assert.equal(acc.status.state, 'not_configured');
    assert.deepEqual(acc.telegram, { botTokenSet: false });
    assert.equal(acc.waha, null);
    assert.equal(acc.line, null);
    assert.equal(tg.state.requests.length, 0);
    const bad = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { telegram: { botToken: 'abc' } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'bad_token');
    const wa = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: true, number: '+86 139 0000 1111' } } } });
    assert.equal(wa.status, 400);
    assert.equal(wa.body.code, 'whatsapp_notify_unsupported');
    assert.match(wa.body.error, /Telegram 机器人不支持 WhatsApp 通知/);
    const waha = await t.createAccount({ name: '扫码号' });
    assert.equal(waha.telegram, null);
    assert.equal((await t.req('PUT', `/api/accounts/${waha.id}`, { body: { telegram: { botToken: BOT } } })).status, 400, '扫码号没有 telegram 字段');
    await t.req('DELETE', `/api/accounts/${waha.id}`);
  });

  it('填 token：先 getMe、删 webhook，之前积压的消息不要；状态 working，显示机器人用户名', async () => {
    tg.push(BOT, botMsg(OLGA, { text: '积压的第一条' }));
    const last = tg.push(BOT, botMsg(OLGA, { text: '积压的第二条' }));
    const s = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { autoReply: true, telegram: { botToken: BOT } } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.telegram, { botTokenSet: true });
    await waitFor(async () => (await status()).state === 'working', { message: '没有进入 working' });
    const st = await status();
    assert.equal(st.error, null);
    assert.deepEqual(st.telegram, { botUsername: 'inkdove_test_bot', bindLink: null, owner: null, connection: null });
    const methods = tg.calls(BOT).map((r) => r.method);
    assert.deepEqual(methods.slice(0, 3), ['getMe', 'deleteWebhook', 'getUpdates']);
    const first = tg.calls(BOT, 'getUpdates')[0];
    assert.equal(first.body.offset, -1, '第一次只取最后一条，前面的确认掉');
    assert.equal(first.body.timeout, 0);
    assert.deepEqual(first.body.allowed_updates, ['message', 'edited_message', 'my_chat_member']);
    await waitFor(() => tg.calls(BOT, 'getUpdates').length >= 2);
    assert.equal(tg.calls(BOT, 'getUpdates')[1].body.offset, last.update_id + 1, '最后一条也跳过');
    const kv = JSON.parse(t.ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(`telegram:${acc.id}`).value);
    assert.equal(kv.offset, last.update_id + 1);
    assert.equal(kv.botId, String(BOT_ID));
    await sleep(100);
    assert.equal(await getConv(t, cid(OLGA)), null);
  });

  it('客户发文字：建会话，名字取 Telegram 上的；先显示「正在输入」再回复；48 小时内能撤回', async () => {
    tg.push(BOT, botMsg(IVAN, { text: '保温杯多少钱' }));
    const msgs = await waitDecided(t, cid(IVAN), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    const send = await waitFor(() => tg.lastTo(BOT, 'sendMessage', IVAN.id));
    assert.match(send.body.text, /59 元/);
    assert.equal(send.body.business_connection_id, undefined);
    const typing = tg.lastTo(BOT, 'sendChatAction', IVAN.id);
    assert.deepEqual(typing.body, { chat_id: String(IVAN.id), action: 'typing' });
    assert.ok(tg.state.requests.indexOf(typing) < tg.state.requests.indexOf(send), '先正在输入再回复');
    assert.equal(tg.calls(BOT, 'readBusinessMessage').length, 0, '机器人不能标已读');
    const conv = await getConv(t, cid(IVAN));
    assert.equal(conv.contactName, 'Ivan Petrov');
    assert.equal(conv.contactNumber, '');
    assert.equal(conv.channel, 'tgbot');
    const out = (await getMessages(t, cid(IVAN))).find((m) => m.direction === 'out');
    assert.equal(out.status, 'sent');
    const left = Date.parse(out.revocableUntil) - Date.now();
    assert.ok(left > 46 * 3600_000 && left <= 47 * 3600_000, `撤回时限 ${left}`);
  });

  it('消息 id 只在一个聊天里唯一：两个客户的消息 id 相同时各存各的；同一聊天重复的只存一次', async () => {
    tg.push(BOT, botMsg(ANNA, { text: '你好' }, { id: 5555 }));
    tg.push(BOT, botMsg(OLGA, { text: '你好' }, { id: 5555 }));
    tg.push(BOT, botMsg(ANNA, { text: '你好' }, { id: 5555 }));
    await waitDecided(t, cid(ANNA), 1);
    await waitDecided(t, cid(OLGA), 1);
    await sleep(150);
    assert.equal((await getMessages(t, cid(ANNA))).filter((m) => m.direction === 'in').length, 1);
    assert.equal((await getMessages(t, cid(OLGA))).filter((m) => m.direction === 'in').length, 1);
  });

  it('客户改消息（edited_message）：换成改后的、改前的留着，已经回复过的不再回复；对不上的、群里的不改', async () => {
    const PETR = person(9000000104, 'Petr');
    tg.push(BOT, botMsg(PETR, { text: '保温杯多少钱' }, { id: 801 }));
    const [m] = await waitDecided(t, cid(PETR), 1);
    assert.equal(m.botDecision, 'replied');
    const sends = () => tg.calls(BOT, 'sendMessage').filter((r) => String(r.body.chat_id) === String(PETR.id)).length;
    await waitFor(() => sends() === 1);
    const edit = (id, content, chat = privateChat(PETR)) =>
      tg.push(BOT, { edited_message: { message_id: id, from: PETR, chat, date: nowSec() - 5, edit_date: nowSec(), ...content } });
    edit(801, { text: '群里改的' }, { id: -100123, type: 'group', title: '群' });
    edit(9999, { text: '对不上的' });
    const u = edit(801, { text: '保温杯多少钱？要两个' });
    await tg.consumed(BOT, u);
    const e = (await getMessages(t, cid(PETR))).find((x) => x.id === m.id);
    assert.equal(e.text, '保温杯多少钱？要两个');
    assert.deepEqual(e.edited.history.map((h) => h.text), ['保温杯多少钱']);
    await sleep(150);
    assert.equal(sends(), 1, '改了已经回复过的不再回复');
    assert.equal((await getMessages(t, cid(PETR))).filter((x) => x.direction === 'in').length, 1, '编辑不存成新消息');
  });

  it('群里的消息、别的机器人发的不处理；客户停用机器人只记日志', async () => {
    tg.push(BOT, botMsg(IVAN, { text: '保温杯多少钱' }, { chat: { id: -100123, type: 'group', title: '群' } }));
    tg.push(BOT, botMsg({ id: 8000000001, is_bot: true, first_name: 'Other Bot' }, { text: '保温杯多少钱' }));
    const u = tg.push(BOT, {
      my_chat_member: {
        chat: privateChat(ANNA),
        from: ANNA,
        date: nowSec(),
        old_chat_member: { status: 'member', user: BOT_ME },
        new_chat_member: { status: 'kicked', user: BOT_ME, until_date: 0 },
      },
    });
    await tg.consumed(BOT, u);
    assert.ok(t.log.lines.some((l) => l.includes('停用了机器人')));
    assert.equal(await getConv(t, convIdOf(acc, '-100123')), null);
    assert.equal(await getConv(t, convIdOf(acc, '8000000001')), null);
  });

  it('客户发的图片取最大的一张、经 getFile 下载；文件照存；超过 20MB 的不下载', async () => {
    const jpeg = fakeJpeg('telegram photo');
    const pdf = makePdf('telegram quote');
    tg.state.files.set('ph-big', { path: 'photos/file_1.jpg', buffer: jpeg });
    tg.state.files.set('doc-1', { path: 'documents/file_2.pdf', buffer: pdf });
    tg.push(
      BOT,
      botMsg(ANNA, {
        photo: [
          { file_id: 'ph-small', file_unique_id: 's', width: 90, height: 90, file_size: 100 },
          { file_id: 'ph-big', file_unique_id: 'b', width: 800, height: 800, file_size: jpeg.length },
        ],
      }),
    );
    tg.push(BOT, botMsg(ANNA, { document: { file_id: 'doc-1', file_unique_id: 'd', file_name: 'quote.pdf', mime_type: 'application/pdf', file_size: pdf.length } }));
    tg.push(BOT, botMsg(ANNA, { video: { file_id: 'vid-huge', file_unique_id: 'v', duration: 10, width: 1, height: 1, mime_type: 'video/mp4', file_size: 25 * 1024 * 1024 } }));
    const msgs = await waitFor(async () => {
      const list = (await getMessages(t, cid(ANNA))).filter((m) => m.direction === 'in' && m.media);
      return list.length === 3 && list.every((m) => m.media.stored !== 'pending') ? list : null;
    });
    const [img, doc, video] = msgs;
    assert.equal(img.text, '[图片]');
    assert.equal(img.media.stored, 'ok', JSON.stringify(img.media));
    assert.equal(img.media.mime, 'image/jpeg');
    const asked = tg.calls(BOT, 'getFile').map((r) => r.body.file_id);
    assert.ok(asked.includes('ph-big') && !asked.includes('ph-small'), asked.join(','));
    const got = await t.req('GET', `${convPath(cid(ANNA))}/messages/${img.id}/media`);
    assert.equal(got.status, 200);
    assert.ok(Buffer.from(got.body).equals(jpeg));
    assert.equal(doc.media.stored, 'ok', JSON.stringify(doc.media));
    assert.equal(doc.media.mime, 'application/pdf');
    assert.equal(video.media.stored, 'too_large');
    assert.ok(!asked.includes('vid-huge'), '已知大小超过 20MB 的不去取');
  });

  it('人工发文字、图片（sendPhoto 带说明）、文件（sendDocument 原样）', async () => {
    const r = await t.req('POST', `${convPath(cid(IVAN))}/send`, { body: { text: '您好，我是店长' } });
    assert.equal(r.body.status, 'sent', JSON.stringify(r.body));
    assert.equal(tg.lastTo(BOT, 'sendMessage', IVAN.id).body.text, '您好，我是店长');
    const up = await t.req('POST', '/api/files', {
      body: filesForm([
        { name: 'cup.png', buffer: TINY_PNG, type: 'image/png' },
        { name: 'price.pdf', buffer: makePdf('price list'), type: 'application/pdf' },
      ]),
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const png = up.body.find((f) => f.filename === 'cup.png');
    const pdf = up.body.find((f) => f.filename === 'price.pdf');
    const p = await t.req('POST', `${convPath(cid(IVAN))}/send-file`, { body: { fileId: png.id, caption: '看图' } });
    assert.equal(p.body.status, 'sent', JSON.stringify(p.body));
    const photo = tg.lastTo(BOT, 'sendPhoto', IVAN.id);
    assert.equal(photo.body.caption, '看图');
    assert.equal(photo.file.field, 'photo');
    assert.ok(photo.file.buffer.equals(TINY_PNG));
    const d = await t.req('POST', `${convPath(cid(IVAN))}/send-file`, { body: { fileId: pdf.id } });
    assert.equal(d.body.status, 'sent', JSON.stringify(d.body));
    const document = tg.lastTo(BOT, 'sendDocument', IVAN.id);
    assert.equal(document.file.field, 'document');
    assert.equal(document.file.name, 'price.pdf');
    assert.equal(document.body.caption, undefined);
  });

  it('客户拉黑了机器人：发送失败，中文原因', async () => {
    bot.blocked.add(String(IVAN.id));
    const r = await t.req('POST', `${convPath(cid(IVAN))}/send`, { body: { text: '还在吗' } });
    assert.equal(r.body.status, 'failed');
    assert.match(r.body.error, /拉黑/);
    bot.blocked.clear();
  });

  it('撤回：deleteMessage；Telegram 报错时不标撤回', async () => {
    const out = (await getMessages(t, cid(IVAN))).filter((m) => m.direction === 'out' && m.status === 'sent' && m.text === '您好，我是店长').at(-1);
    const sent = tg.calls(BOT, 'sendMessage').find((r) => r.body.text === '您好，我是店长');
    bot.deleteFail = true;
    const bad = await t.req('POST', `${convPath(cid(IVAN))}/messages/${out.id}/revoke`, { body: {} });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, 'telegram_error');
    assert.match(bad.body.error, /无法删除/);
    assert.equal((await getMessages(t, cid(IVAN))).find((m) => m.id === out.id).revoked, null);
    bot.deleteFail = false;
    const ok = await t.req('POST', `${convPath(cid(IVAN))}/messages/${out.id}/revoke`, { body: {} });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.revoked.by, 'member');
    assert.deepEqual(tg.calls(BOT, 'deleteMessage').at(-1).body, { chat_id: String(IVAN.id), message_id: sent.result.message_id });
  });

  it('同一个机器人不能给两个号用', async () => {
    const other = await t.createAccount({ name: 'TG 另一个', channel: 'tgbot' });
    const r = await t.req('PUT', `/api/accounts/${other.id}`, { body: { telegram: { botToken: BOT } } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'telegram_bot_in_use');
    await t.req('DELETE', `/api/accounts/${other.id}`);
  });

  it('别处也在用这个 token（409）：failed、中文原因；好了以后自动恢复', async () => {
    bot.conflict = true;
    await waitFor(async () => (await status()).state === 'failed', { message: '409 没有显示出错' });
    assert.match((await status()).error, /正被其他程序使用/);
    bot.conflict = false;
    await waitFor(async () => (await status()).state === 'working', { message: '没有自动恢复' });
    tg.push(BOT, botMsg(OLGA, { text: '恢复后的消息' }));
    await waitFor(async () => (await getMessages(t, cid(OLGA))).some((m) => m.text === '恢复后的消息'));
  });

  it('token 失效（401）：停下不再重试；重新保存 token 后重新开始', async () => {
    tg.state.revoked.add(BOT);
    await waitFor(async () => (await status()).state === 'failed', { message: '401 没有显示出错' });
    assert.match((await status()).error, /token 错误或已失效/);
    const n = tg.calls(BOT).length;
    await sleep(300);
    assert.equal(tg.calls(BOT).length, n, 'token 不对时停下，不一直重试');
    tg.state.revoked.delete(BOT);
    const r = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { telegram: { botToken: BOT } } });
    assert.equal(r.status, 200);
    await waitFor(async () => (await status()).state === 'working', { message: '重新保存后没有重新开始' });
  });

  it('外联群发不能选 Telegram 号', async () => {
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
  });

  it('转人工通知：写名字和「Telegram」，不露用户 id', async () => {
    const n = t.ctx.wa.notifier.buildNotice(t.ctx.accounts.get(acc.id), cid(IVAN), 'handoff', '客户要人工');
    assert.match(n.subject, /^\[待人工\] 客户 Ivan Petrov（Telegram）：/);
    assert.match(n.text, /客户：Ivan Petrov（Telegram）/);
    assert.ok(!n.subject.includes(String(IVAN.id)));
    assert.ok(!n.text.split('\n').filter((l) => !l.startsWith('查看会话：')).some((l) => l.includes(String(IVAN.id))));
  });

  it('导出带 token；导入按机器人去重；其他接入方式带 telegram 报错', async () => {
    const ex = await t.req('GET', '/api/accounts/export');
    assert.equal(ex.status, 200);
    const item = ex.body.accounts.find((a) => a.channel === 'tgbot');
    assert.deepEqual(item.telegram, { botToken: BOT });
    assert.equal(item.line, null);
    const fileOf = (doc) => {
      const fd = new FormData();
      fd.append('file', new Blob([JSON.stringify(doc)], { type: 'application/json' }), 'inkdove-accounts.json');
      return fd;
    };
    const doc = (accounts) => ({ ...ex.body, accounts });
    const dup = await t.req('POST', '/api/accounts/import', { body: fileOf(doc([item])) });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.created.length, 0);
    assert.match(dup.body.skipped[0].reason, /机器人 token 已被号码「TG 机器人」使用，同一个 Telegram 机器人不重复导入/);
    const other = { ...item, name: 'TG 二号', telegram: { botToken: BOT2 } };
    const ok = await t.req('POST', '/api/accounts/import', { body: fileOf(doc([other, { ...other, name: 'TG 三号', channel: 'tgbiz' }])) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.created.length, 1);
    assert.match(ok.body.skipped[0].reason, /与文件中靠前的号码「TG 二号」重复/);
    const created = t.ctx.accounts.get(ok.body.created[0].id);
    assert.equal(created.channel, 'tgbot');
    assert.deepEqual(created.telegram, { botToken: BOT2 });
    // 导入的号也开始收消息
    await waitFor(() => tg.calls(BOT2, 'getUpdates').length > 0, { message: '导入的号没有开始收消息' });
    const bad = await t.req('POST', '/api/accounts/import', { body: fileOf(doc([{ ...item, channel: 'waha' }])) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message || JSON.stringify(bad.body), /telegram 仅适用于 Telegram 接入方式/);
    await t.req('DELETE', `/api/accounts/${created.id}`);
  });

  it('操作日志：token 只记已设置；token 和客户的 Telegram id 不出现在接口和日志里', async () => {
    const row = t.ctx.db.prepare("SELECT * FROM audit_logs WHERE action = 'account.update' AND changes LIKE '%telegram.botToken%' ORDER BY seq DESC LIMIT 1").get();
    assert.ok(row);
    const change = JSON.parse(row.changes).find((c) => c.field === 'telegram.botToken');
    assert.deepEqual(change, { field: 'telegram.botToken', label: 'Telegram 机器人 token', secret: true, note: '已设置' });
    const created = t.ctx.db.prepare("SELECT summary FROM audit_logs WHERE action = 'account.create' AND summary LIKE '%TG 机器人%'").get();
    assert.match(created.summary, /Telegram 机器人/);
    const secret = BOT.split(':')[1];
    const all = JSON.stringify(t.ctx.db.prepare("SELECT * FROM audit_logs WHERE action <> 'account.export'").all());
    assert.ok(!all.includes(secret));
    const api = JSON.stringify((await t.req('GET', '/api/accounts')).body);
    assert.ok(!api.includes(secret));
    for (const s of [secret, String(IVAN.id), String(ANNA.id), String(OLGA.id)]) {
      assert.ok(!t.log.lines.some((l) => l.includes(s)), `日志里出现了 ${s === secret ? 'token' : '客户 id'}`);
    }
  });

  it('删号：停止收消息，清掉记下的 offset', async () => {
    const r = await t.req('DELETE', `/api/accounts/${acc.id}`);
    assert.equal(r.status, 200);
    assert.equal(t.ctx.db.prepare('SELECT 1 FROM kv WHERE key = ?').get(`telegram:${acc.id}`), undefined);
    await sleep(50);
    const n = tg.calls(BOT, 'getUpdates').length;
    await sleep(300);
    assert.equal(tg.calls(BOT, 'getUpdates').length, n);
  });
});

describe('Telegram 机器人：重启后接着取停机期间的消息', () => {
  it('确认过的不再给；停机期间客户发的重启后收到（时间早于启动也收）', async () => {
    const BOT = tokenOf(7000000005);
    const tg = await startFakeTelegram();
    tg.addBot(BOT, { id: 7000000005, is_bot: true, first_name: 'Restart', username: 'inkdove_restart_bot' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-tg-restart-'));
    const env = { INKDOVE_TELEGRAM_API_URL: tg.url, INKDOVE_DATA_DIR: dir };
    const options = { tgPollTimeoutSec: 1, tgRetryMs: 20 };
    let acc;
    try {
      const t1 = await startApp({ env, options });
      try {
        await t1.login();
        acc = await t1.createAccount({ name: '重启号', channel: 'tgbot', telegram: { botToken: BOT } });
        await waitFor(() => tg.calls(BOT, 'getUpdates').length >= 2);
        tg.push(BOT, botMsg(IVAN, { text: '停机前的消息' }));
        await waitFor(async () => (await getMessages(t1, convIdOf(acc, String(IVAN.id))))?.some?.((m) => m.text === '停机前的消息'));
      } finally {
        await t1.close();
      }
      const n = tg.calls(BOT, 'getUpdates').length;
      tg.push(BOT, botMsg(IVAN, { text: '停机期间的消息' }, { date: nowSec() - 120 }));
      const t2 = await startApp({ env, options });
      try {
        await t2.login();
        await waitFor(async () => (await getMessages(t2, convIdOf(acc, String(IVAN.id)))).some((m) => m.text === '停机期间的消息'), {
          message: '重启后没有收到停机期间的消息',
        });
        const after = tg.calls(BOT, 'getUpdates').slice(n);
        assert.ok(after[0].body.offset > 0, `重启后接着上次的 offset，不是 ${after[0].body.offset}`);
        const inbound = (await getMessages(t2, convIdOf(acc, String(IVAN.id)))).filter((m) => m.direction === 'in');
        assert.deepEqual(
          inbound.map((m) => m.text),
          ['停机前的消息', '停机期间的消息'],
        );
      } finally {
        await t2.close();
      }
    } finally {
      await tg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Telegram 私人号（聊天自动化）', () => {
  const BIZ_ID = 7000000002;
  const BIZ = tokenOf(BIZ_ID);
  const NOBIZ = tokenOf(7000000003);
  const BIZ_ME = { id: BIZ_ID, is_bot: true, first_name: 'Inkdove Biz', username: 'inkdove_biz_bot', can_connect_to_business: true };
  const BIZ_BOT_USER = { id: BIZ_ID, is_bot: true, first_name: 'Inkdove Biz', username: 'inkdove_biz_bot' };
  const OWNER = person(5000000001, 'Bowen', 'Owner');
  const STRANGER = person(5000000099, 'Stranger');
  const MARIA = person(9000000201, 'Maria');
  const LENA = person(9000000202, 'Lena');
  const ALL_RIGHTS = { can_reply: true, can_read_messages: true, can_delete_sent_messages: true };
  let t;
  let tg;
  let acc;
  let agent;
  let replyId;
  const cid = (p) => convIdOf(acc, String(p.id));
  const status = async (cookie) => (await t.req('GET', `/api/accounts/${acc.id}`, cookie ? { cookie } : {})).body.status;
  const conn = (id, user, rights, enabled = true) =>
    tg.push(BIZ, { business_connection: { id, user, user_chat_id: user.id, date: nowSec(), rights, is_enabled: enabled } });
  /** 私聊里的一条 business_message：from 是谁发的，peer 是客户（聊天对方）；viaBot 是墨鸽经机器人代发的 */
  const biz = (connId, from, peer, content, o = {}) =>
    tg.push(BIZ, {
      business_message: {
        business_connection_id: connId,
        message_id: o.id ?? 10 + ++mid,
        from,
        chat: privateChat(peer),
        date: nowSec(),
        ...content,
        ...(o.viaBot ? { sender_business_bot: BIZ_BOT_USER } : {}),
      },
    });

  before(async () => {
    tg = await startFakeTelegram();
    tg.addBot(BIZ, BIZ_ME);
    tg.addBot(NOBIZ, { ...BIZ_ME, id: 7000000003, username: 'inkdove_nobiz_bot', can_connect_to_business: false });
    t = await startApp({ env: { INKDOVE_TELEGRAM_API_URL: tg.url }, options: { tgPollTimeoutSec: 1, tgRetryMs: 20 } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: KB });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: 'TG 私人号', channel: 'tgbiz', autoReply: true, telegram: { botToken: BIZ } });
    agent = await t.addMember({ email: 'tg-agent@example.com', accountIds: [acc.id] });
  });
  after(async () => {
    await t.close();
    await tg.close();
  });

  it('填 token 后等号主绑定：给绑定链接，业务员看不到；没开 Business Mode 的机器人提示怎么开', async () => {
    await waitFor(async () => (await status()).telegram?.bindLink, { message: '没有绑定链接' });
    const st = await status();
    assert.equal(st.state, 'waiting');
    assert.equal(st.error, null);
    assert.match(st.telegram.bindLink, /^https:\/\/t\.me\/inkdove_biz_bot\?start=bind_[A-Za-z0-9_-]{16}$/);
    assert.equal(st.telegram.owner, null);
    assert.deepEqual(tg.calls(BIZ, 'getUpdates')[0].body.allowed_updates, ['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages']);
    const seen = await status(agent.cookie);
    assert.equal(seen.state, 'waiting');
    assert.equal(seen.telegram.bindLink, null, '业务员看不到绑定链接');
    const list = (await t.req('GET', '/api/accounts', { cookie: agent.cookie })).body;
    assert.ok(!JSON.stringify(list).includes('start=bind_'));

    const nobiz = await t.createAccount({ name: '没开 Business', channel: 'tgbiz', telegram: { botToken: NOBIZ } });
    const s2 = await waitFor(async () => {
      const s = (await t.req('GET', `/api/accounts/${nobiz.id}`)).body.status;
      return s.state === 'waiting' && s.error ? s : null;
    });
    assert.match(s2.error, /Business Mode/);
    await t.req('DELETE', `/api/accounts/${nobiz.id}`);
  });

  it('还没绑定：别人连上来的、口令不对的 /start、别人连接里的私聊消息都不理', async () => {
    conn('bc-x', STRANGER, { can_reply: true });
    tg.push(BIZ, botMsg(STRANGER, { text: '/start bind_wrongcode' }));
    tg.push(BIZ, botMsg(STRANGER, { text: 'hello' }));
    const u = biz('bc-x', MARIA, MARIA, { text: '保温杯多少钱' });
    await tg.consumed(BIZ, u);
    assert.equal(tg.calls(BIZ, 'sendMessage').length, 0, '机器人谁都不回');
    assert.equal(await getConv(t, cid(MARIA)), null);
    const st = await status();
    assert.equal(st.state, 'waiting');
    assert.equal(st.telegram.connection.byOwner, false);
    assert.equal(st.telegram.connection.name, 'Stranger');
  });

  it('号主点绑定链接：记下号主、机器人回下一步；连着的不是号主时提示；口令只能用一次', async () => {
    const code = (await status()).telegram.bindLink.split('start=bind_')[1];
    tg.push(BIZ, botMsg(OWNER, { text: `/start bind_${code}` }));
    const reply = await waitFor(() => tg.lastTo(BIZ, 'sendMessage', OWNER.id));
    assert.match(reply.body.text, /^已绑定到墨鸽。/);
    assert.match(reply.body.text, /聊天自动化/);
    assert.match(reply.body.text, /@inkdove_biz_bot/);
    assert.equal(reply.body.business_connection_id, undefined);
    const st = await status();
    assert.equal(st.state, 'waiting');
    assert.deepEqual(st.telegram.owner, { name: 'Bowen Owner' });
    assert.equal(st.telegram.bindLink, null);
    assert.match(st.error, /为「Stranger」，与绑定的号主「Bowen Owner」不一致/);
    const u = tg.push(BIZ, botMsg(STRANGER, { text: `/start bind_${code}` }));
    await tg.consumed(BIZ, u);
    assert.equal(tg.calls(BIZ, 'sendMessage').length, 1);
    assert.deepEqual((await status()).telegram.owner, { name: 'Bowen Owner' });
  });

  it('号主连上：working；客户来消息自动回复（带连接 id）、标已读、正在输入；别人再连上来不理', async () => {
    conn('bc-1', OWNER, ALL_RIGHTS);
    await waitFor(async () => (await status()).state === 'working', { message: '号主连上后没有 working' });
    const st = await status();
    assert.equal(st.error, null);
    assert.deepEqual(
      { ...st.telegram.connection, at: null },
      { enabled: true, byOwner: true, name: 'Bowen Owner', canReply: true, canRead: true, canDelete: true, at: null },
    );
    const u = conn('bc-x2', STRANGER, { can_reply: true });
    await tg.consumed(BIZ, u);
    assert.equal((await status()).telegram.connection.name, 'Bowen Owner');
    assert.ok(t.log.lines.some((l) => l.includes('不是绑定的号主，不理')));

    biz('bc-1', MARIA, MARIA, { text: '保温杯多少钱' }, { id: 41 });
    const msgs = await waitDecided(t, cid(MARIA), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    const send = await waitFor(() => tg.lastTo(BIZ, 'sendMessage', MARIA.id));
    assert.equal(send.body.business_connection_id, 'bc-1');
    assert.match(send.body.text, /59 元/);
    replyId = send.result.message_id;
    assert.deepEqual(tg.calls(BIZ, 'readBusinessMessage').at(-1).body, { business_connection_id: 'bc-1', chat_id: MARIA.id, message_id: 41 });
    assert.equal(tg.lastTo(BIZ, 'sendChatAction', MARIA.id).body.business_connection_id, 'bc-1');
    const conv = await getConv(t, cid(MARIA));
    assert.equal(conv.contactName, 'Maria');
    assert.equal(conv.channel, 'tgbiz');
    // 旧的、别人的连接里来的消息不收
    const v = biz('bc-x', LENA, LENA, { text: '你好' });
    await tg.consumed(BIZ, v);
    assert.equal(await getConv(t, cid(LENA)), null);
  });

  it('号主在 Telegram 里自己发的存成手机发的；经机器人发的回声剔除；按 id 判回声时只认同一个聊天', async () => {
    const replyText = tg.lastTo(BIZ, 'sendMessage', MARIA.id).body.text;
    biz('bc-1', OWNER, MARIA, { text: replyText }, { id: replyId, viaBot: true });
    biz('bc-1', OWNER, MARIA, { text: replyText }, { id: replyId });
    biz('bc-1', OWNER, MARIA, { text: '我是本人，稍等' }, { id: 77 });
    // 别的聊天里刚好也是这个 id：是号主在手机上发的，不是回声
    const u = biz('bc-1', OWNER, LENA, { text: '在另一个聊天里发的' }, { id: replyId });
    await tg.consumed(BIZ, u);
    const out = (await getMessages(t, cid(MARIA))).filter((m) => m.direction === 'out');
    assert.deepEqual(
      out.map((m) => [m.author, m.via, m.text === replyText ? '回复' : m.text]),
      [
        ['bot', out[0].via, '回复'],
        ['owner', 'phone', '我是本人，稍等'],
      ],
    );
    const lena = await getMessages(t, cid(LENA));
    assert.equal(lena.length, 1);
    assert.deepEqual([lena[0].author, lena[0].via, lena[0].text], ['owner', 'phone', '在另一个聊天里发的']);
  });

  it('改消息（edited_business_message）：客户改的、号主在 Telegram 里改的都换成改后的；别的连接里来的不改', async () => {
    const edit = (connId, from, peer, id, text) =>
      tg.push(BIZ, {
        edited_business_message: { business_connection_id: connId, message_id: id, from, chat: privateChat(peer), date: nowSec() - 5, edit_date: nowSec(), text },
      });
    edit('bc-x', MARIA, MARIA, 41, '别的连接里改的');
    edit('bc-1', MARIA, MARIA, 41, '保温杯多少钱？蓝色的');
    const u = edit('bc-1', OWNER, MARIA, 77, '我是本人，马上回您');
    await tg.consumed(BIZ, u);
    const msgs = await getMessages(t, cid(MARIA));
    const cust = msgs.find((m) => m.direction === 'in');
    assert.equal(cust.text, '保温杯多少钱？蓝色的');
    assert.deepEqual(cust.edited.history.map((h) => h.text), ['保温杯多少钱']);
    const own = msgs.find((m) => m.via === 'phone');
    assert.equal(own.text, '我是本人，马上回您');
    assert.deepEqual(own.edited.history.map((h) => h.text), ['我是本人，稍等']);
  });

  it('撤回：经墨鸽发的用 deleteBusinessMessages；在 Telegram 里自己发的没有「删除所有消息」权限时不能撤回', async () => {
    const out = (await getMessages(t, cid(MARIA))).filter((m) => m.direction === 'out');
    const bot = out.find((m) => m.author === 'bot');
    const phone = out.find((m) => m.via === 'phone');
    assert.ok(bot.revocableUntil);
    assert.equal(phone.revocableUntil, null);
    const r = await t.req('POST', `${convPath(cid(MARIA))}/messages/${bot.id}/revoke`, { body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revoked.by, 'member');
    assert.deepEqual(tg.calls(BIZ, 'deleteBusinessMessages').at(-1).body, { business_connection_id: 'bc-1', message_ids: [replyId] });
    const no = await t.req('POST', `${convPath(cid(MARIA))}/messages/${phone.id}/revoke`, { body: {} });
    assert.equal(no.status, 400);
    assert.equal(no.body.code, 'revoke_no_right');
  });

  it('删除通知：客户删的标「客户已撤回」；号主在 Telegram 里删的标手机上撤回', async () => {
    const u = tg.push(BIZ, { deleted_business_messages: { business_connection_id: 'bc-1', chat: privateChat(MARIA), message_ids: [41, 77] } });
    await tg.consumed(BIZ, u);
    const msgs = await getMessages(t, cid(MARIA));
    assert.equal(msgs.find((m) => m.direction === 'in').revoked.by, 'customer');
    assert.equal(msgs.find((m) => m.via === 'phone').revoked.by, 'phone');
  });

  it('没有回复权限：working 但提示，发不出去；断开连接：waiting，发消息失败带原因', async () => {
    conn('bc-1', OWNER, { can_read_messages: true });
    await waitFor(async () => (await status()).error, { message: '没有提示缺回复权限' });
    let st = await status();
    assert.equal(st.state, 'working');
    assert.match(st.error, /机器人无回复消息权限/);
    const n = tg.calls(BIZ, 'sendMessage').length;
    const r = await t.req('POST', `${convPath(cid(MARIA))}/send`, { body: { text: '您好' } });
    assert.equal(r.body.status, 'failed');
    assert.match(r.body.error, /回复消息权限/);
    conn('bc-1', OWNER, ALL_RIGHTS, false);
    await waitFor(async () => (await status()).state === 'waiting', { message: '断开后没有 waiting' });
    st = await status();
    assert.equal(st.telegram.connection.enabled, false);
    const r2 = await t.req('POST', `${convPath(cid(MARIA))}/send`, { body: { text: '您好' } });
    assert.equal(r2.body.status, 'failed');
    assert.match(r2.body.error, /尚未连接机器人/);
    assert.equal(tg.calls(BIZ, 'sendMessage').length, n, '没连好时一条都不发');
  });

  it('换号主：清掉号主、换新的绑定链接，业务员不能换；同一个人重新绑定后直接生效；机器人号不能换', async () => {
    const old = await status();
    assert.equal(old.telegram.bindLink, null);
    const no = await t.req('POST', `/api/accounts/${acc.id}/telegram/rebind`, { cookie: agent.cookie });
    assert.equal(no.status, 403);
    const r = await t.req('POST', `/api/accounts/${acc.id}/telegram/rebind`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status.telegram.owner, null);
    const link = r.body.status.telegram.bindLink;
    assert.match(link, /start=bind_/);
    const audit = t.ctx.db.prepare("SELECT summary FROM audit_logs WHERE action = 'account.telegram_rebind'").get();
    assert.equal(audit.summary, '解除号码「TG 私人号」绑定的 Telegram 号主');
    // 号主先在「聊天自动化」里重新连上，再绑定：绑定后马上能收发
    conn('bc-1', OWNER, ALL_RIGHTS);
    tg.push(BIZ, botMsg(OWNER, { text: `/start bind_${link.split('start=bind_')[1]}` }));
    await waitFor(async () => (await status()).state === 'working', { message: '重新绑定后没有 working' });
    assert.match(tg.lastTo(BIZ, 'sendMessage', OWNER.id).body.text, /「聊天自动化」已连接/);

    const plain = await t.createAccount({ name: 'TG 机器人号', channel: 'tgbot' });
    const w = await t.req('POST', `/api/accounts/${plain.id}/telegram/rebind`);
    assert.equal(w.status, 400);
    assert.equal(w.body.code, 'wrong_channel');
    await t.req('DELETE', `/api/accounts/${plain.id}`);
  });

  it('日志里没有 token、绑定口令和 Telegram 用户 id', async () => {
    const secrets = [BIZ.split(':')[1], NOBIZ.split(':')[1]];
    const ids = [OWNER, STRANGER, MARIA, LENA].map((p) => String(p.id));
    const code = tg
      .calls(BIZ, 'getUpdates')
      .flatMap((r) => r.result || [])
      .map((u) => /bind_(\S+)/.exec(u.message?.text || '')?.[1])
      .filter((c) => c && c !== 'wrongcode');
    for (const s of [...secrets, ...ids, ...code]) assert.ok(!t.log.lines.some((l) => l.includes(s)), `日志里出现了 ${s.slice(0, 4)}…`);
  });
});
