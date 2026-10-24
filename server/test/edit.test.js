// 消息编辑：WAHA 推来的 message.edited（客户改了他的消息、同一个号在手机上改了我方消息）；message.any 推来的编辑协议消息；
// 改了还没处理的按改后的重新处理，生成期间改了的这次不发；改前的版本留着，最多 EDIT_HISTORY_MAX 个；存下的译文作废。
// Telegram 的 edited_message / edited_business_message 在 telegram.test.js 里测
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { EDIT_HISTORY_MAX, messageKeyId } from '../src/wa/service.js';
import { aiHooks, convIdOf, convPath, getMessages, sleep, startApp, startFakeWaha, waitDecided, waitFor, wahaSend } from './helpers.js';

let seq = 0;
const newNumber = () => `86136${String(Date.now() % 1e5).padStart(5, '0')}${String(++seq).padStart(2, '0')}`;
const newChat = () => `${newNumber()}@c.us`;
/** WhatsApp 消息 ID（key.ID）的样子：大写十六进制 */
const newKey = () => `3EB0${Date.now().toString(16).toUpperCase()}${String(++seq).padStart(4, '0')}`;

let editSeq = 0;
/**
 * WAHA 的 message.edited 事件，按 WAHA 文档的形状：payload 是编辑那条协议消息转成的 WAMessage，另带 editedMessageId
 * （被改消息的 key.ID，不带前缀）和 body（改后的内容）；原始消息里是 protocolMessage（type 14 = MESSAGE_EDIT）。
 * bare=true 时只给原始消息（没有 editedMessageId 和 body），event 可以换成 message.any
 */
function wahaEdited({ session, chat, editedId, text, fromMe = false, bare = false, event = 'message.edited' } = {}) {
  editSeq++;
  const jid = chat.replace(/@c\.us$/, '@s.whatsapp.net');
  const protoId = `3EB0EDIT${String(editSeq).padStart(6, '0')}`;
  const raw = {
    Info: { Chat: jid, IsFromMe: fromMe, ID: protoId },
    Message: { protocolMessage: { type: 14, key: { remoteJID: jid, fromMe, ID: editedId }, editedMessage: { conversation: text } } },
  };
  return {
    id: `evt_edit_${editSeq}`,
    timestamp: Date.now(),
    event,
    session,
    engine: 'GOWS',
    payload: {
      id: `${fromMe}_${chat}_${protoId}`,
      timestamp: Math.floor(Date.now() / 1000),
      ...(bare ? {} : { from: chat, fromMe, to: fromMe ? null : '19990000000@c.us', body: text, editedMessageId: editedId }),
      hasMedia: false,
      _data: raw,
    },
  };
}

describe('消息编辑', () => {
  let t;
  let fake;
  let hooks;
  let auto; // 自动回复的号
  let manual; // 人工回复的号

  const cid = (acc, chat) => convIdOf(acc, chat);
  const row = (id) => t.ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const keyOf = (msgId) => messageKeyId(row(msgId).external_id);
  const event = (ev) => t.ctx.wa.handleWahaWebhook(ev);
  const msgById = async (convId, id) => (await getMessages(t, convId)).find((m) => m.id === id);

  async function customerSays(acc, chat, text, key = null) {
    const convId = cid(acc, chat);
    const n = t.ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND direction = 'in'").get(convId).n;
    await wahaSend(t, acc, chat, text, key ? { id: `false_${chat}_${key}` } : {});
    const list = await waitDecided(t, convId, n + 1);
    return list.filter((m) => m.direction === 'in').at(-1);
  }

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url }, options: { aiOverrides: hooks.overrides } });
    await t.login();
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

  it('客户改了已经回复过的消息：换成改后的内容，改前的留在 edited.history；不再回复一次；重复推的不改', async () => {
    const chat = newChat();
    const convId = cid(auto, chat);
    const session = auto.waha.sessionName;
    const m = await customerSays(auto, chat, '保温杯 A100 多少钱');
    await waitFor(() => fake.sentTo(chat).length === 1);
    assert.equal(m.edited, null);
    const calls = hooks.calls.generate;
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '保温杯 A100 多少钱？要两个' })), 'edited');
    const e = await msgById(convId, m.id);
    assert.equal(e.text, '保温杯 A100 多少钱？要两个');
    assert.ok(Date.now() - Date.parse(e.edited.at) < 5000);
    assert.deepEqual(e.edited.history, [{ text: '保温杯 A100 多少钱', at: m.ts }]);
    assert.equal(e.botDecision, 'replied', '处理结果不变');
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '保温杯 A100 多少钱？要两个' })), 'ignored_duplicate');
    await sleep(150);
    assert.equal(hooks.calls.generate, calls, '改了已经回复过的不再生成');
    assert.equal(fake.sentTo(chat).length, 1);
    assert.equal((await msgById(convId, m.id)).edited.history.length, 1);
  });

  it('对不上的、群里的、撤回过的、没有 ID 的不改', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    const m = await customerSays(manual, chat, '原话');
    assert.equal(await event(wahaEdited({ session, chat, editedId: newKey(), text: '改了' })), 'ignored_edit_unknown');
    assert.equal(await event(wahaEdited({ session, chat: '120363012345678901@g.us', editedId: keyOf(m.id), text: '改了' })), 'ignored_non_private');
    const noId = wahaEdited({ session, chat, editedId: undefined, text: '改了' });
    assert.equal(await event(noId), 'ignored_edit');
    // 客户撤回了这条以后又推来编辑：撤回的原文不动
    t.ctx.db.prepare("UPDATE messages SET revoked_at = ?, revoked_by = 'customer' WHERE id = ?").run(new Date().toISOString(), m.id);
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '改了' })), 'ignored_revoked');
    const after = await msgById(convId, m.id);
    assert.equal(after.text, '原话');
    assert.equal(after.edited, null);
  });

  it('同一个号在手机上改了我方消息：按 fromMe 只找我方消息；只给原始消息（没有 editedMessageId、body）也认', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    const c = await customerSays(manual, chat, '你好');
    const sent = await t.req('POST', `${convPath(convId)}/send`, { body: { text: '59 元一个' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    // 客户消息的 ID 当成我方改的：对不上
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(c.id), text: '改了', fromMe: true })), 'ignored_edit_unknown');
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(sent.body.id), text: '59 元一个，两个 110 元', fromMe: true, bare: true })), 'edited');
    const e = await msgById(convId, sent.body.id);
    assert.equal(e.text, '59 元一个，两个 110 元');
    assert.deepEqual(e.edited.history.map((h) => h.text), ['59 元一个']);
    assert.equal(e.author, 'operator', '还是原来发的人');
  });

  it('message.any 推来的编辑协议消息按编辑处理，不存成一条新消息', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    const m = await customerSays(manual, chat, '要 3 个');
    const n = (await getMessages(t, convId)).length;
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '要 5 个', bare: true, event: 'message.any' })), 'edited');
    // 两边都推：message.edited 再来一次，内容没变
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '要 5 个' })), 'ignored_duplicate');
    const list = await getMessages(t, convId);
    assert.equal(list.length, n);
    assert.equal(list.find((x) => x.id === m.id).text, '要 5 个');
  });

  it('改了还没处理的消息（防抖中）：按改后的内容生成一次', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.5 } } });
    try {
      const chat = newChat();
      const convId = cid(auto, chat);
      const key = newKey();
      const calls = hooks.calls.generate;
      await wahaSend(t, auto, chat, '保温杯 A100 要 999 个', { id: `false_${chat}_${key}` });
      await waitFor(() => t.ctx.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ?').get(convId));
      assert.equal(await event(wahaEdited({ session: auto.waha.sessionName, chat, editedId: key, text: '保温杯 A100 要 9 个' })), 'edited');
      await waitDecided(t, convId, 1);
      await waitFor(() => fake.sentTo(chat).length === 1);
      assert.equal(hooks.calls.generate, calls + 1);
      assert.equal(hooks.args.generate.message, '保温杯 A100 要 9 个');
    } finally {
      await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    }
  });

  it('生成回复期间客户改了这一轮的消息：生成好的回复不发，按改后的重新生成、只发一次', async () => {
    const chat = newChat();
    const convId = cid(auto, chat);
    const key = newKey();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const calls = hooks.calls.generate;
    hooks.generate = async (args, m) => {
      if (args.message.includes('999')) await gate;
      return m.generate(args);
    };
    try {
      await wahaSend(t, auto, chat, '保温杯 A100 要 999 个', { id: `false_${chat}_${key}` });
      await waitFor(() => hooks.calls.generate > calls, { message: '迟迟没开始生成' });
      assert.equal(await event(wahaEdited({ session: auto.waha.sessionName, chat, editedId: key, text: '保温杯 A100 要 9 个' })), 'edited');
      release();
      await waitFor(() => t.log.lines.some((l) => l.includes(`会话 ${convId} 生成回复期间客户改了消息`)));
      await waitFor(() => fake.sentTo(chat).length === 1, { message: '改后的没有回复' });
      await waitFor(() => t.ctx.wa.idle());
      await sleep(100);
      assert.equal(fake.sentTo(chat).length, 1, '改前的那份没发');
      assert.equal(hooks.calls.generate, calls + 2);
      assert.equal(hooks.args.generate.message, '保温杯 A100 要 9 个');
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'replied');
    } finally {
      hooks.generate = null;
      release();
    }
  });

  it(`改前的版本最多留 ${EDIT_HISTORY_MAX} 个，原文一直留着；存下的译文作废`, async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    const m = await customerSays(manual, chat, 'v0');
    t.ctx.db.prepare('UPDATE messages SET translation = ? WHERE id = ?').run(JSON.stringify({ text: '旧译文', via: 'llm', createdAt: m.ts }), m.id);
    assert.ok((await msgById(convId, m.id)).translation);
    for (let i = 1; i <= EDIT_HISTORY_MAX + 3; i++) {
      assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: `v${i}` })), 'edited');
    }
    const e = await msgById(convId, m.id);
    assert.equal(e.text, `v${EDIT_HISTORY_MAX + 3}`);
    assert.equal(e.translation, null);
    const texts = e.edited.history.map((h) => h.text);
    assert.equal(texts.length, EDIT_HISTORY_MAX);
    assert.equal(texts[0], 'v0', '原文留着');
    assert.deepEqual(texts.slice(1), Array.from({ length: EDIT_HISTORY_MAX - 1 }, (_, i) => `v${i + 4}`), '中间的丢掉最早的');
    assert.equal(e.edited.history[0].at, m.ts);
  });

  it('媒体消息改的是说明文字，改成空的只剩标签；识别过的语音、图片不改', async () => {
    const chat = newChat();
    const convId = cid(manual, chat);
    const session = manual.waha.sessionName;
    const m = await customerSays(manual, chat, '这个杯子');
    // 当成一条带说明的图片
    const media = JSON.stringify({ type: 'image', mime: 'image/jpeg', size: 100, filename: null, stored: 'ok', error: null, fileKey: null });
    t.ctx.db.prepare('UPDATE messages SET media = ? WHERE id = ?').run(media, m.id);
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '这个杯子有蓝色吗' })), 'edited');
    let r = row(m.id);
    assert.deepEqual([r.kind, r.text], ['text', '这个杯子有蓝色吗']);
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '' })), 'edited');
    r = row(m.id);
    assert.deepEqual([r.kind, r.text], ['media', '[图片]']);
    // 识别过的（描述和说明拼在一起）不改
    t.ctx.db.prepare("UPDATE messages SET kind = 'text', text = ? WHERE id = ?").run('[图片] 一个蓝色的杯子\n这个杯子', m.id);
    assert.equal(await event(wahaEdited({ session, chat, editedId: keyOf(m.id), text: '改了' })), 'ignored_edit_media');
    assert.equal((await msgById(convId, m.id)).text, '[图片] 一个蓝色的杯子\n这个杯子');
  });
});
