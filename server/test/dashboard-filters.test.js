// 看板的平均回复时间（客户等人工回复的每一轮）和按业务员筛选（assigneeId，按会话现在的负责人）。
// 直接往库里写消息、处理记录、转人工、线索、草稿、外联，时钟注入成固定时刻，逐项核对：
// 一轮怎么切（客户连发算一轮、机器人先回的不算、导入的和外联群发不进这一串、发送失败的不算回复、撤回的照算、
// 手机和 WhatsApp 转发算人工回复）、平均和中位、跨时间段、成员表每人一列；按业务员、未分配、和按号一起筛时各块的数；
// 改派后历史跟着会话走；草稿列表按业务员筛；参数校验；agent 403。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseDashboardQuery, replyTurns, summarizeReplyTurns } from '../src/dashboard.js';
import { newId } from '../src/util.js';
import { startApp } from './helpers.js';

// 固定的"现在"：2026-10-14（周三）10:00 UTC。UTC 的 7d 从 10-08 0 点开始，上海的从 10-07 16:00Z 开始
const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const at = (s) => `2026-${s}:00.000Z`; // at('10-10T09:00') → 2026-10-10T09:00:00.000Z

let t;
let A;
let B;
let alice;
let aliceCookie;
let bob;
let adminUser;
const c = {};

/** GET /api/dashboard，默认 range=7d、tz=UTC；query 是 &a=b 这样追加的参数（同名的覆盖默认值） */
async function dash(query = '') {
  const q = new URLSearchParams({ range: '7d', tz: 'UTC' });
  for (const [k, v] of new URLSearchParams(query)) q.set(k, v);
  const r = await t.req('GET', `/api/dashboard?${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const pick = (k) => ({ avgReplyMinutes: k.avgReplyMinutes, medianReplyMinutes: k.medianReplyMinutes, replyTurns: k.replyTurns, unrepliedTurns: k.unrepliedTurns });

function seed() {
  const db = t.ctx.db;
  const conv = (acc, key, assignee, { needsHuman = 0, mutedUntil = null } = {}) => {
    const id = `${acc.id}:${key}@c.us`;
    db.prepare(
      `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, needs_human, muted_until, assignee_id, created_at, updated_at)
       VALUES(?, ?, ?, 'waha', '', ?, ?, ?, ?, ?, ?)`,
    ).run(id, acc.id, `${key}@c.us`, key, needsHuman, mutedUntil, assignee, at('08-01T00:00'), at('08-01T00:00'));
    return id;
  };
  c.c1 = conv(A, '8613800000001', alice.id);
  c.c2 = conv(A, '8613800000002', bob.id, { needsHuman: 1 });
  c.c3 = conv(B, '8613800000003', null, { needsHuman: 1, mutedUntil: at('10-15T00:00') });
  c.c4 = conv(A, '8613800000004', alice.id);
  c.c6 = conv(A, '8613800000006', alice.id);

  const msg = (convId, ts, { dir = 'in', author, via = null, status, userId = null, userName = null, revokedAt = null } = {}) =>
    db
      .prepare(
        `INSERT INTO messages(id, conversation_id, direction, author, kind, text, ts, status, handled, via, sent_by_user_id, sent_by_name, revoked_at)
         VALUES(?, ?, ?, ?, 'text', 'x', ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(newId(), convId, dir, author || (dir === 'in' ? 'customer' : 'bot'), ts, status || (dir === 'in' ? 'received' : 'sent'), via, userId, userName, revokedAt);
  const admin = (convId, ts, user, extra = {}) =>
    msg(convId, ts, { dir: 'out', author: 'operator', via: 'admin', userId: user.id, userName: user.name, ...extra });

  // c1（A，Alice）：客户连发两条，30 分钟后 Alice 回 → 30（从第一条算）；机器人先回的那轮不算；
  // 发送失败的不算回复，20 分钟后发成的那条（后来撤回了）算 → 20
  msg(c.c1, at('10-10T09:00'));
  msg(c.c1, at('10-10T09:05'));
  admin(c.c1, at('10-10T09:30'), alice);
  msg(c.c1, at('10-10T12:00'));
  msg(c.c1, at('10-10T12:01'), { dir: 'out', author: 'bot' });
  admin(c.c1, at('10-10T12:30'), alice); // 机器人回过之后人又补一句：不是新的一轮
  msg(c.c1, at('10-10T13:00'));
  admin(c.c1, at('10-10T13:01'), alice, { status: 'failed' });
  admin(c.c1, at('10-10T13:20'), alice, { revokedAt: at('10-10T13:25') });
  // c2（A，Bob）：外联群发不进这一串（客户回外联照样开一轮，中间又群发一条也不算回了），手机上回的 → 60；WhatsApp 转发的 → 45
  msg(c.c2, at('10-11T08:00'), { dir: 'out', author: 'bot', via: 'campaign' });
  msg(c.c2, at('10-11T09:00'));
  msg(c.c2, at('10-11T09:10'), { dir: 'out', author: 'bot', via: 'campaign' });
  msg(c.c2, at('10-11T10:00'), { dir: 'out', author: 'owner', via: 'phone' });
  msg(c.c2, at('10-12T09:00'));
  msg(c.c2, at('10-12T09:45'), { dir: 'out', author: 'operator', via: 'whatsapp' });
  // c3（B，未分配）：导入的历史不进这一串；Bob 在后台回的 → 120；最后一轮还没人回
  msg(c.c3, at('09-01T00:00'), { via: 'import' });
  msg(c.c3, at('09-01T00:05'), { dir: 'out', author: 'owner', via: 'import' });
  msg(c.c3, at('10-13T08:00'));
  admin(c.c3, at('10-13T10:00'), bob);
  msg(c.c3, at('10-14T09:00'));
  // c4（A，Alice）：10-07 开始的一轮在 UTC 7d 外（上海 7d 内，180）；时间段末尾开始、"现在"之后才回的照算 → 30
  msg(c.c4, at('10-07T22:00'));
  admin(c.c4, at('10-08T01:00'), alice);
  msg(c.c4, at('10-14T09:50'));
  admin(c.c4, at('10-14T10:20'), alice);
  // c6（A，Alice）：早期没记 via 的人工消息也算人工回复（不算到哪个成员头上）→ 10
  msg(c.c6, at('10-09T10:00'));
  msg(c.c6, at('10-09T10:10'), { dir: 'out', author: 'operator' });

  // ---- 处理记录、转人工、线索、草稿、外联、模型调用、缺口 ----
  const dec = (acc, convId, decision, code, ts) =>
    t.ctx.records.decision({ ts, accountId: acc.id, conversationId: convId, decision, code, usedEntryIds: [], sentFileIds: [] });
  dec(A, c.c1, 'replied', 'business', at('10-10T12:01'));
  dec(A, c.c2, 'handoff', 'price', at('10-11T09:00'));
  dec(B, c.c3, 'handoff', 'other', at('10-13T08:00'));
  dec(B, c.c3, 'offtopic', 'chitchat', at('10-14T09:00'));
  dec(B, null, 'handoff', 'insufficient_info', at('10-13T08:00')); // 没有会话的处理记录：按业务员筛选时不算
  const ho = (acc, convId, started, minutes, kind, userId = null) =>
    db
      .prepare(
        `INSERT INTO handoffs(id, conversation_id, account_id, code, started_at, first_response_at, first_responder_user_id, first_responder_kind)
         VALUES(?, ?, ?, 'price', ?, ?, ?, ?)`,
      )
      .run(newId(), convId, acc.id, started, new Date(Date.parse(started) + minutes * 60_000).toISOString(), userId, kind);
  ho(A, c.c2, at('10-11T09:00'), 60, 'phone');
  ho(B, c.c3, at('10-13T08:00'), 120, 'admin_ui', bob.id);
  const lead = (convId, acc, stage) =>
    db
      .prepare(`INSERT INTO leads(id, conversation_id, account_id, stage, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)`)
      .run(newId(), convId, acc.id, stage, at('10-01T00:00'), at('10-01T00:00'));
  lead(c.c1, A, 'sample');
  lead(c.c3, B, 'inquiry');
  const draft = (convId, acc, outcome) =>
    db
      .prepare(
        `INSERT INTO draft_outcomes(id, conversation_id, account_id, kind, created_at, text, prompt_version, outcome, outcome_at)
         VALUES(?, ?, ?, 'suggest', ?, '草稿', 'v1', ?, ?)`,
      )
      .run(newId(), convId, acc.id, at('10-12T00:00'), outcome, at('10-12T00:00'));
  draft(c.c1, A, 'edited');
  draft(c.c3, B, 'dismissed');
  draft('gone-conv', A, 'dismissed'); // 会话已经删了：按业务员（包括未分配）筛选时都不算
  const rcp = (acc, convId, replied) =>
    db
      .prepare(
        `INSERT INTO campaign_recipients(id, campaign_id, seq, line, number, account_id, status, sent_at, replied_at, conversation_id)
         VALUES(?, 'camp', 0, 1, '8613800000000', ?, 'sent', ?, ?, ?)`,
      )
      .run(newId(), acc.id, at('10-11T08:00'), replied, convId);
  rcp(A, c.c2, at('10-11T09:00'));
  rcp(B, c.c3, null);
  t.ctx.records.llmCall({ ts: at('10-12T00:00'), purpose: 'reply', format: 'openai', model: 'gpt-x', inputTokens: 10, outputTokens: 5, ok: true, accountId: A.id });
  db.prepare(`INSERT INTO gaps(id, question, status, origin, count, created_at) VALUES('g1', '有没有现货', 'open', 'conversation', 1, ?)`).run(at('10-01T00:00'));
  db.prepare('INSERT INTO gap_hits(gap_id, conversation_id, ts) VALUES(?, ?, ?)').run('g1', c.c3, at('10-13T08:00'));
}

before(async () => {
  t = await startApp({ options: { dashboardNow: () => NOW } });
  await t.login();
  A = await t.createAccount({ name: '号 A' });
  B = await t.createAccount({ name: '号 B' });
  const a = await t.addMember({ email: 'alice@example.com', name: 'Alice', accountIds: [A.id, B.id] });
  alice = a.user;
  aliceCookie = a.cookie;
  bob = (await t.addMember({ email: 'bob@example.com', name: 'Bob', accountIds: [A.id, B.id] })).user;
  adminUser = t.ctx.db.prepare("SELECT id, name, email FROM users WHERE role = 'admin'").get();
  seed();
});

after(() => t?.close());

describe('看板：平均回复时间', () => {
  it('一轮怎么切：连发算一轮、机器人先回的不算、失败的不算回复、撤回的照算、手机和转发算人工、导入和外联群发不进这一串', () => {
    const P = { from: '2026-10-08T00:00:00.000Z', to: new Date(NOW).toISOString(), acc: null, asg: null };
    const turns = replyTurns(t.ctx.db, P)
      .map((x) => ({ start: x.start.slice(5, 16), reply: x.reply?.slice(5, 16) ?? null, kind: x.kind, via: x.via, userId: x.userId }))
      .sort((x, y) => x.start.localeCompare(y.start));
    assert.deepEqual(turns, [
      { start: '10-09T10:00', reply: '10-09T10:10', kind: 'h', via: null, userId: null },
      { start: '10-10T09:00', reply: '10-10T09:30', kind: 'h', via: 'admin', userId: alice.id },
      { start: '10-10T12:00', reply: '10-10T12:01', kind: 'b', via: null, userId: null },
      { start: '10-10T13:00', reply: '10-10T13:20', kind: 'h', via: 'admin', userId: alice.id },
      { start: '10-11T09:00', reply: '10-11T10:00', kind: 'h', via: 'phone', userId: null },
      { start: '10-12T09:00', reply: '10-12T09:45', kind: 'h', via: 'whatsapp', userId: null },
      { start: '10-13T08:00', reply: '10-13T10:00', kind: 'h', via: 'admin', userId: bob.id },
      { start: '10-14T09:00', reply: null, kind: null, via: null, userId: null },
      { start: '10-14T09:50', reply: '10-14T10:20', kind: 'h', via: 'admin', userId: alice.id },
    ]);
  });

  it('KPI：平均、中位、算了几轮、还没回几轮；开始在时间段外的不算，回复晚于时间段末尾的照算', async () => {
    const d = await dash();
    // 10 20 30 30 45 60 120：平均 315 ÷ 7 = 45，中位 30
    assert.deepEqual(pick(d.kpi), { avgReplyMinutes: 45, medianReplyMinutes: 30, replyTurns: 7, unrepliedTurns: 1 });
    // 转人工的中位数照旧只算转人工记录：60、120
    assert.equal(d.kpi.medianResponseMinutes, 90);
    // 上海 7d 多了 c4 从 10-07 22:00 开始的那轮（180）
    const s = await dash('&tz=Asia/Shanghai');
    assert.deepEqual(pick(s.kpi), { avgReplyMinutes: 61.88, medianReplyMinutes: 37.5, replyTurns: 8, unrepliedTurns: 1 });
    // 今天（UTC）：只有 10-14 开始的两轮
    const today = await dash('&range=today');
    assert.deepEqual(pick(today.kpi), { avgReplyMinutes: 30, medianReplyMinutes: 30, replyTurns: 1, unrepliedTurns: 1 });
  });

  it('成员表：每人按自己发出的回复算，手机回复、WhatsApp 转发各一行；没记 via 的不算到任何人头上', async () => {
    const d = await dash();
    const row = (m) => [m.name, m.avgReplyMinutes, m.medianReplyMinutes, m.replyTurns];
    assert.deepEqual(d.members.map(row), [
      [adminUser.name || adminUser.email, null, null, 0],
      ['Alice', 26.67, 30, 3], // 30 20 30
      ['Bob', 120, 120, 1],
      ['手机回复', 60, 60, 1],
      ['WhatsApp 转发', 45, 45, 1],
    ]);
  });

  it('summarizeReplyTurns：等待时间小于 0 的按 0 算，删掉的成员名字取消息上记的', () => {
    const s = summarizeReplyTurns([
      { start: '2026-10-10T10:00:00.000Z', reply: '2026-10-10T09:59:00.000Z', kind: 'h', via: 'phone', userId: null },
      { start: '2026-10-10T10:00:00.000Z', reply: '2026-10-10T10:03:00.000Z', kind: 'h', via: 'admin', userId: 'ghost', userName: '老王' },
      { start: '2026-10-10T10:00:00.000Z', reply: null, kind: null },
    ]);
    assert.deepEqual(s.total, { avgReplyMinutes: 1.5, medianReplyMinutes: 1.5, replyTurns: 2, unrepliedTurns: 1 });
    assert.deepEqual(s.phone, { avgReplyMinutes: 0, medianReplyMinutes: 0, replyTurns: 1 });
    assert.equal(s.names.get('ghost'), '老王');
    assert.deepEqual(s.user('nobody'), { avgReplyMinutes: null, medianReplyMinutes: null, replyTurns: 0 });
  });
});

describe('看板：按业务员筛选', () => {
  it('按成员：只算现在分给他的会话（各块都筛，知识库和成本不筛）', async () => {
    const all = await dash();
    const d = await dash(`&assigneeId=${alice.id}`);
    // c1、c4、c6
    assert.equal(d.kpi.inboundMessages, 6);
    assert.equal(d.kpi.newCustomers, 2); // c1、c6；c4 的第一条在 7d 外
    assert.deepEqual(d.kpi.turns, { replied: 1, handoff: 0, blocked: 0, offtopic: 0 });
    assert.equal(d.kpi.handoffs, 0);
    assert.equal(d.kpi.openNeedsHuman, 0);
    // 10 20 30 30 → 平均 22.5，中位 25
    assert.deepEqual(pick(d.kpi), { avgReplyMinutes: 22.5, medianReplyMinutes: 25, replyTurns: 4, unrepliedTurns: 0 });
    assert.deepEqual(d.handoffReasons, []);
    assert.equal(d.heatmap.flat().reduce((a, b) => a + b, 0), 6);
    assert.equal(d.trend.reduce((n, x) => n + x.replied + x.handoff + x.blocked + x.offtopic, 0), 1);
    assert.deepEqual(
      d.leads.stages.filter((x) => x.count > 0).map((x) => [x.stage, x.count]),
      [['sample', 1]],
    );
    assert.equal(d.leads.countries[0].count, 1);
    assert.equal(d.abuse.mutedConversations, 0);
    assert.equal(d.drafts.total, 1);
    assert.equal(d.outreach.sent, 0);
    // 号码表：号都列，数字只算他的会话
    assert.deepEqual(
      d.accounts.map((x) => [x.name, x.inbound, x.openNeedsHuman]),
      [
        ['号 A', 6, 0],
        ['号 B', 0, 0],
      ],
    );
    // 成员表：只留在这些会话里有动静的行和他自己
    assert.deepEqual(
      d.members.map((m) => [m.name, m.replyTurns, m.manualMessages]),
      [['Alice', 3, 4]],
    );
    // 知识库、成本不按业务员筛
    assert.deepEqual(d.kb, all.kb);
    assert.deepEqual(d.cost, all.cost);
  });

  it('按另一个成员：手机回复、WhatsApp 转发的行在他的会话里有回复就留着；他自己没有回复也留着', async () => {
    const d = await dash(`&assigneeId=${bob.id}`);
    assert.equal(d.kpi.inboundMessages, 2);
    assert.equal(d.kpi.handoffs, 1);
    assert.equal(d.kpi.openNeedsHuman, 1);
    assert.deepEqual(pick(d.kpi), { avgReplyMinutes: 52.5, medianReplyMinutes: 52.5, replyTurns: 2, unrepliedTurns: 0 });
    assert.deepEqual(
      d.handoffReasons.map((x) => [x.code, x.count]),
      [['price', 1]],
    );
    assert.equal(d.outreach.sent, 1);
    assert.equal(d.outreach.replied, 1);
    assert.deepEqual(
      d.members.map((m) => [m.kind, m.name, m.replyTurns, m.handled]),
      [
        ['user', 'Bob', 0, 0], // Bob 回的那轮在未分配的 c3 里
        ['phone', '手机回复', 1, 1],
        ['relay', 'WhatsApp 转发', 1, 0],
      ],
    );
  });

  it('未分配：会话没有负责人的；删掉的会话、没有会话的记录不算', async () => {
    const d = await dash('&assigneeId=unassigned');
    assert.equal(d.kpi.inboundMessages, 2);
    assert.equal(d.kpi.newCustomers, 0); // c3 最早一条是导入的
    assert.deepEqual(d.kpi.turns, { replied: 0, handoff: 1, blocked: 0, offtopic: 1 }); // 没有会话的那条 handoff 不算
    assert.equal(d.kpi.openNeedsHuman, 1);
    assert.deepEqual(pick(d.kpi), { avgReplyMinutes: 120, medianReplyMinutes: 120, replyTurns: 1, unrepliedTurns: 1 });
    assert.equal(d.abuse.mutedConversations, 1);
    assert.deepEqual(
      d.abuse.offtopic.map((x) => x.code),
      ['chitchat'],
    );
    assert.equal(d.drafts.total, 1); // gone-conv 的不算
    assert.equal(d.outreach.sent, 1);
    assert.deepEqual(
      d.members.map((m) => [m.name, m.replyTurns, m.handled]),
      [['Bob', 1, 1]],
    );
    const all = await dash();
    assert.equal(all.drafts.total, 3);
    assert.deepEqual(all.kpi.turns, { replied: 1, handoff: 3, blocked: 0, offtopic: 1 });
  });

  it('和按号一起筛', async () => {
    const aliceB = await dash(`&assigneeId=${alice.id}&accountId=${B.id}`);
    assert.equal(aliceB.kpi.inboundMessages, 0);
    assert.deepEqual(pick(aliceB.kpi), { avgReplyMinutes: null, medianReplyMinutes: null, replyTurns: 0, unrepliedTurns: 0 });
    assert.deepEqual(
      aliceB.accounts.map((x) => x.name),
      ['号 B'],
    );
    const noneB = await dash(`&assigneeId=unassigned&accountId=${B.id}`);
    assert.equal(noneB.kpi.inboundMessages, 2);
    assert.equal(noneB.kpi.replyTurns, 1);
    const noneA = await dash(`&assigneeId=unassigned&accountId=${A.id}`);
    assert.equal(noneA.kpi.inboundMessages, 0);
    assert.equal(noneA.drafts.total, 0);
    const aliceA = await dash(`&assigneeId=${alice.id}&accountId=${A.id}`);
    assert.equal(aliceA.kpi.inboundMessages, 6);
    assert.equal(aliceA.kpi.replyTurns, 4);
  });

  it('推荐回复列表也按业务员筛', async () => {
    const list = async (q) => {
      const r = await t.req('GET', `/api/dashboard/drafts?range=7d&tz=UTC${q}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.items.map((x) => x.conversationId).sort();
    };
    assert.deepEqual(await list(''), [c.c1, c.c3, 'gone-conv'].sort());
    assert.deepEqual(await list(`&assigneeId=${alice.id}`), [c.c1]);
    assert.deepEqual(await list('&assigneeId=unassigned'), [c.c3]);
    assert.deepEqual(await list(`&assigneeId=unassigned&accountId=${A.id}`), []);
    assert.deepEqual(await list(`&assigneeId=${bob.id}`), []);
  });

  it('参数：assigneeId 不是一个字符串或太长 400；不认识的 id 不报错（没有数据）；agent 403', async () => {
    for (const q of ['assigneeId=a&assigneeId=b', `assigneeId=${'x'.repeat(201)}`]) {
      for (const p of ['/api/dashboard', '/api/dashboard/drafts']) {
        const r = await t.req('GET', `${p}?${q}`);
        assert.equal(r.status, 400, `${p}?${q}`);
        assert.equal(r.body.code, 'invalid_assignee');
      }
    }
    const gone = await dash('&assigneeId=gone-user');
    assert.equal(gone.kpi.inboundMessages, 0);
    assert.deepEqual(
      gone.members.map((m) => m.userId),
      [],
    );
    assert.deepEqual(parseDashboardQuery({ assigneeId: '' }).assigneeId, null);
    const r = await t.req('GET', `/api/dashboard?assigneeId=${alice.id}`, { cookie: aliceCookie });
    assert.equal(r.status, 403);
    const l = await t.req('GET', `/api/dashboard/drafts?assigneeId=${alice.id}`, { cookie: aliceCookie });
    assert.equal(l.status, 403);
  });

  it('按的是现在的负责人：会话改派后，以前的消息和回复跟着算到新负责人名下', async () => {
    const r = await t.req('PUT', `/api/wa/conversations/${encodeURIComponent(c.c3)}/assignee`, { body: { userId: alice.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    try {
      const d = await dash(`&assigneeId=${alice.id}`);
      assert.equal(d.kpi.inboundMessages, 8);
      // 多了 c3 里 Bob 回的那轮（120）和还没回的一轮
      assert.deepEqual(pick(d.kpi), { avgReplyMinutes: 42, medianReplyMinutes: 30, replyTurns: 5, unrepliedTurns: 1 });
      assert.deepEqual(
        d.members.map((m) => [m.name, m.replyTurns]),
        [
          ['Alice', 3],
          ['Bob', 1],
        ],
      );
      const none = await dash('&assigneeId=unassigned');
      assert.equal(none.kpi.inboundMessages, 0);
    } finally {
      t.ctx.db.prepare('UPDATE conversations SET assignee_id = NULL WHERE id = ?').run(c.c3);
    }
  });
});
