import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { signFileToken, SIGNED_URL_TTL_MS, verifyFileToken } from '../src/files/signed.js';
import { selectContextFiles } from '../src/files/store.js';
import { buildReplySystemPrompt } from '../src/reply/prompts.js';
import {
  aiHooks,
  convIdOf,
  convPath,
  getConv,
  getMessages,
  startApp,
  startFakeWaha,
  TINY_PNG,
  waitDecided,
  waitFor,
  wahaSend,
} from './helpers.js';
import { fakeJpeg, filesForm, makeDocx, makePdf, makePptx, makeSheet, startFakeGraph } from './fixtures.js';

const BOSS = '8613900000001';
const BOSS_CHAT = `${BOSS}@c.us`;
const PNID = '106540352242999';
const META_TOKEN = 'EAAG-files-token';
const INLINE_MAX = 1000;
let seq = 0;
const newChat = () => `86136${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

const SENDABLE_KEYS = [
  'createdAt',
  'description',
  'descriptionStatus',
  'filename',
  'id',
  'kbSourceId',
  'lastSentAt',
  'mime',
  'name',
  'sendCount',
  'size',
  'status',
  'tags',
  'updatedAt',
];

describe('F15 文件管理', () => {
  let t;
  let fake;
  let graph;
  let acc;
  let hooks;
  const decisions = [];
  const cid = (chat) => convIdOf(acc, chat);
  const upload = (files, opts) => t.req('POST', '/api/files', { body: filesForm(files, opts) });
  const getFile = async (id) => (await t.req('GET', `/api/files/${id}`)).body;
  const waitDescribed = (id) =>
    waitFor(async () => {
      const f = await getFile(id);
      return f.descriptionStatus !== 'pending' ? f : null;
    });
  /** 只留下这些文件是 active，其余停用（机器人能发的只有它们） */
  async function onlyActive(ids) {
    for (const f of (await t.req('GET', '/api/files')).body) {
      await t.req('PUT', `/api/files/${f.id}`, { body: { status: ids.includes(f.id) ? 'active' : 'disabled' } });
    }
  }
  async function customer(text, chat = newChat(), n = 1) {
    await wahaSend(t, acc, chat, text);
    await waitDecided(t, cid(chat), n);
    await waitFor(() => t.ctx.wa.idle());
    return chat;
  }

  before(async () => {
    fake = await startFakeWaha();
    graph = await startFakeGraph();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url, INKDOVE_META_GRAPH_URL: graph.url },
      options: { aiOverrides: hooks.overrides, onDecision: (row) => decisions.push(row), wahaInlineMaxBytes: INLINE_MAX },
    });
    fake.state.fetchBase = t.base;
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: '一号', autoReply: true, notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
    await graph.close();
  });

  describe('上传和管理', () => {
    let all;
    it('上传 pdf、xlsx、xls、csv、docx、pptx、txt、jpg、png、webp：返回 SendableFile，存在 DATA_DIR/files/<id>', async () => {
      const files = [
        { name: 'catalog-2026.pdf', buffer: makePdf('Catalog 2026 A100 B200') },
        { name: 'prices.xlsx', buffer: makeSheet([['型号', '价格'], ['A100', '59 元']]) },
        { name: 'old-prices.xls', buffer: makeSheet([['型号', '价格'], ['B200', '99 元']], 'biff8') },
        { name: 'list.csv', buffer: Buffer.from('model,price\nA100,59\n') },
        { name: 'manual.docx', buffer: await makeDocx(['保温杯使用说明', '不要放进微波炉']) },
        { name: 'deck.pptx', buffer: await makePptx(['公司介绍', '工厂在永康']) },
        { name: 'note.txt', buffer: Buffer.from('售后电话 0579-123') },
        { name: 'photo.jpg', buffer: fakeJpeg() },
        { name: 'logo.png', buffer: TINY_PNG },
        { name: 'pic.webp', buffer: Buffer.from('RIFF0000WEBPVP8 ') },
      ];
      const r = await upload(files);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      all = r.body;
      assert.equal(all.length, 10);
      assert.deepEqual(Object.keys(all[0]).sort(), SENDABLE_KEYS);
      assert.deepEqual(
        all.map((f) => f.mime),
        [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'text/csv',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'text/plain',
          'image/jpeg',
          'image/png',
          'image/webp',
        ],
      );
      assert.equal(all[0].name, 'catalog-2026');
      assert.equal(all[0].filename, 'catalog-2026.pdf');
      assert.equal(all[0].status, 'active');
      assert.equal(all[0].sendCount, 0);
      assert.equal(all[0].lastSentAt, null);
      for (const [i, f] of all.entries()) {
        assert.ok(fs.readFileSync(path.join(t.dataDir, 'files', f.id)).equals(files[i].buffer), f.filename);
      }
      assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'files', 'tmp')), [], '临时文件清掉了');
    });

    it('不支持的格式 400；超过 50MB 413；都不留临时文件', async () => {
      const bad = await upload([{ name: 'tool.exe', buffer: Buffer.from('MZ') }]);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'unsupported_file_type');
      const mixed = await upload([
        { name: 'ok.txt', buffer: Buffer.from('ok') },
        { name: 'x.zip', buffer: Buffer.from('PK') },
      ]);
      assert.equal(mixed.status, 400, '有一个不支持就整批拒绝');
      const big = await upload([{ name: 'big.pdf', buffer: Buffer.alloc(50 * 1024 * 1024 + 1) }]);
      assert.equal(big.status, 413);
      assert.equal(big.body.code, 'file_too_large');
      // 拒收后临时文件是异步删的（fs.rm 不等），等它删完
      await waitFor(() => fs.readdirSync(path.join(t.dataDir, 'files', 'tmp')).length === 0, { timeout: 1000, message: '临时文件没删' });
      assert.equal((await t.req('GET', '/api/files')).body.length, 10);
    });

    it('addToKb（默认勾选）同时建知识库资料；addToKb=false 不建；图片不建；删文件不删资料', async () => {
      const sources = (await t.req('GET', '/api/sources')).body;
      const pdf = all[0];
      assert.ok(pdf.kbSourceId);
      const src = sources.find((s) => s.id === pdf.kbSourceId);
      assert.equal(src.kind, 'file');
      assert.equal(src.status, 'ready');
      assert.equal(src.name, 'catalog-2026.pdf');
      assert.match((await t.req('GET', `/api/sources/${pdf.kbSourceId}`)).body.preview, /Catalog 2026/);
      assert.ok(all.find((f) => f.filename === 'deck.pptx').kbSourceId);
      assert.equal(all.find((f) => f.filename === 'photo.jpg').kbSourceId, null);
      const no = await upload([{ name: 'nokb.txt', buffer: Buffer.from('不进知识库') }], { addToKb: false });
      assert.equal(no.body[0].kbSourceId, null);
      assert.equal((await t.req('GET', '/api/sources')).body.length, sources.length);
      assert.equal((await t.req('DELETE', `/api/files/${no.body[0].id}`)).status, 200);
      const txt = all.find((f) => f.filename === 'note.txt');
      assert.equal((await t.req('DELETE', `/api/files/${txt.id}`)).status, 200);
      assert.equal((await t.req('GET', `/api/files/${txt.id}`)).status, 404);
      // store.remove 异步删文件（fs.rm 不等），等它删完
      await waitFor(() => !fs.existsSync(path.join(t.dataDir, 'files', txt.id)), { timeout: 1000, message: '文件没删' });
      assert.ok((await t.req('GET', '/api/sources')).body.some((s) => s.id === txt.kbSourceId), '对应的资料保留');
    });

    it('描述自动生成（mock）：pending → ready；没开图片识别的图片记 manual；手改记 manual；可以重新生成', async () => {
      const pdf = await waitDescribed(all[0].id);
      assert.equal(pdf.descriptionStatus, 'ready');
      assert.match(pdf.description, /catalog-2026/);
      assert.match(pdf.description, /Catalog 2026/);
      const pptx = await waitDescribed(all.find((f) => f.filename === 'deck.pptx').id);
      assert.match(pptx.description, /公司介绍/);
      const jpg = all.find((f) => f.filename === 'photo.jpg');
      assert.equal(jpg.descriptionStatus, 'manual');
      const off = await t.req('POST', `/api/files/${jpg.id}/describe`);
      assert.equal(off.status, 400);
      assert.equal(off.body.code, 'image_disabled');

      await t.req('PUT', '/api/settings', { body: { media: { image: true } } });
      const re = await t.req('POST', `/api/files/${jpg.id}/describe`);
      assert.equal(re.status, 200);
      assert.equal(re.body.descriptionStatus, 'pending');
      const done = await waitDescribed(jpg.id);
      assert.equal(done.descriptionStatus, 'ready');
      assert.match(done.description, /产品图片/);
      assert.ok(hooks.args.describeFile.image, '图片作为附件交给模型');
      await t.req('PUT', '/api/settings', { body: { media: { image: false } } });

      const put = await t.req('PUT', `/api/files/${pdf.id}`, { body: { name: '2026 产品目录', description: '2026 全系列产品目录', tags: ['目录', '2026'] } });
      assert.equal(put.status, 200);
      assert.equal(put.body.descriptionStatus, 'manual');
      assert.equal(put.body.name, '2026 产品目录');
      assert.deepEqual(put.body.tags, ['目录', '2026']);
      assert.equal((await t.req('PUT', `/api/files/${pdf.id}`, { body: { status: 'gone' } })).status, 400);
      assert.equal((await t.req('PUT', `/api/files/${pdf.id}`, { body: { name: '' } })).status, 400);
    });

    it('列表按 q 和 status 筛选；下载带原文件名（UTF-8）和 mime', async () => {
      const zh = (await upload([{ name: '产品规格书.pdf', buffer: makePdf('Spec') }])).body[0];
      const q = (await t.req('GET', '/api/files?q=规格书')).body;
      assert.deepEqual(q.map((f) => f.id), [zh.id]);
      await t.req('PUT', `/api/files/${zh.id}`, { body: { status: 'disabled' } });
      assert.deepEqual((await t.req('GET', '/api/files?status=disabled')).body.map((f) => f.id), [zh.id]);
      assert.ok(!(await t.req('GET', '/api/files?status=active')).body.some((f) => f.id === zh.id));
      assert.equal((await t.req('GET', '/api/files?status=x')).status, 400);
      const res = await fetch(`${t.base}/api/files/${zh.id}/download`, { headers: { cookie: t.cookie } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.match(res.headers.get('content-disposition'), /^attachment; filename="[^"]+\.pdf"; filename\*=UTF-8''%E4%BA%A7%E5%93%81%E8%A7%84%E6%A0%BC%E4%B9%A6\.pdf$/);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(makePdf('Spec')));
      assert.equal((await t.req('GET', '/api/files/nope/download')).status, 404);
    });

    it('agent 能浏览和下载，不能上传、改、删、重新生成描述', async () => {
      const agent = await t.addMember({ email: 'files-agent@example.com', accountIds: [acc.id] });
      const as = { cookie: agent.cookie };
      const list = await t.req('GET', '/api/files', as);
      assert.equal(list.status, 200);
      const id = list.body[0].id;
      assert.equal((await t.req('GET', `/api/files/${id}`, as)).status, 200);
      assert.equal((await fetch(`${t.base}/api/files/${id}/download`, { headers: { cookie: agent.cookie } })).status, 200);
      assert.equal((await t.req('POST', '/api/files', { ...as, body: filesForm([{ name: 'a.txt', buffer: Buffer.from('a') }]) })).status, 403);
      assert.equal((await t.req('PUT', `/api/files/${id}`, { ...as, body: { name: 'x' } })).status, 403);
      assert.equal((await t.req('DELETE', `/api/files/${id}`, as)).status, 403);
      assert.equal((await t.req('POST', `/api/files/${id}/describe`, as)).status, 403);
      assert.equal((await t.req('GET', '/api/files', { auth: false })).status, 401);
    });
  });

  describe('机器人发文件', () => {
    let catalog;
    let png;
    let bigTxt;
    let extra;
    before(async () => {
      const r = await upload([
        { name: '2026 产品目录.pdf', buffer: makePdf('Catalog') },
        { name: 'logo.png', buffer: TINY_PNG },
        { name: 'big-notes.txt', buffer: Buffer.from('x'.repeat(3000)) },
        { name: 'brochure.pdf', buffer: makePdf('Brochure') },
      ]);
      [catalog, png, bigTxt, extra] = r.body;
      for (const f of r.body) await waitDescribed(f.id);
      await onlyActive(r.body.map((f) => f.id));
    });

    it('客户要目录：先发文字，停一下再发文件（不带 caption）；附件消息另存一条、text 为空；sendCount 和 decisions.sentFileIds', async () => {
      const n = decisions.length;
      const chat = await customer('请发一下产品目录');
      await waitFor(() => fake.mediaTo(chat).length === 1);
      assert.deepEqual(
        fake.timelineFor(chat).filter((k) => k.startsWith('send')),
        ['send', 'send_file'],
        '先文字后文件',
      );
      assert.equal(fake.sentTo(chat)[0].text, '发你了，你看下');
      const m = fake.mediaTo(chat)[0];
      assert.equal(m.kind, 'file', 'pdf 走 sendFile');
      assert.equal(m.session, acc.waha.sessionName);
      assert.equal(m.caption, undefined);
      assert.deepEqual(Object.keys(m.file).sort(), ['data', 'filename', 'mimetype']);
      assert.equal(m.file.mimetype, 'application/pdf');
      assert.equal(m.file.filename, '2026 产品目录.pdf');
      assert.ok(Buffer.from(m.file.data, 'base64').equals(makePdf('Catalog')), 'base64 不带 data: 前缀');

      const out = (await getMessages(t, cid(chat))).filter((x) => x.direction === 'out');
      assert.equal(out.length, 2);
      assert.equal(out[0].text, '发你了，你看下');
      assert.equal(out[0].attachment, null);
      assert.equal(out[1].text, '');
      assert.equal(out[1].author, 'bot');
      assert.deepEqual(out[1].attachment, { fileId: catalog.id, filename: '2026 产品目录.pdf', mime: 'application/pdf', size: catalog.size });
      const f = await getFile(catalog.id);
      assert.equal(f.sendCount, 1);
      assert.ok(f.lastSentAt);
      await waitFor(() => decisions.length > n);
      const d = decisions.at(-1);
      assert.equal(d.decision, 'replied');
      assert.equal(d.code, 'business');
      assert.deepEqual(d.usedEntryIds, [], '只发文件、不引用条目的业务回复也能通过');
      assert.deepEqual(d.sentFileIds, [catalog.id]);
      assert.deepEqual(hooks.args.review.files.map((x) => x.id), [catalog.id], '审核收到要发的文件');
      // 会话列表的最后一条显示成文件
      assert.equal((await getConv(t, cid(chat))).lastMessage.text, '[文件] 2026 产品目录.pdf');
    });

    it('WAHA：png 走 sendImage（base64）；超过阈值的走签名地址，WAHA 能拉到', async () => {
      hooks.generate = () => ({ category: 'business', reply: '发你了', usedEntryIds: [], sendFileIds: [`file:${png.id}`, bigTxt.id], reason: 'x' });
      try {
        const chat = await customer('要图片和说明');
        await waitFor(() => fake.mediaTo(chat).length === 2);
        const [img, big] = fake.mediaTo(chat);
        assert.equal(img.kind, 'image');
        assert.ok(Buffer.from(img.file.data, 'base64').equals(TINY_PNG));
        assert.equal(img.file.mimetype, 'image/png');
        assert.equal(big.kind, 'file');
        assert.equal(big.file.data, undefined);
        assert.match(big.file.url, new RegExp(`^http://inkdove:8794/internal/files/${bigTxt.id}\\?token=\\d+\\.[A-Za-z0-9_-]{43}$`));
        assert.deepEqual(big.fetched, { status: 200, bytes: 3000, contentType: 'text/plain; charset=utf-8' });
      } finally {
        hooks.generate = null;
      }
    });

    it('签名地址：过期、换成别的文件、篡改、没带 token 都 403；正常的 200', async () => {
      const secret = t.config.sessionSecret;
      const get = (id, token) => t.req('GET', `/internal/files/${id}${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`, { auth: false });
      const good = signFileToken(secret, bigTxt.id);
      assert.equal((await get(bigTxt.id, good)).status, 200);
      assert.equal((await get(bigTxt.id, good)).body, 'x'.repeat(3000));
      const expired = signFileToken(secret, bigTxt.id, { now: Date.now() - SIGNED_URL_TTL_MS - 1000 });
      assert.equal((await get(bigTxt.id, expired)).status, 403);
      assert.equal((await get(catalog.id, good)).status, 403, '只放行签名里的那一个文件');
      assert.equal((await get(bigTxt.id, `${good.slice(0, -2)}AA`)).status, 403);
      assert.equal((await get(bigTxt.id, `${Number(good.split('.')[0]) + 600}.${good.split('.')[1]}`)).status, 403, '改过期时间也不行');
      assert.equal((await get(bigTxt.id)).status, 403);
      assert.equal((await get(bigTxt.id, signFileToken('other-secret', bigTxt.id))).status, 403);
      assert.ok(verifyFileToken(secret, bigTxt.id, good));
      assert.ok(!verifyFileToken(secret, bigTxt.id, good, { now: Date.now() + SIGNED_URL_TTL_MS + 1000 }), '10 分钟后失效');
    });

    it('send_file_ids 里有不存在或已停用的文件判 blocked（bad_file）；超过 3 个也是 bad_file；什么都不发', async () => {
      const ask = async (ids) => {
        hooks.generate = () => ({ category: 'business', reply: '发你了', usedEntryIds: [], sendFileIds: ids, reason: 'x' });
        try {
          return (await t.req('POST', '/api/kb/ask', { body: { message: '发资料' } })).body;
        } finally {
          hooks.generate = null;
        }
      };
      let r = await ask(['nope']);
      assert.equal(r.decision, 'blocked');
      assert.equal(r.code, 'bad_file');
      assert.deepEqual(r.sendFileIds, []);
      await t.req('PUT', `/api/files/${extra.id}`, { body: { status: 'disabled' } });
      r = await ask([extra.id]);
      assert.equal(r.code, 'bad_file');
      await t.req('PUT', `/api/files/${extra.id}`, { body: { status: 'active' } });
      r = await ask([catalog.id, png.id, bigTxt.id, extra.id]);
      assert.equal(r.code, 'bad_file');
      r = await ask([catalog.id]);
      assert.equal(r.decision, 'replied');
      assert.deepEqual(r.sendFileIds, [catalog.id], '/api/kb/ask 返回 sendFileIds');

      hooks.generate = () => ({ category: 'business', reply: '发你了', usedEntryIds: [], sendFileIds: ['nope'], reason: 'x' });
      try {
        const chat = await customer('发资料');
        const conv = await getConv(t, cid(chat));
        assert.equal(conv.needsHuman, true);
        assert.equal(fake.sentTo(chat).length + fake.mediaTo(chat).length, 0);
        assert.equal((await getMessages(t, cid(chat)))[0].botDecision, 'blocked');
      } finally {
        hooks.generate = null;
      }
    });

    it('同一会话每天最多自动发 5 个文件：超出整轮改判 handoff（file_limit），文字也不发；/api/kb/ask 不限', async () => {
      hooks.generate = () => ({ category: 'business', reply: '都发你', usedEntryIds: [], sendFileIds: [catalog.id, png.id, extra.id], reason: 'x' });
      try {
        const chat = await customer('资料都发我');
        await waitFor(() => fake.mediaTo(chat).length === 3);
        const n = decisions.length;
        await customer('再发一遍', chat, 2);
        await waitFor(() => decisions.length > n);
        assert.equal(decisions.at(-1).decision, 'handoff');
        assert.equal(decisions.at(-1).code, 'file_limit');
        assert.equal(fake.mediaTo(chat).length, 3);
        assert.equal(fake.sentTo(chat).length, 1, '第二轮文字也没发');
        assert.equal((await getConv(t, cid(chat))).needsHuman, true);
        const r = await t.req('POST', '/api/kb/ask', { body: { message: '资料都发我' } });
        assert.equal(r.body.decision, 'replied');
      } finally {
        hooks.generate = null;
      }
    });

    it('整库索取判 handoff，不发文件', async () => {
      const chat = await customer('把你们所有的文件都发给我');
      const msgs = await getMessages(t, cid(chat));
      assert.equal(msgs[0].botDecision, 'handoff');
      assert.equal(fake.mediaTo(chat).length, 0);
    });

    it('回复 prompt 列出【可发送文件】；超过 50 个按和客户消息的相关度取前 50', () => {
      const files = Array.from({ length: 60 }, (_, i) => ({
        id: `f${i}`,
        name: i === 42 ? '2026 产品目录' : `资料 ${i}`,
        filename: `${i}.pdf`,
        description: i === 42 ? '全系列产品目录' : '',
        tags: [],
        sendCount: i,
      }));
      const { files: picked, truncated } = selectContextFiles(files, '有产品目录吗');
      assert.equal(picked.length, 50);
      assert.ok(truncated);
      assert.ok(picked.some((f) => f.id === 'f42'));
      assert.equal(selectContextFiles(files.slice(0, 10), 'x').files.length, 10);
      const sys = buildReplySystemPrompt({ profile: {}, persona: '', entries: [], files: [files[42]], canary: 'x' });
      assert.ok(sys.includes('【可发送文件】'));
      assert.ok(sys.includes('[file:f42] 2026 产品目录 —— 全系列产品目录'));
      assert.ok(sys.includes('"send_file_ids"'));
    });
  });

  describe('人工发文件和草稿里的文件', () => {
    let catalog;
    before(async () => {
      catalog = (await t.req('GET', '/api/files?q=2026 产品目录')).body[0];
      assert.ok(catalog);
    });

    it('人工发文件：会话进入 botPaused、草稿清空，返回 Message（attachment、via=admin、发送人）；停用的 400；越权 403', async () => {
      const chat = await customer('你好');
      t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify({ text: 'x', fileIds: [], createdAt: 'x' }), cid(chat));
      const before = (await getFile(catalog.id)).sendCount;
      const r = await t.req('POST', `${convPath(cid(chat))}/send-file`, { body: { fileId: catalog.id, caption: '目录在这' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.author, 'operator');
      assert.equal(r.body.via, 'admin');
      assert.equal(r.body.sentByName, '管理员');
      assert.equal(r.body.text, '目录在这');
      assert.equal(r.body.status, 'sent');
      assert.equal(r.body.attachment.fileId, catalog.id);
      assert.equal(fake.mediaTo(chat).at(-1).caption, '目录在这');
      const conv = await getConv(t, cid(chat));
      assert.equal(conv.botPaused, true);
      assert.equal(conv.draft, null);
      assert.equal((await getFile(catalog.id)).sendCount, before + 1);

      assert.equal((await t.req('POST', `${convPath(cid(chat))}/send-file`, { body: {} })).status, 400);
      assert.equal((await t.req('POST', `${convPath(cid(chat))}/send-file`, { body: { fileId: 'nope' } })).status, 404);
      const tmp = (await upload([{ name: 'tmp.txt', buffer: Buffer.from('tmp') }])).body[0];
      await t.req('PUT', `/api/files/${tmp.id}`, { body: { status: 'disabled' } });
      const dis = await t.req('POST', `${convPath(cid(chat))}/send-file`, { body: { fileId: tmp.id } });
      assert.equal(dis.status, 400);
      assert.equal(dis.body.code, 'file_disabled');
      const outsider = await t.addMember({ email: 'files-outsider@example.com', accountIds: [] });
      assert.equal((await t.req('POST', `${convPath(cid(chat))}/send-file`, { cookie: outsider.cookie, body: { fileId: catalog.id } })).status, 403);
    });

    it('转人工的草稿可以带建议发送的文件；/d 先发草稿文字再发文件，视为人工发送', async () => {
      const chat = newChat();
      const n = fake.sentTo(BOSS_CHAT).length;
      await wahaSend(t, acc, chat, '我要人工，顺便发下产品目录', { pushName: '郑先生' });
      await waitDecided(t, cid(chat), 1);
      await waitFor(() => fake.sentTo(BOSS_CHAT).length === n + 1);
      const notice = fake.sentTo(BOSS_CHAT).at(-1);
      const conv = await getConv(t, cid(chat));
      assert.deepEqual(conv.draft.fileIds, [catalog.id]);
      assert.ok(notice.text.includes('草稿附件：2026 产品目录'), notice.text);
      assert.equal(fake.mediaTo(chat).length, 0, '草稿不自动发');
      const before = (await getFile(catalog.id)).sendCount;

      await wahaSend(t, acc, BOSS_CHAT, '/d', { replyTo: { id: notice.id, body: '...' } });
      await waitFor(() => fake.sentTo(BOSS_CHAT).some((m) => m.text === '✅ 已发送给 郑先生'));
      assert.equal(fake.sentTo(chat).length, 1);
      assert.equal(fake.sentTo(chat)[0].text, conv.draft.text);
      assert.equal(fake.mediaTo(chat).length, 1);
      assert.equal(fake.mediaTo(chat)[0].file.filename, '2026 产品目录.pdf');
      const out = (await getMessages(t, cid(chat))).filter((m) => m.direction === 'out');
      assert.deepEqual(
        out.map((m) => [m.author, m.via, !!m.attachment]),
        [
          ['operator', 'whatsapp', false],
          ['operator', 'whatsapp', true],
        ],
      );
      assert.equal((await getFile(catalog.id)).sendCount, before + 1);
      assert.equal((await getConv(t, cid(chat))).draft, null);
    });
  });

  describe('Meta 发文件', () => {
    let macc;
    let pdf;
    let png;
    let webp;
    let csv;
    before(async () => {
      const r = await upload([
        { name: 'meta-catalog.pdf', buffer: makePdf('Meta') },
        { name: 'meta.png', buffer: TINY_PNG },
        { name: 'meta.webp', buffer: Buffer.from('RIFF0000WEBPVP8 ') },
        { name: 'meta.csv', buffer: Buffer.from('a,b\n1,2\n') },
      ]);
      [pdf, png, webp, csv] = r.body;
      macc = await t.createAccount({
        name: 'Meta 号',
        channel: 'meta',
        autoReply: true,
        meta: { phoneNumberId: PNID, verifyToken: 'v', accessToken: META_TOKEN, appSecret: 'meta-secret' },
      });
      // 先让客户发一条消息，建出会话
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'W',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: PNID },
                  contacts: [{ profile: { name: '客户' }, wa_id: '8613500000001' }],
                  messages: [{ from: '8613500000001', id: 'wamid.FILES1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '你好' } }],
                },
              },
            ],
          },
        ],
      });
      const sig = `sha256=${crypto.createHmac('sha256', 'meta-secret').update(raw).digest('hex')}`;
      await t.req('POST', `/webhooks/meta/${macc.id}`, { body: raw, auth: false, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
      await waitDecided(t, convIdOf(macc, '8613500000001'), 1);
    });

    it('先上传（multipart：messaging_product、type、file）再发 document（带 filename）；第二次用缓存的 media id；png 发 image', async () => {
      const conv = convIdOf(macc, '8613500000001');
      const send = (fileId) => t.req('POST', `${convPath(conv)}/send-file`, { body: { fileId } });
      const r = await send(pdf.id);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'sent', r.body.error);
      assert.equal(graph.state.uploads.length, 1);
      const up = graph.state.uploads[0];
      assert.equal(up.path, `/v26.0/${PNID}/media`);
      assert.equal(up.headers.authorization, `Bearer ${META_TOKEN}`);
      assert.match(up.headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.match(up.raw, /name="messaging_product"\r\n\r\nwhatsapp\r\n/);
      assert.match(up.raw, /name="type"\r\n\r\napplication\/pdf\r\n/);
      assert.match(up.raw, /name="file"; filename="meta-catalog.pdf"\r\nContent-Type: application\/pdf/);
      const doc = graph.sent('document').at(-1);
      assert.equal(doc.path, `/v26.0/${PNID}/messages`);
      assert.deepEqual(doc.body.document, { id: up.id, filename: 'meta-catalog.pdf' });
      assert.equal(doc.body.to, '8613500000001');

      await send(pdf.id);
      assert.equal(graph.state.uploads.length, 1, '25 天内用缓存的 media id');
      assert.equal(graph.sent('document').at(-1).body.document.id, up.id);

      await send(png.id);
      assert.equal(graph.state.uploads.length, 2);
      assert.deepEqual(graph.sent('image').at(-1).body.image, { id: graph.state.uploads[1].id });

      await send(csv.id);
      assert.match(graph.state.uploads[2].raw, /name="type"\r\n\r\ntext\/plain\r\n/, 'csv 按纯文本上传');
      assert.equal(graph.sent('document').at(-1).body.document.filename, 'meta.csv');

      const w = await send(webp.id);
      assert.equal(w.body.status, 'failed');
      assert.match(w.body.error, /webp/);
    });
  });
});
