// F11 主动外联：号码解析、预检（去重和每种跳过原因）、分配、发送循环（每日上限、发送窗口、间隔、连续失败暂停、重启接着发）、
// 回复和拒绝、回声、权限。全部用假 WAHA、假 Meta、mock 模型；时钟和发送间隔注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { inWindow, mainTimezone, parsePhoneLine } from '../src/outreach/phone.js';
import {
  aiHooks,
  convIdOf,
  convPath,
  getConv,
  getMessages,
  postWaha,
  sleep,
  startApp,
  startFakeMeta,
  startFakeWaha,
  waitFor,
  wahaHistoryMessage,
  wahaMessage,
  wahaSend,
} from './helpers.js';

/** 北京 12:00、纽约 00:00 */
const NOON_CN = Date.parse('2026-10-12T04:00:00Z');
const DAY = 24 * 3600 * 1000;
const MESSAGE = '您好，这里是墨鸽测试，之前您留了联系方式，有需要随时找我。';
const DEFAULT_OUTREACH = { dailyCapPerAccount: 1000, minIntervalSeconds: 90, maxIntervalSeconds: 240, windowStart: '09:00', windowEnd: '20:00' };

let numSeq = Math.floor(Math.random() * 1e6);
/** 一个新的中国手机号（本国写法，不带国家码）→ {local, digits, chat} */
function cnNumber() {
  const local = `139${String(++numSeq).padStart(8, '0')}`;
  return { local, digits: `86${local}`, chat: `86${local}@c.us` };
}

/** 上传号码文件新建任务（multipart） */
function createCampaign(
  t,
  { lines, raw, name = '测试外联', mode = 'single', accountIds, message = MESSAGE, defaultCountry = 'CN', tplName, tplLang, cookie, filename = 'numbers.txt' },
) {
  const form = new FormData();
  form.append('file', new Blob([raw ?? lines.join('\n')], { type: 'text/plain' }), filename);
  form.append('name', name);
  form.append('mode', mode);
  form.append('accountIds', JSON.stringify(accountIds));
  form.append('message', message);
  form.append('defaultCountry', defaultCountry);
  if (tplName !== undefined) form.append('metaTemplateName', tplName);
  if (tplLang !== undefined) form.append('metaTemplateLanguage', tplLang);
  return t.req('POST', '/api/campaigns', { body: form, cookie });
}

describe('F11 号码解析和发送窗口（单元）', () => {
  it('各种写法：空格、横线、括号、+、00；没有国家码的用 defaultCountry 补全；省掉 + 的国际号码也认', () => {
    const cases = [
      ['+86 138-0013-8000', 'CN', '8613800138000', 'CN'],
      ['+86 (138) 0013 8000', 'US', '8613800138000', 'CN'],
      ['(+86) 138 0013 8000', 'US', '8613800138000', 'CN'],
      ['0086 138 0013 8000', 'US', '8613800138000', 'CN'],
      ['13800138000', 'CN', '8613800138000', 'CN'],
      ['138 0013 8000', 'CN', '8613800138000', 'CN'],
      ['8613800138000', 'CN', '8613800138000', 'CN'],
      ['(212) 555-1234', 'US', '12125551234', 'US'],
      ['212-555-1234', 'US', '12125551234', 'US'],
      ['12125551234', 'CN', '12125551234', 'US'],
      ['+44 20 7946 0958', 'CN', '442079460958', 'GB'],
      ['07946 095 800', 'GB', '447946095800', 'GB'],
    ];
    for (const [raw, dc, digits, country] of cases) {
      assert.deepEqual(parsePhoneLine(raw, dc), { digits, country }, `${raw}（默认 ${dc}）`);
    }
    for (const raw of ['abc', '12345', '+86 138', '138-0013-8000 ext 2', '+86 138 0013 8000 0000', '', '+', '++8613800138000', '138.0013.8000']) {
      assert.equal(parsePhoneLine(raw, 'CN'), null, `"${raw}" 应该无效`);
    }
  });

  it('国家的主时区：多时区国家取首都或人口最多的地区，不知道国家的用 UTC', () => {
    assert.equal(mainTimezone('CN'), 'Asia/Shanghai');
    assert.equal(mainTimezone('US'), 'America/New_York');
    assert.equal(mainTimezone('RU'), 'Europe/Moscow');
    assert.equal(mainTimezone('AU'), 'Australia/Sydney');
    assert.equal(mainTimezone('GB'), 'Europe/London');
    assert.equal(mainTimezone('JP'), 'Asia/Tokyo');
    assert.equal(mainTimezone(null), 'UTC');
    assert.equal(mainTimezone('ZZ'), 'UTC');
  });

  it('发送窗口按收件人当地时间：[start, end)，start 晚于 end 跨午夜，相同表示全天', () => {
    const at = (s) => Date.parse(s);
    assert.equal(inWindow('Asia/Shanghai', at('2026-10-12T01:00:00Z'), '09:00', '20:00'), true, '北京 09:00');
    assert.equal(inWindow('Asia/Shanghai', at('2026-10-12T00:59:00Z'), '09:00', '20:00'), false, '北京 08:59');
    assert.equal(inWindow('Asia/Shanghai', at('2026-10-12T12:00:00Z'), '09:00', '20:00'), false, '北京 20:00 不含');
    assert.equal(inWindow('America/New_York', at('2026-10-12T13:30:00Z'), '09:00', '20:00'), true, '纽约 09:30（夏令时）');
    assert.equal(inWindow('America/New_York', at('2026-12-12T13:30:00Z'), '09:00', '20:00'), false, '纽约 08:30（冬令时）');
    assert.equal(inWindow('Asia/Shanghai', at('2026-10-12T15:00:00Z'), '20:00', '09:00'), true, '跨午夜：北京 23:00');
    assert.equal(inWindow('Asia/Shanghai', at('2026-10-12T04:00:00Z'), '20:00', '09:00'), false, '跨午夜：北京 12:00');
    assert.equal(inWindow('Asia/Shanghai', at('2026-10-12T04:00:00Z'), '00:00', '00:00'), true, '全天');
  });
});

describe('F11 主动外联（mock）', () => {
  let t;
  let fake;
  let meta;
  let hooks;
  let clock = NOON_CN;
  let intervals = 0;
  let accSeq = 0;
  const rows = (sql, ...p) => t.ctx.db.prepare(sql).all(...p);

  before(async () => {
    fake = await startFakeWaha();
    meta = await startFakeMeta();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url, INKDOVE_META_GRAPH_URL: meta.url },
      options: {
        aiOverrides: hooks.overrides,
        outreachNow: () => clock,
        // 间隔注入成 0，顺便数一数等了几次
        outreachIntervalMs: () => {
          intervals++;
          return 0;
        },
      },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
  });
  after(async () => {
    await t.close();
    await fake.close();
    await meta.close();
  });
  beforeEach(async () => {
    clock = NOON_CN;
    fake.state.failSend = false;
    fake.state.failCheckExists = false;
    fake.state.notOnWhatsapp.clear();
    meta.state.fail = false;
    const r = await t.req('PUT', '/api/settings', { body: { outreach: DEFAULT_OUTREACH } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  /** 新建一个扫码号并连上（假 WAHA 直接 WORKING） */
  async function wahaAccount(patch = {}) {
    const acc = await t.createAccount({ name: `外联号${++accSeq}`, ...patch });
    const st = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    assert.equal(st.status, 200);
    return acc;
  }
  /** 等所有发送循环都停下 */
  const settled = () => waitFor(() => t.ctx.outreach.idle(), { message: '外联发送循环迟迟没停' });
  /** 手动检查一遍（定时器在测试里关着），等循环停下 */
  async function tick() {
    t.ctx.outreach.tick();
    await settled();
  }
  const getCampaign = async (id, cookie) => (await t.req('GET', `/api/campaigns/${id}`, { cookie })).body;
  const recipientsOf = async (id, query = '') => (await t.req('GET', `/api/campaigns/${id}/recipients${query}`)).body;
  const recipientByNumber = async (id, digits) => (await recipientsOf(id, '?pageSize=200')).recipients.find((r) => r.number === digits);
  /** 建任务、开始、等发完 */
  async function runCampaign(opts) {
    const c = await createCampaign(t, opts);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const s = await t.req('POST', `/api/campaigns/${c.body.campaign.id}/start`, { body: {} });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    await settled();
    return { id: c.body.campaign.id, preview: c.body.preview, created: c.body.campaign };
  }

  describe('设置', () => {
    it('GET 带默认值；整块写入；校验失败的错误以字段路径开头', async () => {
      const def = await t.req('PUT', '/api/settings', {
        body: { outreach: { dailyCapPerAccount: 30, minIntervalSeconds: 90, maxIntervalSeconds: 240, windowStart: '09:00', windowEnd: '20:00' } },
      });
      assert.deepEqual(def.body.outreach, { dailyCapPerAccount: 30, minIntervalSeconds: 90, maxIntervalSeconds: 240, windowStart: '09:00', windowEnd: '20:00' });
      const put = await t.req('PUT', '/api/settings', {
        body: { outreach: { dailyCapPerAccount: 50, minIntervalSeconds: 10, maxIntervalSeconds: 10, windowStart: '08:30', windowEnd: '21:00' } },
      });
      assert.equal(put.status, 200);
      assert.deepEqual((await t.req('GET', '/api/settings')).body.outreach, {
        dailyCapPerAccount: 50,
        minIntervalSeconds: 10,
        maxIntervalSeconds: 10,
        windowStart: '08:30',
        windowEnd: '21:00',
      });
      const bad = [
        [{ minIntervalSeconds: 300, maxIntervalSeconds: 100 }, 'outreach.maxIntervalSeconds'],
        [{ minIntervalSeconds: 0 }, 'outreach.minIntervalSeconds'],
        [{ dailyCapPerAccount: 0 }, 'outreach.dailyCapPerAccount'],
        [{ dailyCapPerAccount: 1.5 }, 'outreach.dailyCapPerAccount'],
        [{ maxIntervalSeconds: 86401 }, 'outreach.maxIntervalSeconds'],
        [{ windowStart: '9:00' }, 'outreach.windowStart'],
        [{ windowEnd: '24:00' }, 'outreach.windowEnd'],
      ];
      for (const [patch, prefix] of bad) {
        const r = await t.req('PUT', '/api/settings', { body: { outreach: { ...DEFAULT_OUTREACH, ...patch } } });
        assert.equal(r.status, 400, JSON.stringify(patch));
        assert.ok(r.body.error.startsWith(prefix), `${r.body.error} 应以 ${prefix} 开头`);
      }
      assert.equal((await t.req('PUT', '/api/settings', { body: { outreach: 'x' } })).status, 400);
    });
  });

  describe('新建和预检', () => {
    it('去重和每种跳过原因（导入的历史聊天也算联系过），defaultCountry 补全；无效行列出行号和原文；收件人分页', async () => {
      const notifyNo = cnNumber();
      const blocked = cnNumber();
      const chatted = cnNumber();
      const imported = cnNumber();
      const v1 = cnNumber();
      const v2 = cnNumber();
      const v3 = cnNumber();
      const acc = await wahaAccount({ blocklist: [blocked.digits] });
      // 通知号码是另一个号的
      await wahaAccount({ notify: { whatsapp: { enabled: true, number: `+${notifyNo.digits}` } } });
      // 和某个号聊过（实时收到的）
      await wahaSend(t, acc, chatted.chat, '你好');
      await waitFor(() => getConv(t, convIdOf(acc, chatted.chat)));
      // 另一个号连上时导入的已有聊天
      const hist = await t.createAccount({ name: `导入号${++accSeq}` });
      fake.state.chats.set(hist.waha.sessionName, [
        { id: imported.chat, name: '老客户', messages: [wahaHistoryMessage({ chatId: imported.chat, body: '上次的报价收到了' })] },
      ]);
      await t.req('POST', `/api/accounts/${hist.id}/waha/start`);
      await waitFor(() => getConv(t, convIdOf(hist, imported.chat)), { message: '已有聊天迟迟没导入' });
      assert.equal((await getMessages(t, convIdOf(hist, imported.chat)))[0].via, 'import');

      const lines = [
        '# 这一行是注释',
        `+86 ${v1.local.slice(0, 3)}-${v1.local.slice(3, 7)}-${v1.local.slice(7)}`, // 2
        v2.local, // 3：用 defaultCountry 补全
        `0086 ${v1.local}`, // 4：和第 2 行重复
        'hello', // 5
        '', // 6
        '12345', // 7
        blocked.local, // 8
        `(+86) ${notifyNo.local}`, // 9
        chatted.digits, // 10
        `+${imported.digits}`, // 11
        ` ${v3.local} `, // 12
      ];
      const c = await createCampaign(t, { lines, accountIds: [acc.id], name: '预检' });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const { campaign, preview } = c.body;
      assert.equal(preview.valid, 3);
      assert.deepEqual(preview.invalidLines, [
        { line: 5, raw: 'hello' },
        { line: 7, raw: '12345' },
      ]);
      assert.deepEqual(preview.skipped, { invalid: 2, duplicate: 1, blocklisted: 1, notify_number: 1, already_contacted: 2 });
      assert.equal(campaign.status, 'draft');
      assert.equal(campaign.mode, 'single');
      assert.deepEqual(campaign.accountIds, [acc.id]);
      assert.equal(campaign.defaultCountry, 'CN');
      assert.equal(campaign.createdBy.name.length > 0, true);
      assert.deepEqual(campaign.stats, { total: 10, pending: 3, sent: 0, failed: 0, skipped: 7, replied: 0, declined: 0 });
      assert.equal(campaign.perAccount.length, 1);
      assert.equal(campaign.perAccount[0].accountName, acc.name);
      assert.equal(campaign.perAccount[0].assigned, 4, '有效的 3 个 + 在这个号黑名单里的 1 个');
      assert.deepEqual(campaign.outreach, DEFAULT_OUTREACH, '带上生效中的外联参数');

      const pending = await recipientsOf(campaign.id, '?status=pending');
      assert.equal(pending.total, 3);
      assert.deepEqual(
        pending.recipients.map((r) => r.number),
        [v1.digits, v2.digits, v3.digits],
        '规范化成纯数字，按文件顺序',
      );
      assert.ok(pending.recipients.every((r) => r.accountId === acc.id && r.sentAt === null && r.skipReason === null));
      const skipped = await recipientsOf(campaign.id, '?status=skipped');
      assert.equal(skipped.total, 7);
      const reasonOf = (digits) => skipped.recipients.find((r) => r.number === digits)?.skipReason;
      assert.equal(reasonOf(blocked.digits), 'blocklisted');
      assert.equal(reasonOf(notifyNo.digits), 'notify_number');
      assert.equal(reasonOf(chatted.digits), 'already_contacted');
      assert.equal(reasonOf(imported.digits), 'already_contacted');
      assert.equal(reasonOf('hello'), 'invalid');
      assert.equal(skipped.recipients.filter((r) => r.skipReason === 'duplicate').length, 1);
      const page2 = await recipientsOf(campaign.id, '?page=2&pageSize=4');
      assert.equal(page2.total, 10);
      assert.equal(page2.recipients.length, 4);
      assert.equal((await t.req('GET', `/api/campaigns/${campaign.id}/recipients?status=bogus`)).status, 400);
      assert.equal((await t.req('GET', `/api/campaigns/${campaign.id}/recipients?pageSize=1000`)).status, 400);
      // 草稿不发
      await tick();
      assert.equal(fake.sentTo(v1.chat).length, 0);
      assert.equal(fake.state.checks.filter((x) => x.phone === v1.digits).length, 0);
    });

    it('pooled：打乱后轮流分，各号数量最多差 1；分配建好就不变', async () => {
      const accs = [await wahaAccount(), await wahaAccount(), await wahaAccount()];
      const nums = Array.from({ length: 11 }, () => cnNumber());
      const c = await createCampaign(t, { lines: nums.map((n) => n.local), mode: 'pooled', accountIds: accs.map((a) => a.id) });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const counts = c.body.campaign.perAccount.map((p) => p.assigned);
      assert.equal(counts.reduce((a, b) => a + b, 0), 11);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `分配不均：${counts}`);
      const list = (await recipientsOf(c.body.campaign.id, '?pageSize=50')).recipients;
      assert.ok(list.every((r) => accs.some((a) => a.id === r.accountId)));
      const again = (await recipientsOf(c.body.campaign.id, '?pageSize=50')).recipients;
      assert.deepEqual(again.map((r) => r.accountId), list.map((r) => r.accountId));
    });

    it('参数和文件校验：single 只能一个号、号码不存在、非 .txt、非 UTF-8、空文件、超过 10000 行、超过 1MB', async () => {
      const a = await wahaAccount();
      const b = await wahaAccount();
      const n = cnNumber().local;
      const bad = async (opts, status, code) => {
        const r = await createCampaign(t, { lines: [n], accountIds: [a.id], ...opts });
        assert.equal(r.status, status, `${JSON.stringify(Object.keys(opts))} → ${JSON.stringify(r.body)}`);
        if (code) assert.equal(r.body.code, code);
        return r;
      };
      await bad({ accountIds: [a.id, b.id] }, 400);
      await bad({ accountIds: [] }, 400, 'accounts_required');
      await bad({ accountIds: ['nope'] }, 400, 'account_not_found');
      await bad({ mode: 'blast' }, 400);
      await bad({ name: '  ' }, 400, 'name_required');
      await bad({ message: '' }, 400, 'message_required');
      await bad({ defaultCountry: 'XX' }, 400, 'invalid_country');
      await bad({ filename: 'numbers.csv' }, 400, 'unsupported_file');
      await bad({ raw: Buffer.from([0x31, 0x33, 0xff, 0xfe, 0x0a]) }, 400, 'bad_encoding');
      await bad({ raw: '# 只有注释\n\n' }, 400, 'empty_file');
      await bad({ raw: Array.from({ length: 10001 }, (_, i) => `1390${String(i).padStart(7, '0')}`).join('\n') }, 400, 'too_many_lines');
      await bad({ raw: 'x'.repeat(1024 * 1024 + 10) }, 413, 'file_too_large');
      // 正好 10000 行可以；带 BOM 的 UTF-8 也行
      const ok = await createCampaign(t, {
        raw: `﻿${Array.from({ length: 10000 }, (_, i) => `1390${String(i).padStart(7, '0')}`).join('\r\n')}\r\n`,
        accountIds: [a.id],
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
      assert.equal(ok.body.campaign.stats.total, 10000);
      assert.equal((await t.req('DELETE', `/api/campaigns/${ok.body.campaign.id}`)).status, 200);
    });

    it('Meta 号缺模板返回 400 template_required；填了模板按 type:"template" 发 name 和 language，不发自由文本', async () => {
      const m = await t.createAccount({
        name: `Meta 外联号${++accSeq}`,
        channel: 'meta',
        meta: { phoneNumberId: '1065400000001', verifyToken: 'vt', accessToken: 'EAAG-outreach', appSecret: 'secret' },
      });
      const w = await wahaAccount();
      const n1 = cnNumber();
      const n2 = cnNumber();
      for (const tpl of [{}, { tplName: 'hello_world' }, { tplLang: 'zh_CN' }, { tplName: ' ', tplLang: 'zh_CN' }]) {
        const r = await createCampaign(t, { lines: [n1.local], mode: 'pooled', accountIds: [w.id, m.id], ...tpl });
        assert.equal(r.status, 400, JSON.stringify(tpl));
        assert.equal(r.body.code, 'template_required');
      }
      // 只有 Meta 号时开场消息可以不填（发的是模板）
      const { id } = await runCampaign({ lines: [n1.local, n2.local], accountIds: [m.id], message: '', tplName: 'opening_v1', tplLang: 'zh_CN' });
      const sent = meta.templates();
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[0].body, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: n1.digits,
        type: 'template',
        template: { name: 'opening_v1', language: { code: 'zh_CN' } },
      });
      assert.equal(sent[0].headers.authorization, 'Bearer EAAG-outreach');
      assert.equal(meta.texts().length, 0, '不发自由文本');
      const c = await getCampaign(id);
      assert.equal(c.status, 'done');
      assert.deepEqual(c.metaTemplate, { name: 'opening_v1', languageCode: 'zh_CN' });
      assert.equal(c.stats.sent, 2);
      const msgs = await getMessages(t, convIdOf(m, n1.digits));
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].author, 'bot');
      assert.equal(msgs[0].via, 'campaign');
      assert.equal(msgs[0].text, '[模板] opening_v1（zh_CN）');
    });
  });

  describe('发送', () => {
    it('WAHA：先查号，未注册 WhatsApp 的跳过；发到查号给的 chatId；记 sentAt、建会话、写 bot 消息；全部处理完转 done', async () => {
      const acc = await wahaAccount();
      const a = cnNumber();
      const b = cnNumber();
      const lid = cnNumber();
      fake.state.notOnWhatsapp.add(b.digits);
      fake.state.checkChatIds[lid.digits] = '204060801012345@lid';
      const before = intervals;
      const { id, created } = await runCampaign({ lines: [a.local, b.local, lid.local], accountIds: [acc.id] });
      assert.equal(created.status, 'draft');
      const c = await getCampaign(id);
      assert.equal(c.status, 'done');
      assert.ok(c.startedAt && c.finishedAt);
      assert.deepEqual(c.stats, { total: 3, pending: 0, sent: 2, failed: 0, skipped: 1, replied: 0, declined: 0 });
      assert.equal(c.perAccount[0].sent, 2);
      assert.equal(c.perAccount[0].sentToday, 2);
      // 查号带 phone 和 session
      assert.ok(fake.state.checks.some((x) => x.phone === a.digits && x.session === acc.waha.sessionName));
      // 发到查号给的 chatId（@c.us 或 @lid），文本就是开场消息
      assert.equal(fake.sentTo(a.chat).length, 1);
      assert.equal(fake.sentTo(a.chat)[0].text, MESSAGE);
      assert.equal(fake.sentTo(a.chat)[0].session, acc.waha.sessionName);
      assert.equal(fake.sentTo('204060801012345@lid').length, 1);
      assert.equal(fake.sentTo(b.chat).length, 0, '未注册 WhatsApp 的不发');
      assert.equal(intervals - before, 3, '每查一次号或发一条都等一个间隔（注入成 0）');

      const ra = await recipientByNumber(id, a.digits);
      assert.equal(ra.status, 'sent');
      assert.equal(ra.sentAt, new Date(NOON_CN).toISOString(), 'sentAt 用注入的时钟');
      assert.equal(ra.conversationId, convIdOf(acc, a.chat));
      assert.equal((await recipientByNumber(id, b.digits)).skipReason, 'not_on_whatsapp');
      assert.equal((await recipientByNumber(id, lid.digits)).conversationId, convIdOf(acc, '204060801012345@lid'));

      const conv = await getConv(t, convIdOf(acc, a.chat));
      assert.equal(conv.contactNumber, a.digits);
      assert.equal(conv.botPaused, false);
      assert.equal(conv.needsHuman, false);
      const msgs = await getMessages(t, convIdOf(acc, a.chat));
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].direction, 'out');
      assert.equal(msgs[0].author, 'bot');
      assert.equal(msgs[0].via, 'campaign');
      assert.equal(msgs[0].text, MESSAGE);
      assert.equal(msgs[0].status, 'sent');

      // 状态不对的操作返回 409；完成的可以删
      assert.equal((await t.req('POST', `/api/campaigns/${id}/start`, { body: {} })).status, 409);
      assert.equal((await t.req('POST', `/api/campaigns/${id}/resume`, { body: {} })).status, 409);
      assert.equal((await t.req('POST', `/api/campaigns/${id}/cancel`, { body: {} })).status, 409);
    });

    it('外联发出的消息推回来（message.any 的 fromMe）按回声剔除，不当成手机回复', async () => {
      const acc = await wahaAccount();
      const n = cnNumber();
      await runCampaign({ lines: [n.local], accountIds: [acc.id] });
      const sent = fake.sentTo(n.chat)[0];
      const echo = (extra) =>
        t.ctx.wa.handleWahaWebhook({ ...wahaMessage({ from: n.chat, body: MESSAGE, fromMe: true, session: acc.waha.sessionName, ...extra }), event: 'message.any' });
      assert.equal(await echo({ id: sent.id }), 'ignored_echo', '按 id');
      assert.equal(await echo({ id: `true_${n.chat}_OTHERID` }), 'ignored_echo', '回声比 API 响应先到：同 chat、同文本、30 秒内');
      const msgs = await getMessages(t, convIdOf(acc, n.chat));
      assert.equal(msgs.filter((m) => m.author === 'owner').length, 0);
      assert.equal(rows("SELECT * FROM handoffs WHERE conversation_id = ?", convIdOf(acc, n.chat)).length, 0);
    });

    it('每个号码只发一条，没有任何跟进：对方不理会也不再发；别的任务里同一个号码发送前再查一遍，按 already_contacted 跳过', async () => {
      const acc = await wahaAccount();
      const acc2 = await wahaAccount();
      const n = cnNumber();
      // 两个任务都包含 n，第二个建好时第一个还没发
      const first = await createCampaign(t, { lines: [n.local], accountIds: [acc.id] });
      const second = await createCampaign(t, { lines: [n.local], accountIds: [acc2.id] });
      assert.equal(second.body.preview.valid, 1);
      await t.req('POST', `/api/campaigns/${first.body.campaign.id}/start`, { body: {} });
      await settled();
      await t.req('POST', `/api/campaigns/${second.body.campaign.id}/start`, { body: {} });
      await settled();
      assert.equal((await recipientByNumber(second.body.campaign.id, n.digits)).skipReason, 'already_contacted');
      // 过几天再检查几遍，也不跟进
      for (let i = 1; i <= 3; i++) {
        clock = NOON_CN + i * DAY;
        await tick();
      }
      assert.equal(fake.sentTo(n.chat).length, 1);
      assert.equal(fake.state.checks.filter((x) => x.phone === n.digits).length, 1);
      assert.equal((await getCampaign(second.body.campaign.id)).status, 'done');
    });

    it('每日上限（所有任务合计）：到了上限当天不再发，第二天接着发；sentToday 按任务算', async () => {
      await t.req('PUT', '/api/settings', { body: { outreach: { ...DEFAULT_OUTREACH, dailyCapPerAccount: 2 } } });
      const acc = await wahaAccount();
      const nums = [cnNumber(), cnNumber(), cnNumber()];
      const { id } = await runCampaign({ lines: nums.map((n) => n.local), accountIds: [acc.id] });
      let c = await getCampaign(id);
      assert.equal(c.status, 'running');
      assert.equal(c.stats.sent, 2);
      assert.equal(c.stats.pending, 1);
      assert.equal(c.perAccount[0].sentToday, 2);
      await tick();
      assert.equal((await getCampaign(id)).stats.sent, 2, '同一天再检查也不发');
      // 同一天同一个号的另一个任务也不发（上限是号级、所有任务合计）
      const other = cnNumber();
      const { id: id2 } = await runCampaign({ lines: [other.local], accountIds: [acc.id] });
      assert.equal((await getCampaign(id2)).stats.sent, 0);
      // 第二天：两个任务各发一条（上限 2）
      clock = NOON_CN + DAY;
      await tick();
      c = await getCampaign(id);
      assert.equal(c.status, 'done');
      assert.equal(c.stats.sent, 3);
      assert.equal(c.perAccount[0].sentToday, 1, '第二天只算第二天发的');
      assert.equal((await getCampaign(id2)).status, 'done');
      assert.ok(nums.every((n) => fake.sentTo(n.chat).length === 1));
    });

    it('发送窗口按收件人当地时间（注入时钟）：北京、纽约的号码各在自己的白天发', async () => {
      const acc = await wahaAccount();
      const cn = cnNumber();
      const us = { local: `212555${String(++numSeq % 10000).padStart(4, '0')}` };
      us.digits = `1${us.local}`;
      us.chat = `${us.digits}@c.us`;
      clock = Date.parse('2026-10-12T00:30:00Z'); // 北京 08:30、纽约 20:30（前一天）
      const c = await createCampaign(t, { lines: [cn.local, `+1 ${us.local}`], accountIds: [acc.id] });
      const id = c.body.campaign.id;
      await t.req('POST', `/api/campaigns/${id}/start`, { body: {} });
      await settled();
      assert.equal(fake.sentTo(cn.chat).length + fake.sentTo(us.chat).length, 0, '都不在窗口内');
      clock = Date.parse('2026-10-12T13:30:00Z'); // 北京 21:30、纽约 09:30
      await tick();
      assert.equal(fake.sentTo(us.chat).length, 1);
      assert.equal(fake.sentTo(cn.chat).length, 0);
      clock = Date.parse('2026-10-13T01:30:00Z'); // 北京 09:30
      await tick();
      assert.equal(fake.sentTo(cn.chat).length, 1);
      assert.equal((await getCampaign(id)).status, 'done');
    });

    it('同一个号连续失败 3 次：任务自动暂停，error 写明哪个号出了什么错；继续后接着发', async () => {
      const acc = await wahaAccount();
      const nums = [cnNumber(), cnNumber(), cnNumber(), cnNumber()];
      fake.state.failSend = true;
      const { id } = await runCampaign({ lines: nums.map((n) => n.local), accountIds: [acc.id] });
      let c = await getCampaign(id);
      assert.equal(c.status, 'paused');
      assert.ok(c.error.includes(acc.name), c.error);
      assert.ok(c.error.includes('send failed'), c.error);
      assert.equal(c.stats.failed, 3);
      assert.equal(c.stats.pending, 1);
      const failed = await recipientsOf(id, '?status=failed');
      assert.ok(failed.recipients.every((r) => r.error.includes('send failed')));
      // 暂停中不发
      fake.state.failSend = false;
      await tick();
      assert.equal(fake.sentTo(nums[3].chat).length, 0);
      const r = await t.req('POST', `/api/campaigns/${id}/resume`, { body: {} });
      assert.equal(r.status, 200);
      assert.equal(r.body.error, null);
      await settled();
      c = await getCampaign(id);
      assert.equal(c.status, 'done');
      assert.equal(c.stats.sent, 1);
      assert.equal(fake.sentTo(nums[3].chat).length, 1);
    });

    it('查号接口出错也算失败；暂停、取消后不再发，取消后没发的留在 pending；DELETE 只能删 draft、cancelled、done', async () => {
      const acc = await wahaAccount();
      const nums = [cnNumber(), cnNumber()];
      clock = Date.parse('2026-10-12T00:30:00Z'); // 窗口外，先不发
      const c = await createCampaign(t, { lines: nums.map((n) => n.local), accountIds: [acc.id] });
      const id = c.body.campaign.id;
      assert.equal((await t.req('POST', `/api/campaigns/${id}/pause`, { body: {} })).status, 409);
      await t.req('POST', `/api/campaigns/${id}/start`, { body: {} });
      await settled();
      assert.equal((await t.req('DELETE', `/api/campaigns/${id}`)).status, 409, 'running 不能删');
      assert.equal((await t.req('POST', `/api/campaigns/${id}/pause`, { body: {} })).body.status, 'paused');
      clock = NOON_CN;
      await tick();
      assert.equal(fake.sentTo(nums[0].chat).length, 0, '暂停中不发');
      assert.equal((await t.req('DELETE', `/api/campaigns/${id}`)).status, 409, 'paused 不能删');
      fake.state.failCheckExists = true;
      await t.req('POST', `/api/campaigns/${id}/resume`, { body: {} });
      await settled();
      let cur = await getCampaign(id);
      assert.equal(cur.stats.failed, 2);
      assert.equal(cur.status, 'done', '都失败了也算处理完');
      // 另一个任务：取消后不再发
      fake.state.failCheckExists = false;
      clock = Date.parse('2026-10-12T00:30:00Z');
      const n3 = cnNumber();
      const c2 = await createCampaign(t, { lines: [n3.local], accountIds: [acc.id] });
      const id2 = c2.body.campaign.id;
      await t.req('POST', `/api/campaigns/${id2}/start`, { body: {} });
      await settled();
      const x = await t.req('POST', `/api/campaigns/${id2}/cancel`, { body: {} });
      assert.equal(x.body.status, 'cancelled');
      assert.ok(x.body.finishedAt);
      clock = NOON_CN;
      await tick();
      assert.equal(fake.sentTo(n3.chat).length, 0);
      cur = await getCampaign(id2);
      assert.equal(cur.stats.pending, 1);
      assert.equal((await t.req('DELETE', `/api/campaigns/${id2}`)).status, 200);
      assert.equal((await t.req('GET', `/api/campaigns/${id2}`)).status, 404);
      assert.equal(rows('SELECT * FROM campaign_recipients WHERE campaign_id = ?', id2).length, 0);
    });

    it('号没连上时不发，连上后接着发', async () => {
      const acc = await wahaAccount();
      const n = cnNumber();
      const sess = fake.state.sessions.get(acc.waha.sessionName);
      sess.status = 'STOPPED';
      await postWaha(t, { event: 'session.status', session: acc.waha.sessionName, payload: { status: 'STOPPED' } });
      const { id } = await runCampaign({ lines: [n.local], accountIds: [acc.id] });
      assert.equal(fake.sentTo(n.chat).length, 0);
      assert.equal((await getCampaign(id)).status, 'running');
      sess.status = 'WORKING';
      await postWaha(t, { event: 'session.status', session: acc.waha.sessionName, payload: { status: 'WORKING' } });
      await tick();
      assert.equal(fake.sentTo(n.chat).length, 1);
      assert.equal((await getCampaign(id)).status, 'done');
    });
  });

  describe('回复和拒绝', () => {
    it('回复记 repliedAt 并进入正常回复流程；白名单模式的号也回复外联对象（黑名单仍优先），别的号码仍按范围外', async () => {
      const acc = await wahaAccount({ autoReply: true, scope: 'allowlist', allowlist: [] });
      const r1 = cnNumber();
      const r2 = cnNumber();
      const stranger = cnNumber();
      const { id } = await runCampaign({ lines: [r1.local, r2.local], accountIds: [acc.id] });
      assert.equal((await getCampaign(id)).stats.sent, 2);

      await wahaSend(t, acc, r1.chat, '保温杯 A100 多少钱', { pushName: '王先生' });
      await waitFor(() => fake.sentTo(r1.chat).length === 2, { message: '白名单号没有回复外联对象' });
      const rec = await recipientByNumber(id, r1.digits);
      assert.ok(rec.repliedAt);
      assert.equal(rec.declinedAt, null);
      assert.equal(rec.conversationId, convIdOf(acc, r1.chat));
      const msgs = await getMessages(t, convIdOf(acc, r1.chat));
      assert.equal(msgs.find((m) => m.direction === 'in').botDecision, 'replied');
      assert.equal((await getConv(t, convIdOf(acc, r1.chat))).contactName, '王先生');
      const c = await getCampaign(id);
      assert.equal(c.stats.replied, 1);
      assert.equal(c.perAccount[0].replied, 1);

      // 再回复一次，repliedAt 不变
      await wahaSend(t, acc, r1.chat, '好的谢谢');
      await sleep(150);
      assert.equal((await recipientByNumber(id, r1.digits)).repliedAt, rec.repliedAt);

      // 不是外联对象的号码：白名单模式下照旧按范围外处理
      const ev = wahaMessage({ from: stranger.chat, body: '你好', session: acc.waha.sessionName });
      assert.equal(await t.ctx.wa.handleWahaWebhook(ev), 'out_of_scope');
      assert.equal(await getConv(t, convIdOf(acc, stranger.chat)), null);

      // 外联对象进了黑名单：黑名单优先
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { blocklist: [r2.digits] } });
      const ev2 = wahaMessage({ from: r2.chat, body: '你好', session: acc.waha.sessionName });
      assert.equal(await t.ctx.wa.handleWahaWebhook(ev2), 'out_of_scope');
      assert.equal((await recipientByNumber(id, r2.digits)).repliedAt, null);
    });

    it('回复从 @lid 来（发的时候是 @c.us）：按号码对上外联对象，conversationId 换成实际回复的会话', async () => {
      const acc = await wahaAccount({ autoReply: true });
      const n = cnNumber();
      const lidChat = '99887766554433@lid';
      fake.state.lids[lidChat] = n.digits;
      const { id } = await runCampaign({ lines: [n.local], accountIds: [acc.id] });
      await wahaSend(t, acc, lidChat, '你好');
      await waitFor(async () => (await recipientByNumber(id, n.digits)).repliedAt);
      assert.equal((await recipientByNumber(id, n.digits)).conversationId, convIdOf(acc, lidChat));
    });

    it('declined：不回复、不通知、会话暂停，Recipient 记 declinedAt；后续任务按 already_contacted 跳过他', async () => {
      const boss = cnNumber();
      const acc = await wahaAccount({ autoReply: true, notify: { whatsapp: { enabled: true, number: boss.digits } } });
      const d = cnNumber();
      const { id } = await runCampaign({ lines: [d.local], accountIds: [acc.id] });
      const bossBefore = fake.sentTo(boss.chat).length;
      const drafts = hooks.calls.draft;
      await wahaSend(t, acc, d.chat, '不需要了，以后别联系我');
      await waitFor(async () => (await recipientByNumber(id, d.digits)).declinedAt, { message: '迟迟没记 declinedAt' });
      await sleep(150);
      const msgs = await getMessages(t, convIdOf(acc, d.chat));
      assert.equal(msgs.find((m) => m.direction === 'in').botDecision, 'declined');
      assert.equal(fake.sentTo(d.chat).length, 1, '只有那条外联消息，不回复');
      assert.equal(fake.sentTo(boss.chat).length, bossBefore, '不通知');
      assert.equal(hooks.calls.draft, drafts, '不起草');
      const conv = await getConv(t, convIdOf(acc, d.chat));
      assert.equal(conv.botPaused, true);
      assert.equal(conv.needsHuman, false);
      const rec = await recipientByNumber(id, d.digits);
      assert.ok(rec.repliedAt, '拒绝本身也是回复');
      const c = await getCampaign(id);
      assert.equal(c.stats.declined, 1);
      assert.equal(c.perAccount[0].declined, 1);

      // 后续任务（哪个号都一样）按 already_contacted 跳过
      const acc2 = await wahaAccount();
      const next = await createCampaign(t, { lines: [d.local, `+${d.digits}`], accountIds: [acc2.id] });
      assert.equal(next.body.preview.valid, 0);
      assert.equal(next.body.preview.skipped.already_contacted, 1);
      assert.equal(next.body.preview.skipped.duplicate, 1);
    });

    it('"太贵了"不算拒绝：照常按价格规则转人工，只记 repliedAt', async () => {
      const acc = await wahaAccount({ autoReply: true });
      const n = cnNumber();
      const { id } = await runCampaign({ lines: [n.local], accountIds: [acc.id] });
      await wahaSend(t, acc, n.chat, '太贵了');
      await waitFor(async () => (await getMessages(t, convIdOf(acc, n.chat))).find((m) => m.direction === 'in')?.botDecision);
      const msgs = await getMessages(t, convIdOf(acc, n.chat));
      assert.equal(msgs.find((m) => m.direction === 'in').botDecision, 'handoff');
      const rec = await recipientByNumber(id, n.digits);
      assert.ok(rec.repliedAt);
      assert.equal(rec.declinedAt, null);
      assert.equal((await getConv(t, convIdOf(acc, n.chat))).needsHuman, true);
      assert.equal((await getCampaign(id)).stats.declined, 0);
    });
  });

  describe('权限', () => {
    it('agent 只能选自己的号，只能看到和操作自己建的任务；admin 全部；越权 403', async () => {
      const a = await wahaAccount();
      const b = await wahaAccount();
      const x = await t.addMember({ email: `x${++accSeq}@example.com`, name: '小许', accountIds: [a.id] });
      const y = await t.addMember({ email: `y${++accSeq}@example.com`, name: '小杨', accountIds: [b.id] });
      const n = cnNumber();
      const denied = await createCampaign(t, { lines: [n.local], accountIds: [b.id], cookie: x.cookie });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, 'forbidden');
      assert.equal((await createCampaign(t, { lines: [n.local], mode: 'pooled', accountIds: [a.id, b.id], cookie: x.cookie })).status, 403);
      const mine = await createCampaign(t, { lines: [n.local], accountIds: [a.id], cookie: x.cookie, name: '小许的任务' });
      assert.equal(mine.status, 200);
      const id = mine.body.campaign.id;
      assert.equal(mine.body.campaign.createdBy.name, '小许');
      assert.deepEqual(mine.body.campaign.outreach, DEFAULT_OUTREACH, 'agent 读不到设置，任务里带着');
      assert.equal((await t.req('GET', '/api/settings', { cookie: x.cookie })).status, 403);

      const xList = (await t.req('GET', '/api/campaigns', { cookie: x.cookie })).body;
      assert.deepEqual(xList.map((c) => c.id), [id]);
      assert.equal((await t.req('GET', '/api/campaigns', { cookie: y.cookie })).body.length, 0);
      assert.ok((await t.req('GET', '/api/campaigns')).body.some((c) => c.id === id), 'admin 看得到所有任务');
      assert.equal((await getCampaign(id)).id, id);

      for (const [method, p] of [
        ['GET', `/api/campaigns/${id}`],
        ['GET', `/api/campaigns/${id}/recipients`],
        ['POST', `/api/campaigns/${id}/start`],
        ['POST', `/api/campaigns/${id}/pause`],
        ['POST', `/api/campaigns/${id}/resume`],
        ['POST', `/api/campaigns/${id}/cancel`],
        ['DELETE', `/api/campaigns/${id}`],
      ]) {
        const r = await t.req(method, p, { cookie: y.cookie, body: method === 'POST' ? {} : undefined });
        assert.equal(r.status, 403, `${method} ${p}`);
      }
      assert.equal((await t.req('GET', `/api/campaigns/${id}/recipients`, { cookie: x.cookie })).body.total, 1);
      assert.equal((await t.req('GET', '/api/campaigns/nope', { cookie: x.cookie })).status, 404);
      assert.equal((await t.req('POST', `/api/campaigns/${id}/start`, { cookie: x.cookie, body: {} })).status, 200);
      await settled();
      assert.equal(fake.sentTo(n.chat).length, 1);
      // admin 也能操作 agent 建的任务
      assert.equal((await t.req('DELETE', `/api/campaigns/${id}`)).status, 200);
      assert.equal((await t.req('GET', '/api/campaigns', { auth: false })).status, 401);
    });
  });
});

describe('F11 进程重启后 running 的任务接着发', () => {
  it('第一次启动时都在窗口外，没发；重启后（同一个数据目录）到了窗口内自动接着发', async () => {
    const fake = await startFakeWaha();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-f11-restart-'));
    const env = { INKDOVE_WAHA_URL: fake.url, INKDOVE_DATA_DIR: dir };
    const nums = [cnNumber(), cnNumber()];
    let id;
    let acc;
    try {
      const t1 = await startApp({ env, options: { outreachNow: () => Date.parse('2026-10-12T00:30:00Z') } });
      try {
        await t1.login();
        acc = await t1.createAccount({ name: '重启号' });
        await t1.req('POST', `/api/accounts/${acc.id}/waha/start`);
        const c = await createCampaign(t1, { lines: nums.map((n) => n.local), accountIds: [acc.id] });
        id = c.body.campaign.id;
        await t1.req('POST', `/api/campaigns/${id}/start`, { body: {} });
        await waitFor(() => t1.ctx.outreach.idle());
        assert.equal(fake.state.sent.length, 0);
      } finally {
        await t1.close();
      }
      const t2 = await startApp({ env, options: { outreachNow: () => NOON_CN } });
      try {
        await waitFor(() => fake.state.sent.length === 2, { message: '重启后没有接着发' });
        await waitFor(() => t2.ctx.outreach.idle());
        await t2.login();
        const c = (await t2.req('GET', `/api/campaigns/${id}`)).body;
        assert.equal(c.status, 'done');
        assert.equal(c.stats.sent, 2);
        assert.ok(nums.every((n) => fake.sentTo(n.chat).length === 1));
      } finally {
        await t2.close();
      }
    } finally {
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
