import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { USAGE_HINT } from '../src/wa/service.js';
import { F3_USAGE_FOOTER } from '../src/wa/notify.js';
import {
  convIdOf,
  getConv,
  getMessages,
  postWaha,
  sleep,
  startApp,
  startFakeWaha,
  waitDecided,
  waitFor,
  wahaMessage,
  wahaSend,
} from './helpers.js';

const BOSS = '8613900000000';
const BOSS_CHAT = `${BOSS}@c.us`;

let seq = 0;
const newChat = () => `86138${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('F3 在 WhatsApp 里直接处理转人工', () => {
  let t;
  let fake;
  let acc;
  const cid = (chat) => convIdOf(acc, chat);
  const toBoss = () => fake.sentTo(BOSS_CHAT).map((m) => m.text);
  /** 通知号码发一条消息，quoted 为被引用的消息 id */
  const bossSays = (body, quoted, extra = {}) => wahaSend(t, acc, BOSS_CHAT, body, { ...(quoted ? { replyTo: { id: quoted, body: '...' } } : {}), ...extra });
  /** 让一位客户转人工，返回 {chat, notice}（notice 是假 WAHA 记下的通知消息，含 id） */
  async function handoff(name = '王先生', text = '我要人工') {
    const chat = newChat();
    const n = fake.sentTo(BOSS_CHAT).length;
    await wahaSend(t, acc, chat, text, { pushName: name });
    await waitDecided(t, cid(chat), 1);
    await waitFor(() => fake.sentTo(BOSS_CHAT).length === n + 1);
    return { chat, notice: fake.sentTo(BOSS_CHAT).at(-1) };
  }
  const waitBossReply = (text) => waitFor(() => toBoss().includes(text), { message: `通知号码没收到：${text}` });

  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { KBWA_WAHA_URL: fake.url } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: '一号', autoReply: true, notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('通知末尾带用法说明；不引用时回用法提示，同一个号 10 分钟内只回一次；都不进会话列表', async () => {
    const { notice } = await handoff();
    assert.ok(notice.text.endsWith(F3_USAGE_FOOTER));
    const n = toBoss().length;
    await bossSays('在吗');
    await waitBossReply(USAGE_HINT);
    await bossSays('有人吗');
    await bossSays('喂');
    await sleep(250);
    assert.equal(toBoss().length, n + 1, '10 分钟内只回一次');
    assert.equal(await getConv(t, cid(BOSS_CHAT)), null, '通知号码不存成客户会话');
  });

  it('引用通知回复：原样转发给客户，存成 operator 消息（via=whatsapp、sentBy 为空），会话保持暂停，回执"✅ 已发给"', async () => {
    const { chat, notice } = await handoff('李女士');
    await bossSays('您好，我是店长，马上给您报价', notice.id);
    await waitFor(() => fake.sentTo(chat).length === 1);
    assert.equal(fake.sentTo(chat)[0].text, '您好，我是店长，马上给您报价');
    assert.equal(fake.sentTo(chat)[0].session, acc.waha.sessionName);
    await waitBossReply('✅ 已发给 李女士');
    const out = (await getMessages(t, cid(chat))).filter((m) => m.direction === 'out');
    assert.equal(out.length, 1);
    assert.equal(out[0].author, 'operator');
    assert.equal(out[0].via, 'whatsapp');
    assert.equal(out[0].sentByUserId, null);
    assert.equal(out[0].sentByName, null);
    const conv = await getConv(t, cid(chat));
    assert.equal(conv.botPaused, true);
    assert.equal(conv.draft, null);
  });

  it('引用 id 的几种写法：只有最后一段的短 id；GOWS 原始消息里的 contextInfo.stanzaID', async () => {
    const a = await handoff('客户甲');
    const short = a.notice.id.split('_').at(-1);
    await bossSays('短 id 也能找到', short);
    await waitFor(() => fake.sentTo(a.chat).length === 1);
    const b = await handoff('客户乙');
    const evt = wahaMessage({ from: BOSS_CHAT, body: '从 stanzaID 找到', session: acc.waha.sessionName });
    evt.payload._data = { Message: { extendedTextMessage: { text: '从 stanzaID 找到', contextInfo: { stanzaID: b.notice.id.split('_').at(-1) } } } };
    await postWaha(t, evt);
    await waitFor(() => fake.sentTo(b.chat).length === 1);
    assert.equal(fake.sentTo(b.chat)[0].text, '从 stanzaID 找到');
  });

  it('/d：把草稿原样发给客户并清空草稿；没有草稿时回"这个会话没有草稿"', async () => {
    const { chat, notice } = await handoff('赵先生');
    // 转人工时会自动起草（F2a）；先清掉草稿，测"没有草稿"的分支
    t.ctx.db.prepare('UPDATE conversations SET draft = NULL WHERE id = ?').run(cid(chat));
    await bossSays('/d', notice.id);
    await waitBossReply('这个会话没有草稿');
    assert.equal(fake.sentTo(chat).length, 0);
    // 直接写库：A 段格式的旧草稿 {text, createdAt} 也要认
    t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify({ text: 'A100 是 59 元一个，您要多少？', createdAt: new Date().toISOString() }), cid(chat));
    assert.deepEqual((await getConv(t, cid(chat))).draft.text, 'A100 是 59 元一个，您要多少？');
    await bossSays(' /D ', notice.id);
    await waitFor(() => fake.sentTo(chat).length === 1);
    assert.equal(fake.sentTo(chat)[0].text, 'A100 是 59 元一个，您要多少？');
    await waitBossReply('✅ 已发给 赵先生');
    assert.equal((await getConv(t, cid(chat))).draft, null, '发出后草稿清空');
    const out = (await getMessages(t, cid(chat))).filter((m) => m.direction === 'out');
    assert.equal(out[0].via, 'whatsapp');
  });

  it('通知里带草稿（草稿存在时）', async () => {
    const chat = newChat();
    await wahaSend(t, acc, chat, '你好', { pushName: '钱女士' });
    await waitDecided(t, cid(chat), 1);
    t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify({ text: '【待你确认：折扣】', createdAt: new Date().toISOString() }), cid(chat));
    const notice = t.ctx.wa.notifier.buildNotice(t.ctx.accounts.get(acc.id), cid(chat), 'handoff', '客户要求打折');
    assert.ok(notice.text.includes('建议回复（草稿，未发送）：\n【待你确认：折扣】'), notice.text);
  });

  it('/resume：恢复机器人，清掉 needsHuman 和 botPaused，回执"✅ 已恢复机器人"；之后机器人照常回复', async () => {
    const { chat, notice } = await handoff('孙先生');
    let conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, true);
    assert.equal(conv.botPaused, true);
    await bossSays('/resume', notice.id);
    await waitBossReply('✅ 已恢复机器人：孙先生');
    conv = await getConv(t, cid(chat));
    assert.equal(conv.needsHuman, false);
    assert.equal(conv.botPaused, false);
    await wahaSend(t, acc, chat, '保温杯多少钱');
    const msgs = await waitDecided(t, cid(chat), 2);
    assert.equal(msgs.filter((m) => m.direction === 'in').at(-1).botDecision, 'replied');
  });

  it('非文字消息：回"暂时只支持转发文字"，不转发', async () => {
    const { chat, notice } = await handoff('周女士');
    await bossSays('', notice.id, { hasMedia: true, media: { mimetype: 'image/jpeg' } });
    await waitBossReply('暂时只支持转发文字');
    assert.equal(fake.sentTo(chat).length, 0);
  });

  it('同一条命令重复投递只执行一次', async () => {
    const { chat, notice } = await handoff('吴先生');
    const evt = wahaMessage({ from: BOSS_CHAT, body: '只发一次', session: acc.waha.sessionName, replyTo: { id: notice.id } });
    await postWaha(t, evt);
    await postWaha(t, evt);
    await waitFor(() => fake.sentTo(chat).length === 1);
    await sleep(200);
    assert.equal(fake.sentTo(chat).length, 1);
  });

  it('转发失败：回执"❌ 发送失败：<原因>"', async () => {
    const { chat, notice } = await handoff('郑先生');
    fake.state.failChats.add(chat);
    try {
      await bossSays('这条发不出去', notice.id);
      await waitFor(() => toBoss().some((x) => x.startsWith('❌ 发送失败：')));
    } finally {
      fake.state.failChats.delete(chat);
    }
    assert.match(toBoss().find((x) => x.startsWith('❌ 发送失败：')), /❌ 发送失败：.*500/);
    const out = (await getMessages(t, cid(chat))).filter((m) => m.direction === 'out');
    assert.equal(out[0].status, 'failed');
  });

  it('引用的通知超过 7 天：当作没引用，回用法提示（或被节流）', async () => {
    const { chat, notice } = await handoff('冯先生');
    t.ctx.db.prepare('UPDATE notice_messages SET created_at = ? WHERE external_id = ?').run(new Date(Date.now() - 8 * 86400e3).toISOString(), notice.id);
    await bossSays('过期了', notice.id);
    await sleep(300);
    assert.equal(fake.sentTo(chat).length, 0);
  });

  it('非通知号码引用通知：按普通客户消息处理，不转发', async () => {
    const { chat, notice } = await handoff('陈先生');
    const stranger = newChat();
    await wahaSend(t, acc, stranger, '保温杯多少钱', { replyTo: { id: notice.id } });
    const m = await waitDecided(t, cid(stranger), 1);
    assert.equal(m[0].botDecision, 'replied');
    assert.equal(fake.sentTo(chat).length, 0);
  });

  it('号码规范化后比对；关掉 WhatsApp 通知后不再当命令处理', async () => {
    const { chat, notice } = await handoff('褚先生');
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: false } } } });
    await bossSays('关了之后', notice.id);
    await sleep(250);
    assert.equal(fake.sentTo(chat).length, 0);
    assert.equal(await getConv(t, cid(BOSS_CHAT)), null, '仍按黑名单处理，不存档');
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: true, number: '+86 139-0000-0000' } } } });
    await bossSays('开回来了', notice.id);
    await waitFor(() => fake.sentTo(chat).length === 1);
  });

  it('别的号的通知不能用：两个号的通知记录互相隔离', async () => {
    const acc2 = await t.createAccount({ name: '二号', autoReply: true, notify: { whatsapp: { enabled: true, number: BOSS } } });
    await t.req('POST', `/api/accounts/${acc2.id}/waha/start`);
    const { chat, notice } = await handoff('卫先生');
    // 老板在二号的对话里引用一号的通知
    await wahaSend(t, acc2, BOSS_CHAT, '串号了', { replyTo: { id: notice.id } });
    await sleep(300);
    assert.equal(fake.sentTo(chat).length, 0);
    assert.ok(fake.sentTo(BOSS_CHAT).some((m) => m.session === acc2.waha.sessionName && m.text === USAGE_HINT));
  });
});
