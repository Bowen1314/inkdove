// 客户发来的图片、视频、语音、文件、贴纸：收到就后台下载存盘（不等识别开关），会话页用 GET …/messages/:messageId/media 取。
// 假 WAHA 的 /api/files 和假 Graph API 当文件来源；大小上限在测试里调小（mediaStoreMaxBytes），不用真造 64MB 的文件。
// 另有人工回复的号会话页用的两个小接口：标为已处理（只清待处理）、关掉草稿。
// 先 import 'undici'：原来是让 npm undici 接管全局 fetch，和当时的正式环境一致。现在正式环境用 src/builtin-fetch.js 让全局 fetch
// 走 Node 自带的连接，npm test 也用 --import 先加载了它，这一行就不再接管全局 fetch（只有不带 --import 单独跑这个文件时才会）。
// 这不影响下面并发回归测试的意义：媒体下载用 node:http（media-download.js 的 httpGet），不经过 fetch，测的是这条下载路径本身
// 在对方传完就关连接、几个大文件同时边下边写盘时进程不崩、文件完整，和全局 fetch 底下是哪个 undici 无关。
import 'undici';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { MEDIA_STORE_MAX_BYTES } from '../src/wa/media.js';
import { httpGet, HttpGetError } from '../src/wa/media-download.js';
import { createMediaStore } from '../src/wa/media-store.js';
import { metaDownloadMedia, metaOpenMedia } from '../src/wa/meta.js';
import { createWahaClient, TooLargeError } from '../src/wa/waha.js';
import { metaEvent, startFakeGraph } from './fixtures.js';
import {
  convIdOf,
  convPath,
  getConv,
  getMessages,
  postWaha,
  quietLog,
  startApp,
  startFakeWaha,
  waitFor,
  wahaMessage,
  wahaSend,
} from './helpers.js';

const PNID = '106540352243999';
const META_TOKEN = 'EAAG-media-token';
const META_SECRET = 'meta-secret-media';
/** 测试里的单文件上限 */
const MAX = 4096;
let seq = 0;
const newChat = () => `86135${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('客户媒体存盘和显示', () => {
  let t;
  let fake;
  let graph;
  let acc;
  let metaAcc;
  let agent;
  let otherAgent;
  let fileSeq = 0;
  const cid = (chat) => convIdOf(acc, chat);
  const idle = () => waitFor(() => t.ctx.wa.idle(), { message: '媒体下载迟迟没结束' });
  const mediaPath = (convId, msgId) => `${convPath(convId)}/messages/${encodeURIComponent(msgId)}/media`;
  /** 带登录态直接 fetch（要看二进制和响应头） */
  const fetchMedia = (convId, msgId, { cookie = t.cookie, headers = {}, query = '' } = {}) =>
    fetch(`${t.base}${mediaPath(convId, msgId)}${query}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  const mediaDir = () => path.join(t.dataDir, 'media');
  const storedFiles = () => (fs.existsSync(mediaDir()) ? fs.readdirSync(mediaDir()).filter((f) => f !== 'tmp') : []);
  const rawMedia = (msgId) => JSON.parse(t.ctx.db.prepare('SELECT media FROM messages WHERE id = ?').get(msgId).media);

  /** 在假 WAHA 上放一个文件，返回 WAHA 风格的 media 对象 */
  function wahaFile(buffer, mimetype, { filename = null, ...opts } = {}) {
    const p = `${acc.waha.sessionName}/MEDIA${++fileSeq}`;
    fake.state.files.set(p, { buffer, mime: mimetype.split(';')[0], ...opts });
    return { url: `http://waha:3000/api/files/${p}`, mimetype, filename };
  }
  /** 客户发一条媒体消息，等下载结束，返回这条消息 */
  async function sendMedia(chat, media, { body = '', data, wait = true } = {}) {
    const ev = wahaMessage({ from: chat, body, hasMedia: true, media, session: acc.waha.sessionName });
    if (data) ev.payload._data = data;
    const r = await postWaha(t, ev);
    assert.equal(r.status, 200);
    if (!wait) return null;
    await idle();
    return (await getMessages(t, cid(chat))).filter((m) => m.direction === 'in').at(-1);
  }
  const postMeta = async (from, msg) => {
    const raw = JSON.stringify(metaEvent(PNID, from, msg));
    const sig = `sha256=${crypto.createHmac('sha256', META_SECRET).update(raw).digest('hex')}`;
    const r = await t.req('POST', `/webhooks/meta/${metaAcc.id}`, {
      body: raw,
      auth: false,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    });
    assert.equal(r.status, 200);
    await idle();
    return (await getMessages(t, convIdOf(metaAcc, from))).filter((m) => m.direction === 'in').at(-1);
  };

  before(async () => {
    fake = await startFakeWaha();
    graph = await startFakeGraph({ token: META_TOKEN });
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url, INKDOVE_META_GRAPH_URL: graph.url },
      options: { mediaStoreMaxBytes: MAX },
    });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    // 新建的号默认人工回复，识别也没开：媒体照样要存
    acc = await t.createAccount({ name: '人工号' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    metaAcc = await t.createAccount({
      name: 'Meta 号',
      channel: 'meta',
      meta: { phoneNumberId: PNID, verifyToken: 'v', accessToken: META_TOKEN, appSecret: META_SECRET },
    });
    agent = await t.addMember({ email: 'media-agent@example.com', name: '小媒', accountIds: [acc.id, metaAcc.id] });
    otherAgent = await t.addMember({ email: 'media-other@example.com', name: '小别', accountIds: [acc.id, metaAcc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
    await graph.close();
  });

  it('上限常量是 64MB', () => {
    assert.equal(MEDIA_STORE_MAX_BYTES, 64 * 1024 * 1024);
  });

  describe('WAHA', () => {
    it('图片：webhook 先返回、后台再下载；存成随机文件名；接口 inline、带 nosniff、private no-cache（带 ETag，没变回 304）；消息里不带 fileKey', async () => {
      const chat = newChat();
      const img = Buffer.from('fake-jpeg-bytes-0123456789');
      await sendMedia(chat, wahaFile(img, 'image/jpeg', { delayMs: 300 }), { wait: false });
      // 文件晚 300ms 才给：webhook 已经返回，消息已经在了，还在下载
      let [m] = await getMessages(t, cid(chat));
      assert.equal(m.text, '[图片]');
      assert.equal(m.media.stored, 'pending');
      await idle();
      [m] = await getMessages(t, cid(chat));
      assert.deepEqual(m.media, { type: 'image', mime: 'image/jpeg', size: img.length, filename: null, stored: 'ok', error: null });
      assert.equal(m.botDecision, 'skipped', '人工回复的号照旧只存消息');
      assert.equal(m.decisionReason, '这个号没开自动回复');
      assert.equal((await getConv(t, cid(chat))).needsHuman, false, '人工回复的号收到媒体不标待处理');
      const raw = rawMedia(m.id);
      assert.match(raw.fileKey, /^[a-f0-9]{32}$/);
      assert.ok(storedFiles().includes(raw.fileKey), '文件在 <dataDir>/media/<fileKey>');
      assert.ok(!JSON.stringify(await getMessages(t, cid(chat))).includes(raw.fileKey), '接口不返回 fileKey');

      const res = await fetchMedia(cid(chat), m.id);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.match(res.headers.get('content-disposition'), /^inline/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      // no-cache：浏览器每次回服务器验证（换了个没权限的人登录不能直接用缓存），没变时 304
      assert.equal(res.headers.get('cache-control'), 'private, no-cache');
      const etag = res.headers.get('etag');
      assert.ok(etag, '带 ETag');
      assert.ok(res.headers.get('last-modified'), '带 Last-Modified');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(img));
      // 模拟浏览器缓存回来验证。fetch 带了 If-None-Match 会自己加 cache-control: no-cache（服务器就不给 304），所以显式写 max-age=0
      const revalidate = { 'if-none-match': etag, 'cache-control': 'max-age=0' };
      const again = await fetchMedia(cid(chat), m.id, { headers: revalidate });
      assert.equal(again.status, 304);
      assert.equal((await again.arrayBuffer()).byteLength, 0);

      // ?download=1：白名单里的也当附件下载
      const dl = await fetchMedia(cid(chat), m.id, { query: '?download=1' });
      assert.match(dl.headers.get('content-disposition'), /^attachment; filename="?image-[a-z0-9-]+\.jpg"?$/);
      await dl.arrayBuffer();
    });

    it('Range：bytes=2-5 返回 206 和对应的 4 个字节（视频拖动要用）', async () => {
      const chat = newChat();
      const video = Buffer.from('0123456789abcdef');
      const m = await sendMedia(chat, wahaFile(video, 'video/mp4'));
      assert.equal(m.media.type, 'video');
      assert.equal(m.text, '[视频]');
      const res = await fetchMedia(cid(chat), m.id, { headers: { range: 'bytes=2-5' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 2-5/${video.length}`);
      assert.equal(res.headers.get('content-type'), 'video/mp4');
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '2345');
    });

    it('文件（PDF，中文文件名）和 SVG：不在白名单，一律 attachment + application/octet-stream，文件名用原始文件名并转义', async () => {
      const chat = newChat();
      const pdf = Buffer.from('%PDF-1.4 fake');
      const m = await sendMedia(chat, wahaFile(pdf, 'application/pdf', { filename: '报价单 "v2".pdf' }), {
        data: { Message: { documentMessage: { fileName: '报价单 "v2".pdf' } } },
      });
      assert.equal(m.text, '[文件]');
      assert.deepEqual(m.media, { type: 'document', mime: 'application/pdf', size: pdf.length, filename: '报价单 "v2".pdf', stored: 'ok', error: null });
      const raw = rawMedia(m.id);
      assert.ok(!storedFiles().some((f) => f.includes('报价单')), '磁盘上不用客户给的文件名');
      assert.match(raw.fileKey, /^[a-f0-9]{32}$/);
      let res = await fetchMedia(cid(chat), m.id);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      const cd = res.headers.get('content-disposition');
      // 老客户端看 filename（非 ASCII 换成 ?），新浏览器看 filename*（UTF-8 原名）
      assert.match(cd, /^attachment; filename=".*\.pdf"; filename\*=UTF-8''/);
      assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent('报价单 "v2".pdf').replace(/'/g, '%27')}`), cd);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      await res.arrayBuffer();

      const chat2 = newChat();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const s = await sendMedia(chat2, wahaFile(svg, 'image/svg+xml'));
      assert.equal(s.media.stored, 'ok');
      res = await fetchMedia(cid(chat2), s.id);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', 'SVG 永远不 inline');
      assert.match(res.headers.get('content-disposition'), /^attachment/);
      await res.arrayBuffer();
    });

    it('按文件发的（documentMessage，如 SVG、照片原图）：消息标签跟 media.type 一致是 [文件]，不按 mime 写成 [图片]', async () => {
      const chat = newChat();
      const svg = await sendMedia(chat, wahaFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', { filename: 'logo.svg' }), {
        data: { Message: { documentMessage: { fileName: 'logo.svg' } } },
      });
      assert.equal(svg.media.type, 'document');
      assert.equal(svg.text, '[文件]');
      const photo = await sendMedia(chat, wahaFile(Buffer.from('jpeg-original'), 'image/jpeg', { filename: 'IMG_0001.jpg' }), {
        data: { Message: { documentMessage: { fileName: 'IMG_0001.jpg' } } },
      });
      assert.equal(photo.media.type, 'document');
      assert.equal(photo.text, '[文件]');
    });

    it('贴纸（_data.Message.stickerMessage）存成 sticker；语音也存；客户的 caption 照旧是消息文字', async () => {
      const chat = newChat();
      const st = await sendMedia(chat, wahaFile(Buffer.from('RIFFxxxxWEBP'), 'image/webp'), { data: { Message: { stickerMessage: {} } } });
      assert.equal(st.text, '[贴纸]');
      assert.equal(st.media.type, 'sticker');
      assert.equal(st.media.stored, 'ok');
      const v = await sendMedia(chat, wahaFile(Buffer.from('OggS-voice'), 'audio/ogg; codecs=opus'));
      assert.equal(v.media.type, 'voice');
      assert.equal(v.media.mime, 'audio/ogg');
      assert.equal(v.media.stored, 'ok');
      const c = await sendMedia(chat, wahaFile(Buffer.from('jpeg'), 'image/jpeg'), { body: '这个有现货吗' });
      assert.equal(c.text, '这个有现货吗');
      assert.equal(c.media.type, 'image');
      assert.equal(c.media.stored, 'ok');
    });

    it('超过上限：声明的大小超了不下载（记大小），没声明边下边数、超了就停；都记 too_large、不留文件、接口 404', async () => {
      const before = storedFiles().length;
      const chat = newChat();
      const big = await sendMedia(chat, wahaFile(Buffer.alloc(10), 'video/mp4', { contentLength: MAX + 1 }));
      assert.deepEqual(big.media, { type: 'video', mime: 'video/mp4', size: MAX + 1, filename: null, stored: 'too_large', error: '文件太大，没有保存' });
      const streamed = await sendMedia(chat, wahaFile(Buffer.alloc(MAX + 100, 7), 'application/zip', { chunked: true, filename: 'big.zip' }));
      assert.equal(streamed.media.stored, 'too_large');
      assert.equal(streamed.media.error, '文件太大，没有保存');
      assert.equal(streamed.media.size, null, '没声明大小，不知道实际多大');
      assert.equal(streamed.media.filename, 'big.zip');
      // 正好等于上限的能存
      const edge = await sendMedia(chat, wahaFile(Buffer.alloc(MAX, 1), 'image/png', { chunked: true }));
      assert.equal(edge.media.stored, 'ok');
      assert.equal(edge.media.size, MAX);
      assert.equal(storedFiles().length, before + 1, '超限的不留文件');
      assert.deepEqual(fs.existsSync(path.join(mediaDir(), 'tmp')) ? fs.readdirSync(path.join(mediaDir(), 'tmp')) : [], [], '没有残留的半截文件');
      assert.equal((await fetchMedia(cid(chat), big.id)).status, 404);
      assert.equal((await fetchMedia(cid(chat), streamed.id)).status, 404);
    });

    it('下载失败记原因：WAHA 返回 404、没给下载地址、WAHA 下载出错；后面的消息照常处理', async () => {
      const chat = newChat();
      const gone = await sendMedia(chat, { url: `http://waha:3000/api/files/${acc.waha.sessionName}/NOPE`, mimetype: 'image/jpeg' });
      assert.equal(gone.media.stored, 'failed');
      assert.equal(gone.media.error, 'WAHA 返回 404：文件在 WAHA 那边已经过期或不存在', '404 给人话，不带 WAHA 的原文');
      const noUrl = await sendMedia(chat, { url: null, mimetype: 'video/mp4' });
      assert.equal(noUrl.media.stored, 'failed');
      assert.match(noUrl.media.error, /没有提供下载地址/);
      const err = await sendMedia(chat, { url: null, mimetype: 'image/jpeg', error: 'download timeout' });
      assert.match(err.media.error, /WAHA 下载媒体出错：download timeout/);
      const outside = await sendMedia(chat, { url: 'http://evil.example.com/steal', mimetype: 'image/jpeg' });
      assert.match(outside.media.error, /不是 WAHA 的 \/api\/files\/ 路径/);
      assert.equal((await fetchMedia(cid(chat), gone.id)).status, 404);
      await wahaSend(t, acc, chat, '后面这条文字照常收');
      await waitFor(async () => (await getMessages(t, cid(chat))).some((m) => m.text === '后面这条文字照常收'));
    });
  });

  describe('Meta', () => {
    it('视频、文件、贴纸、语音：用 media id 走 Graph API 下载存盘；文件名取 document.filename', async () => {
      const from = '8613500000101';
      const conv = convIdOf(metaAcc, from);
      graph.state.media.set('VID1', { mime: 'video/mp4', buffer: Buffer.from('mp4-bytes') });
      graph.state.media.set('DOC1', { mime: 'application/pdf', buffer: Buffer.from('%PDF meta') });
      graph.state.media.set('STK1', { mime: 'image/webp', buffer: Buffer.from('webp') });
      graph.state.media.set('AUD1', { mime: 'audio/ogg', buffer: Buffer.from('OggS') });
      const v = await postMeta(from, { type: 'video', video: { id: 'VID1', mime_type: 'video/mp4' } });
      assert.equal(v.text, '[视频]');
      assert.deepEqual(v.media, { type: 'video', mime: 'video/mp4', size: 9, filename: null, stored: 'ok', error: null });
      const d = await postMeta(from, { type: 'document', document: { id: 'DOC1', mime_type: 'application/pdf', filename: 'catalog.pdf' } });
      assert.equal(d.media.type, 'document');
      assert.equal(d.media.filename, 'catalog.pdf');
      assert.equal(d.media.stored, 'ok');
      const s = await postMeta(from, { type: 'sticker', sticker: { id: 'STK1', mime_type: 'image/webp', animated: false } });
      assert.equal(s.text, '[贴纸]');
      assert.equal(s.media.type, 'sticker');
      const a = await postMeta(from, { type: 'audio', audio: { id: 'AUD1', mime_type: 'audio/ogg; codecs=opus', voice: true } });
      assert.equal(a.media.type, 'voice');
      assert.equal(a.media.stored, 'ok');
      // 人工回复的号：Meta 和 WAHA 走同一段入站处理，媒体和文字一样只存下来，不标待处理、不记转人工
      for (const m of [v, d, s, a]) {
        assert.equal(m.botDecision, 'skipped', m.text);
        assert.equal(m.decisionReason, '这个号没开自动回复', m.text);
      }
      assert.equal((await getConv(t, conv)).needsHuman, false);
      assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM handoffs WHERE conversation_id = ?').get(conv).n, 0);
      const res = await fetchMedia(conv, d.id);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /^attachment; filename="?catalog\.pdf"?$/);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF meta');
    });

    it('Graph 给的 file_size 超上限：不下载，记 too_large 和大小；媒体不存在：记 failed', async () => {
      const from = '8613500000102';
      graph.state.media.set('BIG1', { mime: 'video/mp4', buffer: Buffer.from('x'), fileSize: MAX * 10 });
      const big = await postMeta(from, { type: 'video', video: { id: 'BIG1', mime_type: 'video/mp4' } });
      assert.equal(big.media.stored, 'too_large');
      assert.equal(big.media.size, MAX * 10);
      assert.ok(!graph.state.downloads.includes('BIG1'), '超限的不下载');
      const gone = await postMeta(from, { type: 'image', image: { id: 'NOPE404', mime_type: 'image/jpeg' } });
      assert.equal(gone.media.stored, 'failed');
      assert.match(gone.media.error, /Meta 返回 404/);
    });
  });

  describe('权限', () => {
    it('agent 只能看分给自己的会话的媒体（别人的 403）；没登录 401；别的会话的消息 id、旧数据（没存）404', async () => {
      const chat = newChat();
      const m = await sendMedia(chat, wahaFile(Buffer.from('agent-img'), 'image/png'));
      // 先没分配：agent 403
      assert.equal((await fetchMedia(cid(chat), m.id, { cookie: agent.cookie })).status, 403);
      await t.req('PUT', `${convPath(cid(chat))}/assignee`, { body: { userId: agent.user.id } });
      let res = await fetchMedia(cid(chat), m.id, { cookie: agent.cookie });
      assert.equal(res.status, 200);
      const etag = res.headers.get('etag');
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'agent-img');
      res = await fetchMedia(cid(chat), m.id, { cookie: otherAgent.cookie });
      assert.equal(res.status, 403, '别人的客户');
      // 带着别人看过的 ETag 来验证缓存也是 403，不是 304（权限检查在先）
      const revalidate = { 'if-none-match': etag, 'cache-control': 'max-age=0' };
      assert.equal((await fetchMedia(cid(chat), m.id, { cookie: agent.cookie, headers: revalidate })).status, 304, '有权限的人验证缓存：304');
      res = await fetchMedia(cid(chat), m.id, { cookie: otherAgent.cookie, headers: revalidate });
      assert.equal(res.status, 403, '带 If-None-Match 也不给 304');
      assert.equal((await fetchMedia(cid(chat), m.id, { cookie: '' })).status, 401);

      // 消息 id 是别的会话的：404（不能拿自己的会话去取别人会话的文件）
      const other = newChat();
      const om = await sendMedia(other, wahaFile(Buffer.from('other-img'), 'image/png'));
      assert.equal((await fetchMedia(cid(chat), om.id, { cookie: agent.cookie })).status, 404);
      assert.equal((await fetchMedia(cid(chat), 'no-such-message')).status, 404);

      // 旧数据只有 {type, mime}：按没存处理
      t.ctx.db.prepare('UPDATE messages SET media = ? WHERE id = ?').run(JSON.stringify({ type: 'image', mime: 'image/png' }), om.id);
      const old = (await getMessages(t, cid(other))).find((x) => x.id === om.id);
      assert.deepEqual(old.media, { type: 'image', mime: 'image/png' });
      assert.equal((await fetchMedia(cid(other), om.id)).status, 404);
      // fileKey 被改成路径：不认
      t.ctx.db
        .prepare('UPDATE messages SET media = ? WHERE id = ?')
        .run(JSON.stringify({ type: 'image', mime: 'image/png', stored: 'ok', fileKey: '../../app.db' }), om.id);
      assert.equal((await fetchMedia(cid(other), om.id)).status, 404);
    });
  });

  it('自己在手机上发的媒体、导入的历史消息不下载', async () => {
    const chat = newChat();
    const before = fake.state.requests.filter((r) => r.path.startsWith('/api/files/')).length;
    const media = wahaFile(Buffer.from('owner'), 'image/jpeg');
    const r = await t.ctx.wa.handleWahaWebhook({
      ...wahaMessage({ from: chat, fromMe: true, hasMedia: true, media, session: acc.waha.sessionName }),
      event: 'message.any',
    });
    assert.equal(r, 'archived_owner');
    await idle();
    const [m] = await getMessages(t, cid(chat));
    assert.deepEqual(m.media, { type: 'image', mime: 'image/jpeg' });
    assert.equal(fake.state.requests.filter((x) => x.path.startsWith('/api/files/')).length, before);
  });

  it('重启时还没下完的（pending）记为下载失败，半截文件删掉', async () => {
    const chat = newChat();
    const m = await sendMedia(chat, wahaFile(Buffer.from('x'), 'image/jpeg'));
    t.ctx.db
      .prepare('UPDATE messages SET media = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'image', mime: 'image/jpeg', size: null, filename: null, stored: 'pending', error: null, fileKey: null }), m.id);
    fs.mkdirSync(path.join(mediaDir(), 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(mediaDir(), 'tmp', 'deadbeef.part'), 'half');
    // 同一个数据目录再起一个实例（模拟重启），只看启动时的清理
    const second = createApp(t.config, {
      log: quietLog(),
      webDist: path.join(t.dataDir, 'no-web'),
      relayBindHost: '127.0.0.1',
      leadsScanIntervalMs: 0,
      outreachTickMs: 0,
      updateCheckIntervalMs: 0,
      githubApiUrl: 'http://127.0.0.1:9',
    });
    await second.ready;
    await second.close();
    const after = (await getMessages(t, cid(chat))).find((x) => x.id === m.id);
    assert.equal(after.media.stored, 'failed');
    assert.match(after.media.error, /中断/);
    assert.ok(!fs.existsSync(path.join(mediaDir(), 'tmp', 'deadbeef.part')));
  });
});

// 回归（走真实路径）：WAHA 传完就关连接（HTTP/1.0、Connection: close），几条大文件和小图片几乎同时到，webhook → 后台并发下载存盘。
// 媒体下载走 fetch（npm undici 7）时这里会让整个进程崩掉，大文件之间夹着的几十 KB 的小图最容易出事（原因见 media-download.js 的注释）。
// WAHA 地址指向一个小代理：/api/files/ 自己给（传完就关连接），其他接口转给假 WAHA。
describe('并发下载、WAHA 传完就关连接：进程不崩，文件都对', () => {
  const BIG = 16 * 1024 * 1024;
  const SMALL = 27985;
  const ROUNDS = 3;
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  /** 路径（<session>/xxx）→ 内容 */
  const files = new Map();
  /** 测试期间进程里没接住的异常（正式环境会直接退出） */
  const crashes = [];
  const onCrash = (err) => crashes.push(String(err?.stack || err));
  let fake;
  let front;
  let t;
  let acc;

  before(async () => {
    process.on('uncaughtException', onCrash);
    fake = await startFakeWaha();
    front = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/api/files/')) {
        const buf = files.get(req.url.slice('/api/files/'.length));
        res.shouldKeepAlive = false;
        if (!buf) {
          res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
          return res.end('{"message":"file not found"}');
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, connection: 'close' });
        return res.end(buf);
      }
      const up = http.request(new URL(req.url, fake.url), { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (err) => {
        res.writeHead(502);
        res.end(String(err));
      });
      req.pipe(up);
    });
    await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
    t = await startApp({ env: { INKDOVE_WAHA_URL: `http://127.0.0.1:${front.address().port}` } });
    await t.login();
    acc = await t.createAccount({ name: '并发号' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await new Promise((resolve) => front.close(resolve));
    await fake.close();
    process.off('uncaughtException', onCrash);
  });

  it(`${ROUNDS} 轮（16MB 视频 + 16MB PDF + 28KB 图片）几乎同时到：都存下，大小和 sha256 对得上`, async () => {
    const sent = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (const [name, size, mimetype] of [
        [`video${r}.mp4`, BIG, 'video/mp4'],
        [`doc${r}.pdf`, BIG, 'application/pdf'],
        [`photo${r}.jpg`, SMALL, 'image/jpeg'],
      ]) {
        const p = `${acc.waha.sessionName}/${name}`;
        const buf = crypto.randomBytes(size);
        files.set(p, buf);
        sent.push({ chat: newChat(), size, hash: sha256(buf), media: { url: `http://waha:3000/api/files/${p}`, mimetype, filename: null } });
      }
    }
    const rs = await Promise.all(
      sent.map((s) => postWaha(t, wahaMessage({ from: s.chat, hasMedia: true, media: s.media, session: acc.waha.sessionName }))),
    );
    assert.ok(rs.every((r) => r.status === 200));
    await waitFor(() => t.ctx.wa.idle(), { timeout: 120_000, message: '媒体下载迟迟没结束' });
    assert.deepEqual(crashes, [], '进程里出了没接住的异常，正式环境会直接退出');
    for (const s of sent) {
      const [m] = (await getMessages(t, convIdOf(acc, s.chat))).filter((x) => x.direction === 'in');
      assert.equal(m.media.stored, 'ok', m.media.error || '');
      assert.equal(m.media.size, s.size);
      const { fileKey } = JSON.parse(t.ctx.db.prepare('SELECT media FROM messages WHERE id = ?').get(m.id).media);
      const file = fs.readFileSync(path.join(t.dataDir, 'media', fileKey));
      assert.equal(file.length, s.size);
      assert.equal(sha256(file), s.hash, '内容不对');
    }
  });
});

// 媒体下载（media-download.js 的 httpGet，node:http）：对方传完就关连接、重定向、超时、出错正文；
// WAHA 的 fetchMedia / downloadMedia（F4）和 Meta 的 metaOpenMedia / metaDownloadMedia（F4）都走它。
describe('媒体下载（node:http）', () => {
  const MB16 = 16 * 1024 * 1024;
  const BIG = [crypto.randomBytes(MB16), crypto.randomBytes(MB16)];
  const SMALL = crypto.randomBytes(27985);
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const API_KEY = 'waha-key-xyz';
  const TOKEN = 'EAAG-download-token';
  const API_VERSION = 'v21.0';
  /** 每个请求收到的头：路径 → headers */
  const seen = new Map();
  let a; // 文件服务器（同时当 WAHA 和 Meta Graph）
  let b; // 另一个主机（不同端口），测跨主机重定向
  let baseA;
  let baseB;
  let dataDir;
  let store;
  let waha;
  const meta = { apiVersion: API_VERSION, accessToken: TOKEN };
  const tmpLeft = () => {
    const tmp = path.join(dataDir, 'media', 'tmp');
    return fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
  };
  const storedLeft = () => fs.readdirSync(path.join(dataDir, 'media')).filter((f) => f !== 'tmp');
  /** 传完就关连接 */
  const sendClose = (res, buf, { length = true, type = 'application/octet-stream' } = {}) => {
    res.shouldKeepAlive = false;
    const h = { 'content-type': type, connection: 'close' };
    if (length) h['content-length'] = buf.length;
    else res.useChunkedEncodingByDefault = false; // 不带 content-length，靠关连接结束（HTTP/1.0 那种）
    res.writeHead(200, h);
    res.end(buf);
  };
  const echo = (req, res) => {
    seen.set(req.url, req.headers);
    sendClose(res, Buffer.from('ok'), { type: 'text/plain' });
  };

  before(async () => {
    b = http.createServer(echo);
    await new Promise((resolve) => b.listen(0, '127.0.0.1', resolve));
    baseB = `http://127.0.0.1:${b.address().port}`;
    a = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      const big = (name) => BIG[Number(name.match(/(\d)/)?.[1] || 0) % 2];
      // WAHA
      if (p.startsWith('/api/files/s/big')) return sendClose(res, big(p));
      if (p === '/api/files/s/small.jpg') return sendClose(res, SMALL, { type: 'image/jpeg' });
      if (p === '/api/files/s/nolen.bin') return sendClose(res, BIG[0], { length: false });
      if (p === '/api/files/s/echo') return echo(req, res);
      if (p === '/api/files/s/to-same') {
        res.writeHead(302, { location: '/api/files/s/echo' });
        return res.end();
      }
      if (p === '/api/files/s/to-other') {
        res.writeHead(307, { location: `${baseB}/echo` });
        return res.end();
      }
      if (p === '/api/files/s/loop') {
        res.writeHead(302, { location: '/api/files/s/loop' });
        return res.end();
      }
      if (p === '/api/files/s/hang') return; // 永远不回
      if (p === '/api/files/s/stall') {
        // 给了头和一半正文就不动了
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 1000 });
        return res.write(Buffer.alloc(500));
      }
      if (p === '/api/files/s/html404') {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!DOCTYPE HTML><html><body>Not found</body></html>');
      }
      if (p === '/api/files/s/json403') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'forbidden' }));
      }
      // Meta：GET /{ver}/{media-id} → {url, mime_type, file_size}；GET /dl/{media-id} 要 Bearer token
      const parts = p.split('/').filter(Boolean);
      if (parts[0] === API_VERSION && parts.length === 2) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return sendClose(res, Buffer.from('{}'), { type: 'application/json' });
        const id = parts[1];
        const url = id === 'REDIR' ? `${baseA}/dl-redirect` : id === 'DENY' ? `${baseA}/dl-deny` : `${baseA}/dl/${id}`;
        const size = id.startsWith('SMALL') ? SMALL.length : MB16;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ url, mime_type: id.startsWith('SMALL') ? 'image/jpeg' : 'video/mp4', file_size: size, id }));
      }
      if (parts[0] === 'dl') {
        seen.set(req.url, req.headers);
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad token' } }));
        }
        return sendClose(res, parts[1].startsWith('SMALL') ? SMALL : big(parts[1]));
      }
      if (p === '/dl-deny') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'url expired' } }));
      }
      if (p === '/dl-redirect') {
        res.writeHead(302, { location: `${baseB}/meta-echo` });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => a.listen(0, '127.0.0.1', resolve));
    baseA = `http://127.0.0.1:${a.address().port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-media-dl-'));
    store = createMediaStore(dataDir);
    waha = createWahaClient({ wahaUrl: baseA, wahaApiKey: API_KEY });
  });
  after(async () => {
    a.closeAllConnections();
    await new Promise((resolve) => a.close(resolve));
    await new Promise((resolve) => b.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('连续存 8 次 16MB（传完就关连接）：每次都成功，大小和内容哈希对得上', async () => {
    const want = sha256(BIG[0]);
    for (let i = 0; i < 8; i++) {
      const res = await waha.fetchMedia('http://waha:3000/api/files/s/big0.bin');
      assert.equal(res.headers.connection, 'close');
      const { key, size } = await store.saveResponse(res, { maxBytes: MEDIA_STORE_MAX_BYTES });
      assert.equal(size, MB16, `第 ${i + 1} 次`);
      const file = fs.readFileSync(store.pathOf(key));
      assert.equal(sha256(file), want, `第 ${i + 1} 次内容不对`);
      await store.remove(key);
    }
    assert.deepEqual(tmpLeft(), []);
  });

  it('没声明大小、边下边数超上限：抛 TooLargeError（size 为 null），不留文件和半截文件；声明的大小超了不读正文', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await waha.fetchMedia('http://waha:3000/api/files/s/nolen.bin');
      assert.equal(res.headers['content-length'], undefined);
      await assert.rejects(store.saveResponse(res, { maxBytes: 4 * 1024 * 1024 }), (err) => {
        assert.ok(err instanceof TooLargeError, err.message);
        assert.equal(err.size, null);
        return true;
      });
    }
    const declared = await waha.fetchMedia('http://waha:3000/api/files/s/big1.bin');
    await assert.rejects(store.saveResponse(declared, { maxBytes: 1024 }), (err) => err instanceof TooLargeError && err.size === MB16);
    assert.ok(declared.destroyed, '不读正文，连接放掉');
    assert.deepEqual(storedLeft(), [], '不留文件');
    assert.deepEqual(tmpLeft(), [], '没有残留的半截文件');
  });

  it('WAHA：带 X-Api-Key；同主机重定向照带，跳到别的主机不带；重定向超过 3 次报错', async () => {
    let res = await waha.fetchMedia('http://waha:3000/api/files/s/to-same');
    res.resume();
    assert.equal(seen.get('/api/files/s/echo')['x-api-key'], API_KEY);
    res = await waha.fetchMedia('http://waha:3000/api/files/s/to-other');
    res.resume();
    assert.ok(seen.has('/echo'), '跟着跳过去了');
    assert.equal(seen.get('/echo')['x-api-key'], undefined, '别的主机拿不到 key');
    await assert.rejects(waha.fetchMedia('http://waha:3000/api/files/s/loop'), (err) => {
      assert.equal(err.message, `WAHA 连不上（${baseA}）：重定向次数太多`);
      return true;
    });
  });

  it('WAHA：出错文案同 request()（404 给人话、HTML 不带正文、JSON 带 message）；超时', async () => {
    await assert.rejects(waha.fetchMedia('http://waha:3000/api/files/s/html404'), { message: 'WAHA 返回 404：文件在 WAHA 那边已经过期或不存在', status: 404 });
    await assert.rejects(waha.fetchMedia('http://waha:3000/api/files/s/json403'), { message: 'WAHA 返回 403：forbidden', status: 403 });
    await assert.rejects(waha.fetchMedia('http://waha:3000/api/files/s/hang', { timeoutMs: 200 }), { message: `WAHA 连不上（${baseA}）：超时` });
    // 读正文时超时：存盘报「下载超时」，不留半截文件
    const res = await waha.fetchMedia('http://waha:3000/api/files/s/stall', { timeoutMs: 300 });
    await assert.rejects(store.saveResponse(res, { maxBytes: MEDIA_STORE_MAX_BYTES }), (err) => err instanceof HttpGetError && err.message === '下载超时');
    assert.deepEqual(tmpLeft(), []);
  });

  it('WAHA F4（downloadMedia，读进内存）：6 路 16MB 和 3 张小图同时下、传完就关连接，内容都对；超过上限照旧 TooLargeError', async () => {
    const jobs = [];
    for (let i = 0; i < 6; i++) jobs.push([`big${i}.bin`, BIG[i % 2]]);
    for (let i = 0; i < 3; i++) jobs.push(['small.jpg', SMALL]);
    const got = await Promise.all(jobs.map(([name]) => waha.downloadMedia(`http://waha:3000/api/files/s/${name}`, { maxBytes: MEDIA_STORE_MAX_BYTES })));
    got.forEach((g, i) => assert.equal(sha256(g.buffer), sha256(jobs[i][1]), jobs[i][0]));
    assert.equal(got.at(-1).mime, 'image/jpeg');
    await assert.rejects(waha.downloadMedia('http://waha:3000/api/files/s/nolen.bin', { maxBytes: 1024 * 1024 }), (err) => err instanceof TooLargeError);
  });

  it('Meta：查到 url 后带 token 下载；6 路 16MB 和 3 张小图同时存盘、传完就关连接，内容都对；F4 读进内存也对', async () => {
    const ids = [...Array.from({ length: 6 }, (_, i) => `VID${i}`), 'SMALL1', 'SMALL2', 'SMALL3'];
    const want = (id) => sha256(id.startsWith('SMALL') ? SMALL : BIG[Number(id.slice(3)) % 2]);
    const saved = await Promise.all(
      ids.map(async (id) => {
        const opened = await metaOpenMedia(baseA, meta, id, { maxBytes: MEDIA_STORE_MAX_BYTES });
        assert.equal(opened.mime, id.startsWith('SMALL') ? 'image/jpeg' : 'video/mp4');
        return store.saveResponse(opened.res, { maxBytes: MEDIA_STORE_MAX_BYTES });
      }),
    );
    saved.forEach((r, i) => assert.equal(sha256(fs.readFileSync(store.pathOf(r.key))), want(ids[i]), ids[i]));
    assert.equal(seen.get('/dl/VID0').authorization, `Bearer ${TOKEN}`);
    for (const r of saved) await store.remove(r.key);
    const f4 = await metaDownloadMedia(baseA, meta, 'SMALL9', { maxBytes: MEDIA_STORE_MAX_BYTES });
    assert.equal(sha256(f4.buffer), sha256(SMALL));
    assert.equal(f4.mime, 'image/jpeg');
  });

  it('Meta：下载地址跳到别的主机不带 token；下载那一步出错报「下载媒体失败：Meta 返回 401」', async () => {
    const opened = await metaOpenMedia(baseA, meta, 'REDIR');
    opened.res.resume();
    assert.ok(seen.has('/meta-echo'), '跟着跳过去了');
    assert.equal(seen.get('/meta-echo').authorization, undefined, '别的主机拿不到 token');
    await assert.rejects(metaOpenMedia(baseA, meta, 'DENY'), { message: '下载媒体失败：Meta 返回 401' });
  });
});

describe('人工回复的号：标为已处理、关掉草稿', () => {
  let t;
  let fake;
  let acc;
  let agent;
  let otherAgent;
  const cid = (chat) => convIdOf(acc, chat);
  const row = (convId) => t.ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  const setDraft = (convId, kind, text = '草稿内容', fileIds = []) =>
    t.ctx.db
      .prepare('UPDATE conversations SET draft = ? WHERE id = ?')
      .run(JSON.stringify({ kind, text, fileIds, createdAt: new Date().toISOString() }), convId);

  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: '人工号' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    agent = await t.addMember({ email: 'ui-agent@example.com', name: '小处', accountIds: [acc.id] });
    otherAgent = await t.addMember({ email: 'ui-other@example.com', name: '小别', accountIds: [acc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  /**
   * 造一个待处理的会话：人工回复的号收到媒体不再标待处理，所以先把号临时改成自动回复，客户发一张图（没 caption）
   * 标上待处理、记一条转人工，再改回人工回复——就是号从自动回复改成人工回复时留下的待处理（升级前库里留下的也一样）
   */
  async function pendingConv() {
    const chat = newChat();
    assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { replyMode: 'auto' } })).status, 200);
    try {
      await postWaha(t, wahaMessage({ from: chat, hasMedia: true, media: { url: null, mimetype: 'image/jpeg' }, session: acc.waha.sessionName }));
      await waitFor(async () => (await getConv(t, cid(chat)))?.needsHuman, { message: '会话迟迟没有待处理' });
      await waitFor(() => t.ctx.wa.idle());
    } finally {
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { replyMode: 'off' } });
    }
    assert.equal((await t.req('GET', `/api/accounts/${acc.id}`)).body.replyMode, 'off');
    return cid(chat);
  }

  it('先核实：恢复机器人（POST /bot paused=false）会清待处理，但同时清掉草稿、改暂停状态，所以另加了接口', async () => {
    const convId = await pendingConv();
    t.ctx.db.prepare('UPDATE conversations SET bot_paused = 1 WHERE id = ?').run(convId);
    setDraft(convId, 'suggest');
    const r = await t.req('POST', `${convPath(convId)}/bot`, { body: { paused: false } });
    assert.equal(r.body.needsHuman, false);
    assert.equal(r.body.draft, null, '恢复机器人清掉了草稿');
    assert.equal(r.body.botPaused, false, '也改了暂停状态');
  });

  it('POST /resolve：只清待处理和原因、关掉转人工记录；草稿、暂停状态不动；权限同手动回复', async () => {
    const convId = await pendingConv();
    t.ctx.db.prepare('UPDATE conversations SET bot_paused = 1 WHERE id = ?').run(convId);
    setDraft(convId, 'suggest', '推荐的回复');
    assert.ok(row(convId).pending_reason);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM handoffs WHERE conversation_id = ? AND resumed_at IS NULL').get(convId).n, 1);

    // agent：没分给他 403，分给别人也 403
    assert.equal((await t.req('POST', `${convPath(convId)}/resolve`, { cookie: agent.cookie })).status, 403);
    await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: otherAgent.user.id } });
    assert.equal((await t.req('POST', `${convPath(convId)}/resolve`, { cookie: agent.cookie })).status, 403);
    assert.equal(row(convId).needs_human, 1);
    await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });

    const r = await t.req('POST', `${convPath(convId)}/resolve`, { cookie: agent.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, convId);
    assert.equal(r.body.needsHuman, false);
    assert.equal(r.body.pendingReason, null);
    assert.equal(r.body.botPaused, true, '暂停状态不动');
    assert.equal(r.body.draft.text, '推荐的回复', '草稿不动');
    assert.equal(row(convId).pending_reason, null);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM handoffs WHERE conversation_id = ? AND resumed_at IS NULL').get(convId).n, 0);
    // 没有待处理时再点也是 200
    assert.equal((await t.req('POST', `${convPath(convId)}/resolve`)).status, 200);
    assert.equal((await t.req('POST', `${convPath(`${acc.id}:nope@c.us`)}/resolve`)).status, 404);
  });

  describe('DELETE /draft（关掉推荐回复 / 草稿）', () => {
    it('清掉推荐回复（suggest）和转人工草稿（handoff），返回更新后的会话；没有草稿也 200', async () => {
      const chat = newChat();
      await wahaSend(t, acc, chat, '你好');
      const convId = cid(chat);
      await waitFor(async () => !!(await getConv(t, convId)));

      setDraft(convId, 'suggest', '推荐', ['file-1']);
      let r = await t.req('DELETE', `${convPath(convId)}/draft`);
      assert.equal(r.status, 200);
      assert.equal(r.body.id, convId);
      assert.equal(r.body.draft, null);
      assert.equal(row(convId).draft, null);

      setDraft(convId, 'handoff', '转人工时起草的');
      r = await t.req('DELETE', `${convPath(convId)}/draft`);
      assert.equal(r.status, 200);
      assert.equal(r.body.draft, null);
      assert.equal(row(convId).draft, null);

      r = await t.req('DELETE', `${convPath(convId)}/draft`);
      assert.equal(r.status, 200, '没有草稿也 200');
      assert.equal(r.body.draft, null);
      assert.equal((await t.req('DELETE', `${convPath(`${acc.id}:nope@c.us`)}/draft`)).status, 404);
    });

    it('权限同手动回复：agent 清不了别人客户的草稿（403，草稿还在）；分给自己的可以', async () => {
      const chat = newChat();
      await wahaSend(t, acc, chat, '在吗');
      const convId = cid(chat);
      await waitFor(async () => !!(await getConv(t, convId)));
      setDraft(convId, 'suggest', '别人的推荐');
      await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: otherAgent.user.id } });
      const denied = await t.req('DELETE', `${convPath(convId)}/draft`, { cookie: agent.cookie });
      assert.equal(denied.status, 403);
      assert.ok(row(convId).draft, '草稿还在');
      const ok = await t.req('DELETE', `${convPath(convId)}/draft`, { cookie: otherAgent.cookie });
      assert.equal(ok.status, 200);
      assert.equal(row(convId).draft, null);
    });
  });
});
