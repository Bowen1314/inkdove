// 推荐回复（辅助模式）：号的三种回复方式、suggest 模式下自动起草推荐、手动「换一条」、公司话术和个人话术、
// 旧 autoReply 的升级和导入映射。模型都用 mock（aiHooks 记下参数）。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildDraftSystemPrompt, buildSuggestUserPrompt } from '../src/reply/prompts.js';
import { DAILY_LLM_LIMIT, localDay } from '../src/wa/service.js';
import {
  aiHooks,
  convIdOf,
  convPath,
  getConv,
  getMessages,
  postWaha,
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
const newChat = () => `86136${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('推荐回复（辅助模式）', () => {
  let t;
  let fake;
  let hooks;
  let sug;
  let autoAcc;
  let offAcc;
  let agent;
  const decisions = [];
  const notices = () => fake.sentTo(BOSS_CHAT).map((m) => m.text).filter((x) => x.startsWith('[待人工]'));
  const convRow = (convId) => t.ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  const suggestCalls = (convId) => t.ctx.db.prepare("SELECT COUNT(*) n FROM llm_calls WHERE conversation_id = ? AND purpose = 'suggest'").get(convId).n;
  const idle = () => waitFor(() => t.ctx.wa.idle());
  const manual = (convId, cookie) => t.req('POST', `${convPath(convId)}/suggest`, { cookie });
  /** 客户发一句，等这个会话的 n 条客户消息都有处理结果、服务空闲，返回会话 id */
  async function says(acc, chat, text, n) {
    const r = await wahaSend(t, acc, chat, text);
    assert.equal(r.status, 200);
    const convId = convIdOf(acc, chat);
    await waitDecided(t, convId, n);
    await idle();
    return convId;
  }
  /** 机主在手机上回了一条（fromMe、不是回声） */
  const ownerSays = (acc, chat, body) =>
    t.ctx.wa.handleWahaWebhook({ ...wahaMessage({ from: chat, body, fromMe: true, session: acc.waha.sessionName }), event: 'message.any' });

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url },
      options: { aiOverrides: hooks.overrides, onDecision: (row) => decisions.push(row) },
    });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    // 新建的号默认就是推荐回复
    sug = await t.createAccount({ name: '推荐号', notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    autoAcc = await t.createAccount({ name: '自动号', replyMode: 'auto' });
    offAcc = await t.createAccount({ name: '关闭号', replyMode: 'off', notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    for (const a of [sug, autoAcc, offAcc]) await t.req('POST', `/api/accounts/${a.id}/waha/start`);
    agent = await t.addMember({ email: 'sug-agent@example.com', name: '小周', accountIds: [sug.id, offAcc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  describe('号的回复方式 replyMode', () => {
    it('新建的号默认 suggest；autoReply 照旧返回（= replyMode 是 auto）', async () => {
      assert.equal(sug.replyMode, 'suggest');
      assert.equal(sug.autoReply, false);
      assert.equal(autoAcc.replyMode, 'auto');
      assert.equal(autoAcc.autoReply, true);
      assert.equal(offAcc.replyMode, 'off');
      assert.equal(offAcc.autoReply, false);
    });

    it('PUT：replyMode 三选一；仍接受 autoReply（true → auto，false → off）；两个都给时以 replyMode 为准；非法值 400', async () => {
      const acc = await t.createAccount({ name: '改回复方式' });
      const put = (body) => t.req('PUT', `/api/accounts/${acc.id}`, { body });
      let r = await put({ autoReply: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.replyMode, 'auto');
      r = await put({ autoReply: false });
      assert.equal(r.body.replyMode, 'off');
      r = await put({ replyMode: 'suggest', autoReply: true });
      assert.equal(r.body.replyMode, 'suggest');
      assert.equal(r.body.autoReply, false);
      r = await put({ replyMode: 'off', autoReply: true });
      assert.equal(r.body.replyMode, 'off');
      for (const body of [{ replyMode: 'manual' }, { replyMode: true }, { replyMode: null }, { autoReply: 'yes' }]) {
        const e = await put(body);
        assert.equal(e.status, 400, JSON.stringify(body));
      }
      assert.equal(t.ctx.accounts.get(acc.id).replyMode, 'off');
      const stored = JSON.parse(t.ctx.db.prepare('SELECT config FROM accounts WHERE id = ?').get(acc.id).config);
      assert.equal(stored.replyMode, 'off');
      assert.ok(!('autoReply' in stored), '库里只存 replyMode');
    });

    it('升级：库里只有旧的 autoReply 的号，true → auto，false（或没有）→ off，不会变成 suggest；再保存时改存 replyMode', async () => {
      const a = await t.createAccount({ name: '老号甲' });
      const b = await t.createAccount({ name: '老号乙' });
      const c = await t.createAccount({ name: '老号丙' });
      const setOld = (acc, patch) => {
        const cfg = JSON.parse(t.ctx.db.prepare('SELECT config FROM accounts WHERE id = ?').get(acc.id).config);
        delete cfg.replyMode;
        t.ctx.db.prepare('UPDATE accounts SET config = ? WHERE id = ?').run(JSON.stringify({ ...cfg, ...patch }), acc.id);
      };
      setOld(a, { autoReply: true });
      setOld(b, { autoReply: false });
      setOld(c, {});
      const view = async (acc) => (await t.req('GET', `/api/accounts/${acc.id}`)).body;
      assert.equal((await view(a)).replyMode, 'auto');
      assert.equal((await view(a)).autoReply, true);
      assert.equal((await view(b)).replyMode, 'off');
      assert.equal((await view(c)).replyMode, 'off');
      assert.equal((await t.req('PUT', `/api/accounts/${a.id}`, { body: { persona: '老号' } })).status, 200);
      const stored = JSON.parse(t.ctx.db.prepare('SELECT config FROM accounts WHERE id = ?').get(a.id).config);
      assert.equal(stored.replyMode, 'auto');
      assert.ok(!('autoReply' in stored));
    });

    it('导出带 replyMode（不再带 autoReply）；导入老文件只有 autoReply 时按 true → auto、false → off 换算，都没有按默认 suggest', async () => {
      const exp = await t.req('GET', '/api/accounts/export');
      assert.equal(exp.status, 200);
      const mine = exp.body.accounts.find((x) => x.name === '自动号');
      assert.equal(mine.replyMode, 'auto');
      assert.ok(!('autoReply' in mine));

      const item = (name, extra) => ({ name, channel: 'waha', waha: null, meta: null, ...extra });
      const doc = {
        format: 'inkdove-accounts',
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: [
          item('旧文件开着', { autoReply: true }),
          item('旧文件关着', { autoReply: false }),
          item('什么都没写'),
          item('两个都写', { replyMode: 'suggest', autoReply: true }),
          item('新文件', { replyMode: 'off' }),
        ],
      };
      const fd = new FormData();
      fd.append('file', new Blob([JSON.stringify(doc)], { type: 'application/json' }), 'inkdove-accounts.json');
      const r = await t.req('POST', '/api/accounts/import', { body: fd });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const modes = r.body.created.map((c) => t.ctx.accounts.get(c.id).replyMode);
      assert.deepEqual(modes, ['auto', 'off', 'suggest', 'suggest', 'off']);

      const bad = { ...doc, accounts: [item('坏值', { replyMode: 'manual' })] };
      const fd2 = new FormData();
      fd2.append('file', new Blob([JSON.stringify(bad)], { type: 'application/json' }), 'inkdove-accounts.json');
      const e = await t.req('POST', '/api/accounts/import', { body: fd2 });
      assert.equal(e.status, 400);
      assert.match(e.body.error, /^第 1 个号（坏值）：replyMode/);
    });
  });

  describe('suggest 模式自动起草', () => {
    it('客户消息防抖后起草一条推荐存进 draft（kind=suggest）：不发给客户、不通知、不暂停、不标待处理；消息记 suggested；llm_calls 记 suggest；不写处理记录', async () => {
      const chat = newChat();
      const gen = hooks.calls.generate;
      const before = notices().length;
      const convId = await says(sug, chat, '保温杯 A100 能便宜点吗', 1);
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'suggested');
      assert.equal(m.decisionReason, '已生成推荐回复');
      const conv = await getConv(t, convId);
      assert.deepEqual(Object.keys(conv.draft).sort(), ['createdAt', 'fileIds', 'kind', 'text']);
      assert.equal(conv.draft.kind, 'suggest');
      assert.match(conv.draft.text, /59 元/);
      assert.match(conv.draft.text, /【待你确认：/);
      assert.equal(conv.needsHuman, false);
      assert.equal(conv.botPaused, false);
      assert.equal(fake.sentTo(chat).length, 0, '推荐回复不会发给客户');
      assert.equal(notices().length, before, '不发转人工通知');
      assert.equal(hooks.calls.generate, gen, '不走自动回复流程');
      assert.equal(suggestCalls(convId), 1);
      assert.equal(convRow(convId).llm_calls, 1, '计入会话每日模型次数');
      assert.ok(!decisions.some((d) => d.conversationId === convId), '推荐回复不写处理记录（不算自动回复也不算转人工）');
      assert.equal(hooks.args.suggest.previous, '');
      assert.equal(hooks.args.suggest.message, '保温杯 A100 能便宜点吗');
    });

    it('防抖期间连发几条：合并成一次生成', async () => {
      await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.4 } } });
      try {
        const chat = newChat();
        const n = hooks.calls.suggest;
        for (const text of ['你好', '想问下保温杯 A100', '有现货吗']) await wahaSend(t, sug, chat, text);
        const convId = convIdOf(sug, chat);
        const msgs = await waitDecided(t, convId, 3);
        await idle();
        assert.equal(hooks.calls.suggest - n, 1, '只生成一次');
        assert.equal(hooks.args.suggest.message, '你好\n想问下保温杯 A100\n有现货吗');
        assert.ok(msgs.every((m) => m.botDecision === 'suggested'));
        assert.equal(suggestCalls(convId), 1);
      } finally {
        await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
      }
    });

    it('「客户这次的消息」= 我方最后一条之后客户发的所有消息（已经起草过的也合进来）；人工回过（会话暂停）后客户再发照样起草；上下文带前面的对话', async () => {
      const chat = newChat();
      const convId = await says(sug, chat, '第一句：保温杯 A100', 1);
      await says(sug, chat, '第二句：有黑色吗', 2);
      assert.equal(hooks.args.suggest.message, '第一句：保温杯 A100\n第二句：有黑色吗');
      assert.deepEqual(hooks.args.suggest.history, []);

      const sent = await t.req('POST', `${convPath(convId)}/send`, { body: { text: '有的，黑白两色' } });
      assert.equal(sent.status, 200);
      let conv = await getConv(t, convId);
      assert.equal(conv.draft, null, '人工发出后推荐清掉');
      assert.equal(conv.botPaused, true);

      await says(sug, chat, '第三句：那来 100 个', 3);
      assert.equal(hooks.args.suggest.message, '第三句：那来 100 个');
      assert.deepEqual(
        hooks.args.suggest.history.map((h) => `${h.role}:${h.text}`),
        ['customer:第一句：保温杯 A100', 'customer:第二句：有黑色吗', 'bot:有的，黑白两色'],
      );
      conv = await getConv(t, convId);
      assert.equal(conv.draft.kind, 'suggest', '会话暂停不影响推荐回复');
      assert.equal((await getMessages(t, convId)).at(-1).botDecision, 'suggested');
    });

    it('我方任何消息发出后清掉推荐：手机上回、外联；转人工草稿不受手机回复影响', async () => {
      const chat = newChat();
      const convId = await says(sug, chat, '保温杯 A100 多少钱', 1);
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest');
      assert.equal(await ownerSays(sug, chat, '59 元'), 'archived_owner');
      assert.equal((await getConv(t, convId)).draft, null, '手机上回了');

      await says(sug, chat, '那 200 个呢', 2);
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest');
      const internal = t.ctx.accounts.get(sug.id);
      await t.ctx.wa.sendCampaignMessage(internal, { chatId: chat, number: chat.replace(/\D+/g, ''), text: '新品上市，欢迎咨询' });
      assert.equal((await getConv(t, convId)).draft, null, '外联发出');

      const handoff = { kind: 'handoff', text: '转人工时起草的', fileIds: [], createdAt: new Date().toISOString() };
      t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(handoff), convId);
      await ownerSays(sug, chat, '手机上又回了一句');
      assert.deepEqual((await getConv(t, convId)).draft, handoff);
    });

    it('自动回复模式下机器人发出回复也清掉推荐', async () => {
      const chat = newChat();
      const convId = await says(autoAcc, chat, '保温杯 A100 多少钱', 1);
      await waitFor(() => fake.sentTo(chat).length === 1);
      const r = await manual(convId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest');
      await says(autoAcc, chat, '保温杯 A100 容量多大', 2);
      await waitFor(() => fake.sentTo(chat).length === 2);
      await idle();
      assert.equal((await getConv(t, convId)).draft, null);
    });

    it('生成期间我方已经回了：丢掉结果（手机上回的，消息记 skipped 和原因；后台回的，消息已被人工接管）', async () => {
      for (const how of ['phone', 'admin']) {
        const chat = newChat();
        const convId = convIdOf(sug, chat);
        let release;
        const gate = new Promise((r) => {
          release = r;
        });
        let started = false;
        hooks.suggest = async (args, mock) => {
          started = true;
          await gate;
          return mock.suggest(args);
        };
        try {
          await wahaSend(t, sug, chat, '保温杯 A100 有货吗');
          await waitFor(() => started);
          if (how === 'phone') await ownerSays(sug, chat, '有货');
          else assert.equal((await t.req('POST', `${convPath(convId)}/send`, { body: { text: '有货' } })).status, 200);
          release();
          await waitDecided(t, convId, 1);
          await idle();
        } finally {
          hooks.suggest = null;
        }
        assert.equal((await getConv(t, convId)).draft, null, how);
        const [m] = (await getMessages(t, convId)).filter((x) => x.direction === 'in');
        assert.equal(m.botDecision, 'skipped', how);
        assert.equal(m.decisionReason, how === 'phone' ? '生成推荐回复期间我方已经回复，推荐作废' : '人工已接管', how);
      }
    });

    it('当天模型次数到上限、生成失败：消息记 skipped 加原因，不存新推荐', async () => {
      const chat = newChat();
      const convId = await says(sug, chat, '保温杯 A100', 1);
      const old = (await getConv(t, convId)).draft;
      t.ctx.db.prepare('UPDATE conversations SET llm_calls = ? WHERE id = ?').run(DAILY_LLM_LIMIT, convId);
      const n = hooks.calls.suggest;
      await says(sug, chat, '还在吗', 2);
      let last = (await getMessages(t, convId)).at(-1);
      assert.equal(last.botDecision, 'skipped');
      assert.equal(last.decisionReason, `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次）`);
      assert.equal(hooks.calls.suggest, n, '没有调模型');
      assert.deepEqual((await getConv(t, convId)).draft, old);

      const chat2 = newChat();
      hooks.suggest = () => {
        throw new Error('模型超时');
      };
      try {
        const c2 = await says(sug, chat2, '你好', 1);
        last = (await getMessages(t, c2)).at(-1);
        assert.equal(last.botDecision, 'skipped');
        assert.equal(last.decisionReason, '生成推荐回复失败：模型超时');
        assert.equal((await getConv(t, c2)).draft, null);
        assert.equal((await getConv(t, c2)).needsHuman, false);
      } finally {
        hooks.suggest = null;
      }
    });

    it('off 模式只存消息不起草；auto 模式照旧自动回复、不起草推荐', async () => {
      const n = hooks.calls.suggest;
      const chat = newChat();
      const convId = await says(offAcc, chat, '保温杯 A100 多少钱', 1);
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'skipped');
      assert.equal(m.decisionReason, '这个号没开自动回复');
      assert.equal((await getConv(t, convId)).draft, null);

      const chat2 = newChat();
      const c2 = await says(autoAcc, chat2, '保温杯 A100 多少钱', 1);
      await waitFor(() => fake.sentTo(chat2).length === 1);
      assert.equal((await getMessages(t, c2)).find((x) => x.direction === 'in').botDecision, 'replied');
      assert.equal(hooks.calls.suggest, n);
      assert.equal(suggestCalls(convId) + suggestCalls(c2), 0);
    });

    it('非文字消息：推荐回复模式没开识别时记 skipped，不标待处理、不通知；off 模式照旧标待处理并通知', async () => {
      const image = { url: 'http://waha:3000/api/files/x/IMG1.jpeg', mimetype: 'image/jpeg', filename: null };
      const send = (acc, chat) => postWaha(t, wahaMessage({ from: chat, hasMedia: true, media: image, session: acc.waha.sessionName }));
      const before = notices().length;
      const chat = newChat();
      await send(sug, chat);
      const [m] = await waitDecided(t, convIdOf(sug, chat), 1);
      assert.equal(m.botDecision, 'skipped');
      assert.match(m.decisionReason, /不生成推荐回复/);
      assert.equal((await getConv(t, convIdOf(sug, chat))).needsHuman, false);
      assert.equal(notices().length, before);

      const chat2 = newChat();
      await send(offAcc, chat2);
      await waitDecided(t, convIdOf(offAcc, chat2), 1);
      assert.equal((await getConv(t, convIdOf(offAcc, chat2))).needsHuman, true);
      await waitFor(() => notices().length === before + 1);
    });

    it('开了语音识别：推荐回复模式也识别，识别出的文字参与推荐', async () => {
      assert.equal((await t.req('PUT', '/api/settings', { body: { media: { voice: true, transcribeModel: 'whisper-1' } } })).status, 200);
      try {
        const chat = newChat();
        const p = `${sug.waha.sessionName}/SUGVOICE1.oga`;
        fake.state.files.set(p, { buffer: Buffer.from('保温杯 A100 有几种颜色'), mime: 'audio/ogg' });
        const media = { url: `http://waha:3000/api/files/${p}`, mimetype: 'audio/ogg; codecs=opus', filename: null };
        await postWaha(t, wahaMessage({ from: chat, hasMedia: true, media, session: sug.waha.sessionName }));
        const convId = convIdOf(sug, chat);
        const [m] = await waitDecided(t, convId, 1);
        await idle();
        assert.equal(m.text, '[语音] 保温杯 A100 有几种颜色');
        assert.equal(m.botDecision, 'suggested');
        assert.equal(hooks.args.suggest.message, '[语音] 保温杯 A100 有几种颜色');
        assert.equal((await getConv(t, convId)).draft.kind, 'suggest');
        assert.equal(convRow(convId).llm_calls, 2, '识别 1 次 + 推荐 1 次');
      } finally {
        await t.req('PUT', '/api/settings', { body: { media: { voice: false } } });
      }
    });

    it('看板：推荐回复不算自动回复也不算转人工；成本按用途列出「推荐回复」', async () => {
      const r = await t.req('GET', '/api/dashboard?range=today');
      assert.equal(r.status, 200);
      const { turns } = r.body.kpi;
      assert.deepEqual(Object.keys(turns).sort(), ['blocked', 'handoff', 'offtopic', 'replied']);
      const count = (d) => decisions.filter((x) => x.decision === d).length;
      assert.equal(turns.replied, count('replied'));
      assert.equal(turns.handoff, count('handoff'));
      const sugPurpose = r.body.cost.byPurpose.find((p) => p.purpose === 'suggest');
      assert.ok(sugPurpose, '有推荐回复这一项');
      assert.equal(sugPurpose.label, '推荐回复');
      assert.ok(sugPurpose.calls > 0);
    });
  });

  describe('手动「换一条」POST /api/wa/conversations/:id/suggest', () => {
    it('带上当前推荐作为【上一条推荐】，返回并存下不同的一条；计入模型次数，不改消息的处理结果', async () => {
      const chat = newChat();
      const convId = await says(sug, chat, '保温杯 A100 多少钱', 1);
      const old = (await getConv(t, convId)).draft;
      const before = await getMessages(t, convId);
      const r = await manual(convId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body), ['draft']);
      assert.equal(r.body.draft.kind, 'suggest');
      assert.notEqual(r.body.draft.text, old.text);
      assert.equal(hooks.args.suggest.previous, old.text);
      assert.equal(hooks.args.suggest.message, '保温杯 A100 多少钱');
      assert.deepEqual((await getConv(t, convId)).draft, r.body.draft);
      assert.equal(suggestCalls(convId), 2);
      assert.equal(convRow(convId).llm_calls, 2);
      assert.deepEqual(await getMessages(t, convId), before);
    });

    it('off、auto 模式的号也能手动要；我方已经回过时用最近一段客户消息', async () => {
      const chat = newChat();
      const convId = await says(offAcc, chat, '保温杯 A100 有现货吗', 1);
      let r = await manual(convId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.draft.kind, 'suggest');
      assert.equal(hooks.args.suggest.previous, '');
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest');

      assert.equal((await t.req('POST', `${convPath(convId)}/send`, { body: { text: '有的' } })).status, 200);
      r = await manual(convId);
      assert.equal(r.status, 200);
      assert.equal(hooks.args.suggest.message, '保温杯 A100 有现货吗');

      const chat2 = newChat();
      const c2 = await says(autoAcc, chat2, '你们公司在哪', 1);
      r = await manual(c2);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.draft.kind, 'suggest');
    });

    it('错误：没有客户消息 400 no_customer_message；当天上限 429 llm_daily_limit；生成失败 502；会话不存在 404', async () => {
      const chat = newChat();
      await t.ctx.wa.sendCampaignMessage(t.ctx.accounts.get(offAcc.id), { chatId: chat, number: chat.replace(/\D+/g, ''), text: '你好' });
      const outOnly = convIdOf(offAcc, chat);
      let r = await manual(outOnly);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'no_customer_message');

      const chat2 = newChat();
      const c2 = await says(offAcc, chat2, '在吗', 1);
      t.ctx.db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(localDay(), DAILY_LLM_LIMIT, c2);
      const n = hooks.calls.suggest;
      r = await manual(c2);
      assert.equal(r.status, 429);
      assert.equal(r.body.code, 'llm_daily_limit');
      assert.equal(hooks.calls.suggest, n);

      t.ctx.db.prepare('UPDATE conversations SET llm_calls = 0 WHERE id = ?').run(c2);
      hooks.suggest = () => {
        throw new Error('模型超时');
      };
      try {
        r = await manual(c2);
        assert.equal(r.status, 502);
        assert.equal(r.body.code, 'llm_error');
      } finally {
        hooks.suggest = null;
      }
      assert.equal((await getConv(t, c2)).draft, null);
      assert.equal((await manual(`${offAcc.id}:nobody@c.us`)).status, 404);
    });

    it('权限同其他会话接口：agent 只能对分给自己的会话要推荐', async () => {
      const chat = newChat();
      const convId = await says(sug, chat, '保温杯 A100', 1);
      let r = await manual(convId, agent.cookie);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'forbidden');
      await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });
      r = await manual(convId, agent.cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });
  });

  describe('公司话术和个人话术', () => {
    it('settings.suggest.companyPrompt：GET 返回、PUT 能改（最多 4000 字）；agent 改不了', async () => {
      let r = await t.req('PUT', '/api/settings', { body: { suggest: { companyPrompt: '称呼客户 Dear，结尾署名 Inkdove Team' } } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.suggest, { companyPrompt: '称呼客户 Dear，结尾署名 Inkdove Team' });
      assert.deepEqual((await t.req('GET', '/api/settings')).body.suggest, { companyPrompt: '称呼客户 Dear，结尾署名 Inkdove Team' });
      for (const body of [{ suggest: { companyPrompt: 'x'.repeat(4001) } }, { suggest: { companyPrompt: 1 } }, { suggest: 'x' }]) {
        r = await t.req('PUT', '/api/settings', { body });
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      }
      assert.equal((await t.req('PUT', '/api/settings', { body: { suggest: { companyPrompt: 'x'.repeat(4000) } } })).status, 200);
      assert.equal((await t.req('PUT', '/api/settings', { body: { suggest: { companyPrompt: '称呼客户 Dear' } } })).status, 200);
      assert.equal((await t.req('PUT', '/api/settings', { body: { suggest: { companyPrompt: '' } }, cookie: agent.cookie })).status, 403);
    });

    it('PUT /api/auth/me/style-prompt：任何登录用户改自己的（最多 2000 字），GET /api/auth/me 带 stylePrompt；成员列表不带', async () => {
      let r = await t.req('GET', '/api/auth/me', { cookie: agent.cookie });
      assert.equal(r.body.user.stylePrompt, '');
      r = await t.req('PUT', '/api/auth/me/style-prompt', { body: { stylePrompt: '我习惯用短句，多用 OK' }, cookie: agent.cookie });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.id, agent.user.id);
      assert.equal(r.body.user.stylePrompt, '我习惯用短句，多用 OK');
      assert.equal((await t.req('GET', '/api/auth/me', { cookie: agent.cookie })).body.user.stylePrompt, '我习惯用短句，多用 OK');
      assert.equal((await t.req('GET', '/api/auth/me')).body.user.stylePrompt, '', '只改了自己的');
      r = await t.req('PUT', '/api/auth/me/style-prompt', { body: { stylePrompt: '管理员的话术：先问好' } });
      assert.equal(r.body.user.stylePrompt, '管理员的话术：先问好');
      for (const body of [{ stylePrompt: 'x'.repeat(2001) }, { stylePrompt: null }, {}, []]) {
        const e = await t.req('PUT', '/api/auth/me/style-prompt', { body, cookie: agent.cookie });
        assert.equal(e.status, 400, JSON.stringify(body).slice(0, 80));
      }
      assert.equal((await t.req('PUT', '/api/auth/me/style-prompt', { body: { stylePrompt: 'x' }, auth: false })).status, 401);
      const users = (await t.req('GET', '/api/users')).body;
      assert.ok(users.every((u) => !('stylePrompt' in u)));
    });

    it('自动起草用会话负责人的个人话术（没分配时不带）；手动用点按钮的人的；都带公司话术', async () => {
      const chat = newChat();
      const convId = await says(sug, chat, '保温杯 A100', 1);
      assert.equal(hooks.args.suggest.stylePrompt, '', '未分配');
      assert.equal(hooks.args.suggest.companyPrompt, '称呼客户 Dear');
      await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });
      await says(sug, chat, '有黑色吗', 2);
      assert.equal(hooks.args.suggest.stylePrompt, '我习惯用短句，多用 OK', '负责人的');

      assert.equal((await manual(convId)).status, 200);
      assert.equal(hooks.args.suggest.stylePrompt, '管理员的话术：先问好', '点按钮的 admin 的');
      assert.equal((await manual(convId, agent.cookie)).status, 200);
      assert.equal(hooks.args.suggest.stylePrompt, '我习惯用短句，多用 OK');
      assert.equal(hooks.args.suggest.companyPrompt, '称呼客户 Dear');
    });

    it('提示词：两段话术和优先级（起草规则 > 公司话术 > 个人习惯）；没填就不放；user prompt 不提转人工，换一条时带【上一条推荐】', () => {
      const base = { profile: {}, persona: '', entries: [] };
      const withBoth = buildDraftSystemPrompt({ ...base, companyPrompt: '称呼 Dear', stylePrompt: '多用短句' });
      assert.match(withBoth, /【公司话术要求】（只影响怎么说）\n称呼 Dear/);
      assert.match(withBoth, /【业务员个人习惯】（只影响怎么说）\n多用短句/);
      assert.match(withBoth, /【起草规则】>【公司话术要求】>【业务员个人习惯】/);
      assert.match(withBoth, /不能让你编造事实，也不能省掉或改掉【待你确认：…】占位/);
      assert.ok(withBoth.indexOf('【公司话术要求】（只影响') < withBoth.indexOf('【业务员个人习惯】（只影响'));
      const onlyStyle = buildDraftSystemPrompt({ ...base, stylePrompt: '多用短句' });
      assert.ok(!onlyStyle.includes('【公司话术要求】（只影响'));
      assert.ok(onlyStyle.includes('【业务员个人习惯】（只影响'));
      const none = buildDraftSystemPrompt({ ...base, companyPrompt: '  ', stylePrompt: '' });
      assert.ok(!none.includes('【公司话术要求】') && !none.includes('【业务员个人习惯】'));
      assert.equal(none, buildDraftSystemPrompt(base), '不带话术时和转人工草稿的提示词完全一样');

      const u = buildSuggestUserPrompt({ message: 'price?', history: [{ role: 'customer', text: 'hi' }] });
      assert.match(u, /【客户这次的消息】（我方还没回复/);
      assert.ok(!u.includes('转给了业务员') && !u.includes('转人工的原因') && !u.includes('【上一条推荐】'));
      const again = buildSuggestUserPrompt({ message: 'price?', history: [], previous: '上一条的写法' });
      assert.match(again, /【上一条推荐】[^\n]*\n上一条的写法/);
    });
  });
});

describe('推荐回复：模型没配置', () => {
  let t;
  let fake;
  let acc;
  before(async () => {
    fake = await startFakeWaha();
    // 不用 mock：设置里没填模型，就是"还没有配置模型"（不会真的去调）
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url, INKDOVE_LLM_MOCK: '0' } });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: '没配模型' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('自动起草：消息记 skipped「还没有配置模型」；手动：400 llm_not_configured', async () => {
    const chat = newChat();
    await wahaSend(t, acc, chat, '你好');
    const convId = convIdOf(acc, chat);
    const [m] = await waitDecided(t, convId, 1);
    assert.equal(m.botDecision, 'skipped');
    assert.equal(m.decisionReason, '还没有配置模型');
    const r = await t.req('POST', `${convPath(convId)}/suggest`);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'llm_not_configured');
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n, 0);
  });
});
