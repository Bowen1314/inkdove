// 消息撤回：业务员在墨鸽里撤回我方消息（经 WAHA 对所有人删除）；WAHA 推来的 message.revoked（客户撤回、同一个号在手机上撤回）；
// 撤回过的消息不进模型的上下文（自动回复、推荐回复和跟进、转人工草稿、存进知识库、一键翻译判断语言、客户线索）；老 session 补订阅。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createMockAi } from '../src/ai/mock.js';
import { messageKeyId, REVOKE_WINDOW_MS, REVOKED_SKIP_REASON, WHATSAPP_REVOKE_LIMIT_MS } from '../src/wa/service.js';
import { fakeJpeg } from './fixtures.js';
import { aiHooks, convIdOf, convPath, getMessages, postWaha, sleep, startApp, startFakeWaha, waitDecided, waitFor, wahaMessage, wahaSend } from './helpers.js';

let seq = 0;
const newNumber = () => `86135${String(Date.now() % 1e5).padStart(5, '0')}${String(++seq).padStart(2, '0')}`;
const newChat = () => `${newNumber()}@c.us`;
/** WhatsApp 消息 ID（key.ID）的样子：大写十六进制 */
const newKey = () => `3EB0${Date.now().toString(16).toUpperCase()}${String(++seq).padStart(4, '0')}`;

let revSeq = 0;
/**
 * WAHA 的 message.revoked 事件，形状按 GOWS 2026.9.2 的 dist 代码：after 是撤回那条协议消息转成的 WAMessage（from 是聊天对象，
 * fromMe 是不是自己撤回的，source 是 api / app，不给就不带），before 是 null，revokedMessageId 是被撤回消息的 key.ID（不带前缀）。
 * 群里的撤回 from 是 @g.us，原始消息 Info 里带发送人
 */
function wahaRevoked({ session, chat, revokedId, fromMe = false, source, timestamp = Math.floor(Date.now() / 1000), sender } = {}) {
  revSeq++;
  const jid = chat.replace(/@c\.us$/, '@s.whatsapp.net');
  const protoId = `3EB0REVOKE${String(revSeq).padStart(6, '0')}`;
  const info = { Chat: jid, IsFromMe: fromMe, ID: protoId, ...(sender ? { Sender: sender, IsGroup: true } : {}) };
  const raw = { Info: info, Message: { protocolMessage: { type: 0, key: { remoteJID: jid, fromMe, ID: revokedId } } } };
  return {
    id: `evt_revoke_${revSeq}`,
    timestamp: Date.now(),
    event: 'message.revoked',
    session,
    engine: 'GOWS',
    payload: {
      after: {
        id: `${fromMe}_${chat}_${protoId}`,
        timestamp,
        from: chat,
        fromMe,
        ...(source ? { source } : {}),
        to: fromMe ? null : '19990000000@c.us',
        body: '',
        hasMedia: false,
        _data: raw,
      },
      before: null,
      revokedMessageId: revokedId,
      _data: raw,
    },
  };
}

describe('消息撤回', () => {
  let t;
  let fake;
  let hooks;
  let auto; // 自动回复的号
  let manual; // 人工回复的号：客户消息只存下来
  let me; // 当前登录的 admin
  const mock = createMockAi({ delayMs: 0 });
  const spy = { translate: null, leads: [] };

  const cid = (acc, chat) => convIdOf(acc, chat);
  const revoke = (convId, messageId, o = {}) => t.req('POST', `${convPath(convId)}/messages/${encodeURIComponent(messageId)}/revoke`, o);
  /** 假 WAHA 收到的撤回请求数（包括失败的） */
  const revokeCalls = () => fake.state.revokeStarted.length;
  const row = (id) => t.ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const keyOf = (msgId) => messageKeyId(row(msgId).external_id);
  /** 直接交给 webhook 处理，返回处理结果 */
  const event = (ev) => t.ctx.wa.handleWahaWebhook(ev);
  const msgById = async (convId, id) => (await getMessages(t, convId)).find((m) => m.id === id);

  /** 客户发一句（key 给了就用这个消息 ID），等到处理完，返回这条消息 */
  async function customerSays(acc, chat, text, key = null) {
    const convId = cid(acc, chat);
    const n = t.ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND direction = 'in'").get(convId).n;
    await wahaSend(t, acc, chat, text, key ? { id: `false_${chat}_${key}` } : {});
    const list = await waitDecided(t, convId, n + 1);
    return list.filter((m) => m.direction === 'in').at(-1);
  }
  async function operatorSend(convId, text) {
    const r = await t.req('POST', `${convPath(convId)}/send`, { body: { text } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url },
      options: {
        aiOverrides: {
          ...hooks.overrides,
          translate: (args) => {
            spy.translate = args;
            return mock.translate(args);
          },
          extractLead: (args) => {
            spy.leads.push(args);
            return mock.extractLead(args);
          },
        },
      },
    });
    await t.login();
    me = (await t.req('GET', '/api/auth/me')).body.user;
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    auto = await t.createAccount({ name: '自动号', autoReply: true });
    manual = await t.createAccount({ name: '人工号' });
    for (const acc of [auto, manual]) assert.equal((await t.req('POST', `/api/accounts/${acc.id}/waha/start`)).status, 200);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('消息 ID：取 WAHA 序列化 id 的第 3 段（私聊、@lid、群里带发送人的都对），不带前缀的原样返回', () => {
    assert.equal(messageKeyId('true_8613800000000@c.us_3EB0AAA111'), '3EB0AAA111');
    assert.equal(messageKeyId('false_8613800000000@s.whatsapp.net_3EB0AAA111'), '3EB0AAA111');
    assert.equal(messageKeyId('false_123456789012345@lid_3EB0AAA111'), '3EB0AAA111');
    assert.equal(messageKeyId('false_120363012345678901@g.us_3EB0AAA111_8613800000000@c.us'), '3EB0AAA111');
    assert.equal(messageKeyId('true_120363012345678901@g.us_3EB0AAA111_123456789012345@lid'), '3EB0AAA111');
    assert.equal(messageKeyId('3EB0AAA111'), '3EB0AAA111');
    assert.ok(REVOKE_WINDOW_MS < WHATSAPP_REVOKE_LIMIT_MS, '比 WhatsApp 的时限留出余量');
  });

  it('业务员撤回我方消息：调 WAHA 的 DELETE（完整的序列化 id），库里记上谁、什么时候撤回的，原文保留；再撤回 409、不再调 WAHA', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    await customerSays(manual, chat, '你好，保温杯多少钱');
    const sent = await operatorSend(convId, '59 元一个');
    assert.equal(sent.status, 'sent');
    assert.equal(sent.revoked, null);
    assert.ok(Math.abs(Date.parse(sent.revocableUntil) - (Date.parse(sent.ts) + REVOKE_WINDOW_MS)) < 1000, '发出后 REVOKE_WINDOW_MS 内能撤回');
    const externalId = row(sent.id).external_id;
    assert.match(externalId, /^true_.+@c\.us_SENT\d+$/);

    const n = fake.state.revoked.length;
    const r = await revoke(convId, sent.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.state.revoked.length, n + 1);
    assert.deepEqual(fake.state.revoked.at(-1), { session: manual.waha.sessionName, chatId: chat, messageId: externalId });
    assert.equal(r.body.text, '59 元一个', '原文保留');
    assert.equal(r.body.revocableUntil, null);
    assert.deepEqual({ ...r.body.revoked, at: null }, { at: null, by: 'member', userId: me.id, name: me.name });
    assert.ok(Math.abs(Date.parse(r.body.revoked.at) - Date.now()) < 5000);
    const db = row(sent.id);
    assert.deepEqual([db.revoked_by, db.revoked_by_user_id, db.revoked_by_name], ['member', me.id, me.name]);
    assert.deepEqual((await msgById(convId, sent.id)).revoked, r.body.revoked);

    const calls = revokeCalls();
    const again = await revoke(convId, sent.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_revoked');
    assert.equal(revokeCalls(), calls);
  });

  it('权限同手动发消息：没这个号权限的、会话没分给自己的 agent 都 403，不调 WAHA；分给自己的 agent 能撤回，记他的名字', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    await customerSays(manual, chat, '在吗');
    const sent = await operatorSend(convId, '在的');
    const outsider = await t.addMember({ email: 'revoke-outsider@example.com', name: '小外', accountIds: [] });
    const colleague = await t.addMember({ email: 'revoke-agent@example.com', name: '小吴', accountIds: [manual.id] });
    const calls = revokeCalls();
    assert.equal((await revoke(convId, sent.id, { cookie: outsider.cookie })).status, 403);
    assert.equal((await revoke(convId, sent.id, { cookie: colleague.cookie })).status, 403, '有号权限但会话没分给他');
    assert.equal(revokeCalls(), calls);
    assert.equal(row(sent.id).revoked_at, null);

    assert.equal((await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: colleague.user.id } })).status, 200);
    const r = await revoke(convId, sent.id, { cookie: colleague.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.revoked.by, r.body.revoked.userId, r.body.revoked.name], ['member', colleague.user.id, '小吴']);
  });

  it('判不过的不调 WAHA：客户的消息、发送失败的、超过时限的、Meta 号的、不存在的；列表里这些消息的 revocableUntil 都是 null', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const inbound = await customerSays(manual, chat, '你好');
    fake.state.failSend = true;
    const failed = await operatorSend(convId, '这条发不出去');
    fake.state.failSend = false;
    assert.equal(failed.status, 'failed');
    const old = await operatorSend(convId, '两天半以前说的');
    const recent = await operatorSend(convId, '快到时限了');
    const setAgo = (id, ms) => t.ctx.db.prepare('UPDATE messages SET ts = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), id);
    setAgo(old.id, REVOKE_WINDOW_MS + 60_000);
    setAgo(recent.id, REVOKE_WINDOW_MS - 60_000);
    const list = await getMessages(t, convId);
    const by = (id) => list.find((m) => m.id === id);
    for (const m of [inbound, failed, old]) assert.equal(by(m.id).revocableUntil, null, m.text);
    assert.ok(by(recent.id).revocableUntil, '没到时限的还能撤回');

    const calls = revokeCalls();
    for (const [id, status, code] of [
      [inbound.id, 400, 'not_own_message'],
      [failed.id, 400, 'not_sent'],
      [old.id, 400, 'revoke_expired'],
    ]) {
      const r = await revoke(convId, id);
      assert.equal(r.status, status, code);
      assert.equal(r.body.code, code);
      assert.match(r.body.error, /[一-鿿]/, '中文原因');
    }
    assert.equal((await revoke(convId, 'no-such-message')).status, 404);

    // Meta 官方接口的号：Cloud API 没有撤回接口
    const metaAcc = await t.createAccount({
      name: '官方号',
      channel: 'meta',
      meta: { phoneNumberId: '1234567890', verifyToken: 'test-verify', accessToken: 'test-access-token', appSecret: 'test-app-secret' },
    });
    const number = newNumber();
    const metaConv = `${metaAcc.id}:${number}`;
    const now = new Date().toISOString();
    t.ctx.db
      .prepare(
        `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
         VALUES(?, ?, ?, 'meta', '', ?, ?, ?)`,
      )
      .run(metaConv, metaAcc.id, number, number, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO messages(id, conversation_id, external_id, direction, author, kind, text, ts, status, handled)
         VALUES('meta-out-1', ?, 'wamid.TEST1', 'out', 'operator', 'text', '官方号发的', ?, 'sent', 1)`,
      )
      .run(metaConv, now);
    assert.equal((await msgById(metaConv, 'meta-out-1')).revocableUntil, null);
    const r = await revoke(metaConv, 'meta-out-1');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'revoke_unsupported');
    assert.equal(revokeCalls(), calls);
  });

  it('WAHA 报错时消息不变、报中文原因：500 → 502 waha_error，422（号没连上）→ 409 not_connected；没撤成的不按这个成员记', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    await customerSays(manual, chat, '你好');
    const sent = await operatorSend(convId, '要撤回的这句');
    try {
      fake.state.revokeError = { status: 500, message: 'revoke failed' };
      let r = await revoke(convId, sent.id);
      assert.equal(r.status, 502);
      assert.equal(r.body.code, 'waha_error');
      assert.match(r.body.error, /^撤回失败：/);
      fake.state.revokeError = { status: 422, message: 'Session status is not as expected' };
      r = await revoke(convId, sent.id);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'not_connected');
      assert.match(r.body.error, /没连上 WhatsApp/);
    } finally {
      fake.state.revokeError = null;
    }
    assert.equal(row(sent.id).revoked_at, null);
    const m = await msgById(convId, sent.id);
    assert.equal(m.revoked, null);
    assert.ok(m.revocableUntil, '还能再撤回');
    // 之后在手机上撤回的照常按手机记（没撤成的那两次不留记录）
    const ev = wahaRevoked({ session: manual.waha.sessionName, chat, revokedId: keyOf(sent.id), fromMe: true, source: 'app' });
    assert.equal(await event(ev), 'revoked_phone');
  });

  it('同一个号在手机上撤回我方消息：标「已在手机上撤回」；手机上发的消息也能在墨鸽里撤回；墨鸽里撤回后 WAHA 推回来的通知不改记录', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    await customerSays(manual, chat, 'hi');
    const a = await operatorSend(convId, '第一句');
    const ts = Math.floor(Date.now() / 1000) - 3;
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: keyOf(a.id), fromMe: true, source: 'app', timestamp: ts })), 'revoked_phone');
    const ma = await msgById(convId, a.id);
    assert.deepEqual(ma.revoked, { at: new Date(ts * 1000).toISOString(), by: 'phone', userId: null, name: null });
    assert.equal(ma.revocableUntil, null);
    assert.equal(ma.text, '第一句');

    // 机主在手机上发的一条（message.any，fromMe）：库里存的就是 true_<chat>_<ID>，原样交给 WAHA
    const own = wahaMessage({ from: chat, body: '手机上回的', fromMe: true, session, pushName: 'Shop Owner', source: 'app' });
    await event({ ...own, event: 'message.any' });
    const ownerMsg = await waitFor(async () => (await getMessages(t, convId)).find((m) => m.author === 'owner'));
    assert.ok(ownerMsg.revocableUntil);
    const r1 = await revoke(convId, ownerMsg.id);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(fake.state.revoked.at(-1).messageId, own.payload.id);

    // 墨鸽里撤回成功后，WAHA 推来的撤回通知（source=api）：已经标过，不改成手机
    const b = await operatorSend(convId, '第二句');
    const r2 = await revoke(convId, b.id);
    assert.equal(r2.status, 200);
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: keyOf(b.id), fromMe: true, source: 'api' })), 'ignored_duplicate');
    assert.deepEqual((await msgById(convId, b.id)).revoked, r2.body.revoked);
  });

  it('撤回通知比接口响应先到：按点撤回的成员记，不当成手机上撤回；接口返回后不再改', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    await customerSays(manual, chat, 'hi');
    const sent = await operatorSend(convId, '这句马上撤回');
    const started = fake.state.revokeStarted.length;
    fake.state.revokeDelayMs = 300;
    try {
      const pending = revoke(convId, sent.id);
      await waitFor(() => fake.state.revokeStarted.length > started);
      // 有的引擎不带 source：靠墨鸽记下的撤回尝试认出是这个成员
      const ts = Math.floor(Date.now() / 1000) - 1;
      assert.equal(await event(wahaRevoked({ session, chat, revokedId: keyOf(sent.id), fromMe: true, timestamp: ts })), 'revoked_member');
      const r = await pending;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.revoked, { at: new Date(ts * 1000).toISOString(), by: 'member', userId: me.id, name: me.name });
    } finally {
      fake.state.revokeDelayMs = 0;
    }
  });

  it('客户撤回：对上私聊里客户的那条消息，标「客户已撤回」，原文保留；重复推的、对不上的、群里的忽略；chat id 变成 @lid 的也能对上', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    const key = newKey();
    const msg = await customerSays(manual, chat, '我要 300 个，送到上海', key);
    const ts = Math.floor(Date.now() / 1000) - 5;
    const ev = wahaRevoked({ session, chat, revokedId: key, timestamp: ts });
    assert.equal(await event(ev), 'revoked_customer');
    const m = await msgById(convId, msg.id);
    assert.equal(m.text, '我要 300 个，送到上海');
    assert.deepEqual(m.revoked, { at: new Date(ts * 1000).toISOString(), by: 'customer', userId: null, name: null });
    assert.equal(m.revocableUntil, null);
    assert.equal(await event(ev), 'ignored_duplicate');

    // 对不上：库里没有这个 ID；客户的撤回通知只对客户的消息（ID 撞上我方消息也不动）
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: newKey() })), 'ignored_revoke_unknown');
    const ours = await operatorSend(convId, '好的');
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: keyOf(ours.id) })), 'ignored_revoke_unknown');
    assert.equal(row(ours.id).revoked_at, null);
    // 群里的撤回（墨鸽不收群消息）：忽略，ID 撞上私聊的消息也不动
    const key2 = newKey();
    const msg2 = await customerSays(manual, chat, '第二句', key2);
    const group = wahaRevoked({ session, chat: '120363012345678901@g.us', revokedId: key2, sender: `${chat.replace('@c.us', '')}@s.whatsapp.net` });
    assert.equal(await event(group), 'ignored_non_private');
    assert.equal(row(msg2.id).revoked_at, null);
    // 同一个客户的 chat id 这次是 @lid：在这个号的所有会话里找
    assert.equal(await event(wahaRevoked({ session, chat: '99887766554433@lid', revokedId: key2 })), 'revoked_customer');
    assert.equal(row(msg2.id).revoked_by, 'customer');

    // 走签名的 webhook 也一样（路由不挑事件）
    const key3 = newKey();
    const msg3 = await customerSays(manual, chat, '第三句', key3);
    assert.equal((await postWaha(t, wahaRevoked({ session, chat, revokedId: key3 }))).status, 200);
    await waitFor(() => row(msg3.id).revoked_at, { message: 'webhook 推来的撤回迟迟没有标上' });
  });

  it('客户撤回还没处理的消息：不按它回复，记为跳过（客户撤回了这条消息）；之后的消息照常回复，上下文里没有撤回的那句', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.5 } } });
    try {
      const chat = newChat();
      const convId = cid(auto, chat);
      const key = newKey();
      const calls = hooks.calls.generate;
      await wahaSend(t, auto, chat, '发错了：要 999 个红色的', { id: `false_${chat}_${key}` });
      await waitFor(() => t.ctx.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ?').get(convId));
      assert.equal(await event(wahaRevoked({ session: auto.waha.sessionName, chat, revokedId: key })), 'revoked_customer');
      await wahaSend(t, auto, chat, '保温杯 A100 多少钱');
      const list = await waitDecided(t, convId, 2);
      await waitFor(() => fake.sentTo(chat).length === 1);
      const revoked = list.find((m) => m.text.startsWith('发错了'));
      assert.equal(revoked.botDecision, 'skipped');
      assert.equal(revoked.decisionReason, REVOKED_SKIP_REASON);
      assert.equal(hooks.calls.generate, calls + 1, '只按没撤回的那句生成了一次');
      assert.equal(hooks.args.generate.message, '保温杯 A100 多少钱');
      assert.deepEqual(hooks.args.generate.history, []);
    } finally {
      await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    }
  });

  it('生成回复期间客户撤回了这一轮的消息：生成好的回复不发', async () => {
    const chat = newChat();
    const convId = cid(auto, chat);
    const key = newKey();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const calls = hooks.calls.generate;
    hooks.generate = async (args, m) => {
      await gate;
      return m.generate(args);
    };
    try {
      await wahaSend(t, auto, chat, '保温杯 A100 多少钱，发错了', { id: `false_${chat}_${key}` });
      await waitFor(() => hooks.calls.generate > calls, { message: '迟迟没开始生成' });
      assert.equal(await event(wahaRevoked({ session: auto.waha.sessionName, chat, revokedId: key })), 'revoked_customer');
      release();
      await waitFor(() => t.log.lines.some((l) => l.includes(`会话 ${convId} 生成回复期间客户撤回了消息`)));
      await waitFor(() => t.ctx.wa.idle());
      await sleep(100);
      assert.equal(fake.sentTo(chat).length, 0);
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'skipped');
      assert.equal(m.decisionReason, REVOKED_SKIP_REASON);
    } finally {
      hooks.generate = null;
      release();
    }
  });

  it('客户撤回还在下载的图片：不再拿去识图，记为跳过，不回复', async () => {
    assert.equal((await t.req('PUT', '/api/settings', { body: { media: { image: true } } })).status, 200);
    try {
      const chat = newChat();
      const convId = cid(auto, chat);
      const session = auto.waha.sessionName;
      const key = newKey();
      // 文件晚 300ms 才给：撤回时还在下载
      const p = `${session}/REVOKED${key}.jpeg`;
      fake.state.files.set(p, { buffer: fakeJpeg(), mime: 'image/jpeg', delayMs: 300 });
      const media = { url: `http://waha:3000/api/files/${p}`, mimetype: 'image/jpeg', filename: null };
      const calls = hooks.calls.describeImage;
      await postWaha(t, wahaMessage({ id: `false_${chat}_${key}`, from: chat, hasMedia: true, media, session }));
      await waitFor(() => t.ctx.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ?').get(convId));
      await waitFor(() => fake.state.requests.some((r) => r.path === `/api/files/${p}`), { message: '迟迟没开始下载' });
      assert.equal(await event(wahaRevoked({ session, chat, revokedId: key })), 'revoked_customer');
      await waitFor(() => t.ctx.wa.idle(), { message: '识别迟迟没收尾' });
      await sleep(100);
      assert.equal(hooks.calls.describeImage, calls, '没有拿去识图');
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'skipped');
      assert.equal(m.decisionReason, REVOKED_SKIP_REASON);
      assert.equal(m.revoked.by, 'customer');
      assert.equal(fake.sentTo(chat).length, 0);
    } finally {
      await t.req('PUT', '/api/settings', { body: { media: { image: false } } });
    }
  });

  it('撤回过的消息不进自动回复和转人工草稿的上下文：客户撤回的、我方撤回的都不带', async () => {
    const chat = newChat();
    const convId = cid(auto, chat);
    const session = auto.waha.sessionName;
    const key = newKey();
    await wahaSend(t, auto, chat, '保温杯 A100 要红色的', { id: `false_${chat}_${key}` });
    await waitFor(() => fake.sentTo(chat).length === 1);
    const r1 = (await getMessages(t, convId)).find((m) => m.author === 'bot');
    // 客户撤回第一句，业务员撤回机器人的回复（不暂停机器人）
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: key })), 'revoked_customer');
    assert.equal((await revoke(convId, r1.id)).status, 200);

    await wahaSend(t, auto, chat, '保温杯 A100 有现货吗');
    await waitFor(() => fake.sentTo(chat).length === 2);
    assert.equal(hooks.args.generate.message, '保温杯 A100 有现货吗');
    assert.deepEqual(hooks.args.generate.history, [], '撤回的两条都不在最近对话里');
    const r2 = (await getMessages(t, convId)).filter((m) => m.author === 'bot').at(-1);

    const drafts = hooks.calls.draft;
    await wahaSend(t, auto, chat, '我要人工');
    await waitFor(() => hooks.calls.draft > drafts, { message: '转人工草稿迟迟没有起草' });
    assert.deepEqual(hooks.args.draft.history, [
      { role: 'customer', text: '保温杯 A100 有现货吗' },
      { role: 'bot', text: r2.text },
    ]);
  });

  it('撤回过的消息不进推荐回复（含跟进）的上下文；我方唯一的回复撤回了，按客户的消息还没回过起草', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    await customerSays(manual, chat, '保温杯 A100 多少钱');
    const key = newKey();
    await customerSays(manual, chat, '再加 50 个盖子（发错了）', key);
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: key })), 'revoked_customer');
    const suggest = async () => {
      const r = await t.req('POST', `${convPath(convId)}/suggest`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return hooks.args.suggest;
    };
    let a = await suggest();
    assert.equal(a.followUp, false);
    assert.equal(a.message, '保温杯 A100 多少钱');
    assert.ok(!JSON.stringify(a).includes('盖子'));

    const o1 = await operatorSend(convId, '59 元一个，明天发报价单');
    const o2 = await operatorSend(convId, '另外送你 10 个杯套（说错了）');
    assert.equal((await revoke(convId, o2.id)).status, 200);
    a = await suggest();
    assert.equal(a.followUp, true);
    assert.deepEqual(a.ourMessages, ['59 元一个，明天发报价单']);
    assert.ok(!JSON.stringify(a).includes('杯套'));
    assert.ok(!JSON.stringify(a).includes('盖子'));

    assert.equal((await revoke(convId, o1.id)).status, 200);
    a = await suggest();
    assert.equal(a.followUp, false);
    assert.equal(a.message, '保温杯 A100 多少钱');
    assert.deepEqual(a.history, []);
  });

  it('存进知识库：撤回过的人工回复不能存（400），客户撤回的提问不当成问题', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    await customerSays(manual, chat, '保温杯 A100 能刻字吗');
    const key = newKey();
    await customerSays(manual, chat, '你们老板电话多少（发错了）', key);
    assert.equal(await event(wahaRevoked({ session: manual.waha.sessionName, chat, revokedId: key })), 'revoked_customer');
    const answer = await operatorSend(convId, '可以刻字，免费');
    const kbDraft = (id) => t.req('POST', `${convPath(convId)}/messages/${id}/kb-draft`);
    assert.equal((await kbDraft(answer.id)).status, 200);
    assert.equal(hooks.args.kbDraft.question, '保温杯 A100 能刻字吗');
    assert.equal((await revoke(convId, answer.id)).status, 200);
    const calls = hooks.calls.kbDraft;
    const r = await kbDraft(answer.id);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'message_revoked');
    assert.equal(hooks.calls.kbDraft, calls);
  });

  it('一键翻译判断客户语言、客户线索提取都不带撤回过的消息', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    await customerSays(manual, chat, 'Hola, me llamo Ana, quiero 100 termos');
    const key = newKey();
    await customerSays(manual, chat, 'こんにちは、私の名前は花子です', key);
    assert.equal(await event(wahaRevoked({ session, chat, revokedId: key })), 'revoked_customer');
    const tr = await t.req('POST', `${convPath(convId)}/translate`, { body: { text: '有现货' } });
    assert.equal(tr.status, 200, JSON.stringify(tr.body));
    assert.deepEqual(spy.translate.customerMessages, ['Hola, me llamo Ana, quiero 100 termos']);

    // 线索：会话安静 10 分钟以上、有人回过才提取；把这个会话的消息都挪到 20 分钟前
    await operatorSend(convId, 'Hola Ana');
    t.ctx.db.prepare('UPDATE messages SET ts = ? WHERE conversation_id = ?').run(new Date(Date.now() - 20 * 60_000).toISOString(), convId);
    spy.leads = [];
    const r = await t.ctx.leads.scan();
    assert.ok(r.extracted.includes(convId));
    const call = spy.leads.find((c) => c.messages.some((m) => m.text.includes('Ana')));
    assert.ok(call);
    assert.ok(!call.messages.some((m) => m.text.includes('花子')));
  });

  it('已有的号：服务启动时补订阅 message.revoked（推一次新配置）；已经有的不再推', async () => {
    const session = manual.waha.sessionName;
    t.ctx.db.prepare('UPDATE accounts SET waha_config_hash = ? WHERE id = ?').run('old-hash', manual.id);
    fake.state.sessions.get(session).config.webhooks[0].events = ['message.any', 'session.status'];
    const puts = () => fake.state.requests.filter((r) => r.method === 'PUT' && r.path === `/api/sessions/${session}`).length;
    const before = puts();
    await t.ctx.wa.init();
    await waitFor(() => puts() === before + 1, { message: '没有把新配置推给 WAHA' });
    assert.deepEqual(fake.state.sessions.get(session).config.webhooks[0].events, ['message.any', 'message.revoked', 'session.status']);
    await waitFor(() => t.ctx.accounts.get(manual.id).wahaConfigHash !== 'old-hash');
    await t.ctx.wa.init();
    await sleep(100);
    assert.equal(puts(), before + 1, '已经订阅了的不再推');
  });
});
