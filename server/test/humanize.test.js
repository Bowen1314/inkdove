import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { splitReply } from '../src/wa/service.js';
import {
  aiHooks,
  convIdOf,
  convPath,
  getMessages,
  sleep,
  startApp,
  startFakeWaha,
  waitDecided,
  waitFor,
  wahaSend,
} from './helpers.js';

const P1 = 'The A100 is ¥59 per piece and holds 500ml, a good size for daily commuting, and it keeps drinks warm for hours.';
const P2 = 'It comes in a few colors. Most customers pick the matte black one because it hides scratches well.';
const P3 = 'Tell me which color you like and roughly how many pieces you need.';
const P4 = 'Shipping can be sorted out after that.';

let seq = 0;
const newChat = () => `86137${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('F14 拆条规则', () => {
  it('两段及以上且总长 > 160 才拆；最多 3 条，多出来的并进第 3 条', () => {
    assert.deepEqual(splitReply('A100 is ¥59.\n\nWhich color?'), ['A100 is ¥59.\n\nWhich color?'], '短的不拆');
    assert.deepEqual(splitReply(`${P1} ${P2} ${P3}`), [`${P1} ${P2} ${P3}`], '一段不拆');
    assert.deepEqual(splitReply(`${P1}\n\n${P2}`), [P1, P2]);
    assert.deepEqual(splitReply(`${P1}\n\n${P2}\n  \n${P3}`), [P1, P2, P3]);
    assert.deepEqual(splitReply(`${P1}\n\n${P2}\n\n${P3}\n\n${P4}`), [P1, P2, `${P3}\n\n${P4}`]);
  });
});

describe('F1 / F14 拟真发送（等待注入成 0）', () => {
  let t;
  let fake;
  let hooks;
  let acc;
  const decisions = [];
  const send = (from, body, extra) => wahaSend(t, acc, from, body, extra);
  const cid = (chat) => convIdOf(acc, chat);
  const longReply = (n) => [P1, P2, P3, P4].slice(0, n).join('\n\n');
  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url },
      options: { aiOverrides: hooks.overrides, onDecision: (d) => decisions.push(d) },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.2 } } });
    acc = await t.createAccount({ autoReply: true });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });
  afterEach(async () => {
    hooks.generate = null;
    await t.req('PUT', '/api/settings', { body: { reply: { humanize: true } } });
  });

  it('replied：标已读（带这一轮的全部消息 id）→ 正在输入 → 停止输入 → 发送', async () => {
    const chat = newChat();
    const id1 = `false_${chat}_A${Date.now()}`;
    const id2 = `false_${chat}_B${Date.now()}`;
    await send(chat, '保温杯多少钱', { id: id1 });
    await sleep(50);
    await send(chat, '容量多大', { id: id2 });
    await waitDecided(t, cid(chat), 2);
    await waitFor(() => fake.sentTo(chat).length === 1);
    assert.deepEqual(fake.timelineFor(chat), ['seen', 'typing', 'paused', 'send']);
    assert.deepEqual(fake.seenFor(chat), [{ session: acc.waha.sessionName, chatId: chat, messageIds: [id1, id2] }]);
    const pres = fake.presenceFor(chat);
    assert.deepEqual(pres.map((p) => p.presence), ['typing', 'paused']);
    assert.equal(pres[0].session, acc.waha.sessionName);
  });

  it('转人工、离题、被拦截、跳过：不标已读，不显示正在输入', async () => {
    const chats = [newChat(), newChat(), newChat()];
    await send(chats[0], '我要人工');
    await send(chats[1], '帮我写代码');
    hooks.generate = (args, mock) =>
      /保温杯/.test(args.message)
        ? { category: 'business', reply: 'A100 现在 39 元', usedEntryIds: [args.entries[0].id], reason: 'x' }
        : mock.generate(args);
    await send(chats[2], '保温杯多少钱');
    const d = await Promise.all(chats.map((c) => waitDecided(t, cid(c), 1)));
    assert.deepEqual(d.map((m) => m[0].botDecision), ['handoff', 'offtopic', 'blocked']);
    // 跳过：暂停中的会话
    await send(chats[0], '在吗');
    await waitDecided(t, cid(chats[0]), 2);
    await sleep(150);
    for (const c of chats) {
      assert.deepEqual(fake.timelineFor(c), [], c);
    }
  });

  it('后台人工发送：不标已读、不显示正在输入，直接发', async () => {
    const chat = newChat();
    await send(chat, '我要人工');
    await waitDecided(t, cid(chat), 1);
    const r = await t.req('POST', `${convPath(cid(chat))}/send`, { body: { text: '我来了' } });
    assert.equal(r.body.status, 'sent');
    assert.deepEqual(fake.timelineFor(chat), ['send']);
  });

  it('长回复拆成 3 条：每条前都有正在输入；各存一条、带同一组 usedEntryIds；处理记录只算一次', async () => {
    const chat = newChat();
    let entryId;
    hooks.generate = ({ entries }) => {
      entryId = entries[0].id;
      return { category: 'business', reply: longReply(3), usedEntryIds: [entryId], reason: 'x' };
    };
    const before = decisions.length;
    await send(chat, '保温杯多少钱');
    await waitDecided(t, cid(chat), 1);
    await waitFor(() => fake.sentTo(chat).length === 3);
    assert.deepEqual(fake.sentTo(chat).map((m) => m.text), [P1, P2, P3]);
    assert.deepEqual(fake.timelineFor(chat), ['seen', 'typing', 'paused', 'send', 'typing', 'paused', 'send', 'typing', 'paused', 'send']);
    const msgs = await getMessages(t, cid(chat));
    const out = msgs.filter((m) => m.direction === 'out');
    assert.equal(out.length, 3);
    assert.ok(out.every((m) => m.author === 'bot' && m.status === 'sent' && m.usedEntryIds.length === 1 && m.usedEntryIds[0] === entryId));
    const parts = t.ctx.db.prepare("SELECT part_index FROM messages WHERE conversation_id = ? AND direction = 'out' ORDER BY seq").all(cid(chat));
    assert.deepEqual(parts.map((p) => p.part_index), [0, 1, 2]);
    assert.equal(msgs.filter((m) => m.direction === 'in')[0].botDecision, 'replied');
    const mine = decisions.slice(before).filter((d) => d.conversationId === cid(chat));
    assert.equal(mine.length, 1, 'onDecision 只调一次');
    assert.equal(mine[0].decision, 'replied');
    assert.equal(mine[0].code, 'business');
    assert.equal(mine[0].accountId, acc.id);
  });

  it('超过 3 段：后面的段落并进第 3 条；短的多段回复不拆', async () => {
    const chat = newChat();
    hooks.generate = ({ entries }) => ({ category: 'business', reply: longReply(4), usedEntryIds: [entries[0].id], reason: 'x' });
    await send(chat, '保温杯多少钱');
    await waitFor(() => fake.sentTo(chat).length === 3);
    await sleep(100);
    assert.deepEqual(fake.sentTo(chat).map((m) => m.text), [P1, P2, `${P3}\n\n${P4}`]);
    const chat2 = newChat();
    hooks.generate = ({ entries }) => ({ category: 'business', reply: 'A100 is ¥59.\n\nWhich color?', usedEntryIds: [entries[0].id], reason: 'x' });
    await send(chat2, '保温杯多少钱');
    await waitFor(() => fake.sentTo(chat2).length === 1);
    await sleep(100);
    assert.equal(fake.sentTo(chat2).length, 1);
  });

  it('拆开的回复按一条算每小时回复上限', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { maxBotRepliesPerChatPerHour: 2 } } });
    try {
      const chat = newChat();
      hooks.generate = ({ entries }) => ({ category: 'business', reply: longReply(3), usedEntryIds: [entries[0].id], reason: 'x' });
      await send(chat, '保温杯多少钱');
      await waitDecided(t, cid(chat), 1);
      await waitFor(() => fake.sentTo(chat).length === 3);
      await send(chat, '还有别的颜色吗');
      const m = await waitDecided(t, cid(chat), 2);
      assert.equal(m.filter((x) => x.direction === 'in').at(-1).botDecision, 'replied', '第 2 次回复没超限');
    } finally {
      await t.req('PUT', '/api/settings', { body: { reply: { maxBotRepliesPerChatPerHour: 20 } } });
    }
  });

  it('humanize 关闭：不标已读、不显示正在输入，长回复也只发一条', async () => {
    await t.req('PUT', '/api/settings', { body: { reply: { humanize: false } } });
    const chat = newChat();
    hooks.generate = ({ entries }) => ({ category: 'business', reply: longReply(3), usedEntryIds: [entries[0].id], reason: 'x' });
    await send(chat, '保温杯多少钱');
    await waitFor(() => fake.sentTo(chat).length === 1);
    await sleep(100);
    assert.deepEqual(fake.timelineFor(chat), ['send']);
    assert.equal(fake.sentTo(chat)[0].text, longReply(3));
  });
});

describe('F1 / F14 取消：等待期间来了新消息', () => {
  let t;
  let fake;
  let hooks;
  let acc;
  const seenMessages = [];
  const send = (from, body) => wahaSend(t, acc, from, body);
  const cid = (chat) => convIdOf(acc, chat);
  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url },
      options: {
        aiOverrides: hooks.overrides,
        humanize: { preMs: () => 80, typingMs: () => 300, betweenMs: () => 80 },
      },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ autoReply: true });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    hooks.generate = (args) => {
      seenMessages.push(args.message);
      const id = args.entries[0].id;
      if (/容量/.test(args.message) && !/多少钱/.test(args.message)) return { category: 'business', reply: 'It holds 500ml.', usedEntryIds: [id], reason: 'x' };
      if (/长/.test(args.message)) return { category: 'business', reply: [P1, P2, P3].join('\n\n'), usedEntryIds: [id], reason: 'x' };
      return { category: 'business', reply: 'A100 is ¥59 and holds 500ml.', usedEntryIds: [id], reason: 'x' };
    };
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('一条都没发出就来了新消息：取消，新消息合进去从防抖重新走；只回一次，两条都记 replied', async () => {
    const chat = newChat();
    const n = seenMessages.length;
    await send(chat, '保温杯多少钱');
    await waitFor(() => fake.timelineFor(chat).includes('typing'));
    await send(chat, '容量多大');
    const msgs = await waitDecided(t, cid(chat), 2);
    await waitFor(() => fake.sentTo(chat).length === 1);
    await sleep(500);
    assert.equal(fake.sentTo(chat).length, 1);
    assert.equal(fake.sentTo(chat)[0].text, 'A100 is ¥59 and holds 500ml.');
    assert.deepEqual(seenMessages.slice(n), ['保温杯多少钱', '保温杯多少钱\n容量多大']);
    assert.deepEqual(msgs.filter((m) => m.direction === 'in').map((m) => m.botDecision), ['replied', 'replied']);
    assert.deepEqual(fake.timelineFor(chat), ['seen', 'typing', 'paused', 'seen', 'typing', 'paused', 'send']);
    assert.equal(fake.seenFor(chat)[1].messageIds.length, 2);
  });

  it('发了一条之后来了新消息：剩下的不再发，已发的保留；新消息重新走流程', async () => {
    const chat = newChat();
    const n = seenMessages.length;
    await send(chat, '保温杯多少钱，说长一点');
    await waitFor(() => fake.sentTo(chat).length === 1);
    await send(chat, '容量多大');
    const msgs = await waitDecided(t, cid(chat), 2);
    await waitFor(() => fake.sentTo(chat).length === 2);
    await sleep(700);
    assert.deepEqual(fake.sentTo(chat).map((m) => m.text), [P1, 'It holds 500ml.']);
    assert.deepEqual(seenMessages.slice(n), ['保温杯多少钱，说长一点', '容量多大']);
    assert.deepEqual(msgs.filter((m) => m.direction === 'in').map((m) => m.botDecision), ['replied', 'replied']);
    const out = (await getMessages(t, cid(chat))).filter((m) => m.direction === 'out');
    assert.deepEqual(out.map((m) => m.text), [P1, 'It holds 500ml.']);
    assert.ok(t.log.lines.some((l) => l.includes(`会话 ${cid(chat)} 拟真发送被取消：已发 1/3 条`)));
  });

  it('等待期间人工接管：机器人这条不发，客户消息记 skipped（人工已接管）；人工消息立即发出', async () => {
    const chat = newChat();
    await send(chat, '保温杯多少钱');
    await waitFor(() => fake.timelineFor(chat).includes('typing'));
    const started = Date.now();
    const r = await t.req('POST', `${convPath(cid(chat))}/send`, { body: { text: '我是店长，我来回答' } });
    assert.ok(Date.now() - started < 250, '人工发送不等待');
    assert.equal(r.body.status, 'sent');
    await sleep(600);
    assert.deepEqual(fake.sentTo(chat).map((m) => m.text), ['我是店长，我来回答']);
    const msgs = await getMessages(t, cid(chat));
    const inbound = msgs.filter((m) => m.direction === 'in');
    assert.equal(inbound[0].botDecision, 'skipped');
    assert.equal(inbound[0].decisionReason, '人工已接管');
  });
});
