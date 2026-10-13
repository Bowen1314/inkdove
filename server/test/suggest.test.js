// 推荐回复（只能手动要）：号的两种回复方式（人工回复 / 自动回复）、v0.3.0 的 suggest 模式兼容（读库、PUT、导入导出）、
// 客户来消息时不会自动起草、手动「推荐回复」「换一条」、我方发消息后清掉推荐、公司话术和个人话术。模型都用 mock（aiHooks 记下参数）。
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
const newChat = () => `86136${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('推荐回复（只能手动要）', () => {
  let t;
  let fake;
  let hooks;
  /** 新建时什么都不改的号：默认人工回复 */
  let manualAcc;
  let autoAcc;
  /** 库里存的还是 v0.3.0 的 replyMode='suggest' */
  let legacyAcc;
  let agent;
  const decisions = [];
  const notices = () => fake.sentTo(BOSS_CHAT).map((m) => m.text).filter((x) => x.startsWith('[待人工]'));
  const convRow = (convId) => t.ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  const llmCalls = (convId, purpose) =>
    purpose
      ? t.ctx.db.prepare('SELECT COUNT(*) n FROM llm_calls WHERE conversation_id = ? AND purpose = ?').get(convId, purpose).n
      : t.ctx.db.prepare('SELECT COUNT(*) n FROM llm_calls WHERE conversation_id = ?').get(convId).n;
  const suggestCalls = (convId) => llmCalls(convId, 'suggest');
  const idle = () => waitFor(() => t.ctx.wa.idle());
  const manual = (convId, cookie) => t.req('POST', `${convPath(convId)}/suggest`, { cookie });
  const storedConfig = (acc) => JSON.parse(t.ctx.db.prepare('SELECT config FROM accounts WHERE id = ?').get(acc.id).config);
  /** 直接改库里存的号配置（模拟老版本存下的数据）；dropReplyMode 时先去掉 replyMode */
  const setStored = (acc, patch, { dropReplyMode = false } = {}) => {
    const cfg = storedConfig(acc);
    if (dropReplyMode) delete cfg.replyMode;
    t.ctx.db.prepare('UPDATE accounts SET config = ? WHERE id = ?').run(JSON.stringify({ ...cfg, ...patch }), acc.id);
  };
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
  /** 各个 AI 方法到现在为止的调用次数 */
  const callCounts = () => ({ ...hooks.calls });

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
    const notify = { whatsapp: { enabled: true, number: `+${BOSS}` } };
    manualAcc = await t.createAccount({ name: '人工号', notify });
    autoAcc = await t.createAccount({ name: '自动号', replyMode: 'auto' });
    legacyAcc = await t.createAccount({ name: '老推荐号', notify });
    setStored(legacyAcc, { replyMode: 'suggest' });
    for (const a of [manualAcc, autoAcc, legacyAcc]) await t.req('POST', `/api/accounts/${a.id}/waha/start`);
    agent = await t.addMember({ email: 'sug-agent@example.com', name: '小周', accountIds: [manualAcc.id, legacyAcc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  describe('号的回复方式 replyMode', () => {
    it('新建的号默认 off（人工回复）；autoReply 照旧返回（= replyMode 是 auto）', async () => {
      assert.equal(manualAcc.replyMode, 'off');
      assert.equal(manualAcc.autoReply, false);
      assert.equal(storedConfig(manualAcc).replyMode, 'off');
      assert.equal(autoAcc.replyMode, 'auto');
      assert.equal(autoAcc.autoReply, true);
    });

    it('PUT：replyMode 只有 off、auto；suggest 按 off（兼容 v0.3.0 的客户端）；仍接受 autoReply；两个都给时以 replyMode 为准；非法值 400', async () => {
      const acc = await t.createAccount({ name: '改回复方式' });
      const put = (body) => t.req('PUT', `/api/accounts/${acc.id}`, { body });
      let r = await put({ autoReply: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.replyMode, 'auto');
      r = await put({ replyMode: 'suggest' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.replyMode, 'off');
      assert.equal(r.body.autoReply, false);
      assert.equal(storedConfig(acc).replyMode, 'off', '库里写 off，不写 suggest');
      r = await put({ replyMode: 'auto' });
      assert.equal(r.body.replyMode, 'auto');
      r = await put({ replyMode: 'suggest', autoReply: true });
      assert.equal(r.body.replyMode, 'off', '两个都给时以 replyMode 为准，suggest 再换成 off');
      r = await put({ autoReply: true });
      assert.equal(r.body.replyMode, 'auto');
      r = await put({ autoReply: false });
      assert.equal(r.body.replyMode, 'off');
      r = await put({ replyMode: 'off', autoReply: true });
      assert.equal(r.body.replyMode, 'off');
      for (const body of [{ replyMode: 'manual' }, { replyMode: 'SUGGEST' }, { replyMode: true }, { replyMode: null }, { autoReply: 'yes' }]) {
        const e = await put(body);
        assert.equal(e.status, 400, JSON.stringify(body));
      }
      assert.match((await put({ replyMode: 'manual' })).body.error, /replyMode 只能是 off 或 auto/);
      assert.equal(t.ctx.accounts.get(acc.id).replyMode, 'off');
      const stored = storedConfig(acc);
      assert.equal(stored.replyMode, 'off');
      assert.ok(!('autoReply' in stored), '库里只存 replyMode');
    });

    it('升级：库里存的 suggest 读成 off（下次保存写 off）；只有旧 autoReply 的按 true → auto、false（或没有）→ off', async () => {
      const a = await t.createAccount({ name: '老号甲' });
      const b = await t.createAccount({ name: '老号乙' });
      const c = await t.createAccount({ name: '老号丙' });
      const d = await t.createAccount({ name: '老号丁' });
      setStored(a, { autoReply: true }, { dropReplyMode: true });
      setStored(b, { autoReply: false }, { dropReplyMode: true });
      setStored(c, {}, { dropReplyMode: true });
      setStored(d, { replyMode: 'suggest' });
      const view = async (acc) => (await t.req('GET', `/api/accounts/${acc.id}`)).body;
      assert.equal((await view(a)).replyMode, 'auto');
      assert.equal((await view(a)).autoReply, true);
      assert.equal((await view(b)).replyMode, 'off');
      assert.equal((await view(c)).replyMode, 'off');
      const dv = await view(d);
      assert.equal(dv.replyMode, 'off');
      assert.equal(dv.autoReply, false);
      assert.equal((await t.req('GET', '/api/accounts')).body.find((x) => x.id === d.id).replyMode, 'off', '列表里也是 off');
      assert.equal(t.ctx.accounts.get(d.id).replyMode, 'off', '服务端内部也当 off');
      assert.equal(storedConfig(d).replyMode, 'suggest', '只读不改库');

      assert.equal((await t.req('PUT', `/api/accounts/${d.id}`, { body: { persona: '老推荐号' } })).status, 200);
      assert.equal(storedConfig(d).replyMode, 'off', '再保存时写 off');
      assert.equal((await t.req('PUT', `/api/accounts/${a.id}`, { body: { persona: '老号' } })).status, 200);
      const stored = storedConfig(a);
      assert.equal(stored.replyMode, 'auto');
      assert.ok(!('autoReply' in stored));
    });

    it('导出只写 off / auto；导入：suggest 按 off，只有 autoReply 的 true → auto、false → off，都没有 → off；非法值 400', async () => {
      const exp = await t.req('GET', '/api/accounts/export');
      assert.equal(exp.status, 200);
      assert.equal(exp.body.accounts.find((x) => x.name === '自动号').replyMode, 'auto');
      assert.equal(exp.body.accounts.find((x) => x.name === '老推荐号').replyMode, 'off', '库里存的 suggest 导出成 off');
      assert.ok(exp.body.accounts.every((x) => ['off', 'auto'].includes(x.replyMode) && !('autoReply' in x)));

      const item = (name, extra) => ({ name, channel: 'waha', waha: null, meta: null, ...extra });
      const doc = {
        format: 'inkdove-accounts',
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: [
          item('旧文件开着', { autoReply: true }),
          item('旧文件关着', { autoReply: false }),
          item('什么都没写'),
          item('v0.3.0 导出的', { replyMode: 'suggest' }),
          item('两个都写', { replyMode: 'suggest', autoReply: true }),
          item('新文件自动', { replyMode: 'auto' }),
          item('新文件人工', { replyMode: 'off' }),
        ],
      };
      const fd = new FormData();
      fd.append('file', new Blob([JSON.stringify(doc)], { type: 'application/json' }), 'inkdove-accounts.json');
      const r = await t.req('POST', '/api/accounts/import', { body: fd });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const created = r.body.created.map((c) => c.id);
      assert.deepEqual(
        created.map((id) => t.ctx.accounts.get(id).replyMode),
        ['auto', 'off', 'off', 'off', 'off', 'auto', 'off'],
      );
      assert.ok(
        created.every((id) => ['off', 'auto'].includes(JSON.parse(t.ctx.db.prepare('SELECT config FROM accounts WHERE id = ?').get(id).config).replyMode)),
        '库里不会存 suggest',
      );

      const bad = { ...doc, accounts: [item('坏值', { replyMode: 'manual' })] };
      const fd2 = new FormData();
      fd2.append('file', new Blob([JSON.stringify(bad)], { type: 'application/json' }), 'inkdove-accounts.json');
      const e = await t.req('POST', '/api/accounts/import', { body: fd2 });
      assert.equal(e.status, 400);
      assert.match(e.body.error, /^第 1 个号（坏值）：replyMode/);
    });
  });

  describe('客户来消息不会自动起草推荐回复', () => {
    it('人工回复的号：只存消息，不调用模型、不写推荐草稿；消息记 skipped「这个号没开自动回复」；不发给客户、不通知、不暂停', async () => {
      const chat = newChat();
      const before = callCounts();
      const n = notices().length;
      const convId = await says(manualAcc, chat, '保温杯 A100 能便宜点吗', 1);
      await sleep(150); // 超过防抖时间，确认后面也没有起草
      await idle();
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'skipped');
      assert.equal(m.decisionReason, '这个号没开自动回复');
      const conv = await getConv(t, convId);
      assert.equal(conv.draft, null);
      assert.equal(conv.needsHuman, false);
      assert.equal(conv.botPaused, false);
      assert.deepEqual(hooks.calls, before, '没有调用任何 AI 方法');
      assert.equal(llmCalls(convId), 0);
      assert.equal(convRow(convId).llm_calls, 0);
      assert.equal(fake.sentTo(chat).length, 0);
      assert.equal(notices().length, n);
      assert.ok(!decisions.some((d) => d.conversationId === convId));
    });

    it('人工回复的号：连发几条、人工回过之后客户再发，都不起草', async () => {
      const chat = newChat();
      const before = callCounts();
      for (const text of ['你好', '想问下保温杯 A100']) await wahaSend(t, manualAcc, chat, text);
      const convId = convIdOf(manualAcc, chat);
      await waitDecided(t, convId, 2);
      assert.equal((await t.req('POST', `${convPath(convId)}/send`, { body: { text: '在的' } })).status, 200);
      await says(manualAcc, chat, '有现货吗', 3);
      await sleep(150);
      await idle();
      const inbound = (await getMessages(t, convId)).filter((x) => x.direction === 'in');
      assert.ok(inbound.every((x) => x.botDecision === 'skipped' && x.decisionReason === '这个号没开自动回复'));
      assert.equal((await getConv(t, convId)).draft, null);
      assert.equal(hooks.calls.suggest, before.suggest);
      assert.equal(suggestCalls(convId), 0);
      assert.equal(convRow(convId).llm_calls, 0);
    });

    it('库里还是 suggest 的号（v0.3.0 升级上来的）：按人工回复处理，不起草', async () => {
      assert.equal(storedConfig(legacyAcc).replyMode, 'suggest');
      const chat = newChat();
      const before = callCounts();
      const convId = await says(legacyAcc, chat, '保温杯 A100 多少钱', 1);
      await sleep(150);
      await idle();
      const [m] = await getMessages(t, convId);
      assert.equal(m.botDecision, 'skipped');
      assert.equal(m.decisionReason, '这个号没开自动回复');
      assert.equal((await getConv(t, convId)).draft, null);
      assert.deepEqual(hooks.calls, before);
      assert.equal(llmCalls(convId), 0);
    });

    it('自动回复的号：照旧自动回复，不起草推荐回复', async () => {
      const n = hooks.calls.suggest;
      const chat = newChat();
      const convId = await says(autoAcc, chat, '保温杯 A100 多少钱', 1);
      await waitFor(() => fake.sentTo(chat).length === 1);
      assert.equal((await getMessages(t, convId)).find((x) => x.direction === 'in').botDecision, 'replied');
      assert.equal(hooks.calls.suggest, n);
      assert.equal(suggestCalls(convId), 0);
      assert.equal((await getConv(t, convId)).draft, null);
    });

    it('非文字消息：人工回复的号（含库里还是 suggest 的）照旧标待处理并通知，不调用模型', async () => {
      const image = { url: 'http://waha:3000/api/files/x/IMG1.jpeg', mimetype: 'image/jpeg', filename: null };
      const send = (acc, chat) => postWaha(t, wahaMessage({ from: chat, hasMedia: true, media: image, session: acc.waha.sessionName }));
      for (const acc of [manualAcc, legacyAcc]) {
        const before = callCounts();
        const n = notices().length;
        const chat = newChat();
        await send(acc, chat);
        const [m] = await waitDecided(t, convIdOf(acc, chat), 1);
        assert.equal(m.botDecision, 'skipped', acc.name);
        assert.match(m.decisionReason, /^非文字消息.*已通知人工$/, acc.name);
        assert.equal((await getConv(t, convIdOf(acc, chat))).needsHuman, true, acc.name);
        await waitFor(() => notices().length === n + 1);
        assert.deepEqual(hooks.calls, before, acc.name);
      }
    });

    it('开了语音识别：人工回复的号也不识别（不调用模型），照旧标待处理并通知', async () => {
      assert.equal((await t.req('PUT', '/api/settings', { body: { media: { voice: true, transcribeModel: 'whisper-1' } } })).status, 200);
      try {
        const chat = newChat();
        const p = `${manualAcc.waha.sessionName}/SUGVOICE1.oga`;
        fake.state.files.set(p, { buffer: Buffer.from('保温杯 A100 有几种颜色'), mime: 'audio/ogg' });
        const media = { url: `http://waha:3000/api/files/${p}`, mimetype: 'audio/ogg; codecs=opus', filename: null };
        const before = callCounts();
        const n = notices().length;
        await postWaha(t, wahaMessage({ from: chat, hasMedia: true, media, session: manualAcc.waha.sessionName }));
        const convId = convIdOf(manualAcc, chat);
        const [m] = await waitDecided(t, convId, 1);
        await idle();
        assert.equal(m.botDecision, 'skipped');
        assert.match(m.decisionReason, /已通知人工/);
        assert.equal((await getConv(t, convId)).needsHuman, true);
        await waitFor(() => notices().length === n + 1);
        assert.deepEqual(hooks.calls, before, '没有转写，也没有起草');
        assert.equal(convRow(convId).llm_calls, 0);
      } finally {
        await t.req('PUT', '/api/settings', { body: { media: { voice: false } } });
      }
    });
  });

  describe('手动要推荐回复 POST /api/wa/conversations/:id/suggest', () => {
    it('起草一条存进 draft（kind=suggest）并返回：不发给客户、不通知、不暂停、不标待处理、不写处理记录；llm_calls 记 suggest，计入会话每日模型次数', async () => {
      const chat = newChat();
      const gen = hooks.calls.generate;
      const n = notices().length;
      const convId = await says(manualAcc, chat, '保温杯 A100 能便宜点吗', 1);
      const before = await getMessages(t, convId);
      const r = await manual(convId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body), ['draft']);
      assert.deepEqual(Object.keys(r.body.draft).sort(), ['createdAt', 'fileIds', 'kind', 'text']);
      assert.equal(r.body.draft.kind, 'suggest');
      assert.match(r.body.draft.text, /59 元/);
      assert.match(r.body.draft.text, /【待你确认：/);
      const conv = await getConv(t, convId);
      assert.deepEqual(conv.draft, r.body.draft);
      assert.equal(conv.needsHuman, false);
      assert.equal(conv.botPaused, false);
      assert.equal(fake.sentTo(chat).length, 0, '推荐回复不会发给客户');
      assert.equal(notices().length, n, '不发转人工通知');
      assert.equal(hooks.calls.generate, gen, '不走自动回复流程');
      assert.equal(suggestCalls(convId), 1);
      assert.equal(convRow(convId).llm_calls, 1, '计入会话每日模型次数');
      assert.ok(!decisions.some((d) => d.conversationId === convId), '推荐回复不写处理记录（不算自动回复也不算转人工）');
      assert.equal(hooks.args.suggest.previous, '');
      assert.equal(hooks.args.suggest.message, '保温杯 A100 能便宜点吗');
      assert.deepEqual(await getMessages(t, convId), before, '不改消息的处理结果');
    });

    it('「换一条」：带上当前推荐作为【上一条推荐】，返回并存下不同的一条；计入模型次数，不改消息的处理结果', async () => {
      const chat = newChat();
      const convId = await says(manualAcc, chat, '保温杯 A100 多少钱', 1);
      const first = await manual(convId);
      assert.equal(first.status, 200);
      const before = await getMessages(t, convId);
      const r = await manual(convId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.draft.kind, 'suggest');
      assert.notEqual(r.body.draft.text, first.body.draft.text);
      assert.equal(hooks.args.suggest.previous, first.body.draft.text);
      assert.equal(hooks.args.suggest.message, '保温杯 A100 多少钱');
      assert.deepEqual((await getConv(t, convId)).draft, r.body.draft);
      assert.equal(suggestCalls(convId), 2);
      assert.equal(convRow(convId).llm_calls, 2);
      assert.deepEqual(await getMessages(t, convId), before);
    });

    it('「客户这次的消息」= 我方最后一条之后客户发的所有消息（合并）；我方已经回过时用最近一段客户消息；上下文带前面的对话', async () => {
      const chat = newChat();
      const convId = await says(manualAcc, chat, '第一句：保温杯 A100', 1);
      await says(manualAcc, chat, '第二句：有黑色吗', 2);
      assert.equal((await manual(convId)).status, 200);
      assert.equal(hooks.args.suggest.message, '第一句：保温杯 A100\n第二句：有黑色吗');
      assert.deepEqual(hooks.args.suggest.history, []);

      const sent = await t.req('POST', `${convPath(convId)}/send`, { body: { text: '有的，黑白两色' } });
      assert.equal(sent.status, 200);
      assert.equal((await getConv(t, convId)).draft, null, '人工发出后推荐清掉');
      assert.equal((await manual(convId)).status, 200);
      assert.equal(hooks.args.suggest.message, '第一句：保温杯 A100\n第二句：有黑色吗', '我方已经回过：用最近一段客户消息');

      await says(manualAcc, chat, '第三句：那来 100 个', 3);
      assert.equal((await manual(convId)).status, 200);
      assert.equal(hooks.args.suggest.message, '第三句：那来 100 个');
      assert.deepEqual(
        hooks.args.suggest.history.map((h) => `${h.role}:${h.text}`),
        ['customer:第一句：保温杯 A100', 'customer:第二句：有黑色吗', 'bot:有的，黑白两色'],
      );
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest', '会话暂停（人工发过消息）不影响手动要');
    });

    it('人工回复、自动回复、库里还是 suggest 的号都能手动要', async () => {
      for (const acc of [manualAcc, autoAcc, legacyAcc]) {
        const chat = newChat();
        const convId = await says(acc, chat, '你们公司在哪', 1);
        const r = await manual(convId);
        assert.equal(r.status, 200, `${acc.name} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.draft.kind, 'suggest', acc.name);
        assert.equal(suggestCalls(convId), 1, acc.name);
      }
    });

    it('起草期间我方已经回了（手机上回、后台发）：照样返回这条推荐，但不存进会话', async () => {
      for (const how of ['phone', 'admin']) {
        const chat = newChat();
        const convId = await says(manualAcc, chat, '保温杯 A100 有货吗', 1);
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
        let r;
        try {
          const pending = manual(convId);
          await waitFor(() => started);
          if (how === 'phone') assert.equal(await ownerSays(manualAcc, chat, '有货'), 'archived_owner');
          else assert.equal((await t.req('POST', `${convPath(convId)}/send`, { body: { text: '有货' } })).status, 200);
          release();
          r = await pending;
        } finally {
          hooks.suggest = null;
        }
        assert.equal(r.status, 200, how);
        assert.equal(r.body.draft.kind, 'suggest', how);
        assert.equal((await getConv(t, convId)).draft, null, how);
      }
    });

    it('我方任何消息发出后清掉推荐：手机上回、外联；转人工草稿不受手机回复影响', async () => {
      const chat = newChat();
      const convId = await says(manualAcc, chat, '保温杯 A100 多少钱', 1);
      assert.equal((await manual(convId)).status, 200);
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest');
      assert.equal(await ownerSays(manualAcc, chat, '59 元'), 'archived_owner');
      assert.equal((await getConv(t, convId)).draft, null, '手机上回了');

      await says(manualAcc, chat, '那 200 个呢', 2);
      assert.equal((await manual(convId)).status, 200);
      assert.equal((await getConv(t, convId)).draft.kind, 'suggest');
      const internal = t.ctx.accounts.get(manualAcc.id);
      await t.ctx.wa.sendCampaignMessage(internal, { chatId: chat, number: chat.replace(/\D+/g, ''), text: '新品上市，欢迎咨询' });
      assert.equal((await getConv(t, convId)).draft, null, '外联发出');

      const handoff = { kind: 'handoff', text: '转人工时起草的', fileIds: [], createdAt: new Date().toISOString() };
      t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(handoff), convId);
      await ownerSays(manualAcc, chat, '手机上又回了一句');
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

    it('错误：没有客户消息 400 no_customer_message；当天上限 429 llm_daily_limit；生成失败 502；会话不存在 404', async () => {
      const chat = newChat();
      await t.ctx.wa.sendCampaignMessage(t.ctx.accounts.get(manualAcc.id), { chatId: chat, number: chat.replace(/\D+/g, ''), text: '你好' });
      const outOnly = convIdOf(manualAcc, chat);
      let r = await manual(outOnly);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'no_customer_message');

      const chat2 = newChat();
      const c2 = await says(manualAcc, chat2, '在吗', 1);
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
      assert.equal((await getConv(t, c2)).needsHuman, false);
      assert.equal((await manual(`${manualAcc.id}:nobody@c.us`)).status, 404);
    });

    it('权限同其他会话接口：agent 只能对分给自己的会话要推荐', async () => {
      const chat = newChat();
      const convId = await says(manualAcc, chat, '保温杯 A100', 1);
      let r = await manual(convId, agent.cookie);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'forbidden');
      await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });
      r = await manual(convId, agent.cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
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

    it('用点按钮的人的个人话术（和会话负责人是谁无关）；都带公司话术', async () => {
      const chat = newChat();
      const convId = await says(manualAcc, chat, '保温杯 A100', 1);
      assert.equal((await manual(convId)).status, 200);
      assert.equal(hooks.args.suggest.stylePrompt, '管理员的话术：先问好', '未分配时 admin 点的');
      assert.equal(hooks.args.suggest.companyPrompt, '称呼客户 Dear');
      await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });
      assert.equal((await manual(convId)).status, 200);
      assert.equal(hooks.args.suggest.stylePrompt, '管理员的话术：先问好', '分给了业务员，admin 点的仍用 admin 的');
      assert.equal((await manual(convId, agent.cookie)).status, 200);
      assert.equal(hooks.args.suggest.stylePrompt, '我习惯用短句，多用 OK', '业务员点的用业务员的');
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

  it('客户消息照常只存（新建的号是人工回复，不调用模型）；手动要：400 llm_not_configured', async () => {
    assert.equal(acc.replyMode, 'off');
    const chat = newChat();
    await wahaSend(t, acc, chat, '你好');
    const convId = convIdOf(acc, chat);
    const [m] = await waitDecided(t, convId, 1);
    assert.equal(m.botDecision, 'skipped');
    assert.equal(m.decisionReason, '这个号没开自动回复');
    const r = await t.req('POST', `${convPath(convId)}/suggest`);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'llm_not_configured');
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n, 0);
  });
});
