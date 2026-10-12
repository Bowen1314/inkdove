// 关联后导入已有聊天（WAHA）：号进入 WORKING 后把 WAHA 里已有的聊天导进「会话」，导入的消息是静默的。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { HISTORY_CHAT_LIMIT, HISTORY_MESSAGES_PER_CHAT } from '../src/wa/service.js';
import {
  aiHooks,
  convIdOf,
  getConv,
  getMessages,
  postWaha,
  sleep,
  startApp,
  startFakeWaha,
  waitDecided,
  waitFor,
  wahaHistoryMessage,
  wahaMessage,
} from './helpers.js';

const T2022 = Math.floor(Date.parse('2022-03-04T05:06:07Z') / 1000);
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec) => new Date(sec * 1000).toISOString();
const SKIP_REASON = '导入的历史消息，机器人不处理';

let seq = 0;
const newNumber = () => `86139${String(Date.now() % 1e5).padStart(5, '0')}${String(++seq).padStart(2, '0')}`;

describe('关联后导入已有聊天（WAHA）', () => {
  let t;
  let fake;
  let hooks;
  const decisions = [];

  before(async () => {
    fake = await startFakeWaha({ initialStatus: 'SCAN_QR_CODE' });
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url },
      options: { aiOverrides: hooks.overrides, onDecision: (row) => decisions.push(row) },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    const s = await t.req('PUT', '/api/settings', {
      body: { reply: { debounceSeconds: 0.05 }, media: { voice: true, image: true, transcribeModel: 'whisper-1' } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  /** 新建一个开着自动回复的号并启动（假 WAHA 停在等待关联），把 chats 放进假 WAHA */
  async function newAccount(patch = {}, chats = []) {
    const acc = await t.createAccount({ name: `导入测试号${++seq}`, autoReply: true, ...patch });
    const st = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    assert.equal(st.body.state, 'scan_qr');
    fake.state.chats.set(acc.waha.sessionName, chats);
    return acc;
  }
  const pushStatus = (acc, status) => postWaha(t, { event: 'session.status', session: acc.waha.sessionName, payload: { status } });
  /** 模拟在手机上完成关联：session 变成 WORKING，WAHA 推 session.status */
  async function link(acc) {
    const s = fake.state.sessions.get(acc.waha.sessionName);
    s.status = 'WORKING';
    s.me = { id: '19990000000@c.us', pushName: 'Shop' };
    assert.equal((await pushStatus(acc, 'WORKING')).status, 200);
  }
  /** 掉线再连上 */
  async function relink(acc) {
    await pushStatus(acc, 'STARTING');
    await pushStatus(acc, 'WORKING');
  }
  const importLines = (acc) => t.log.lines.filter((l) => l.includes(`号 ${acc.id} 导入已有聊天：`));
  const waitImported = (acc, n = 1) => waitFor(() => importLines(acc).length >= n, { message: '导入迟迟没跑完' });
  const accountConvs = async (acc) => (await t.req('GET', `/api/wa/conversations?accountId=${acc.id}`)).body;

  it('关联后导入：私聊进会话（聊天对象取 chat id），群、广播、频道不收；fromMe 存成手机回复；保留原始时间', async () => {
    const a = newNumber();
    const b = newNumber();
    const chatA = `${a}@c.us`;
    const chatB = `${b}@s.whatsapp.net`;
    const group = '120363000000000000@g.us';
    const acc = await newAccount({}, [
      {
        id: chatA,
        name: '张三',
        messages: [
          wahaHistoryMessage({ chatId: chatA, timestamp: T2022, body: '你好，A100 还有货吗', pushName: '张三的微信名' }),
          wahaHistoryMessage({ chatId: chatA, timestamp: T2022 + 60, body: '有的，今天能发', fromMe: true }),
        ],
      },
      { id: chatB, name: '李四', messages: [wahaHistoryMessage({ chatId: chatB, timestamp: T2022 + 3600, hasMedia: true })] },
      { id: group, name: '客户群', messages: [wahaHistoryMessage({ chatId: group, timestamp: T2022, body: '群消息' })] },
      { id: 'status@broadcast', messages: [wahaHistoryMessage({ chatId: 'status@broadcast', timestamp: T2022, body: '动态' })] },
      { id: '120363000000000001@newsletter', name: '频道', messages: [] },
    ]);
    const session = acc.waha.sessionName;
    const sentBefore = fake.state.sent.length;
    await link(acc);
    await waitImported(acc);

    // 先拉聊天列表，只对要收的私聊读消息：每个最多 20 条，不下载媒体
    const chatReqs = fake.state.requests.filter((r) => decodeURIComponent(r.path).startsWith(`/api/${session}/chats`));
    assert.deepEqual(
      chatReqs.map((r) => `${decodeURIComponent(r.path)}${r.query}`),
      [
        `/api/${session}/chats?limit=${HISTORY_CHAT_LIMIT}`,
        `/api/${session}/chats/${chatA}/messages?limit=${HISTORY_MESSAGES_PER_CHAT}&downloadMedia=false`,
        `/api/${session}/chats/${chatB}/messages?limit=${HISTORY_MESSAGES_PER_CHAT}&downloadMedia=false`,
      ],
    );

    const convs = await accountConvs(acc);
    assert.deepEqual(convs.map((c) => c.id).sort(), [convIdOf(acc, chatA), convIdOf(acc, `${b}@c.us`)].sort(), '@s.whatsapp.net 记成 @c.us');
    const ca = convs.find((c) => c.id === convIdOf(acc, chatA));
    assert.equal(ca.contactName, '张三', '名字取聊天的 name，不取消息里的 PushName');
    assert.equal(ca.contactNumber, a);
    assert.equal(ca.updatedAt, iso(T2022 + 60), '会话时间是最新一条消息的时间');
    assert.deepEqual(ca.lastMessage, { text: '有的，今天能发', direction: 'out', ts: iso(T2022 + 60) });
    assert.equal(ca.needsHuman, false);
    assert.equal(ca.botPaused, false);
    const row = t.ctx.db.prepare('SELECT created_at FROM conversations WHERE id = ?').get(ca.id);
    assert.equal(row.created_at, iso(T2022), '新会话的创建时间是最早一条消息的时间');

    const [m1, m2] = await getMessages(t, ca.id);
    assert.equal((await getMessages(t, ca.id)).length, 2);
    assert.equal(m1.direction, 'in');
    assert.equal(m1.author, 'customer');
    assert.equal(m1.text, '你好，A100 还有货吗');
    assert.equal(m1.ts, iso(T2022));
    assert.equal(m1.via, 'import');
    assert.equal(m1.botDecision, 'skipped');
    assert.equal(m1.decisionReason, SKIP_REASON);
    assert.equal(m1.status, 'received');
    assert.equal(m2.direction, 'out');
    assert.equal(m2.author, 'owner', '本人发的存成手机回复');
    assert.equal(m2.text, '有的，今天能发');
    assert.equal(m2.ts, iso(T2022 + 60));
    assert.equal(m2.via, 'import');
    assert.equal(m2.status, 'sent');
    assert.equal(m2.botDecision, null);

    const cb = convs.find((c) => c.id === convIdOf(acc, `${b}@c.us`));
    assert.equal(cb.contactName, '李四');
    assert.equal(cb.contactNumber, b);
    const [mb] = await getMessages(t, cb.id);
    assert.equal(mb.text, '[媒体消息]', '媒体不下载，和没识别的入站媒体一样只存标签');
    assert.equal(mb.media, null);
    assert.equal(mb.ts, iso(T2022 + 3600));

    assert.equal(fake.state.sent.length, sentBefore, '没发任何消息');
    const lines = importLines(acc);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /2 个聊天、3 条消息，跳过 0 条.*范围外的聊天 3 个/);
    assert.ok(!t.log.lines.some((l) => l.includes(a) || l.includes(b) || l.includes('还有货')), '日志里没有号码和内容');
  });

  it('导入的消息是静默的：不自动回复、不调模型、不通知、不标待处理、不占每日额度、不记缺口', async () => {
    const boss = newNumber();
    const c = newNumber();
    const chat = `${c}@c.us`;
    const old = nowSec() - 30 * 86400;
    const acc = await newAccount({ notify: { whatsapp: { enabled: true, number: boss } } }, [
      {
        id: chat,
        name: '王五',
        messages: [
          wahaHistoryMessage({ chatId: chat, timestamp: old, body: '我要找人工，给我打个折，你是机器人吗' }),
          wahaHistoryMessage({ chatId: chat, timestamp: old + 5, body: '火星车配件有吗' }),
          wahaHistoryMessage({ chatId: chat, timestamp: old + 9, hasMedia: true }),
        ],
      },
    ]);
    const calls = { ...hooks.calls };
    const nDecisions = decisions.length;
    const sentBefore = fake.state.sent.length;
    const gapsBefore = (await t.req('GET', '/api/kb/gaps')).body.length;
    await link(acc);
    await waitImported(acc);
    await sleep(300);

    const cid = convIdOf(acc, chat);
    assert.equal((await getMessages(t, cid)).length, 3);
    assert.deepEqual(hooks.calls, calls, '没调模型（生成、审核、草稿、识图、转写都没有）');
    assert.equal(decisions.length, nDecisions, '没有处理记录');
    assert.equal(fake.state.sent.length, sentBefore, '没回复客户，也没给通知号码发通知');
    assert.equal(fake.seenFor(chat).length, 0);
    assert.equal(fake.presenceFor(chat).length, 0);
    const conv = await getConv(t, cid);
    assert.equal(conv.needsHuman, false, '不进待处理');
    assert.equal(conv.pendingReason, null);
    assert.equal(conv.botPaused, false);
    assert.equal(conv.mutedUntil, null);
    const row = t.ctx.db.prepare('SELECT llm_day, llm_calls FROM conversations WHERE id = ?').get(cid);
    assert.deepEqual({ ...row }, { llm_day: null, llm_calls: 0 }, '不占每日模型额度');
    assert.equal((await t.req('GET', '/api/kb/gaps')).body.length, gapsBefore, '不记缺口');
    const pending = t.ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND handled = 0').get(cid).n;
    assert.equal(pending, 0, '都记为已处理');
    assert.ok(t.ctx.wa.idle());
  });

  it('幂等：掉线再连上重新导入不重复；webhook 再推同一条也不重复；id 前缀不同但短 id 相同的算同一条', async () => {
    const c = newNumber();
    const chat = `${c}@c.us`;
    const m1 = wahaHistoryMessage({ chatId: chat, timestamp: T2022, body: '在吗' });
    const m2 = wahaHistoryMessage({ chatId: chat, timestamp: T2022 + 10, body: '在的', fromMe: true });
    const acc = await newAccount({}, [{ id: chat, name: '赵六', messages: [m1, m2] }]);
    const session = acc.waha.sessionName;
    await link(acc);
    await waitImported(acc);
    const cid = convIdOf(acc, chat);
    assert.equal((await getMessages(t, cid)).length, 2);

    // 同一条消息换了个 id 前缀（比如 @c.us 和 @s.whatsapp.net），短 id 不变
    const short = m2.id.slice(m2.id.lastIndexOf('_') + 1);
    fake.state.chats.get(session)[0].messages.push({ ...m2, id: `true_${c}@s.whatsapp.net_${short}` });
    await relink(acc);
    await waitImported(acc, 2);
    assert.equal((await getMessages(t, cid)).length, 2);
    assert.match(importLines(acc)[1], /0 个聊天、0 条消息，跳过 3 条/);

    // webhook 再推已导入的那条（哪怕时间是新的）：按 id 去重
    const r = await t.ctx.wa.handleWahaWebhook(wahaMessage({ id: m1.id, from: chat, body: '在吗', session, timestamp: nowSec() }));
    assert.equal(r, 'ignored_duplicate');
    assert.equal((await getMessages(t, cid)).length, 2);
    assert.equal(fake.sentTo(chat).length, 0);
  });

  it('会话已存在（新消息先到）就并进去；还没推过来的新消息留给 webhook，照常自动回复', async () => {
    const c = newNumber();
    const chat = `${c}@c.us`;
    const d = newNumber();
    const chatD = `${d}@c.us`;
    const acc = await newAccount();
    const session = acc.waha.sessionName;
    const cid = convIdOf(acc, chat);
    // 导入之前客户先发来一条新消息：照常自动回复
    const live = wahaMessage({ from: chat, body: '保温杯 A100 多少钱', session });
    await postWaha(t, live);
    await waitDecided(t, cid, 1);
    await waitFor(() => fake.sentTo(chat).length === 1);
    const before = await getConv(t, cid);
    assert.equal(before.contactName, '');

    // WAHA 里：c 的聊天有一条 2022 年的旧消息和刚才那条；d 的聊天有一条旧消息和一条还没推过来的新消息
    const fresh = wahaHistoryMessage({ chatId: chatD, timestamp: nowSec(), body: 'A100 多少钱' });
    fake.state.chats.set(session, [
      { id: chat, name: '钱七', messages: [wahaHistoryMessage({ chatId: chat, timestamp: T2022, body: '去年买过' }), { ...live.payload, to: null }] },
      { id: chatD, name: '孙八', messages: [wahaHistoryMessage({ chatId: chatD, timestamp: T2022, body: '老客户' }), fresh] },
    ]);
    await link(acc);
    await waitImported(acc);

    assert.equal((await accountConvs(acc)).length, 2, '没有另建会话');
    const msgs = await getMessages(t, cid);
    assert.equal(msgs.length, 3, '新消息、机器人回复、导入的旧消息');
    const imported = msgs.filter((m) => m.via === 'import');
    assert.deepEqual(
      imported.map((m) => [m.text, m.ts]),
      [['去年买过', iso(T2022)]],
    );
    assert.equal(msgs.filter((m) => m.text === '保温杯 A100 多少钱').length, 1, '已有的那条没重复');
    const after = await getConv(t, cid);
    assert.equal(after.updatedAt, before.updatedAt, '会话时间不会被旧消息往回拨');
    assert.equal(after.contactName, '钱七', '原来没有名字的补上');
    assert.equal(fake.sentTo(chat).length, 1, '导入没有再触发回复');

    // d：旧消息导入了，太新的那条（webhook 会处理的）没导入
    const dm = await getMessages(t, convIdOf(acc, chatD));
    assert.deepEqual(
      dm.map((m) => m.text),
      ['老客户'],
    );
    assert.match(importLines(acc)[0], /2 个聊天、2 条消息，跳过 2 条/);
    // 这条随后由 webhook 推过来：照常归档、自动回复
    await postWaha(t, wahaMessage({ id: fresh.id, from: chatD, body: fresh.body, session, timestamp: fresh.timestamp }));
    const after2 = await waitDecided(t, convIdOf(acc, chatD), 2);
    assert.equal(after2.find((m) => m.text === 'A100 多少钱').botDecision, 'replied');
    await waitFor(() => fake.sentTo(chatD).length === 1);
  });

  it('范围沿用入站规则：黑名单、通知号码不收；lid 换算出号码再判断；白名单模式只收白名单里的', async () => {
    const ok = newNumber();
    const blocked = newNumber();
    const boss = newNumber();
    const lidNum = newNumber();
    const lid = `${Date.now()}${++seq}@lid`;
    fake.state.lids[lid] = `${lidNum}@c.us`;
    const chatOf = (id, name) => ({ id, name, messages: [wahaHistoryMessage({ chatId: id, timestamp: T2022, body: '你好' })] });
    const chats = [chatOf(`${ok}@c.us`, '甲'), chatOf(`${blocked}@c.us`, '乙'), chatOf(`${boss}@c.us`, '老板'), chatOf(lid, '丙')];

    const acc = await newAccount({ blocklist: [blocked], notify: { whatsapp: { enabled: false, number: boss } } }, chats);
    await link(acc);
    await waitImported(acc);
    const convs = await accountConvs(acc);
    assert.deepEqual(convs.map((c) => c.id).sort(), [convIdOf(acc, `${ok}@c.us`), convIdOf(acc, lid)].sort());
    assert.equal(convs.find((c) => c.id === convIdOf(acc, lid)).contactNumber, lidNum);
    assert.match(importLines(acc)[0], /2 个聊天、2 条消息.*范围外的聊天 2 个/);

    const acc2 = await newAccount({ scope: 'allowlist', allowlist: [ok] }, chats);
    await link(acc2);
    await waitImported(acc2);
    assert.deepEqual(
      (await accountConvs(acc2)).map((c) => c.id),
      [convIdOf(acc2, `${ok}@c.us`)],
    );
  });

  it('读聊天列表失败只记一行警告；单个聊天读失败只计数，日志里没有号码', async () => {
    const acc = await newAccount();
    const session = acc.waha.sessionName;
    fake.state.failChatList = true;
    try {
      await link(acc);
      await waitFor(() => t.log.lines.some((l) => l.includes(`号 ${acc.id} 导入已有聊天失败`)));
    } finally {
      fake.state.failChatList = false;
    }
    const bad = newNumber();
    const good = newNumber();
    fake.state.chats.set(session, [
      { id: `${bad}@c.us`, name: '读不到', messages: [wahaHistoryMessage({ chatId: `${bad}@c.us`, timestamp: T2022, body: '你好' })] },
      { id: `${good}@c.us`, name: '读得到', messages: [wahaHistoryMessage({ chatId: `${good}@c.us`, timestamp: T2022, body: '你好' })] },
    ]);
    fake.state.failChatMessages.add(`${bad}@c.us`);
    await relink(acc);
    await waitImported(acc);
    assert.match(importLines(acc)[0], /1 个聊天、1 条消息.*读取失败 1 个/);
    assert.deepEqual(
      (await accountConvs(acc)).map((c) => c.id),
      [convIdOf(acc, `${good}@c.us`)],
    );
    assert.ok(!t.log.lines.some((l) => l.includes(bad) || l.includes(good)));
  });

  it('同一个号同时只跑一次：导入还没跑完时又连上一次，不会叠着再跑', async () => {
    const c = newNumber();
    const chat = `${c}@c.us`;
    const acc = await newAccount({}, [{ id: chat, name: '李雷', messages: [wahaHistoryMessage({ chatId: chat, timestamp: T2022, body: '你好' })] }]);
    const listPath = `/api/${acc.waha.sessionName}/chats`;
    const lists = () => fake.state.requests.filter((r) => r.path === listPath).length;
    fake.state.chatListDelayMs = 300;
    try {
      await link(acc);
      await waitFor(() => lists() === 1);
      await relink(acc);
      await waitImported(acc);
      await sleep(400);
      assert.equal(lists(), 1);
      assert.equal(importLines(acc).length, 1);
      assert.equal((await getMessages(t, convIdOf(acc, chat))).length, 1);
    } finally {
      fake.state.chatListDelayMs = 0;
    }
  });
});

describe('启动时已经连着的号', () => {
  it('服务启动时已经是 WORKING 的号（第一次看到它 WORKING）也导入，不用重新关联', async () => {
    const fake = await startFakeWaha();
    const t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    try {
      await t.login();
      // 号已经在库里，WAHA 那边没 start 过（看到的是 stopped，还没见过 WORKING）
      const acc = await t.createAccount({ name: '老号', autoReply: true });
      assert.equal(acc.status.state, 'stopped');
      const session = acc.waha.sessionName;
      const c = newNumber();
      const chat = `${c}@c.us`;
      fake.state.sessions.set(session, { name: session, status: 'WORKING', config: {}, me: { id: '19990000000@c.us', pushName: 'Shop' } });
      // 服务没开着的时候来的消息（早于这次启动）也算历史，静默导入
      const ts = nowSec() - 3600;
      fake.state.chats.set(session, [{ id: chat, name: '周九', messages: [wahaHistoryMessage({ chatId: chat, timestamp: ts, body: '昨晚的消息' })] }]);
      // 启动时的检查：不用任何人打开后台
      await t.ctx.wa.init();
      await waitFor(() => t.log.lines.some((l) => l.includes(`号 ${acc.id} 导入已有聊天：1 个聊天、1 条消息`)), { message: '启动后没有导入' });
      const msgs = await getMessages(t, convIdOf(acc, chat));
      assert.deepEqual(
        msgs.map((m) => [m.text, m.ts, m.via, m.botDecision]),
        [['昨晚的消息', iso(ts), 'import', 'skipped']],
      );
      await sleep(200);
      assert.equal(fake.state.sent.length, 0, '没有自动回复');
      // 之后再查状态（一直是 WORKING）不会重复导入
      await t.req('GET', `/api/accounts/${acc.id}`);
      await sleep(100);
      assert.equal(t.log.lines.filter((l) => l.includes(`号 ${acc.id} 导入已有聊天：`)).length, 1);
    } finally {
      await t.close();
      await fake.close();
    }
  });
});
