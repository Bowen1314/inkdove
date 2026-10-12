import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildDraftSystemPrompt, buildReplySystemPrompt, HANDOFF_TYPES, STYLE_RULES } from '../src/reply/prompts.js';
import { handoffCodeOf } from '../src/reply/engine.js';
import { DAILY_LLM_LIMIT } from '../src/wa/service.js';
import {
  aiHooks,
  convIdOf,
  convPath,
  getConv,
  getMessages,
  sleep,
  startApp,
  startFakeWaha,
  waitDecided,
  waitFor,
  wahaSend,
} from './helpers.js';

const BOSS = '8613900000000';
const BOSS_CHAT = `${BOSS}@c.us`;
let seq = 0;
const newChat = () => `86137${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('F2 知识库闭环 + F14 草稿', () => {
  let t;
  let fake;
  let acc;
  let hooks;
  const decisions = [];
  const cid = (chat) => convIdOf(acc, chat);
  const notices = () => fake.sentTo(BOSS_CHAT).map((m) => m.text).filter((x) => x.startsWith('[待人工]'));

  /** 一位客户发一句话，等处理完，返回 {chat, conv, msgs} */
  async function customer(text, name = '客户') {
    const chat = newChat();
    await wahaSend(t, acc, chat, text, { pushName: name });
    const msgs = await waitDecided(t, cid(chat), 1);
    await waitFor(() => t.ctx.wa.idle());
    return { chat, msgs, conv: await getConv(t, cid(chat)) };
  }

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({
      env: { KBWA_WAHA_URL: fake.url },
      options: { aiOverrides: hooks.overrides, onDecision: (row) => decisions.push(row) },
    });
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

  describe('F2a 转人工时备好草稿', () => {
    it('handoff 时起草（不发给客户），存成 {text, fileIds, createdAt}；先起草再通知，通知里带草稿；草稿调用计入 LLM 次数', async () => {
      const before = notices().length;
      const { chat, conv } = await customer('保温杯 A100 能便宜点吗，给个折扣', '周先生');
      assert.equal(conv.needsHuman, true);
      assert.ok(conv.draft, '应该有草稿');
      assert.deepEqual(Object.keys(conv.draft).sort(), ['createdAt', 'fileIds', 'text']);
      assert.match(conv.draft.text, /【待你确认：/);
      assert.deepEqual(conv.draft.fileIds, []);
      assert.equal(fake.sentTo(chat).length, 0, '草稿不会自动发给客户');
      await waitFor(() => notices().length === before + 1);
      const notice = notices().at(-1);
      assert.ok(notice.includes(`建议回复（草稿，未发送）：\n${conv.draft.text}`), notice);
      const row = t.ctx.db.prepare('SELECT llm_calls FROM conversations WHERE id = ?').get(cid(chat));
      assert.equal(row.llm_calls, 2, '生成 1 次 + 草稿 1 次');
    });

    it('草稿不过 4.3 / 4.4：带折扣词、资料外价格和【待你确认】占位也原样存下，不调审核', async () => {
      const raw = '可以给您 9 折，100 件 199 元【待你确认：折扣和 100 件的单价】';
      hooks.draft = () => ({ text: raw, fileIds: [] });
      const reviews = hooks.calls.review;
      try {
        const { conv } = await customer('我要人工');
        assert.equal(conv.draft.text, raw);
        assert.equal(hooks.calls.review, reviews);
      } finally {
        hooks.draft = null;
      }
    });

    it('草稿 prompt 带说话方式规则和【待你确认：…】要求；回复 prompt 带同一段说话方式', () => {
      const sys = buildDraftSystemPrompt({ profile: {}, persona: '', entries: [], files: [] });
      assert.ok(sys.includes(`【说话方式】\n${STYLE_RULES}\n`));
      assert.ok(sys.includes('【待你确认：…】'));
      assert.ok(sys.includes('{"text": "草稿正文", "file_ids": ["..."]}'));
      assert.ok(buildReplySystemPrompt({ profile: {}, persona: '', entries: [], canary: 'x' }).includes(STYLE_RULES));
    });

    it('草稿生成失败：照常通知，不带草稿', async () => {
      hooks.draft = () => {
        throw new Error('模型挂了');
      };
      const before = notices().length;
      try {
        const { conv } = await customer('我要人工');
        assert.equal(conv.needsHuman, true);
        assert.equal(conv.draft, null);
        await waitFor(() => notices().length === before + 1);
        assert.ok(!notices().at(-1).includes('建议回复'));
      } finally {
        hooks.draft = null;
      }
    });

    it('当天 LLM 次数用完：不起草，照常通知', async () => {
      const chat = newChat();
      // 先建会话，再把今天的次数调到只够这一轮生成 + 审核
      await wahaSend(t, acc, chat, '你好');
      await waitDecided(t, cid(chat), 1);
      const d = new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      t.ctx.db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(day, DAILY_LLM_LIMIT - 2, cid(chat));
      hooks.review = () => ({ verdict: 'ungrounded', reason: '没依据' });
      const drafts = hooks.calls.draft;
      const before = notices().length;
      try {
        await wahaSend(t, acc, chat, '保温杯 A100 多少钱');
        await waitDecided(t, cid(chat), 2);
        await waitFor(() => notices().length === before + 1);
        const conv = await getConv(t, cid(chat));
        assert.equal(conv.needsHuman, true);
        assert.equal(conv.draft, null);
        assert.equal(hooks.calls.draft, drafts, '次数不够就不调草稿');
      } finally {
        hooks.review = null;
      }
    });

    it('人工发消息、/resume 都清空草稿；新的转人工产生新草稿', async () => {
      const a = await customer('我要人工');
      assert.ok(a.conv.draft);
      await t.req('POST', `${convPath(cid(a.chat))}/send`, { body: { text: '您好，我来了' } });
      assert.equal((await getConv(t, cid(a.chat))).draft, null);

      const b = await customer('我要人工');
      assert.ok(b.conv.draft);
      await t.req('POST', `${convPath(cid(b.chat))}/bot`, { body: { paused: false } });
      assert.equal((await getConv(t, cid(b.chat))).draft, null);
      hooks.draft = () => ({ text: '新草稿', fileIds: [] });
      try {
        await wahaSend(t, acc, b.chat, '还是要人工');
        await waitDecided(t, cid(b.chat), 2);
        await waitFor(async () => (await getConv(t, cid(b.chat))).draft?.text === '新草稿');
      } finally {
        hooks.draft = null;
      }
    });

    it('A 段格式的旧草稿 {text, createdAt} 读出来 fileIds 为 []', async () => {
      const { chat } = await customer('你好');
      t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify({ text: '旧草稿', createdAt: '2026-01-01T00:00:00.000Z' }), cid(chat));
      assert.deepEqual((await getConv(t, cid(chat))).draft, { text: '旧草稿', fileIds: [], createdAt: '2026-01-01T00:00:00.000Z' });
    });
  });

  describe('待处理原因 pendingReason', () => {
    it('needsHuman 时列表和单个会话都带让它进入待处理的那条消息的原因；恢复后为 null', async () => {
      const { chat, msgs, conv } = await customer('我要人工');
      const reason = msgs.find((m) => m.direction === 'in').decisionReason;
      assert.ok(reason);
      assert.equal(conv.pendingReason, reason);
      assert.equal((await t.req('GET', convPath(cid(chat)))).body.pendingReason, reason);
      await t.req('POST', `${convPath(cid(chat))}/bot`, { body: { paused: false } });
      assert.equal((await getConv(t, cid(chat))).pendingReason, null);
      assert.equal((await t.req('GET', convPath(cid(chat)))).body.pendingReason, null);
    });

    it('非文字消息、回复次数超限也写原因；正常回复的会话为 null', async () => {
      const ok = await customer('保温杯 A100 多少钱');
      assert.equal(ok.conv.needsHuman, false);
      assert.equal(ok.conv.pendingReason, null);
      const chat = newChat();
      await wahaSend(t, acc, chat, '', { hasMedia: true, media: { mimetype: 'image/jpeg', url: null } });
      await waitFor(async () => (await getConv(t, cid(chat)))?.needsHuman);
      assert.equal((await getConv(t, cid(chat))).pendingReason, '非文字消息[图片]，已通知人工');
    });
  });

  describe('F2b 人工回复一键存进知识库', () => {
    it('kb-draft：只能用于 operator 消息；改写结果带 sourceRefs、不落库；agent 403', async () => {
      const { chat } = await customer('运费怎么算？寄到上海', '吴女士');
      await t.req('POST', `${convPath(cid(chat))}/send`, { body: { text: '吴女士您好，江浙沪运费 10 元，满 300 包邮，电话 13800138000' } });
      const msgs = await getMessages(t, cid(chat));
      const op = msgs.find((m) => m.author === 'operator');
      const cust = msgs.find((m) => m.author === 'customer');
      const entriesBefore = (await t.req('GET', '/api/kb/entries')).body.length;

      const r = await t.req('POST', `${convPath(cid(chat))}/messages/${op.id}/kb-draft`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['content', 'sourceRefs', 'tags', 'title', 'type']);
      assert.equal(r.body.type, 'faq');
      assert.equal(r.body.title, '运费怎么算？寄到上海');
      assert.ok(!r.body.content.includes('13800138000'), '去掉电话号码');
      assert.deepEqual(r.body.sourceRefs, [{ sourceId: null, sourceName: '会话：吴女士', quote: op.text.slice(0, 200) }]);
      assert.equal(hooks.args.kbDraft.question, '运费怎么算？寄到上海');
      assert.equal((await t.req('GET', '/api/kb/entries')).body.length, entriesBefore, '不落库');

      const bad = await t.req('POST', `${convPath(cid(chat))}/messages/${cust.id}/kb-draft`);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'not_operator_message');
      assert.equal((await t.req('POST', `${convPath(cid(chat))}/messages/nope/kb-draft`)).status, 404);
      const agent = await t.addMember({ email: 'f2agent@example.com', accountIds: [acc.id] });
      assert.equal((await t.req('POST', `${convPath(cid(chat))}/messages/${op.id}/kb-draft`, { cookie: agent.cookie })).status, 403);
    });

    it('POST /api/kb/entries 支持 origin=conversation 和 sourceRefs；默认 manual；其他取值 400', async () => {
      const refs = [{ sourceId: null, sourceName: '会话：吴女士', quote: '江浙沪运费 10 元' }];
      const r = await t.req('POST', '/api/kb/entries', {
        body: { type: 'policy', title: '运费', content: '江浙沪运费 10 元，满 300 包邮。', tags: ['运费'], origin: 'conversation', sourceRefs: refs },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.origin, 'conversation');
      assert.deepEqual(r.body.sourceRefs, refs);
      const m = await t.req('POST', '/api/kb/entries', { body: { type: 'fact', title: 'x', content: 'y', sourceRefs: refs } });
      assert.equal(m.body.origin, 'manual');
      assert.deepEqual(m.body.sourceRefs, [], 'manual 不带 sourceRefs');
      assert.equal((await t.req('POST', '/api/kb/entries', { body: { type: 'fact', title: 'x', content: 'y', origin: 'distill' } })).status, 400);
    });
  });

  describe('F2c 答不了的问题自动进缺口清单', () => {
    it('handoff_type=insufficient_info：question_zh 进缺口（origin=conversation、conversationId、count=1）；相似问题只加 count；按 count 倒序', async () => {
      hooks.generate = (args, mock) =>
        /火星车/.test(args.message)
          ? { category: 'handoff', reply: '', usedEntryIds: [], sendFileIds: [], handoffType: 'insufficient_info', questionZh: '你们有没有火星车配件', reason: '资料里没有' }
          : mock.generate(args);
      try {
        const a = await customer('你们有火星车吗？');
        let gaps = (await t.req('GET', '/api/kb/gaps')).body;
        const g = gaps.find((x) => x.question === '你们有没有火星车配件');
        assert.ok(g, JSON.stringify(gaps));
        assert.equal(g.origin, 'conversation');
        assert.equal(g.conversationId, cid(a.chat));
        assert.equal(g.count, 1);
        await customer('火星车有货吗');
        gaps = (await t.req('GET', '/api/kb/gaps')).body;
        assert.equal(gaps.filter((x) => x.question === '你们有没有火星车配件').length, 1);
        assert.equal(gaps[0].question, '你们有没有火星车配件', '按 count 倒序');
        assert.equal(gaps[0].count, 2);
      } finally {
        hooks.generate = null;
      }
    });

    it('其他 handoff_type 不进缺口；没给 question_zh 时用客户原话', async () => {
      const before = (await t.req('GET', '/api/kb/gaps')).body.length;
      await customer('我要人工');
      assert.equal((await t.req('GET', '/api/kb/gaps')).body.length, before);
      await customer('你们卖不卖潜水艇零件啊');
      const gaps = (await t.req('GET', '/api/kb/gaps')).body;
      assert.ok(gaps.some((g) => g.question === '你们卖不卖潜水艇零件啊' && g.origin === 'conversation'));
    });

    it('rebuild 只删蒸馏出来的 open 缺口，会话来的保留', async () => {
      await t.req('POST', '/api/sources/text', { body: { name: '资料', text: '保温杯 A100 价格 59 元。' } });
      const { jobId } = (await t.req('POST', '/api/distill', { body: { mode: 'rebuild' } })).body;
      await waitFor(async () => ['done', 'failed'].includes((await t.req('GET', `/api/distill/jobs/${jobId}`)).body.status), { timeout: 8000 });
      const gaps = (await t.req('GET', '/api/kb/gaps')).body;
      assert.ok(gaps.some((g) => g.question === '你们有没有火星车配件' && g.status === 'open'));
    });

    it('handoff_type → F12 code：六个值同名，缺失或不认识的记 other；decisions 带 code', async () => {
      assert.deepEqual(HANDOFF_TYPES.map(handoffCodeOf), HANDOFF_TYPES);
      assert.equal(handoffCodeOf(''), 'other');
      assert.equal(handoffCodeOf('weird'), 'other');
      for (const [type, code] of [
        ['price', 'price'],
        ['purchase', 'purchase'],
        ['identity', 'identity'],
        ['human_request', 'human_request'],
        ['bogus', 'other'],
        [undefined, 'other'],
      ]) {
        hooks.generate = () => ({ category: 'handoff', reply: '', usedEntryIds: [], handoffType: type, reason: 'x' });
        const r = await t.req('POST', '/api/kb/ask', { body: { message: '随便问问' } });
        assert.equal(r.body.decision, 'handoff');
        assert.equal(r.body.code, code, String(type));
      }
      hooks.generate = null;
      // 走 WhatsApp 的那一轮也按这个 code 记 decisions
      const n = decisions.length;
      await customer('能给个折扣吗');
      await waitFor(() => decisions.length > n);
      assert.equal(decisions.at(-1).code, 'price');
      assert.deepEqual(decisions.at(-1).sentFileIds, []);
      await sleep(10);
    });
  });
});
