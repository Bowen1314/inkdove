// 推荐回复和转人工草稿的依据条目（draft.entryIds）、会话页显示引用条目用的 GET /api/kb/entries/by-ids。
// 模型用 mock（aiHooks 记下参数、可以换掉返回值）；real.js 的解析用本地假 LLM 服务。
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createRealAi } from '../src/ai/real.js';
import { MAX_BY_IDS } from '../src/routes/kb.js';
import { MAX_DRAFT_ENTRIES, parseDraft } from '../src/wa/service.js';
import { aiHooks, convIdOf, convPath, getConv, startApp, startFakeWaha, waitDecided, waitFor, wahaSend } from './helpers.js';

const BOSS = '8613900000000';
let seq = 0;
const newChat = () => `86135${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;

describe('草稿的依据条目 entryIds', () => {
  let t;
  let fake;
  let hooks;
  let manualAcc;
  let autoAcc;
  /** 知识条目：A100、退换政策（启用），停用的 B200（在知识库里，但不会放进提示词） */
  let a100;
  let refund;
  let disabled;
  const rawDraft = (convId) => JSON.parse(t.ctx.db.prepare('SELECT draft FROM conversations WHERE id = ?').get(convId).draft ?? 'null');
  const manual = (convId) => t.req('POST', `${convPath(convId)}/suggest`);
  const idle = () => waitFor(() => t.ctx.wa.idle());
  async function says(acc, chat, text, n) {
    assert.equal((await wahaSend(t, acc, chat, text)).status, 200);
    const convId = convIdOf(acc, chat);
    await waitDecided(t, convId, n);
    await idle();
    return convId;
  }
  const addEntry = async (body) => {
    const r = await t.req('POST', '/api/kb/entries', { body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url }, options: { aiOverrides: hooks.overrides } });
    await t.login();
    a100 = await addEntry({ type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' });
    refund = await addEntry({ type: 'policy', title: '退换政策', content: '收货 7 天内可以退换，运费买家承担。' });
    disabled = await addEntry({ type: 'product', title: '保温杯 B200（停产）', content: '保温杯 B200 价格 79 元。', status: 'disabled' });
    assert.equal(disabled.status, 'disabled');
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    manualAcc = await t.createAccount({ name: '人工号' });
    autoAcc = await t.createAccount({ name: '自动号', replyMode: 'auto', notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    for (const a of [manualAcc, autoAcc]) await t.req('POST', `/api/accounts/${a.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('推荐回复：返回和存下的 draft 带 entryIds（mock 给依据的那几条），会话接口里一样', async () => {
    const convId = await says(manualAcc, newChat(), '保温杯 A100 多少钱', 1);
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.draft.text, /59 元/);
    assert.deepEqual(r.body.draft.entryIds, [a100.id]);
    assert.deepEqual(rawDraft(convId).entryIds, [a100.id], '库里存下');
    assert.deepEqual((await getConv(t, convId)).draft, r.body.draft);
    assert.deepEqual((await t.req('GET', convPath(convId))).body.draft, r.body.draft, '单个会话接口也带');
  });

  it('推荐回复：模型抄来的 "id:" 前缀和方括号去掉、去重；不在这次提示词里的 id（停用条目、不存在的）丢掉，不报错', async () => {
    const convId = await says(manualAcc, newChat(), '保温杯 A100 多少钱，能退换吗', 1);
    let inPrompt;
    hooks.suggest = (args) => {
      inPrompt = args.entries.map((e) => e.id);
      return {
        text: 'A100 是 59 元，收货 7 天内可以退换',
        fileIds: [],
        entryIds: [`id:${a100.id}`, `[id:${refund.id}]`, `ID:${a100.id}`, `id:${disabled.id}`, 'id:not-an-entry', `[${refund.id}]`, 42],
      };
    };
    let r;
    try {
      r = await manual(convId);
    } finally {
      hooks.suggest = null;
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(inPrompt.includes(a100.id) && inPrompt.includes(refund.id));
    assert.ok(!inPrompt.includes(disabled.id), '停用的条目不进提示词');
    assert.deepEqual(r.body.draft.entryIds, [a100.id, refund.id]);
    assert.deepEqual(rawDraft(convId).entryIds, [a100.id, refund.id]);
  });

  it('推荐回复：模型没给 used_entry_ids（或不是数组）时 entryIds 是 []，草稿照常', async () => {
    const convId = await says(manualAcc, newChat(), '保温杯 A100 多少钱', 1);
    for (const entryIds of [undefined, 'x', null]) {
      hooks.suggest = () => ({ text: '59 元一个', fileIds: [], entryIds });
      try {
        const r = await manual(convId);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.draft.entryIds, [], String(entryIds));
        assert.equal(r.body.draft.text, '59 元一个');
      } finally {
        hooks.suggest = null;
      }
    }
  });

  it('转人工草稿：handoff 时起草的 draft 也带 entryIds；同样去前缀、只留放进提示词的', async () => {
    let chat = newChat();
    let convId = await says(autoAcc, chat, '保温杯 A100 能便宜点吗，给个折扣', 1);
    let conv = await waitFor(() => getConv(t, convId).then((c) => (c?.draft ? c : null)));
    assert.equal(conv.needsHuman, true);
    assert.equal(conv.draft.kind, 'handoff');
    assert.deepEqual(conv.draft.entryIds, [a100.id], 'mock 草稿照 A100 写');

    hooks.draft = (args) => ({
      text: 'A100 是 59 元【待你确认：折扣】',
      fileIds: [],
      entryIds: [`[id:${args.entries[0].id}]`, `id:${disabled.id}`, 'id:nope'],
    });
    try {
      chat = newChat();
      convId = await says(autoAcc, chat, '我要人工', 1);
      conv = await waitFor(() => getConv(t, convId).then((c) => (c?.draft ? c : null)));
    } finally {
      hooks.draft = null;
    }
    const first = hooks.args.draft.entries[0].id;
    assert.notEqual(first, disabled.id);
    assert.deepEqual(conv.draft.entryIds, [first]);
    assert.deepEqual(rawDraft(convId).entryIds, [first]);
  });

  it('老草稿没有 entryIds：接口里是 []；不合法的去掉，最多 MAX_DRAFT_ENTRIES 条', async () => {
    const convId = await says(manualAcc, newChat(), '你好', 1);
    const at = new Date().toISOString();
    for (const old of [
      { kind: 'suggest', text: '老推荐', fileIds: [], createdAt: at },
      { kind: 'handoff', text: '老草稿', fileIds: [], createdAt: at },
      { text: 'A 段的草稿', createdAt: at },
    ]) {
      t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify(old), convId);
      const d = (await getConv(t, convId)).draft;
      assert.deepEqual(d.entryIds, [], old.text);
      assert.equal(d.text, old.text);
    }
    const many = Array.from({ length: MAX_DRAFT_ENTRIES + 5 }, (_, i) => `id:e${i}`);
    const d = parseDraft(JSON.stringify({ kind: 'suggest', text: 'x', fileIds: [], entryIds: [...many, { id: 'obj' }, ''], createdAt: at }));
    assert.equal(d.entryIds.length, MAX_DRAFT_ENTRIES);
    assert.deepEqual(d.entryIds.slice(0, 2), ['e0', 'e1']);
    assert.deepEqual(parseDraft(JSON.stringify({ text: 'x', entryIds: 'e1' })).entryIds, []);
    assert.equal(parseDraft(JSON.stringify({ text: '', fileIds: [], entryIds: [a100.id] })), null, '只有条目、没有文字和文件的不算草稿');
  });
});

describe('GET /api/kb/entries/by-ids', () => {
  let t;
  let agent;
  const ids = [];
  const byIds = (q, o) => t.req('GET', `/api/kb/entries/by-ids${q}`, o);

  before(async () => {
    t = await startApp();
    await t.login();
    for (const [title, status] of [
      ['条目一', 'active'],
      ['条目二', 'active'],
      ['条目三（停用）', 'disabled'],
    ]) {
      const r = await t.req('POST', '/api/kb/entries', { body: { type: 'faq', title, content: `${title}的内容`, status } });
      ids.push(r.body.id);
    }
    agent = await t.addMember({ email: 'byids-agent@example.com', name: '小吴' });
  });
  after(() => t.close());

  it('按给的顺序返回，结构同 GET /api/kb/entries；不存在的跳过，停用的照样返回（带 status），重复的只返回一次', async () => {
    const all = (await t.req('GET', '/api/kb/entries')).body;
    const full = (id) => all.find((e) => e.id === id);
    let r = await byIds(`?ids=${ids[2]},missing-id,${ids[0]},${ids[0]}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, [full(ids[2]), full(ids[0])]);
    assert.equal(r.body[0].status, 'disabled');
    r = await byIds(`?ids=${encodeURIComponent(` ${ids[1]} , ${ids[0]} `)}`);
    assert.deepEqual(r.body.map((e) => e.id), [ids[1], ids[0]], '去掉空格');
    r = await byIds(`?ids=${ids[1]}&ids=${ids[0]},${ids[2]}`);
    assert.deepEqual(r.body.map((e) => e.id), [ids[1], ids[0], ids[2]], '也认重复的 ids=');
    r = await byIds('?ids=nope1,nope2');
    assert.deepEqual(r.body, [], '都不存在：空数组，不报错');
  });

  it('没给 ids 或是空的：返回 []', async () => {
    for (const q of ['', '?ids=', '?ids=,,%20']) {
      const r = await byIds(q);
      assert.equal(r.status, 200, q);
      assert.deepEqual(r.body, [], q);
    }
  });

  it(`上限 ${MAX_BY_IDS} 个（去重后算）：超过 400 too_many_ids`, async () => {
    const fill = (n) => Array.from({ length: n }, (_, i) => (i < ids.length ? ids[i] : `x${i}`));
    let r = await byIds(`?ids=${fill(MAX_BY_IDS).join(',')}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, ids.length);
    r = await byIds(`?ids=${[...fill(MAX_BY_IDS), ids[0], ids[1]].join(',')}`);
    assert.equal(r.status, 200, '重复的不算数');
    r = await byIds(`?ids=${fill(MAX_BY_IDS + 1).join(',')}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'too_many_ids');
  });

  it('权限同 GET /api/kb/entries：业务员能用，没登录 401', async () => {
    const r = await byIds(`?ids=${ids[0]}`, { cookie: agent.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map((e) => e.id), [ids[0]]);
    assert.equal((await t.req('GET', '/api/kb/entries', { cookie: agent.cookie })).status, 200);
    assert.equal((await byIds(`?ids=${ids[0]}`, { auth: false })).status, 401);
  });
});

/** 本地假 LLM（OpenAI 格式）：记录请求体，按 handler 回一段文字 */
async function startFakeLlm() {
  const state = { requests: [], handler: () => '{}' };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'fake', choices: [{ message: { role: 'assistant', content: state.handler(body) } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

describe('真实模型实现：起草输出的 used_entry_ids（本地假 LLM 服务）', () => {
  let f;
  let ai;
  const args = {
    message: 'A100 多少钱',
    history: [],
    entries: [{ id: 'e-1', type: 'product', title: '保温杯 A100', content: '59 元', tags: [] }],
    files: [],
    profile: {},
    persona: '',
  };
  before(async () => {
    f = await startFakeLlm();
    ai = createRealAi(() => ({ llm: { format: 'openai', baseUrl: `${f.url}/v1`, apiKey: 'sk-local-fake', model: 'fake-model', distillModel: '' } }));
  });
  after(() => f.close());

  it('draft、suggest 把 used_entry_ids 原样给成 entryIds（规整和过滤在 wa/service.js）；没给时是 []；提示词要求输出 used_entry_ids', async () => {
    f.state.handler = () => JSON.stringify({ text: 'A100 是 59 元', file_ids: [], used_entry_ids: ['id:e-1', 'e-2', 3, { x: 1 }] });
    for (const name of ['draft', 'suggest']) {
      const out = await ai[name](args);
      assert.deepEqual(out, { text: 'A100 是 59 元', fileIds: [], entryIds: ['id:e-1', 'e-2', '3'] }, name);
      const sys = f.state.requests.at(-1).messages[0].content;
      assert.ok(sys.includes('"used_entry_ids": ["..."]'), name);
      assert.ok(sys.includes('used_entry_ids 列出起草所依据的知识条目 id'), name);
      assert.ok(sys.includes('[id:e-1] '), name);
    }
    f.state.handler = () => JSON.stringify({ text: '好的', file_ids: [] });
    assert.deepEqual((await ai.suggest(args)).entryIds, []);
  });
});
