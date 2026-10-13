// F12 管理员数据看板 GET /api/dashboard：直接往库里写一批处理记录、模型调用、转人工、线索和阶段历史、消息、外联、体检数据，
// 时钟注入成固定时刻（createApp 的 dashboardNow），逐字段核对返回：中位数（奇偶个数）、漏斗、autoReplyRate 的分母、
// 按号过滤（kb、cost 不过滤）、tz 分组（跨时区边界）、热力图周一第 0 行、导入消息不计入、单价换算、agent 403、参数校验。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { codeLabel, leadStageLabel, purposeLabel } from '../src/codes.js';
import { countryOfNumber, localDayStart, median, parseDashboardQuery, resolveRange } from '../src/dashboard.js';
import { newId } from '../src/util.js';
import { startApp } from './helpers.js';

// 固定的"现在"：2026-10-14（周三）10:00 UTC，上海是当天 18:00
const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const T1 = '2026-10-13T16:30:00.000Z'; // UTC 10-13 周二 16 点；上海已是 10-14 周三 00:30
const T2 = '2026-10-14T08:00:00.000Z'; // 周三：UTC 8 点，上海 16 点，加尔各答 13:30
const T3 = '2026-10-12T09:40:00.000Z'; // 周一：UTC 9 点，上海 17 点，加尔各答 15:10（按整点的 UTC 桶算会错成 14 点）
const T4 = '2026-10-09T03:00:00.000Z'; // 周五：UTC 3 点，上海 11 点，加尔各答 08:30
const T_EDGE = '2026-10-07T23:00:00.000Z'; // UTC 的 7d 从 10-08 0 点开始，不在内；上海是 10-08 周四 07:00，在内
const T_OLD = '2026-09-20T12:00:00.000Z'; // 30d 内、7d 外
const T_ANCIENT = '2026-08-01T00:00:00.000Z'; // 30d 外
const T_FUTURE = '2026-10-14T11:00:00.000Z'; // 晚于"现在"，不算
const plusMin = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();

const PRICING = [
  { model: 'gpt-x', inputPerMillion: 2, outputPerMillion: 8 },
  { model: 'claude-y', inputPerMillion: 3, outputPerMillion: 15 },
];

let t;
let A;
let B;
let C;
let alice;
let aliceCookie;
let bob;
let adminUser;
const ids = {};

/** GET /api/dashboard，断言 200 并返回 body */
async function dash(query = '') {
  const r = await t.req('GET', `/api/dashboard${query}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function seed() {
  const db = t.ctx.db;

  // ---- 会话 ----
  const conv = (acc, key, { number = '', needsHuman = 0, mutedUntil = null } = {}) => {
    const chatId = number ? `${number}@c.us` : `${key}@lid`;
    const id = `${acc.id}:${chatId}`;
    db.prepare(
      `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, needs_human, muted_until, created_at, updated_at)
       VALUES(?, ?, ?, 'waha', '', ?, ?, ?, ?, ?)`,
    ).run(id, acc.id, chatId, number, needsHuman, mutedUntil, T_ANCIENT, T_ANCIENT);
    return id;
  };
  const cA1 = conv(A, 'a1', { number: '8613800138000', needsHuman: 1 }); // 中国
  const cA2 = conv(A, 'a2', { number: '14155552671', needsHuman: 1 }); // 美国
  const cA3 = conv(A, 'a3', { mutedUntil: plusMin(NOW_ISO, 120) }); // @lid 换算不出号码；还在静默中
  const cA4 = conv(A, 'a4', { number: '8613900139000' }); // 中国，导入过历史聊天的老客户
  const cA5 = conv(A, 'a5', { number: '8613700137000' }); // 只有导入的消息
  const cB1 = conv(B, 'b1', { number: '442071838750', needsHuman: 1, mutedUntil: plusMin(NOW_ISO, -60) }); // 英国；静默已过期
  const cB2 = conv(B, 'b2', { number: '5511987654321' });
  const cC1 = conv(C, 'c1', { number: '8613600136000' });
  const cC2 = conv(C, 'c2', { number: '8613500135000' }); // 最早一条是本时间段内导入的
  Object.assign(ids, { cA1, cA2, cA3, cA4, cA5, cB1, cB2, cC1, cC2 });

  // ---- 消息 ----
  const msg = (convId, ts, { dir = 'in', author, via = null, status, userId = null, userName = null } = {}) =>
    db
      .prepare(
        `INSERT INTO messages(id, conversation_id, direction, author, kind, text, ts, status, handled, via, sent_by_user_id, sent_by_name)
         VALUES(?, ?, ?, ?, 'text', 'x', ?, ?, 1, ?, ?, ?)`,
      )
      .run(newId(), convId, dir, author || (dir === 'in' ? 'customer' : 'bot'), ts, status || (dir === 'in' ? 'received' : 'sent'), via, userId, userName);
  // 客户消息
  msg(cA1, T1);
  msg(cA1, T2);
  msg(cA2, T3);
  msg(cA2, T_FUTURE);
  msg(cA3, T4);
  msg(cA4, '2026-09-01T00:00:00.000Z', { via: 'import' });
  msg(cA4, T2);
  msg(cA5, T3, { via: 'import' });
  msg(cB1, T_EDGE);
  msg(cB1, T2);
  msg(cB2, T_OLD);
  msg(cB2, T2);
  msg(cC2, T4, { via: 'import' });
  msg(cC2, T2);
  // 出站的都不算客户消息
  msg(cA1, T2, { dir: 'out', author: 'bot' });
  msg(cA1, T2, { dir: 'out', author: 'owner', via: 'phone' });
  msg(cA4, '2026-09-01T00:05:00.000Z', { dir: 'out', author: 'owner', via: 'import' });
  // 后台人工消息（成员表 manualMessages）
  const op = (convId, ts, userId, extra = {}) => msg(convId, ts, { dir: 'out', author: 'operator', via: 'admin', userId, ...extra });
  op(cA1, T2, alice.id);
  op(cA1, T3, alice.id);
  op(cB1, T2, alice.id);
  op(cA1, T2, alice.id, { status: 'failed' }); // 没发出去的不算
  op(cA1, T_OLD, alice.id); // 7d 外
  op(cA2, T4, adminUser.id);
  op(cA2, T3, 'ghost-user', { userName: '老王' }); // 已经删掉的成员
  msg(cA1, T2, { dir: 'out', author: 'operator', via: 'whatsapp' }); // F3 转发，不算任何人的后台消息

  // ---- 知识库条目、文件、缺口 ----
  const entry = (id, type, title, status = 'active') =>
    db
      .prepare(
        `INSERT INTO entries(id, type, title, content, status, origin, created_at, updated_at) VALUES(?, ?, ?, '内容', ?, 'manual', ?, ?)`,
      )
      .run(id, type, title, status, T_ANCIENT, T_ANCIENT);
  entry('e1', 'faq', '退货政策');
  entry('eP', 'product', 'A 型号水泵');
  entry('e3', 'faq', '发货时间');
  entry('e4', 'faq', '保修');
  entry('e5', 'faq', '付款方式');
  entry('e6', 'faq', '公司介绍');
  entry('eOff', 'product', '停用的产品', 'disabled');
  const file = (id, name) =>
    db
      .prepare(
        `INSERT INTO files(id, name, filename, mime, size, description_status, created_at, updated_at)
         VALUES(?, ?, ?, 'application/pdf', 100, 'done', ?, ?)`,
      )
      .run(id, name, `${name}.pdf`, T_ANCIENT, T_ANCIENT);
  file('f1', '产品目录');
  file('f2', '价目表');
  const gap = (id, question, status = 'open') =>
    db
      .prepare(`INSERT INTO gaps(id, question, status, origin, count, created_at) VALUES(?, ?, ?, 'conversation', 1, ?)`)
      .run(id, question, status, T_ANCIENT);
  gap('g1', '有没有现货');
  gap('g2', '能开发票吗');
  gap('g3', '支持哪些付款方式', 'answered');
  const hit = (gapId, ts) => db.prepare('INSERT INTO gap_hits(gap_id, conversation_id, ts) VALUES(?, NULL, ?)').run(gapId, ts);
  [T2, T1, T3].forEach((ts) => hit('g1', ts));
  hit('g2', T4);
  hit('g2', T_OLD);
  hit('g3', T2);
  hit('g3', T2);

  // ---- 处理记录 ----
  const dec = (acc, convId, decision, code, ts, used = [], files = []) =>
    t.ctx.records.decision({ ts, accountId: acc?.id ?? null, conversationId: convId, decision, code, usedEntryIds: used, sentFileIds: files });
  dec(A, cA1, 'replied', 'business', T2, ['e1', 'eP'], ['f1']); // d1
  dec(A, cA1, 'replied', 'business', T1, ['e1'], ['f1', 'f2', 'gone-file']); // d2
  dec(A, cA2, 'handoff', 'price', T3); // d3
  dec(A, cA2, 'blocked', 'price_mismatch', T4, ['e5']); // d4：拦截的回复引用的条目也算"被引用过"
  dec(B, cB1, 'handoff', 'insufficient_info', T2); // d5
  dec(B, cB1, 'offtopic', 'chitchat', T2); // d6
  dec(A, cA3, 'offtopic', 'muted', T3); // d7
  dec(A, cA3, 'declined', 'declined', T3); // d8：不进 turns、趋势和回复率
  dec(B, cB2, 'replied', 'smalltalk', T_EDGE, ['eP']); // d9
  dec(A, cA1, 'replied', 'business', T_OLD, ['e3']); // d10
  dec(A, cA1, 'handoff', 'other', T_ANCIENT, ['e4']); // d11：30 天前引用的不算
  dec(A, cA1, 'blocked', 'canary', T2); // d12
  dec(C, cC1, 'offtopic', 'task', T2); // d13
  dec(A, cA2, 'handoff', 'price', T4); // d14
  dec(A, cA2, 'handoff', 'other', T3); // d15
  dec(A, cA2, 'offtopic', 'other', T3); // d16：和 handoff 的 other 分开算
  dec(A, cA1, 'replied', 'business', T_FUTURE, ['e1']); // d17：晚于现在

  // ---- 模型调用 ----
  const call = (purpose, model, input, output, ts, acc) =>
    t.ctx.records.llmCall({ ts, purpose, format: 'openai', model, inputTokens: input, outputTokens: output, ok: true, accountId: acc?.id ?? null });
  call('reply', 'gpt-x', 1000, 500, T2, A); // $0.006
  call('reply', 'gpt-x', 3000, 1000, T3, B); // $0.014
  call('review', 'claude-y', 2000, 100, T2, A); // $0.0075
  call('distill', 'claude-y', 10000, 2000, T4, null); // $0.06，不属于任何号
  call('media', 'whisper-1', null, null, T2, A); // 没单价、没 token
  call('reply', 'local-llm', 500, 500, T4, A); // 没单价
  call('redteam', 'gpt-x', 100, 100, T_ANCIENT, null); // 30d 外
  call('leads', 'gpt-x', 400, 100, T_FUTURE, A); // 晚于现在
  t.ctx.updateSettings((s) => {
    s.pricing = PRICING;
  });

  // ---- 转人工记录 ----
  const ho = (acc, convId, started, minutes, kind = null, userId = null) =>
    db
      .prepare(
        `INSERT INTO handoffs(id, conversation_id, account_id, code, started_at, first_response_at, first_responder_user_id, first_responder_kind)
         VALUES(?, ?, ?, 'price', ?, ?, ?, ?)`,
      )
      .run(newId(), convId, acc.id, started, minutes == null ? null : plusMin(started, minutes), userId, kind);
  ho(A, cA1, T4, 10, 'admin_ui', alice.id); // h1
  ho(A, cA2, T3, 20, 'admin_ui', alice.id); // h2
  ho(B, cB1, plusMin(T2, -60), 30, 'admin_ui', alice.id); // h3
  ho(A, cA3, T3, 5, 'phone'); // h4
  ho(A, cA1, T1, 15, 'phone'); // h5
  ho(A, cA2, T4, 7, 'whatsapp_relay'); // h6
  ho(A, cA1, T2, null); // h7：还没人回
  ho(B, cB2, T_OLD, 100, 'admin_ui', bob.id); // h8：7d 外
  ho(A, cA2, T3, 40, 'admin_ui', 'ghost-user'); // h9
  ho(B, cB1, T_EDGE, 50, 'admin_ui', bob.id); // h10：UTC 7d 外，上海 7d 内

  // ---- 客户线索和阶段历史 ----
  const lead = (id, convId, acc, stage, history) => {
    db.prepare(`INSERT INTO leads(id, conversation_id, account_id, stage, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)`).run(
      id,
      convId,
      acc.id,
      stage,
      T_ANCIENT,
      T_ANCIENT,
    );
    history.forEach((s, i) =>
      db.prepare('INSERT INTO lead_stage_history(lead_id, stage, ts) VALUES(?, ?, ?)').run(id, s, plusMin(T_ANCIENT, i)),
    );
  };
  lead('L1', cA1, A, 'negotiation', ['inquiry', 'sample', 'negotiation']);
  lead('L2', cA2, A, 'inquiry', ['inquiry', 'order_intent', 'inquiry']); // 到过 order_intent 又退回来
  lead('L3', cA3, A, 'after_sales', ['after_sales']); // 不进漏斗
  lead('L4', cB1, B, 'sample', []); // 没有历史，按当前阶段算
  lead('L5', cA4, A, 'other', ['inquiry', 'other']);
  db.prepare("INSERT INTO lead_stage_history(lead_id, stage, ts) VALUES('gone-lead', 'order_intent', ?)").run(T2); // 删掉的线索

  // ---- 外联收件人 ----
  const rcp = (accId, status, sentAt, { replied = null, declined = null } = {}) =>
    db
      .prepare(
        `INSERT INTO campaign_recipients(id, campaign_id, seq, line, number, account_id, status, sent_at, replied_at, declined_at)
         VALUES(?, 'camp', 0, 1, '8613800000000', ?, ?, ?, ?, ?)`,
      )
      .run(newId(), accId, status, sentAt, replied, declined);
  rcp(A.id, 'sent', T2, { replied: plusMin(T2, 5) });
  rcp(A.id, 'sent', T3, { replied: plusMin(T3, 5), declined: plusMin(T3, 5) });
  rcp(A.id, 'sent', T4);
  rcp(B.id, 'sent', T2);
  rcp(A.id, 'failed', null);
  rcp(A.id, 'skipped', null);
  rcp(A.id, 'sent', T_OLD, { replied: plusMin(T_OLD, 5) });
  rcp('acc-gone', 'sent', T3);

  // ---- 红线体检 ----
  const run = (id, status, finishedAt, summary) =>
    db
      .prepare(`INSERT INTO redteam_runs(id, status, progress, summary, started_at, finished_at) VALUES(?, ?, '{}', ?, ?, ?)`)
      .run(id, status, JSON.stringify(summary), T_ANCIENT, finishedAt);
  run('r1', 'done', '2026-10-10T00:00:00.000Z', { redlineFailed: 5, legitRefused: 0 });
  run('r2', 'done', '2026-10-13T00:00:00.000Z', { total: 36, redlinePassed: 29, redlineFailed: 2, legitReplied: 4, legitRefused: 1 });
  run('r3', 'failed', '2026-10-14T01:00:00.000Z', { redlineFailed: 9, legitRefused: 9 });
  run('r4', 'cancelled', '2026-10-14T02:00:00.000Z', { redlineFailed: 9, legitRefused: 9 });
}

before(async () => {
  t = await startApp({ options: { dashboardNow: () => NOW } });
  await t.login();
  A = await t.createAccount({ name: '号 A' });
  B = await t.createAccount({ name: '号 B' });
  C = await t.createAccount({ name: '号 C' });
  const a = await t.addMember({ email: 'alice@example.com', name: 'Alice', accountIds: [A.id] });
  alice = a.user;
  aliceCookie = a.cookie;
  bob = (await t.addMember({ email: 'bob@example.com', name: 'Bob', accountIds: [B.id] })).user;
  adminUser = t.ctx.db.prepare("SELECT id, name, email FROM users WHERE role = 'admin'").get();
  seed();
});

after(() => t?.close());

describe('看板：权限和参数', () => {
  it('agent 调用返回 403，未登录 401', async () => {
    const r = await t.req('GET', '/api/dashboard?range=7d', { cookie: aliceCookie });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
    const anon = await t.req('GET', '/api/dashboard', { auth: false });
    assert.equal(anon.status, 401);
  });

  it('range 非法 400；tz 不是可用的时区 400', async () => {
    for (const q of ['?range=1y', '?range=', '?range=7d&range=30d']) {
      const r = await t.req('GET', `/api/dashboard${q}`);
      if (q === '?range=') {
        assert.equal(r.status, 200); // 空值按默认 7d
        continue;
      }
      assert.equal(r.status, 400, q);
      assert.equal(r.body.code, 'invalid_range');
    }
    for (const tz of ['Mars/Base', 'x'.repeat(101), 'UTC+99']) {
      const r = await t.req('GET', `/api/dashboard?tz=${encodeURIComponent(tz)}`);
      assert.equal(r.status, 400, tz);
      assert.equal(r.body.code, 'invalid_tz');
    }
  });

  it('不带 range 按 7d、不带 tz 按 UTC；tz 规范成标准写法', async () => {
    const d = await dash();
    assert.deepEqual(d.range, { from: '2026-10-08T00:00:00.000Z', to: NOW_ISO, tz: 'UTC' });
    assert.equal(d.trend.length, 7);
    const s = await dash('?range=today&tz=asia/shanghai');
    assert.deepEqual(s.range, { from: '2026-10-13T16:00:00.000Z', to: NOW_ISO, tz: 'Asia/Shanghai' });
    const m = await dash('?range=30d&tz=UTC');
    assert.equal(m.range.from, '2026-09-15T00:00:00.000Z');
    assert.equal(m.trend.length, 30);
    assert.equal(m.trend[0].date, '2026-09-15');
    assert.equal(m.trend[29].date, '2026-10-14');
    // accountId 为空等于全部号
    assert.deepEqual(await dash('?range=7d&tz=UTC&accountId='), await dash('?range=7d&tz=UTC'));
  });

  it('parseDashboardQuery', () => {
    assert.deepEqual(parseDashboardQuery({}), { range: '7d', tz: 'UTC', accountId: null });
    assert.deepEqual(parseDashboardQuery({ range: '30d', tz: 'Europe/London', accountId: 'abc' }), {
      range: '30d',
      tz: 'Europe/London',
      accountId: 'abc',
    });
    assert.throws(() => parseDashboardQuery({ accountId: ['a', 'b'] }), /accountId/);
  });
});

describe('看板：KPI 和按号筛选', () => {
  it('7d（UTC）全部号', async () => {
    const d = await dash('?range=7d&tz=UTC');
    assert.deepEqual(d.kpi, {
      // cA1 两条、cA2、cA3、cA4（导入的不算）、cB1（T_EDGE 在范围外）、cB2、cC2 各一条；晚于现在的不算
      inboundMessages: 8,
      // cA1、cA2、cA3；cA4、cC2 最早的一条是导入的（老客户），cB1、cB2 的第一条在范围外
      newCustomers: 3,
      // 2 ÷ (2 + 4 + 2)，离题和拒绝不进分母
      autoReplyRate: 0.25,
      turns: { replied: 2, handoff: 4, blocked: 2, offtopic: 4 },
      handoffs: 8,
      openNeedsHuman: 3,
      // 5 7 10 15 20 30 40（奇数个），没人回的 h7 不算
      medianResponseMinutes: 15,
    });
  });

  it('按号筛选（A：中位数偶数个；B；C：分母为 0 时 null）', async () => {
    const a = await dash(`?range=7d&tz=UTC&accountId=${A.id}`);
    assert.deepEqual(a.kpi, {
      inboundMessages: 5,
      newCustomers: 3,
      autoReplyRate: 2 / 7,
      turns: { replied: 2, handoff: 3, blocked: 2, offtopic: 2 },
      handoffs: 7,
      openNeedsHuman: 2,
      // 5 7 10 15 20 40 → (10 + 15) / 2
      medianResponseMinutes: 12.5,
    });
    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(b.kpi, {
      inboundMessages: 2,
      newCustomers: 0,
      autoReplyRate: 0,
      turns: { replied: 0, handoff: 1, blocked: 0, offtopic: 1 },
      handoffs: 1,
      openNeedsHuman: 1,
      medianResponseMinutes: 30,
    });
    const c = await dash(`?range=7d&tz=UTC&accountId=${C.id}`);
    assert.deepEqual(c.kpi, {
      inboundMessages: 1,
      newCustomers: 0, // cC2 最早的一条是导入的，本时间段内的那条导入消息也算"更早"
      autoReplyRate: null,
      turns: { replied: 0, handoff: 0, blocked: 0, offtopic: 1 },
      handoffs: 0,
      openNeedsHuman: 0,
      medianResponseMinutes: null,
    });
    // 删掉的号也能筛（数据还在），没有数据时都是 0
    const gone = await dash('?range=7d&tz=UTC&accountId=acc-gone');
    assert.equal(gone.kpi.inboundMessages, 0);
    assert.equal(gone.outreach.sent, 1);
    assert.deepEqual(gone.accounts, []);
  });

  it('上海时区：时间段从当地 0 点开始，跨日的消息归到当地日期', async () => {
    const d = await dash('?range=7d&tz=Asia/Shanghai');
    assert.equal(d.range.from, '2026-10-07T16:00:00.000Z');
    // 多了 cB1 在 T_EDGE 的那条，cB1 也成了新客户；多了 d9 的回复和 h10
    assert.equal(d.kpi.inboundMessages, 9);
    assert.equal(d.kpi.newCustomers, 4);
    assert.deepEqual(d.kpi.turns, { replied: 3, handoff: 4, blocked: 2, offtopic: 4 });
    assert.equal(d.kpi.autoReplyRate, 3 / 9);
    assert.equal(d.kpi.handoffs, 9);
    assert.equal(d.kpi.medianResponseMinutes, 17.5); // 5 7 10 15 20 30 40 50
    const b = await dash(`?range=7d&tz=Asia/Shanghai&accountId=${B.id}`);
    assert.equal(b.kpi.inboundMessages, 3);
    assert.equal(b.kpi.newCustomers, 1);
    assert.equal(b.kpi.autoReplyRate, 0.5);
    assert.equal(b.kpi.medianResponseMinutes, 40); // 30、50
  });

  it('今天：UTC 和上海的"今天"不一样', async () => {
    const u = await dash('?range=today&tz=UTC');
    assert.equal(u.range.from, '2026-10-14T00:00:00.000Z');
    assert.equal(u.kpi.inboundMessages, 5);
    assert.equal(u.kpi.newCustomers, 0); // cA1 的第一条（T1）在 UTC 昨天
    assert.deepEqual(u.kpi.turns, { replied: 1, handoff: 1, blocked: 1, offtopic: 2 });
    assert.equal(u.kpi.handoffs, 2);
    assert.deepEqual(
      u.trend.map((x) => x.date),
      ['2026-10-14'],
    );
    const s = await dash('?range=today&tz=Asia/Shanghai');
    assert.equal(s.kpi.inboundMessages, 6);
    assert.equal(s.kpi.newCustomers, 1); // T1 在上海已经是今天
    assert.deepEqual(s.kpi.turns, { replied: 2, handoff: 1, blocked: 1, offtopic: 2 });
    assert.equal(s.kpi.handoffs, 3);
  });

  it('30d：新客户按会话第一条客户消息，导入过历史的不算', async () => {
    const d = await dash('?range=30d&tz=UTC');
    assert.equal(d.kpi.inboundMessages, 10);
    assert.equal(d.kpi.newCustomers, 5); // cA1 cA2 cA3 cB1 cB2；cA4、cA5、cC2 不算
  });

  it('handoffReasons 只取 handoff 和 blocked，按 (decision, code) 计数并带 decision', async () => {
    const d = await dash('?range=7d&tz=UTC');
    const r = (code, decision, count) => ({ code, label: codeLabel(decision, code), decision, count });
    assert.deepEqual(d.handoffReasons, [
      r('price', 'handoff', 2),
      r('canary', 'blocked', 1),
      r('insufficient_info', 'handoff', 1),
      r('other', 'handoff', 1),
      r('price_mismatch', 'blocked', 1),
    ]);
    assert.equal(d.handoffReasons[3].label, '其他原因');
    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(b.handoffReasons, [r('insufficient_info', 'handoff', 1)]);
  });
});

describe('看板：趋势和热力图（按 tz）', () => {
  const day = (date, replied = 0, handoff = 0, blocked = 0, offtopic = 0) => ({ date, replied, handoff, blocked, offtopic });
  /** 7×24 的零矩阵，cells 里 [row, col, n] 填上 */
  const grid = (cells) => {
    const g = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const [r, c, n] of cells) g[r][c] = n;
    return g;
  };

  it('trend：UTC 和上海对同一批记录分日不同', async () => {
    const u = await dash('?range=7d&tz=UTC');
    assert.deepEqual(u.trend, [
      day('2026-10-08'),
      day('2026-10-09', 0, 1, 1, 0),
      day('2026-10-10'),
      day('2026-10-11'),
      day('2026-10-12', 0, 2, 0, 2),
      day('2026-10-13', 1),
      day('2026-10-14', 1, 1, 1, 2),
    ]);
    const s = await dash('?range=7d&tz=Asia/Shanghai');
    assert.deepEqual(s.trend, [
      day('2026-10-08', 1), // d9（UTC 10-07 23:00）
      day('2026-10-09', 0, 1, 1, 0),
      day('2026-10-10'),
      day('2026-10-11'),
      day('2026-10-12', 0, 2, 0, 2),
      day('2026-10-13'), // T1 的回复在上海是 10-14
      day('2026-10-14', 2, 1, 1, 2),
    ]);
  });

  it('heatmap：7 行 × 24 列，周一第 0 行，按 tz 的星期和小时；导入的消息不计入', async () => {
    const u = await dash('?range=7d&tz=UTC');
    // 周一 9 点 cA2（cA5 同一时刻的导入消息不算）；周二 16 点 cA1；周三 8 点五条；周五 3 点 cA3（cC2 的导入消息不算）
    assert.deepEqual(u.heatmap, grid([[0, 9, 1], [1, 16, 1], [2, 8, 5], [4, 3, 1]]));
    const s = await dash('?range=7d&tz=Asia/Shanghai');
    assert.deepEqual(s.heatmap, grid([[0, 17, 1], [2, 0, 1], [2, 16, 5], [3, 7, 1], [4, 11, 1]]));
    // 加尔各答 +05:30：半小时偏移要按 15 分钟的桶换算，T3 是当地 15:10
    const k = await dash('?range=7d&tz=Asia/Kolkata');
    assert.equal(k.range.from, '2026-10-07T18:30:00.000Z');
    assert.deepEqual(k.heatmap, grid([[0, 15, 1], [1, 22, 1], [2, 13, 5], [3, 4, 1], [4, 8, 1]]));
    const a = await dash(`?range=7d&tz=UTC&accountId=${A.id}`);
    assert.deepEqual(a.heatmap, grid([[0, 9, 1], [1, 16, 1], [2, 8, 2], [4, 3, 1]]));
  });
});

describe('看板：知识库（不按号筛选）', () => {
  it('topGaps、topEntries、unusedEntries、lastRedteam、topFiles', async () => {
    const d = await dash('?range=7d&tz=UTC');
    assert.deepEqual(d.kb, {
      // g3 已经回答过，不列
      topGaps: [
        { gapId: 'g1', question: '有没有现货', count: 3 },
        { gapId: 'g2', question: '能开发票吗', count: 1 },
      ],
      // 只数 replied 的引用：d1（e1、eP）、d2（e1）
      topEntries: [
        { entryId: 'e1', title: '退货政策', count: 2 },
        { entryId: 'eP', title: 'A 型号水泵', count: 1 },
      ],
      // 启用中的 6 条里，e4（只在 30 天前被引用过）和 e6 没被引用过
      unusedEntries: 2,
      activeEntries: 6,
      // 最近一次 done 的（failed、cancelled 的不算）
      lastRedteam: { runId: 'r2', finishedAt: '2026-10-13T00:00:00.000Z', redlineFailed: 2, legitRefused: 1 },
      // decisions.sentFileIds：d1 f1，d2 f1 f2（已删的文件不列）
      topFiles: [
        { fileId: 'f1', name: '产品目录', count: 2 },
        { fileId: 'f2', name: '价目表', count: 1 },
      ],
    });
    // 选了号也一样
    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(b.kb, d.kb);
    const m = await dash('?range=30d&tz=UTC');
    assert.deepEqual(
      m.kb.topGaps.map((g) => g.count),
      [3, 2],
    );
    // 30d 多了 d9（eP）和 d10（e3）；同数按标题排
    assert.deepEqual(
      m.kb.topEntries.map((e) => [e.entryId, e.count]),
      [
        ['eP', 2],
        ['e1', 2],
        ['e3', 1],
      ],
    );
  });
});

describe('看板：客户线索', () => {
  it('stages、funnel、countries 是当前线索；products 按时间段的回复', async () => {
    const d = await dash('?range=7d&tz=UTC');
    const st = (stage, count) => ({ stage, label: leadStageLabel(stage), count });
    const fn = (stage, reached) => ({ stage, label: leadStageLabel(stage), reached });
    assert.deepEqual(d.leads, {
      stages: [st('inquiry', 1), st('sample', 1), st('negotiation', 1), st('order_intent', 0), st('after_sales', 1), st('other', 1)],
      // L1 到过 negotiation，L2 到过 order_intent（又退回 inquiry），L4 只有当前阶段 sample，L5 到过 inquiry，L3 只有售后
      funnel: [fn('inquiry', 4), fn('sample', 3), fn('negotiation', 2), fn('order_intent', 1)],
      // @lid 换算不出号码的归"未知"；同数时未知排最后
      countries: [
        { code: 'CN', name: '中国', count: 2 },
        { code: 'GB', name: '英国', count: 1 },
        { code: 'US', name: '美国', count: 1 },
        { code: null, name: '未知', count: 1 },
      ],
      products: [{ entryId: 'eP', title: 'A 型号水泵', count: 1 }],
    });
    const s = await dash('?range=7d&tz=Asia/Shanghai');
    assert.deepEqual(s.leads.products, [{ entryId: 'eP', title: 'A 型号水泵', count: 2 }]);
    assert.deepEqual(s.leads.funnel, d.leads.funnel);

    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(
      b.leads.stages.map((x) => x.count),
      [0, 1, 0, 0, 0, 0],
    );
    assert.deepEqual(
      b.leads.funnel.map((x) => x.reached),
      [1, 1, 0, 0],
    );
    assert.deepEqual(b.leads.countries, [{ code: 'GB', name: '英国', count: 1 }]);
    assert.deepEqual(b.leads.products, []);
    const bs = await dash(`?range=7d&tz=Asia/Shanghai&accountId=${B.id}`);
    assert.deepEqual(bs.leads.products, [{ entryId: 'eP', title: 'A 型号水泵', count: 1 }]);
  });

  it('countryOfNumber', () => {
    assert.equal(countryOfNumber('8613800138000'), 'CN');
    assert.equal(countryOfNumber('5511987654321'), 'BR');
    assert.equal(countryOfNumber(''), null);
    assert.equal(countryOfNumber('80012345678'), null);
  });
});

describe('看板：成员', () => {
  it('按首次回复人统计，外加手机回复和 WhatsApp 转发两行', async () => {
    const d = await dash('?range=7d&tz=UTC');
    assert.deepEqual(d.members, [
      { userId: adminUser.id, name: adminUser.name || adminUser.email, kind: 'user', handled: 0, medianResponseMinutes: null, manualMessages: 1 },
      // h1 10、h2 20、h3 30；后台消息 cA1 两条 + cB1 一条（失败的和 7d 外的不算）
      { userId: alice.id, name: 'Alice', kind: 'user', handled: 3, medianResponseMinutes: 20, manualMessages: 3 },
      { userId: bob.id, name: 'Bob', kind: 'user', handled: 0, medianResponseMinutes: null, manualMessages: 0 },
      // 已经删掉的成员，名字取消息上记的发送人
      { userId: 'ghost-user', name: '老王', kind: 'user', handled: 1, medianResponseMinutes: 40, manualMessages: 1 },
      { userId: null, name: '手机回复', kind: 'phone', handled: 2, medianResponseMinutes: 10, manualMessages: null },
      { userId: null, name: 'WhatsApp 转发', kind: 'relay', handled: 1, medianResponseMinutes: 7, manualMessages: null },
    ]);
    const a = await dash(`?range=7d&tz=UTC&accountId=${A.id}`);
    const aliceA = a.members.find((m) => m.userId === alice.id);
    assert.deepEqual(aliceA, { userId: alice.id, name: 'Alice', kind: 'user', handled: 2, medianResponseMinutes: 15, manualMessages: 2 });
    const s = await dash('?range=7d&tz=Asia/Shanghai');
    const bobS = s.members.find((m) => m.userId === bob.id);
    assert.equal(bobS.handled, 1);
    assert.equal(bobS.medianResponseMinutes, 50);
  });
});

describe('看板：成本', () => {
  it('token × 单价；没配单价的模型所在用途 costUsd 为 null，总费用只算配了的', async () => {
    const d = await dash('?range=7d&tz=UTC');
    const p = (purpose, calls, inputTokens, outputTokens, costUsd) => ({ purpose, label: purposeLabel(purpose), calls, inputTokens, outputTokens, costUsd });
    assert.deepEqual(d.cost, {
      calls: 6,
      inputTokens: 16500,
      outputTokens: 4100,
      // 0.006 + 0.014 + 0.0075 + 0.06
      estimatedCostUsd: 0.0875,
      byPurpose: [
        p('reply', 3, 4500, 2000, null), // 有一次是没配单价的 local-llm
        p('review', 1, 2000, 100, 0.0075),
        p('distill', 1, 10000, 2000, 0.06),
        p('media', 1, null, null, null), // 没有用量：token 为 null
      ],
    });
  });

  it('按号筛选时只筛和号有关的调用，不属于任何号的照算', async () => {
    const a = await dash(`?range=7d&tz=UTC&accountId=${A.id}`);
    assert.equal(a.cost.calls, 5);
    assert.equal(a.cost.inputTokens, 13500);
    assert.equal(a.cost.outputTokens, 3100);
    assert.equal(a.cost.estimatedCostUsd, 0.0735);
    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(b.cost.byPurpose, [
      { purpose: 'reply', label: purposeLabel('reply'), calls: 1, inputTokens: 3000, outputTokens: 1000, costUsd: 0.014 },
      { purpose: 'distill', label: purposeLabel('distill'), calls: 1, inputTokens: 10000, outputTokens: 2000, costUsd: 0.06 },
    ]);
    assert.equal(b.cost.estimatedCostUsd, 0.074);
  });

  it('一个单价都没配时 estimatedCostUsd 和各用途 costUsd 都是 null', async () => {
    t.ctx.updateSettings((s) => {
      s.pricing = [];
    });
    try {
      const d = await dash('?range=7d&tz=UTC');
      assert.equal(d.cost.estimatedCostUsd, null);
      assert.ok(d.cost.byPurpose.every((x) => x.costUsd === null));
      assert.equal(d.cost.inputTokens, 16500);
    } finally {
      t.ctx.updateSettings((s) => {
        s.pricing = PRICING;
      });
    }
  });
});

describe('看板：挡掉的白嫖、外联、号码表', () => {
  it('abuse', async () => {
    const d = await dash('?range=7d&tz=UTC');
    const x = (decision, code, count) => ({ code, label: codeLabel(decision, code), count });
    assert.deepEqual(d.abuse, {
      offtopic: [x('offtopic', 'chitchat', 1), x('offtopic', 'muted', 1), x('offtopic', 'other', 1), x('offtopic', 'task', 1)],
      blocked: [x('blocked', 'canary', 1), x('blocked', 'price_mismatch', 1)],
      // 实时：cA3 还在静默中，cB1 的静默已过期
      mutedConversations: 1,
    });
    assert.equal(d.abuse.offtopic[2].label, '其他离题');
    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(b.abuse, { offtopic: [x('offtopic', 'chitchat', 1)], blocked: [], mutedConversations: 0 });
  });

  it('outreach：本时间段内发出的，回复率、拒绝率按这些人算', async () => {
    const d = await dash('?range=7d&tz=UTC');
    assert.equal(d.outreach.sent, 5);
    assert.equal(d.outreach.replied, 2);
    assert.equal(d.outreach.replyRate, 0.4);
    assert.equal(d.outreach.declined, 1);
    assert.equal(d.outreach.declineRate, 0.2);
    assert.deepEqual(d.outreach.byAccount[0], { accountId: A.id, name: '号 A', sent: 3, replied: 2, declined: 1 });
    assert.deepEqual(
      d.outreach.byAccount.slice(1).sort((x, y) => x.name.localeCompare(y.name)),
      [
        { accountId: 'acc-gone', name: '（已删除）', sent: 1, replied: 0, declined: 0 },
        { accountId: B.id, name: '号 B', sent: 1, replied: 0, declined: 0 },
      ].sort((x, y) => x.name.localeCompare(y.name)),
    );
    const b = await dash(`?range=7d&tz=UTC&accountId=${B.id}`);
    assert.deepEqual(b.outreach, {
      sent: 1,
      replied: 0,
      replyRate: 0,
      declined: 0,
      declineRate: 0,
      byAccount: [{ accountId: B.id, name: '号 B', sent: 1, replied: 0, declined: 0 }],
    });
    const c = await dash(`?range=7d&tz=UTC&accountId=${C.id}`);
    assert.deepEqual(c.outreach, { sent: 0, replied: 0, replyRate: null, declined: 0, declineRate: null, byAccount: [] });
  });

  it('accounts：每个号的客户消息、自动回复率、待处理', async () => {
    const d = await dash('?range=7d&tz=UTC');
    assert.deepEqual(
      d.accounts.map(({ state, ...rest }) => {
        assert.equal(typeof state, 'string');
        return rest;
      }),
      [
        { id: A.id, name: '号 A', inbound: 5, autoReplyRate: 2 / 7, openNeedsHuman: 2 },
        { id: B.id, name: '号 B', inbound: 2, autoReplyRate: 0, openNeedsHuman: 1 },
        { id: C.id, name: '号 C', inbound: 1, autoReplyRate: null, openNeedsHuman: 0 },
      ],
    );
    const a = await dash(`?range=7d&tz=UTC&accountId=${A.id}`);
    assert.deepEqual(
      a.accounts.map((x) => x.id),
      [A.id],
    );
  });
});

describe('看板：时间段换算和中位数', () => {
  it('夏令时：纽约 7d 跨过 11 月 1 日回拨，第一天的 0 点还是夏令时', () => {
    const r = resolveRange('7d', 'America/New_York', Date.parse('2026-11-03T15:00:00.000Z'));
    assert.equal(r.from, '2026-10-28T04:00:00.000Z');
    assert.deepEqual(r.dates, ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    // 回拨当天 0 点（EDT）和第二天 0 点（EST）
    assert.equal(new Date(localDayStart(2026, 11, 1, 'America/New_York')).toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(new Date(localDayStart(2026, 11, 2, 'America/New_York')).toISOString(), '2026-11-02T05:00:00.000Z');
    // 跨月、跨年
    const y = resolveRange('7d', 'UTC', Date.parse('2027-01-02T01:00:00.000Z'));
    assert.deepEqual(y.dates[0], '2026-12-27');
    const k = resolveRange('today', 'Asia/Kolkata', NOW);
    assert.equal(k.from, '2026-10-13T18:30:00.000Z');
  });

  it('median：奇数个取中间，偶数个取中间两个的平均，空数组 null', () => {
    assert.equal(median([30, 10, 20]), 20);
    assert.equal(median([40, 10, 20, 30]), 25);
    assert.equal(median([1, 2]), 1.5);
    assert.equal(median([]), null);
  });
});
