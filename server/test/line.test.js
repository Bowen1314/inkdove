// LINE 官方帐号（LINE Messaging API）：签名校验、事件去重和过滤、reply token 和推送、额度用完、图片和文件、
// 客户发来的媒体（content 接口 202 重试）、撤回、外联、白名单、号的配置和导出导入、操作日志。全部对着本地的假 LINE 服务器
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { LINE_QUOTA_TEXT, parseLineMessage } from '../src/wa/service.js';
import { fakeJpeg, filesForm, makePdf } from './fixtures.js';
import { convIdOf, convPath, getConv, getMessages, sleep, startApp, TINY_PNG, waitDecided, waitFor } from './helpers.js';

// 不像真密钥的假值（拼起来，免得被当成泄露的密钥拦下）
const SECRET = ['line', 'channel', 'secret', 'test'].join('-');
const TOKEN = ['line', 'access', 'token', 'test'].join('-');
const CHANNEL_ID = '1650000001';

/**
 * 假 LINE 服务器（api.line.me 和 api-data.line.me 都指向它）：
 * - GET /v2/bot/profile/{userId}：profiles 里有的返回名字，没有的 404
 * - POST /v2/bot/message/reply、/push：返回 sentMessages（R<n>、P<n>）；quota=true 时推送返回 429（每月额度用完）
 * - POST /v2/bot/chat/loading/start（202）、/v2/bot/chat/markAsRead（200）
 * - GET /v2/bot/message/{id}/content：content 里登记的文件；notReady 里的先返回一次 202
 * 所有请求都要带 Bearer TOKEN
 */
async function startFakeLine() {
  const state = { requests: [], profiles: new Map(), content: new Map(), notReady: new Set(), quota: false, sent: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Authentication failed.' });
    let m;
    if (req.method === 'GET' && (m = /^\/v2\/bot\/profile\/([^/]+)$/.exec(url.pathname))) {
      const name = state.profiles.get(decodeURIComponent(m[1]));
      return name ? json(200, { userId: decodeURIComponent(m[1]), displayName: name, language: 'ja' }) : json(404, { message: 'Not found' });
    }
    if (req.method === 'GET' && (m = /^\/v2\/bot\/message\/([^/]+)\/content$/.exec(url.pathname))) {
      const id = decodeURIComponent(m[1]);
      if (state.notReady.delete(id)) {
        res.writeHead(202);
        return res.end();
      }
      const c = state.content.get(id);
      if (!c) return json(404, { message: 'Not found' });
      res.writeHead(200, { 'content-type': c.mime, 'content-length': c.buffer.length });
      return res.end(c.buffer);
    }
    if (req.method !== 'POST') return json(404, { message: 'Not found' });
    switch (url.pathname) {
      case '/v2/bot/message/reply':
        return json(200, { sentMessages: body.messages.map(() => ({ id: `R${++state.sent}`, quoteToken: 'q' })) });
      case '/v2/bot/message/push':
        if (state.quota) return json(429, { message: 'You have reached your monthly limit.' });
        return json(200, { sentMessages: body.messages.map(() => ({ id: `P${++state.sent}`, quoteToken: 'q' })) });
      case '/v2/bot/chat/loading/start':
        return json(202, {});
      case '/v2/bot/chat/markAsRead':
        return json(200, {});
      default:
        return json(404, { message: 'Not found' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const of = (p) => state.requests.filter((r) => r.path === p);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    of,
    replies: () => of('/v2/bot/message/reply'),
    pushes: (to) => of('/v2/bot/message/push').filter((r) => !to || r.body?.to === to),
    /** 最近一次发消息（回复或推送）的请求 */
    lastSend: () => state.requests.filter((r) => r.path === '/v2/bot/message/reply' || r.path === '/v2/bot/message/push').at(-1),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

const sign = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

let seq = 0;
const uid = (n) => `U${String(n).padStart(32, '0')}`;
/** 一条客户消息事件；o 可以改 source、mode、webhookEventId、replyToken、消息 id 等 */
function msgEvent(userId, message, o = {}) {
  seq++;
  return {
    type: 'message',
    mode: o.mode || 'active',
    timestamp: o.timestamp ?? Date.now(),
    source: o.source || { type: 'user', userId },
    webhookEventId: o.eventId || `01JLINEEVENT${Date.now()}${seq}`,
    deliveryContext: { isRedelivery: !!o.redelivery },
    replyToken: o.replyToken ?? `rt-${seq}`,
    message: { id: o.id || `5${Date.now()}${seq}`, quoteToken: `qt-${seq}`, markAsReadToken: o.readToken ?? `mr-${seq}`, ...message },
  };
}
const text = (s) => ({ type: 'text', text: s });

async function postLine(t, acc, events, { secret = SECRET, signature } = {}) {
  const raw = JSON.stringify({ destination: 'Ubot0000000000000000000000000000', events });
  const headers = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-line-signature'] = signature ?? sign(raw, secret);
  return t.req('POST', `/webhooks/line/${acc.id}`, { body: raw, headers, auth: false });
}

const LINE_CONFIG = { channelId: CHANNEL_ID, channelSecret: SECRET, accessToken: TOKEN };

describe('LINE 消息解析（单元）', () => {
  it('文字、贴图、位置、文件、语音：标签和媒体', () => {
    const ev = (message) => ({ timestamp: 1700000000000, source: { type: 'user', userId: uid(1) }, message: { id: '100', ...message } });
    const t = parseLineMessage(ev({ type: 'text', text: ' 你好 ' }));
    assert.equal(t.channel, 'line');
    assert.equal(t.chatId, uid(1));
    assert.equal(t.text, '你好');
    assert.equal(t.timestampMs, 1700000000000);
    assert.equal(t.media, null);
    assert.equal(parseLineMessage(ev({ type: 'sticker', packageId: '1', stickerId: '2' })).mediaLabel, '[贴纸]');
    const loc = parseLineMessage(ev({ type: 'location', title: '東京タワー', address: '東京都港区芝公園4-2-8', latitude: 35.65, longitude: 139.74 }));
    assert.equal(loc.mediaLabel, '[位置] 東京タワー（東京都港区芝公園4-2-8）');
    assert.equal(parseLineMessage(ev({ type: 'location', latitude: 35.65, longitude: 139.74 })).mediaLabel, '[位置] 35.65, 139.74');
    const file = parseLineMessage(ev({ type: 'file', fileName: 'quote.pdf', fileSize: 1234 }));
    assert.equal(file.mediaLabel, '[文件]');
    assert.deepEqual(
      { type: file.media.type, id: file.media.id, filename: file.media.filename, f4Type: file.media.f4Type },
      { type: 'document', id: '100', filename: 'quote.pdf', f4Type: null },
    );
    const voice = parseLineMessage(ev({ type: 'audio', duration: 4500, contentProvider: { type: 'line' } }));
    assert.equal(voice.media.type, 'voice');
    assert.equal(voice.media.f4Type, 'voice');
    assert.equal(voice.media.seconds, 4.5);
    assert.equal(voice.media.url, null);
    const ext = parseLineMessage(ev({ type: 'image', contentProvider: { type: 'external', originalContentUrl: 'https://img.example.com/a.jpg' } }));
    assert.equal(ext.media.url, 'https://img.example.com/a.jpg');
    assert.equal(parseLineMessage({ type: 'message' }), null);
  });
});

describe('LINE 官方帐号', () => {
  let t;
  let line;
  let acc;
  const cid = (u) => convIdOf(acc, u);
  before(async () => {
    line = await startFakeLine();
    t = await startApp({ env: { INKDOVE_LINE_API_URL: line.url, INKDOVE_LINE_DATA_API_URL: line.url }, options: { lineContentRetryMs: 10 } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: 'LINE 号', channel: 'line' });
  });
  after(async () => {
    await t.close();
    await line.close();
  });

  it('未配置：state=not_configured，回调 403；未知号、扫码号 404', async () => {
    assert.equal(acc.status.state, 'not_configured');
    assert.deepEqual(acc.line, { channelId: '', channelSecretSet: false, accessTokenSet: false, webhookUrl: `https://kb.example.com/webhooks/line/${acc.id}` });
    assert.equal(acc.waha, null);
    assert.equal(acc.meta, null);
    const r = await postLine(t, acc, [msgEvent(uid(1), text('你好'))]);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'line_not_configured');
    assert.equal((await t.req('POST', '/webhooks/line/nope', { body: '{}', auth: false })).status, 404);
    const waha = await t.createAccount({ name: '扫码号' });
    assert.equal((await postLine(t, waha, [])).status, 404);
    assert.equal((await t.req('PUT', `/api/accounts/${waha.id}`, { body: { line: { channelId: '1' } } })).status, 400, '扫码号没有 line 字段');
    await t.req('DELETE', `/api/accounts/${waha.id}`);
  });

  it('配置：密钥只回「设没设」；Channel ID 只能是数字；不能改 meta、不能开 WhatsApp 通知', async () => {
    assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { line: { channelId: 'abc' } } })).status, 400);
    assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { meta: { phoneNumberId: '1' } } })).status, 400);
    const s = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { autoReply: true, line: LINE_CONFIG } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.line, { channelId: CHANNEL_ID, channelSecretSet: true, accessTokenSet: true, webhookUrl: `https://kb.example.com/webhooks/line/${acc.id}` });
    assert.equal(s.body.status.state, 'configured');
    const wa = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: true, number: '+86 139 0000 1111' } } } });
    assert.equal(wa.status, 400);
    assert.equal(wa.body.code, 'whatsapp_notify_unsupported');
    // 控制台的「Verify」按钮：签过名的空事件列表
    assert.equal((await postLine(t, acc, [])).status, 200);
  });

  it('签名错误或缺失返回 401，什么都不存', async () => {
    const ev = msgEvent(uid(2), text('保温杯多少钱'));
    assert.equal((await postLine(t, acc, [ev], { secret: 'wrong-secret' })).status, 401);
    assert.equal((await postLine(t, acc, [ev], { signature: null })).status, 401);
    assert.equal((await postLine(t, acc, [ev], { signature: 'not-base64!!' })).status, 401);
    await sleep(150);
    assert.equal(await getConv(t, cid(uid(2))), null);
    assert.equal(line.state.requests.length, 0);
  });

  it('文字消息：名字从资料接口取；先标已读、显示正在输入，再用 reply token 回复；token 用过后人工发送走推送', async () => {
    const u = uid(3);
    line.state.profiles.set(u, '山田太郎');
    const ev = msgEvent(u, text('保温杯多少钱'), { replyToken: 'rt-first', readToken: 'mr-first' });
    assert.equal((await postLine(t, acc, [ev])).status, 200);
    const msgs = await waitDecided(t, cid(u), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    await waitFor(() => line.replies().length >= 1);
    const reply = line.replies().find((r) => r.body.replyToken === 'rt-first');
    assert.ok(reply, '用这条消息的 reply token 回复');
    assert.equal(reply.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(reply.body.messages[0].type, 'text');
    assert.match(reply.body.messages[0].text, /59 元/);
    const reqs = line.state.requests;
    const read = reqs.findIndex((r) => r.path === '/v2/bot/chat/markAsRead');
    const loading = reqs.findIndex((r) => r.path === '/v2/bot/chat/loading/start');
    assert.deepEqual(reqs[read].body, { markAsReadToken: 'mr-first' });
    assert.deepEqual(reqs[loading].body, { chatId: u, loadingSeconds: 20 });
    assert.ok(read < loading && loading < reqs.indexOf(reply), '先标已读、再正在输入、再回复');
    const conv = await getConv(t, cid(u));
    assert.equal(conv.contactName, '山田太郎');
    assert.equal(conv.contactNumber, '');
    assert.equal(conv.channel, 'line');
    const out = (await getMessages(t, cid(u))).find((m) => m.direction === 'out');
    assert.equal(out.status, 'sent');
    assert.equal(out.revocableUntil, null);

    // reply token 只能用一次：人工再发走推送
    const n = line.replies().length;
    const r = await t.req('POST', `${convPath(cid(u))}/send`, { body: { text: '您好，我是店长' } });
    assert.equal(r.body.status, 'sent');
    assert.equal(line.replies().length, n);
    const push = line.pushes(u).at(-1);
    assert.deepEqual(push.body, { to: u, messages: [{ type: 'text', text: '您好，我是店长' }] });

    // 不能撤回
    const rv = await t.req('POST', `${convPath(cid(u))}/messages/${out.id}/revoke`, { body: {} });
    assert.equal(rv.status, 400);
    assert.equal(rv.body.code, 'revoke_unsupported');
    assert.match(JSON.stringify(rv.body), /LINE 官方帐号不能撤回/);
  });

  it('重发的事件（webhookEventId 相同）只存一次；不同事件 id、相同消息 id 也只存一次', async () => {
    const u = uid(4);
    const ev = msgEvent(u, text('你好'));
    await postLine(t, acc, [ev]);
    await postLine(t, acc, [{ ...ev, deliveryContext: { isRedelivery: true } }]);
    await postLine(t, acc, [{ ...ev, webhookEventId: `${ev.webhookEventId}-other` }]);
    await waitDecided(t, cid(u), 1);
    await sleep(150);
    assert.equal((await getMessages(t, cid(u))).filter((m) => m.direction === 'in').length, 1);
  });

  it('standby 模式的事件、群和多人聊天不处理', async () => {
    const u = uid(5);
    await postLine(t, acc, [
      msgEvent(u, text('保温杯多少钱'), { mode: 'standby' }),
      msgEvent(u, text('保温杯多少钱'), { source: { type: 'group', groupId: 'Cgroup1', userId: u } }),
      msgEvent(u, text('保温杯多少钱'), { source: { type: 'room', roomId: 'Rroom1', userId: u } }),
    ]);
    await sleep(200);
    assert.equal(await getConv(t, cid(u)), null);
    assert.equal(line.pushes(u).length, 0);
  });

  it('贴图、位置存成标签；客户发来的图片经 content 接口下载（先 202 再 200）', async () => {
    const u = uid(6);
    line.state.profiles.set(u, '佐藤');
    const imgId = `7${Date.now()}`;
    const jpeg = fakeJpeg('line photo');
    line.state.content.set(imgId, { mime: 'image/jpeg', buffer: jpeg });
    line.state.notReady.add(imgId);
    await postLine(t, acc, [
      msgEvent(u, { type: 'sticker', packageId: '446', stickerId: '1988' }),
      msgEvent(u, { type: 'location', title: '東京タワー', address: '東京都港区芝公園4-2-8', latitude: 35.65, longitude: 139.74 }),
      msgEvent(u, { type: 'image', contentProvider: { type: 'line' } }, { id: imgId }),
    ]);
    const msgs = await waitFor(async () => {
      const list = await getMessages(t, cid(u));
      const img = Array.isArray(list) && list.find((m) => m.media?.type === 'image');
      return img && img.media.stored !== 'pending' ? list : null;
    });
    const inbound = msgs.filter((m) => m.direction === 'in');
    assert.deepEqual(
      inbound.map((m) => m.text),
      ['[贴纸]', '[位置] 東京タワー（東京都港区芝公園4-2-8）', '[图片]'],
    );
    const img = inbound.at(-1);
    assert.equal(img.media.stored, 'ok', JSON.stringify(img.media));
    assert.equal(img.media.mime, 'image/jpeg');
    assert.equal(line.of(`/v2/bot/message/${imgId}/content`).length, 2, '202 之后再取一次');
    const file = await t.req('GET', `${convPath(cid(u))}/messages/${img.id}/media`);
    assert.equal(file.status, 200);
    assert.ok(Buffer.from(file.body).equals(jpeg));
  });

  it('客户撤回（unsend）：标「客户已撤回」', async () => {
    const u = uid(7);
    const id = `8${Date.now()}`;
    await postLine(t, acc, [msgEvent(u, text('我要找人工'), { id })]);
    await waitDecided(t, cid(u), 1);
    await postLine(t, acc, [
      { type: 'unsend', mode: 'active', timestamp: Date.now(), source: { type: 'user', userId: u }, webhookEventId: `unsend-${id}`, unsend: { messageId: id } },
    ]);
    const m = await waitFor(async () => (await getMessages(t, cid(u))).find((x) => x.direction === 'in' && x.revoked));
    assert.equal(m.revoked.by, 'customer');
  });

  it('follow：已有会话按资料更新名字；unfollow 只记日志', async () => {
    const u = uid(3);
    line.state.profiles.set(u, '山田花子');
    const base = { mode: 'active', timestamp: Date.now(), source: { type: 'user', userId: u } };
    await postLine(t, acc, [{ ...base, type: 'follow', webhookEventId: `follow-${Date.now()}`, replyToken: 'rt-follow', follow: { isUnblocked: true } }]);
    await waitFor(async () => (await getConv(t, cid(u))).contactName === '山田花子');
    await postLine(t, acc, [{ ...base, type: 'unfollow', webhookEventId: `unfollow-${Date.now()}` }]);
    await waitFor(() => t.log.lines.some((l) => l.includes('取消了好友')));
    // 没聊过的人加好友：不建空会话
    line.state.profiles.set(uid(8), '新朋友');
    await postLine(t, acc, [{ ...base, source: { type: 'user', userId: uid(8) }, type: 'follow', webhookEventId: `follow2-${Date.now()}` }]);
    await sleep(150);
    assert.equal(await getConv(t, cid(uid(8))), null);
  });

  it('推送超出每月额度：消息记发送失败（中文原因），号的状态显示；推送成功后清掉', async () => {
    const u = uid(3);
    line.state.quota = true;
    const r = await t.req('POST', `${convPath(cid(u))}/send`, { body: { text: '还在吗' } });
    assert.equal(r.body.status, 'failed');
    assert.equal(r.body.error, LINE_QUOTA_TEXT);
    let st = await t.req('GET', `/api/accounts/${acc.id}`);
    assert.equal(st.body.status.state, 'configured');
    assert.equal(st.body.status.error, LINE_QUOTA_TEXT);
    line.state.quota = false;
    assert.equal((await t.req('POST', `${convPath(cid(u))}/send`, { body: { text: '还在吗' } })).body.status, 'sent');
    st = await t.req('GET', `/api/accounts/${acc.id}`);
    assert.equal(st.body.status.error, null);
  });

  it('发图片：30 天有效的公网签名地址（预览图同一个），说明文字另起一条；其他文件发文件名和下载链接', async () => {
    const u = uid(3);
    const up = await t.req('POST', '/api/files', {
      body: filesForm([
        { name: 'cup.png', buffer: TINY_PNG, type: 'image/png' },
        { name: 'price.pdf', buffer: makePdf('price list'), type: 'application/pdf' },
      ]),
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const png = up.body.find((f) => f.filename === 'cup.png');
    const pdf = up.body.find((f) => f.filename === 'price.pdf');
    const r = await t.req('POST', `${convPath(cid(u))}/send-file`, { body: { fileId: png.id, caption: '看图' } });
    assert.equal(r.body.status, 'sent', JSON.stringify(r.body));
    const req = line.lastSend();
    const [img, cap] = req.body.messages;
    assert.equal(img.type, 'image');
    assert.ok(img.originalContentUrl.startsWith(`https://kb.example.com/internal/files/${png.id}?token=`), img.originalContentUrl);
    assert.equal(img.previewImageUrl, img.originalContentUrl);
    assert.deepEqual(cap, { type: 'text', text: '看图' });
    const exp = Number(new URL(img.originalContentUrl).searchParams.get('token').split('.')[0]);
    assert.ok(exp * 1000 > Date.now() + 29 * 24 * 3600 * 1000, '30 天有效');
    // 这个地址确实能下载到这个文件
    const got = await t.req('GET', img.originalContentUrl.replace('https://kb.example.com', ''), { auth: false });
    assert.equal(got.status, 200);

    const r2 = await t.req('POST', `${convPath(cid(u))}/send-file`, { body: { fileId: pdf.id } });
    assert.equal(r2.body.status, 'sent', JSON.stringify(r2.body));
    const msgs = line.lastSend().body.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'text');
    assert.match(msgs[0].text, /^price\.pdf\nhttps:\/\/kb\.example\.com\/internal\/files\//);
  });

  it('只回白名单：LINE 的客户没有号码，照样回复', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { scope: 'allowlist', allowlist: ['8613800000001'] } });
    const u = uid(9);
    await postLine(t, acc, [msgEvent(u, text('保温杯多少钱'))]);
    const msgs = await waitDecided(t, cid(u), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { scope: 'all' } });
  });

  it('转人工通知：LINE 的客户写名字和「LINE」，不露 userId', async () => {
    const u = uid(3);
    const n = t.ctx.wa.notifier.buildNotice(t.ctx.accounts.get(acc.id), cid(u), 'handoff', '客户要人工');
    assert.match(n.subject, /^\[待人工\] 客户 山田花子（LINE）：/);
    assert.match(n.text, /客户：山田花子（LINE）/);
    // userId 只在「去处理」的会话链接里出现
    assert.ok(!n.subject.includes(u));
    assert.ok(!n.text.split('\n').filter((l) => !l.startsWith('去处理：')).some((l) => l.includes(u)));
  });

  it('外联群发不能选 LINE 官方帐号', async () => {
    const form = new FormData();
    form.append('file', new Blob(['+86 138 0013 8000'], { type: 'text/plain' }), 'numbers.txt');
    form.append('name', 'LINE 外联');
    form.append('mode', 'single');
    form.append('accountIds', JSON.stringify([acc.id]));
    form.append('message', '你好');
    form.append('defaultCountry', 'CN');
    const r = await t.req('POST', '/api/campaigns', { body: form });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'line_unsupported');
  });

  it('导出带 LINE 的密钥；导入按 Channel ID 去重；其他接入方式带 line 报错', async () => {
    const ex = await t.req('GET', '/api/accounts/export');
    assert.equal(ex.status, 200);
    const item = ex.body.accounts.find((a) => a.channel === 'line');
    assert.deepEqual(item.line, LINE_CONFIG);
    assert.equal(item.waha, null);
    assert.equal(item.meta, null);
    const fileOf = (doc) => {
      const fd = new FormData();
      fd.append('file', new Blob([JSON.stringify(doc)], { type: 'application/json' }), 'inkdove-accounts.json');
      return fd;
    };
    const doc = (accounts) => ({ ...ex.body, accounts });
    const dup = await t.req('POST', '/api/accounts/import', { body: fileOf(doc([item])) });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.created.length, 0);
    assert.match(dup.body.skipped[0].reason, new RegExp(`Channel ID ${CHANNEL_ID} 已经被号「LINE 号」使用`));
    const other = { ...item, name: 'LINE 二号', line: { ...item.line, channelId: '1650000002' } };
    const ok = await t.req('POST', '/api/accounts/import', { body: fileOf(doc([other, { ...other, name: 'LINE 三号' }])) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.created.length, 1);
    assert.match(ok.body.skipped[0].reason, /和文件里前面的号「LINE 二号」重复/);
    const created = t.ctx.accounts.get(ok.body.created[0].id);
    assert.equal(created.channel, 'line');
    assert.deepEqual(created.line, { ...LINE_CONFIG, channelId: '1650000002' });
    const bad = await t.req('POST', '/api/accounts/import', { body: fileOf(doc([{ ...item, channel: 'waha' }])) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message || JSON.stringify(bad.body), /line 只有 LINE 官方帐号才有/);
  });

  it('操作日志：Channel ID 照记，secret 和 token 只记已设置；密钥不出现在接口和日志里', async () => {
    const row = t.ctx.db.prepare("SELECT * FROM audit_logs WHERE action = 'account.update' AND changes LIKE '%line.channelSecret%' ORDER BY seq DESC LIMIT 1").get();
    assert.ok(row);
    const byField = Object.fromEntries(JSON.parse(row.changes).map((c) => [c.field, c]));
    assert.equal(byField['line.channelId'].label, 'LINE Channel ID');
    assert.equal(byField['line.channelId'].to, CHANNEL_ID);
    assert.deepEqual(byField['line.channelSecret'], { field: 'line.channelSecret', label: 'LINE Channel secret', secret: true, note: '已设置' });
    assert.equal(byField['line.accessToken'].secret, true);
    const created = t.ctx.db.prepare("SELECT summary FROM audit_logs WHERE action = 'account.create' AND summary LIKE '%LINE 号%'").get();
    assert.match(created.summary, /LINE 官方帐号/);
    const all = JSON.stringify(t.ctx.db.prepare("SELECT * FROM audit_logs WHERE action <> 'account.export'").all());
    assert.ok(!all.includes(SECRET) && !all.includes(TOKEN));
    const api = JSON.stringify((await t.req('GET', '/api/accounts')).body);
    assert.ok(!api.includes(SECRET) && !api.includes(TOKEN));
    assert.ok(!t.log.lines.some((l) => l.includes(SECRET) || l.includes(TOKEN)));
  });
});

describe('LINE 官方帐号：reply token 过期、公网地址不是 https', () => {
  let t;
  let line;
  let acc;
  before(async () => {
    line = await startFakeLine();
    t = await startApp({
      env: { INKDOVE_LINE_API_URL: line.url, INKDOVE_LINE_DATA_API_URL: line.url, INKDOVE_PUBLIC_BASE_URL: 'http://inkdove.example.com' },
      // reply token 一收到就算过期
      options: { lineReplyWindowMs: 0 },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: 'LINE 号', channel: 'line', autoReply: true, line: LINE_CONFIG });
  });
  after(async () => {
    await t.close();
    await line.close();
  });

  it('reply token 过期：改用推送', async () => {
    const u = uid(11);
    await postLine(t, acc, [msgEvent(u, text('保温杯多少钱'))]);
    const msgs = await waitDecided(t, convIdOf(acc, u), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    await waitFor(() => line.pushes(u).length >= 1);
    assert.equal(line.replies().length, 0);
    assert.match(line.pushes(u)[0].body.messages[0].text, /59 元/);
  });

  it('INKDOVE_PUBLIC_BASE_URL 不是 https：图片和文件不发，报清楚的原因', async () => {
    const u = uid(11);
    const up = await t.req('POST', '/api/files', { body: filesForm([{ name: 'cup.png', buffer: TINY_PNG, type: 'image/png' }]) });
    const n = line.state.requests.length;
    const r = await t.req('POST', `${convPath(convIdOf(acc, u))}/send-file`, { body: { fileId: up.body[0].id } });
    assert.equal(r.body.status, 'failed');
    assert.match(r.body.error, /HTTPS/);
    assert.equal(line.state.requests.slice(n).filter((q) => q.path.startsWith('/v2/bot/message/')).length, 0);
  });
});
