// 按客户分配会话：agent 只看分给自己、而且有号权限的会话（列表、详情、发送、线索），admin 单个分配、批量分配、转交，
// 删成员、改 accountIds、删号时收回成未分配，停用不动，外联发起人归属，分配记录，升级迁移只跑一次。全部用假 WAHA、mock 模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { kvGet } from '../src/db.js';
import { newId } from '../src/util.js';
import { convIdOf, convPath, getConv, startApp, startFakeWaha, waitFor, wahaSend } from './helpers.js';

/** 北京 12:00（外联的发送窗口内） */
const NOON_CN = Date.parse('2026-10-12T04:00:00Z');

let numSeq = Math.floor(Math.random() * 1e6);
/** 一个新的中国手机号（本国写法）→ {local, digits, chat} */
function cnNumber() {
  const local = `137${String(++numSeq).padStart(8, '0')}`;
  return { local, digits: `86${local}`, chat: `86${local}@c.us` };
}
const chatOf = (convId) => convId.slice(convId.indexOf(':') + 1);

/** 上传号码文件新建外联任务（multipart） */
function createCampaign(t, { lines, accountIds, cookie, name = '分配测试外联' }) {
  const form = new FormData();
  form.append('file', new Blob([lines.join('\n')], { type: 'text/plain' }), 'numbers.txt');
  form.append('name', name);
  form.append('mode', 'single');
  form.append('accountIds', JSON.stringify(accountIds));
  form.append('message', '您好，这里是墨鸽测试。');
  form.append('defaultCountry', 'CN');
  return t.req('POST', '/api/campaigns', { body: form, cookie });
}

describe('按客户分配：权限和接口', () => {
  let t;
  let fake;
  let A;
  let B;
  let x;
  let y;
  let admin;
  let memberSeq = 0;

  const as = (who, method, p, body) => t.req(method, p, { cookie: who.cookie, body });
  const assign = (convId, userId) => t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId } });
  const bulk = (body, o = {}) => t.req('POST', '/api/wa/conversations/assign', { body, ...o });
  const history = async (convId) => (await t.req('GET', `${convPath(convId)}/assignments`)).body;
  /** who 为 null 时以 admin 身份列 */
  const listIds = async (who, query = '') =>
    (await t.req('GET', `/api/wa/conversations${query}`, who ? { cookie: who.cookie } : {})).body.map((c) => c.id);
  const userOf = async (id) => (await t.req('GET', '/api/users')).body.find((u) => u.id === id);
  const member = (name, accountIds, role = 'agent') => t.addMember({ email: `assign-${++memberSeq}@example.com`, name, accountIds, role });

  /** 号 acc 收到一个新客户的消息，返回会话 id */
  async function newConv(acc) {
    const chat = cnNumber().chat;
    await wahaSend(t, acc, chat, '你好');
    const id = convIdOf(acc, chat);
    await waitFor(() => getConv(t, id), { message: '会话迟迟没建出来' });
    return id;
  }

  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    await t.login();
    admin = (await t.req('GET', '/api/auth/me')).body.user;
    A = await t.createAccount({ name: '一号' });
    B = await t.createAccount({ name: '二号' });
    assert.equal((await t.req('POST', `/api/accounts/${A.id}/waha/start`)).status, 200);
    assert.equal((await t.req('POST', `/api/accounts/${B.id}/waha/start`)).status, 200);
    x = await t.addMember({ email: 'assign-x@example.com', name: '小许', accountIds: [A.id] });
    y = await t.addMember({ email: 'assign-y@example.com', name: '小杨', accountIds: [A.id, B.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('新会话一律未分配（号上只有一个 agent 也一样）：agent 列表里没有，详情、消息、发送、发文件、翻译、机器人开关、分配记录都 403', async () => {
    assert.equal(kvGet(t.ctx.db, 'assignments_migrated'), true, '新装的库第一次启动就记上迁移标记');
    const c = await newConv(A);
    const conv = await getConv(t, c);
    assert.equal(conv.assignee, null);
    assert.equal(conv.assignedAt, null);
    assert.ok((await listIds(null)).includes(c), 'admin 看得到');
    assert.ok(!(await listIds(x)).includes(c));
    assert.ok(!(await listIds(y)).includes(c));
    const cp = convPath(c);
    for (const [method, p, body] of [
      ['GET', cp],
      ['GET', `${cp}/messages`],
      ['GET', `${cp}/assignments`],
      ['POST', `${cp}/send`, { text: 'hi' }],
      ['POST', `${cp}/send-file`, { fileId: 'nope' }],
      ['POST', `${cp}/translate`, { text: '你好' }],
      ['POST', `${cp}/bot`, { paused: true }],
    ]) {
      const r = await as(x, method, p, body);
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.deepEqual(r.body, { error: '无权限', code: 'forbidden' });
    }
    assert.equal(fake.sentTo(chatOf(c)).length, 0);
    assert.equal((await getConv(t, c)).botPaused, false);
  });

  it('admin 分配后 agent 能看、能发；改分给别人后原来的 agent 立即 403；取消分配后谁都看不到', async () => {
    const c = await newConv(A);
    const r = await assign(c, x.user.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, c);
    assert.deepEqual(r.body.assignee, { id: x.user.id, name: '小许', email: 'assign-x@example.com', disabled: false });
    assert.ok(Date.parse(r.body.assignedAt) > 0);
    assert.ok('lastMessage' in r.body && 'accountName' in r.body, '返回完整的 Conversation');

    assert.ok((await listIds(x)).includes(c));
    assert.equal((await as(x, 'GET', convPath(c))).body.assignee.id, x.user.id);
    assert.equal((await as(x, 'GET', `${convPath(c)}/messages`)).status, 200);
    const send = await as(x, 'POST', `${convPath(c)}/send`, { text: '您好，我是小许' });
    assert.equal(send.status, 200, JSON.stringify(send.body));
    assert.equal(send.body.sentByUserId, x.user.id);
    assert.equal(fake.sentTo(chatOf(c)).length, 1);
    // y 有这个号的权限，但会话没分给他
    assert.equal((await as(y, 'GET', convPath(c))).status, 403);
    assert.ok(!(await listIds(y)).includes(c));

    assert.equal((await assign(c, y.user.id)).body.assignee.id, y.user.id);
    assert.equal((await as(x, 'GET', convPath(c))).status, 403);
    assert.equal((await as(x, 'POST', `${convPath(c)}/send`, { text: '还在吗' })).status, 403);
    assert.ok(!(await listIds(x)).includes(c));
    assert.equal((await as(y, 'GET', convPath(c))).status, 200);

    const un = await assign(c, null);
    assert.equal(un.status, 200);
    assert.equal(un.body.assignee, null);
    assert.equal(un.body.assignedAt, null);
    assert.equal((await as(y, 'GET', convPath(c))).status, 403);
    assert.equal(fake.sentTo(chatOf(c)).length, 1);
  });

  it('PUT assignee：分给 admin 自己可以；和原负责人相同不写记录；目标无效 400 assignee_invalid；没有号权限 400 assignee_no_account_access；agent 调 403', async () => {
    const c = await newConv(B); // x 没有二号的权限
    let r = await assign(c, admin.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.assignee.id, admin.id);
    const at = r.body.assignedAt;
    r = await assign(c, admin.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.assignedAt, at, '没变就不动');
    assert.equal((await history(c)).length, 1, '和原负责人相同不写记录');

    r = await assign(c, x.user.id);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'assignee_no_account_access');
    r = await assign(c, 'no-such-user');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'assignee_invalid');
    const off = await member('停用的人', [B.id]);
    await t.req('PUT', `/api/users/${off.user.id}`, { body: { disabled: true } });
    r = await assign(c, off.user.id);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'assignee_invalid');
    for (const body of [{}, { userId: 5 }, { userId: '' }]) {
      r = await t.req('PUT', `${convPath(c)}/assignee`, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'invalid_input');
    }
    assert.equal((await assign(`${A.id}:nope@c.us`, x.user.id)).status, 404);
    assert.equal((await getConv(t, c)).assignee.id, admin.id);
    assert.equal((await history(c)).length, 1);

    // agent 不能改负责人，负责这个会话也不行
    assert.equal((await assign(c, y.user.id)).status, 200);
    r = await as(y, 'PUT', `${convPath(c)}/assignee`, { userId: y.user.id });
    assert.equal(r.status, 403);
    r = await as(y, 'PUT', `${convPath(c)}/assignee`, { userId: null });
    assert.equal(r.status, 403);
    assert.equal((await getConv(t, c)).assignee.id, y.user.id);
  });

  it('列表 assignee 筛选：admin 可以 me / none / 成员 id；agent 只能不传、me 或自己的 id，none 和别人的 id 403', async () => {
    const c1 = await newConv(A);
    const c2 = await newConv(A);
    const c3 = await newConv(B);
    await assign(c2, x.user.id);
    await assign(c3, admin.id);
    const three = (ids) => ids.filter((id) => [c1, c2, c3].includes(id));
    assert.deepEqual(new Set(three(await listIds(null))), new Set([c1, c2, c3]));
    assert.deepEqual(three(await listIds(null, '?assignee=none')), [c1]);
    assert.deepEqual(three(await listIds(null, `?assignee=${x.user.id}`)), [c2]);
    assert.deepEqual(three(await listIds(null, '?assignee=me')), [c3]);
    assert.deepEqual(three(await listIds(null, `?accountId=${A.id}&assignee=none`)), [c1]);
    const none = (await t.req('GET', '/api/wa/conversations?assignee=none')).body;
    assert.ok(none.every((c) => c.assignee === null));
    const ofX = (await t.req('GET', `/api/wa/conversations?assignee=${x.user.id}`)).body;
    assert.ok(ofX.length >= 1 && ofX.every((c) => c.assignee.id === x.user.id));

    for (const q of ['', '?assignee=me', `?assignee=${x.user.id}`, `?accountId=${A.id}&assignee=me`]) {
      assert.deepEqual(three(await listIds(x, q)), [c2], q);
    }
    for (const q of ['?assignee=none', `?assignee=${y.user.id}`, `?assignee=${admin.id}`, `?accountId=${B.id}`]) {
      const r = await t.req('GET', `/api/wa/conversations${q}`, { cookie: x.cookie });
      assert.equal(r.status, 403, q);
      assert.equal(r.body.code, 'forbidden');
    }
  });

  it('批量分配：返回 updated 和 skipped（unchanged、assignee_no_account_access、not_found）；目标无效整体 400；超过 500 个 400；agent 403', async () => {
    const a1 = await newConv(A);
    const a2 = await newConv(A);
    const b1 = await newConv(B);
    await assign(a2, x.user.id);
    const r = await bulk({ conversationIds: [a1, a2, b1, 'nope', a1], userId: x.user.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      updated: 1,
      skipped: [
        { id: a2, code: 'unchanged' },
        { id: b1, code: 'assignee_no_account_access' },
        { id: 'nope', code: 'not_found' },
      ],
    });
    assert.equal((await getConv(t, a1)).assignee.id, x.user.id);
    assert.equal((await getConv(t, b1)).assignee, null);
    const h = await history(a1);
    assert.equal(h.length, 1);
    assert.equal(h[0].reason, 'bulk');
    assert.deepEqual(h[0].by, { id: admin.id, name: '管理员' });

    // 批量取消分配；分给 admin 时不看号
    assert.deepEqual((await bulk({ conversationIds: [a1, a2], userId: null })).body, { updated: 2, skipped: [] });
    assert.deepEqual((await bulk({ conversationIds: [a1, b1], userId: admin.id })).body, { updated: 2, skipped: [] });
    assert.equal((await getConv(t, b1)).assignee.id, admin.id);

    const off = await member('批量停用', [A.id]);
    await t.req('PUT', `/api/users/${off.user.id}`, { body: { disabled: true } });
    for (const userId of ['nope', off.user.id]) {
      const bad = await bulk({ conversationIds: [a2], userId });
      assert.equal(bad.status, 400, userId);
      assert.equal(bad.body.code, 'assignee_invalid');
    }
    assert.equal((await getConv(t, a2)).assignee, null, '目标无效时一个都不改');
    for (const body of [
      { conversationIds: Array.from({ length: 501 }, (_, i) => `c${i}`), userId: x.user.id },
      { conversationIds: 'a', userId: x.user.id },
      { conversationIds: [1], userId: x.user.id },
      { conversationIds: [a2] },
    ]) {
      const bad = await bulk(body);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'invalid_input');
    }
    assert.equal((await bulk({ conversationIds: [], userId: x.user.id })).body.updated, 0);
    const denied = await bulk({ conversationIds: [a2], userId: y.user.id }, { cookie: y.cookie });
    assert.equal(denied.status, 403);
    assert.equal((await getConv(t, a2)).assignee, null);
  });

  it('分配记录：新到旧，from / to / by 是 {id, name}；负责这个会话的 agent 能看，别人 403', async () => {
    const c = await newConv(A);
    await assign(c, x.user.id);
    await assign(c, y.user.id);
    await assign(c, null);
    await assign(c, x.user.id);
    const h = await history(c);
    assert.deepEqual(
      h.map((e) => [e.reason, e.from?.id ?? null, e.to?.id ?? null]),
      [
        ['manual', null, x.user.id],
        ['manual', y.user.id, null],
        ['manual', x.user.id, y.user.id],
        ['manual', null, x.user.id],
      ],
    );
    assert.deepEqual(h[0].to, { id: x.user.id, name: '小许' });
    assert.deepEqual(h[1].from, { id: y.user.id, name: '小杨' });
    for (const e of h) {
      assert.deepEqual(Object.keys(e).sort(), ['at', 'by', 'from', 'id', 'reason', 'to']);
      assert.deepEqual(e.by, { id: admin.id, name: '管理员' });
      assert.ok(Date.parse(e.at) > 0);
    }
    const mine = await as(x, 'GET', `${convPath(c)}/assignments`);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, h);
    assert.equal((await as(y, 'GET', `${convPath(c)}/assignments`)).status, 403);
    assert.equal((await t.req('GET', `${convPath(`${A.id}:nope@c.us`)}/assignments`)).status, 404);
  });

  it('GET /api/users 带 assignedCount；转交：全部转给另一个人，目标 agent 没有号权限的保持原样、计入 skipped；目标无效 400', async () => {
    const p = await member('小潘', [A.id, B.id]);
    const q = await member('小秦', [A.id]);
    const a1 = await newConv(A);
    const b1 = await newConv(B);
    await assign(a1, p.user.id);
    await assign(b1, p.user.id);
    assert.equal((await userOf(p.user.id)).assignedCount, 2);
    assert.equal((await userOf(q.user.id)).assignedCount, 0);
    assert.ok((await t.req('GET', '/api/users')).body.every((u) => Number.isInteger(u.assignedCount)));

    const r = await t.req('POST', `/api/users/${p.user.id}/transfer`, { body: { toUserId: q.user.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { moved: 1, skipped: 1 });
    assert.equal((await getConv(t, a1)).assignee.id, q.user.id);
    assert.equal((await getConv(t, b1)).assignee.id, p.user.id, '小秦没有二号的权限，保持原样');
    const h = await history(a1);
    assert.equal(h[0].reason, 'transfer');
    assert.deepEqual([h[0].from.id, h[0].to.id, h[0].by.id], [p.user.id, q.user.id, admin.id]);

    const off = await member('转交停用', [A.id, B.id]);
    await t.req('PUT', `/api/users/${off.user.id}`, { body: { disabled: true } });
    for (const body of [{ toUserId: p.user.id }, { toUserId: 'nope' }, { toUserId: off.user.id }, {}, { toUserId: null }]) {
      const bad = await t.req('POST', `/api/users/${p.user.id}/transfer`, { body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(bad.body.code, 'assignee_invalid');
    }
    // 转给 admin：不看号
    assert.deepEqual((await t.req('POST', `/api/users/${p.user.id}/transfer`, { body: { toUserId: admin.id } })).body, { moved: 1, skipped: 0 });
    assert.equal((await getConv(t, b1)).assignee.id, admin.id);
    assert.deepEqual((await t.req('POST', `/api/users/${p.user.id}/transfer`, { body: { toUserId: q.user.id } })).body, { moved: 0, skipped: 0 });
    assert.equal((await t.req('POST', '/api/users/nope/transfer', { body: { toUserId: q.user.id } })).status, 404);
    assert.equal((await as(q, 'POST', `/api/users/${q.user.id}/transfer`, { toUserId: p.user.id })).status, 403);
    assert.equal((await userOf(p.user.id)).assignedCount, 0);
    assert.equal((await userOf(q.user.id)).assignedCount, 1);
  });

  it('停用成员：负责关系不动，assignee.disabled 为 true，admin 还能按他筛选；不能再分给他；转交后正常', async () => {
    const s = await member('小沈', [A.id]);
    const c = await newConv(A);
    await assign(c, s.user.id);
    const put = await t.req('PUT', `/api/users/${s.user.id}`, { body: { disabled: true } });
    assert.equal(put.status, 200);
    assert.equal(put.body.assignedCount, 1);
    const conv = await getConv(t, c);
    assert.equal(conv.assignee.id, s.user.id);
    assert.equal(conv.assignee.disabled, true);
    assert.deepEqual(await listIds(null, `?assignee=${s.user.id}`), [c]);
    assert.equal((await history(c)).length, 1);
    const c2 = await newConv(A);
    assert.equal((await assign(c2, s.user.id)).body.code, 'assignee_invalid');
    assert.deepEqual((await t.req('POST', `/api/users/${s.user.id}/transfer`, { body: { toUserId: x.user.id } })).body, { moved: 1, skipped: 0 });
    assert.equal((await getConv(t, c)).assignee.id, x.user.id);
  });

  it('删除成员：他负责的会话变成未分配（user_deleted），分配记录里他显示为「已删除成员」', async () => {
    const d = await member('小邓', [A.id]);
    const c = await newConv(A);
    await assign(c, d.user.id);
    assert.equal((await t.req('DELETE', `/api/users/${d.user.id}`)).status, 200);
    const conv = await getConv(t, c);
    assert.equal(conv.assignee, null);
    assert.equal(conv.assignedAt, null);
    assert.ok((await listIds(null, '?assignee=none')).includes(c));
    const h = await history(c);
    assert.equal(h.length, 2);
    assert.equal(h[0].reason, 'user_deleted');
    assert.deepEqual(h[0].from, { id: d.user.id, name: '已删除成员' });
    assert.equal(h[0].to, null);
    assert.deepEqual(h[0].by, { id: admin.id, name: '管理员' });
    assert.deepEqual(h[1].to, { id: d.user.id, name: '已删除成员' });
  });

  it('agent 的 accountIds 去掉某个号：他在这个号上负责的会话变成未分配（access_removed），别的号上的不动；admin 降级成 agent 同理', async () => {
    const m = await member('小马', [A.id, B.id]);
    const a1 = await newConv(A);
    const b1 = await newConv(B);
    await assign(a1, m.user.id);
    await assign(b1, m.user.id);
    const put = await t.req('PUT', `/api/users/${m.user.id}`, { body: { accountIds: [A.id] } });
    assert.equal(put.status, 200);
    assert.equal(put.body.assignedCount, 1);
    assert.equal((await getConv(t, a1)).assignee.id, m.user.id);
    assert.equal((await getConv(t, b1)).assignee, null);
    const h = await history(b1);
    assert.equal(h[0].reason, 'access_removed');
    assert.deepEqual([h[0].from.id, h[0].to, h[0].by.id], [m.user.id, null, admin.id]);
    // 把号加回来也不会自动分回去；只改名字不影响
    await t.req('PUT', `/api/users/${m.user.id}`, { body: { accountIds: [A.id, B.id], name: '小马哥' } });
    assert.equal((await getConv(t, b1)).assignee, null);
    assert.equal((await getConv(t, a1)).assignee.name, '小马哥');

    const adm2 = await member('二号管理员', [], 'admin');
    const b2 = await newConv(B);
    assert.equal((await assign(b2, adm2.user.id)).status, 200, 'admin 不用有号的权限');
    await t.req('PUT', `/api/users/${adm2.user.id}`, { body: { role: 'agent', accountIds: [A.id] } });
    assert.equal((await getConv(t, b2)).assignee, null);
    assert.equal((await history(b2))[0].reason, 'access_removed');
  });

  it('删号：agent 在这个号上负责的会话变成未分配（access_removed，记删号的人），admin 负责的不动', async () => {
    const acc = await t.createAccount({ name: '要删的号' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    const g = await member('小高', [acc.id, A.id]);
    const c1 = await newConv(acc);
    const c2 = await newConv(acc);
    const a1 = await newConv(A);
    await assign(c1, g.user.id);
    await assign(c2, admin.id);
    await assign(a1, g.user.id);
    assert.equal((await t.req('DELETE', `/api/accounts/${acc.id}`)).status, 200);
    assert.equal((await getConv(t, c1)).assignee, null);
    const h = await history(c1);
    assert.equal(h[0].reason, 'access_removed');
    assert.deepEqual(h[0].by, { id: admin.id, name: '管理员' });
    assert.equal((await getConv(t, c2)).assignee.id, admin.id);
    assert.equal((await getConv(t, a1)).assignee.id, g.user.id);
    assert.deepEqual((await userOf(g.user.id)).accountIds, [A.id]);
    // 已删除号的会话不能再分给 agent
    assert.equal((await assign(c1, g.user.id)).body.code, 'assignee_no_account_access');
  });

  it('线索跟着负责人：agent 只看、改自己负责的会话的线索（导出只有 admin）；转交后跟着走', async () => {
    const l1 = await member('线索甲', [A.id]);
    const l2 = await member('线索乙', [A.id]);
    const c = await newConv(A);
    const leadId = newId();
    const now = new Date().toISOString();
    t.ctx.db
      .prepare('INSERT INTO leads(id, conversation_id, account_id, name, stage, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(leadId, c, A.id, '分配线索客户', 'inquiry', now, now);
    const leadIds = async (who) => (await t.req('GET', '/api/leads', { cookie: who.cookie })).body.map((l) => l.id);
    assert.ok(!(await leadIds(l1)).includes(leadId), '未分配的线索 agent 看不到');
    assert.equal((await as(l1, 'GET', `/api/leads/${leadId}`)).status, 403);
    assert.equal((await as(l1, 'PUT', `/api/leads/${leadId}`, { name: 'x' })).status, 403);
    assert.ok((await t.req('GET', '/api/leads')).body.some((l) => l.id === leadId), 'admin 看得到');

    await assign(c, l1.user.id);
    assert.ok((await leadIds(l1)).includes(leadId));
    assert.equal((await as(l1, 'GET', `/api/leads/${leadId}`)).status, 200);
    assert.equal((await as(l1, 'PUT', `/api/leads/${leadId}`, { company: '分配贸易' })).status, 200);
    assert.equal((await as(l1, 'GET', '/api/leads/export.csv')).status, 403);
    assert.ok((await t.req('GET', '/api/leads/export.csv')).body.includes('分配线索客户'));
    assert.ok(!(await leadIds(l2)).includes(leadId));

    await t.req('POST', `/api/users/${l1.user.id}/transfer`, { body: { toUserId: l2.user.id } });
    assert.ok(!(await leadIds(l1)).includes(leadId));
    assert.equal((await as(l1, 'GET', `/api/leads/${leadId}`)).status, 403);
    assert.ok((await leadIds(l2)).includes(leadId));
    assert.equal((await as(l2, 'GET', `/api/leads/${leadId}`)).body.company, '分配贸易');
  });
});

describe('按客户分配：外联发起人归属', () => {
  let t;
  let fake;
  let acc;
  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url }, options: { outreachNow: () => NOON_CN } });
    await t.login();
    acc = await t.createAccount({ name: '外联号' });
    assert.equal((await t.req('POST', `/api/accounts/${acc.id}/waha/start`)).status, 200);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  /** 建任务、开始、等开场消息发出去，返回会话 id */
  async function run({ cookie, number = cnNumber() } = {}) {
    const c = await createCampaign(t, { lines: [number.local], accountIds: [acc.id], cookie });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const s = await t.req('POST', `/api/campaigns/${c.body.campaign.id}/start`, { body: {} });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const convId = convIdOf(acc, number.chat);
    await waitFor(async () => (await getConv(t, convId)) && t.ctx.outreach.idle(), { message: '外联消息迟迟没发出去' });
    return { convId, campaignId: c.body.campaign.id };
  }

  it('agent 发起的：新会话分给发起人（reason=campaign，by 为 null 表示系统）；admin 发起的保持未分配', async () => {
    const agent = await t.addMember({ email: 'campaign-agent@example.com', name: '小外', accountIds: [acc.id] });
    const { convId } = await run({ cookie: agent.cookie });
    const conv = await getConv(t, convId);
    assert.equal(conv.assignee.id, agent.user.id);
    const h = (await t.req('GET', `${convPath(convId)}/assignments`)).body;
    assert.deepEqual(h.map((e) => [e.reason, e.from, e.to?.id, e.by]), [['campaign', null, agent.user.id, null]]);
    const mine = (await t.req('GET', '/api/wa/conversations', { cookie: agent.cookie })).body.map((c) => c.id);
    assert.deepEqual(mine, [convId]);

    const byAdmin = await run();
    assert.equal((await getConv(t, byAdmin.convId)).assignee, null);
    assert.equal((await t.req('GET', `${convPath(byAdmin.convId)}/assignments`)).body.length, 0);
    assert.equal((await t.req('GET', convPath(byAdmin.convId), { cookie: agent.cookie })).status, 403);
  });

  it('发送时发起人已经没有这个号的权限、或已停用：保持未分配', async () => {
    const lost = await t.addMember({ email: 'campaign-lost@example.com', name: '小失', accountIds: [acc.id] });
    const off = await t.addMember({ email: 'campaign-off@example.com', name: '小停', accountIds: [acc.id] });
    const n1 = cnNumber();
    const n2 = cnNumber();
    const c1 = await createCampaign(t, { lines: [n1.local], accountIds: [acc.id], cookie: lost.cookie });
    const c2 = await createCampaign(t, { lines: [n2.local], accountIds: [acc.id], cookie: off.cookie });
    await t.req('PUT', `/api/users/${lost.user.id}`, { body: { accountIds: [] } });
    await t.req('PUT', `/api/users/${off.user.id}`, { body: { disabled: true } });
    // 发起人已经动不了这两个任务了，由 admin 开始
    for (const c of [c1, c2]) assert.equal((await t.req('POST', `/api/campaigns/${c.body.campaign.id}/start`, { body: {} })).status, 200);
    for (const n of [n1, n2]) {
      const convId = convIdOf(acc, n.chat);
      await waitFor(async () => (await getConv(t, convId)) && t.ctx.outreach.idle(), { message: '外联消息迟迟没发出去' });
      assert.equal((await getConv(t, convId)).assignee, null);
    }
  });
});

describe('按客户分配：升级迁移', () => {
  it('已有会话的号恰好只有一个启用中的 agent 有权限时分给他（migration），两个或零个时不分；只跑一次', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-assign-migrate-'));
    const env = { INKDOVE_DATA_DIR: dir };
    const ids = {};
    try {
      const t1 = await startApp({ env });
      try {
        await t1.login();
        const one = await t1.createAccount({ name: '一个 agent' });
        const two = await t1.createAccount({ name: '两个 agent' });
        const withOff = await t1.createAccount({ name: '一个启用一个停用' });
        const none = await t1.createAccount({ name: '没有 agent' });
        const x = await t1.addMember({ email: 'mig-x@example.com', name: '小许', accountIds: [one.id, two.id] });
        const y = await t1.addMember({ email: 'mig-y@example.com', name: '小杨', accountIds: [two.id, withOff.id] });
        const off = await t1.addMember({ email: 'mig-off@example.com', name: '停用的', accountIds: [withOff.id, none.id] });
        await t1.req('PUT', `/api/users/${off.user.id}`, { body: { disabled: true } });
        // admin 有所有号的权限，不算
        await t1.addMember({ email: 'mig-admin@example.com', name: '二号管理员', role: 'admin', accountIds: [one.id] });
        Object.assign(ids, { one, two, withOff, none, x: x.user.id, y: y.user.id });
        const now = new Date().toISOString();
        const insert = t1.ctx.db.prepare(
          `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
           VALUES(?, ?, ?, 'waha', '', '', ?, ?)`,
        );
        for (const [key, acc] of [['c1', one], ['c1b', one], ['c2', two], ['c3', withOff], ['c4', none]]) {
          const chat = cnNumber().chat;
          ids[key] = convIdOf(acc, chat);
          insert.run(ids[key], acc.id, chat, now, now);
        }
        assert.equal((await getConv(t1, ids.c1)).assignee, null, '升级前建的会话都是未分配');
        // 模拟升级前的库：还没有迁移标记
        t1.ctx.db.prepare("DELETE FROM kv WHERE key = 'assignments_migrated'").run();
      } finally {
        await t1.close();
      }

      const t2 = await startApp({ env });
      try {
        await t2.login();
        assert.equal(kvGet(t2.ctx.db, 'assignments_migrated'), true);
        assert.equal((await getConv(t2, ids.c1)).assignee.id, ids.x);
        assert.equal((await getConv(t2, ids.c1b)).assignee.id, ids.x);
        assert.equal((await getConv(t2, ids.c2)).assignee, null, '两个 agent 时不分');
        assert.equal((await getConv(t2, ids.c3)).assignee.id, ids.y, '停用的 agent 不算');
        assert.equal((await getConv(t2, ids.c4)).assignee, null, '没有启用中的 agent 时不分');
        const h = (await t2.req('GET', `${convPath(ids.c1)}/assignments`)).body;
        assert.deepEqual(h.map((e) => [e.reason, e.from, e.to, e.by]), [['migration', null, { id: ids.x, name: '小许' }, null]]);
        const users = (await t2.req('GET', '/api/users')).body;
        assert.equal(users.find((u) => u.id === ids.x).assignedCount, 2);
        // 迁移之后：取消一个、新来一个会话，都不应该被再次迁移分配
        assert.equal((await t2.req('PUT', `${convPath(ids.c1)}/assignee`, { body: { userId: null } })).status, 200);
        const chat = cnNumber().chat;
        ids.c5 = convIdOf(ids.one, chat);
        const now = new Date().toISOString();
        t2.ctx.db
          .prepare(
            `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
             VALUES(?, ?, ?, 'waha', '', '', ?, ?)`,
          )
          .run(ids.c5, ids.one.id, chat, now, now);
      } finally {
        await t2.close();
      }

      const t3 = await startApp({ env });
      try {
        await t3.login();
        assert.equal((await getConv(t3, ids.c1)).assignee, null, '只跑一次');
        assert.equal((await getConv(t3, ids.c5)).assignee, null);
        assert.equal((await getConv(t3, ids.c1b)).assignee.id, ids.x);
        assert.equal((await t3.req('GET', `${convPath(ids.c1)}/assignments`)).body.length, 2);
      } finally {
        await t3.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
