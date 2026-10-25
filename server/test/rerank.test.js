// 重排（可选）：重排接口客户端（请求格式、鉴权头、两种返回格式、用量、错误分类、错误里没有密钥）、设置（校验、默认关、不返回密钥、
// 存坏了回到默认、agent 403）、测试接口（用表单里的值、失败不带密钥、记成测试连接）、检索（按分数重新排、只发前 40 条、接口只回一部分时
// 其余接在后面、全带档和没开时不调、出错和超时退回原来的顺序且日志 5 分钟一行、缓存、llm_calls 记 rerank 且不计入会话的模型次数、
// 和按意思搜一起用）和操作日志。不调真实服务：客户端和检索用本地假服务，和按意思搜一起用的那组用 mock 和替换掉的方法。
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { buildRerankRequest, parseRerankResponse, rerankDocuments, RerankError } from '../src/ai/rerank.js';
import { kvSet } from '../src/db.js';
import { queryTextOf, selectEntries } from '../src/kb/retrieve.js';
import { RERANK_CACHE_MS, RERANK_CANDIDATES, RERANK_DOC_CHARS, rerankDocText } from '../src/kb/rerank.js';
import { pickQueryTerms } from '../src/kb/search.js';
import { llmScope } from '../src/records.js';
import { buildReplyContext } from '../src/reply/engine.js';
import { loadSettings } from '../src/settings.js';
import { aiHooks, startApp } from './helpers.js';

const KEY = 'rr-test-SECRET-4321';

/** 本地假重排服务：记下请求（方法、路径、头、JSON 体），按 handler 回复；handler 返回 [status, body, headers?, delayMs?] */
async function startFakeRerank() {
  const state = { requests: [], handler: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const rec = { method: req.method, path: req.url, headers: req.headers, body };
    state.requests.push(rec);
    const [status, data, headers = {}, delayMs = 0] = await state.handler(rec);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (res.destroyed) return;
    const isRaw = typeof data === 'string';
    res.writeHead(status, { 'content-type': isRaw ? 'text/html' : 'application/json', ...headers });
    res.end(isRaw ? data : JSON.stringify(data));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    last: () => state.requests.at(-1),
    count: () => state.requests.length,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/** Jina / Cohere 的返回：按 scoreOf(文字, 序号) 打分，从高到低 */
const jinaReply = (docs, scoreOf, extra = {}) => ({
  model: 'm',
  results: docs.map((d, index) => ({ index, relevance_score: scoreOf(d, index), document: { text: d } })).sort((a, b) => b.relevance_score - a.relevance_score),
  usage: { total_tokens: 321 },
  ...extra,
});
/** 把序号倒过来排（后面的分高） */
const reverseScore = (_d, i) => i / 1000;
const ids = (list) => list.map((e) => e.id);

describe('重排接口客户端（本地假服务）', () => {
  let f;
  before(async () => {
    f = await startFakeRerank();
  });
  after(() => f.close());

  it('POST {地址}/rerank，Bearer 密钥，体只有 {model, query, documents}（不带 top_n）；Jina / Cohere 的 results 按分数排，记 usage.total_tokens', async () => {
    f.state.handler = (req) => [200, jinaReply(req.body.documents, reverseScore)];
    const cfg = { baseUrl: ` ${f.url}/v1/ `, apiKey: KEY, model: ' jina-reranker-v2-base-multilingual ' };
    const r = await rerankDocuments(cfg, { query: '价格', documents: ['a', 'b', 'c'] });
    const req = f.last();
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/rerank');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(req.body, { model: 'jina-reranker-v2-base-multilingual', query: '价格', documents: ['a', 'b', 'c'] });
    assert.deepEqual(r.results, [
      { index: 2, score: 0.002 },
      { index: 1, score: 0.001 },
      { index: 0, score: 0 },
    ]);
    assert.equal(r.inputTokens, 321);
    assert.equal(r.outputTokens, null);
    assert.equal(buildRerankRequest({ baseUrl: 'https://api.cohere.com/v2', model: 'rerank-v3.5' }, 'q', ['x']).url, 'https://api.cohere.com/v2/rerank');
  });

  it('Voyage 的 data[]、硅基流动的 tokens、Cohere 的 search_units（不是 token，不记）；没填密钥不带鉴权头；乱序的结果按分数排', async () => {
    f.state.handler = () => [
      200,
      { object: 'list', data: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }], model: 'rerank-2.5', usage: { total_tokens: 55 } },
    ];
    let r = await rerankDocuments({ baseUrl: f.url, apiKey: '', model: 'rerank-2.5' }, { query: 'q', documents: ['x', 'y'] });
    assert.deepEqual(r.results.map((x) => x.index), [1, 0]);
    assert.equal(r.inputTokens, 55);
    assert.equal(f.last().headers.authorization, undefined);

    const sf = parseRerankResponse({ id: 'x', results: [{ index: 1, relevance_score: 0.3 }, { index: 0, relevance_score: 0.8 }], tokens: { input_tokens: 40, output_tokens: 0 } }, 2);
    assert.deepEqual(sf.results.map((x) => x.index), [0, 1]);
    assert.equal(sf.inputTokens, 40);
    assert.equal(sf.outputTokens, 0);
    const co = parseRerankResponse({ results: [{ index: 0, relevance_score: 0.5 }], meta: { billed_units: { search_units: 1 } } }, 1);
    assert.equal(co.inputTokens, null, 'search_units 不当 token 记');

    f.state.handler = () => [200, { results: [{ index: 1, relevance_score: 0.5 }, { index: 0, relevance_score: 0.5 }] }];
    r = await rerankDocuments({ baseUrl: f.url, model: 'm' }, { query: 'q', documents: ['x', 'y'] });
    assert.deepEqual(r.results.map((x) => x.index), [1, 0], '分数一样按返回的先后');
  });

  it('序号不对（超出范围、重复、不是整数）、分数不是数的跳过；一个能用的都没有、缺 results、非 JSON 都是 bad_response', async () => {
    const p = parseRerankResponse(
      {
        results: [
          { index: 5, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 },
          { index: 1, relevance_score: 0.99 },
          { index: '0', relevance_score: 0.7 },
          { index: 0, relevance_score: 'high' },
          { index: 2, relevance_score: 0.1 },
        ],
      },
      3,
    );
    assert.deepEqual(p.results, [
      { index: 1, score: 0.8 },
      { index: 2, score: 0.1 },
    ]);
    assert.throws(() => parseRerankResponse({ results: [{ index: 9, relevance_score: 1 }] }, 3), (e) => e instanceof RerankError && e.kind === 'bad_response');
    assert.throws(() => parseRerankResponse({ object: 'list' }, 3), (e) => e.kind === 'bad_response');
    f.state.handler = () => [200, '<!doctype html><title>首页</title>'];
    const e = await rerankDocuments({ baseUrl: f.url, model: 'm' }, { query: 'q', documents: ['x'] }).catch((x) => x);
    assert.equal(e.kind, 'bad_response');
    assert.match(e.message, /非 JSON/);
  });

  it('HTTP 错误分类：401/403 鉴权、404 地址或模型（提示 /rerank）、429、5xx、其他 4xx；连不上、超时、配置不对（config 不发请求）；信息里没有密钥', async () => {
    const cfg = { baseUrl: f.url, apiKey: KEY, model: 'm' };
    const errOf = async (status, body) => {
      f.state.handler = () => [status, body];
      return rerankDocuments(cfg, { query: 'q', documents: ['x'] }).catch((e) => e);
    };
    let e = await errOf(401, { message: `invalid api token ${KEY}` });
    assert.ok(e instanceof RerankError);
    assert.equal(e.kind, 'auth');
    assert.match(e.message, /鉴权失败（401）/);
    assert.ok(!e.message.includes(KEY));
    assert.equal((await errOf(403, {})).kind, 'auth');
    e = await errOf(404, { detail: 'Not Found' });
    assert.equal(e.kind, 'not_found');
    assert.match(e.message, /\/rerank/);
    assert.equal((await errOf(429, { message: 'slow down' })).kind, 'rate_limit');
    assert.equal((await errOf(500, 'Internal Server Error')).kind, 'server');
    e = await errOf(422, { message: `bad documents ${KEY}` });
    assert.equal(e.kind, 'bad_request');
    assert.ok(!e.message.includes(KEY));

    e = await rerankDocuments({ ...cfg, baseUrl: 'http://127.0.0.1:9' }, { query: 'q', documents: ['x'] }).catch((x) => x);
    assert.equal(e.kind, 'network');
    assert.match(e.message, /^无法连接重排接口/);
    f.state.handler = () => [200, { results: [] }, {}, 1000];
    e = await rerankDocuments(cfg, { query: 'q', documents: ['x'], timeoutMs: 50 }).catch((x) => x);
    assert.equal(e.kind, 'timeout');

    const n = f.count();
    assert.equal((await rerankDocuments({ ...cfg, apiKey: `${KEY}中文` }, { query: 'q', documents: ['x'] }).catch((x) => x)).kind, 'config');
    assert.equal((await rerankDocuments({ ...cfg, baseUrl: 'ftp://x' }, { query: 'q', documents: ['x'] }).catch((x) => x)).kind, 'config');
    assert.equal((await rerankDocuments({ ...cfg, baseUrl: ' ' }, { query: 'q', documents: ['x'] }).catch((x) => x)).kind, 'config');
    assert.equal((await rerankDocuments({ ...cfg, model: '' }, { query: 'q', documents: ['x'] }).catch((x) => x)).kind, 'config');
    assert.deepEqual((await rerankDocuments(cfg, { query: 'q', documents: [] })).results, [], '没有文字不发请求');
    assert.equal(f.count(), n);
  });

  it('发过去的条目文字：标题、内容、标签（不带 [id:…] 和类型），最多 2000 字', () => {
    const e = { id: 'abc', type: 'faq', title: '保温杯价格', content: '59 元', tags: ['价格', '保温杯'] };
    assert.equal(rerankDocText(e), '保温杯价格\n59 元\n标签：价格、保温杯');
    const long = rerankDocText({ title: 't', content: 'x'.repeat(5000) });
    assert.equal(long.length, RERANK_DOC_CHARS);
    assert.equal(RERANK_CANDIDATES, 40);
  });
});

describe('重排的设置', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(() => t.close());

  it('默认关：GET 里有 rerank 块，没有密钥', async () => {
    const r = await t.req('GET', '/api/settings');
    assert.deepEqual(r.body.rerank, { enabled: false, baseUrl: '', model: '', apiKeySet: false, apiKeyLast4: null });
  });

  it('字段校验：类型不对、地址不是 http 回 400，错误以 rerank.<字段> 开头；开着时没地址、没模型各有 code；没保存', async () => {
    const put = (rerank) => t.req('PUT', '/api/settings', { body: { rerank } });
    assert.match((await put({ enabled: 'yes' })).body.error, /^rerank\.enabled/);
    assert.equal((await put({ baseUrl: 'ftp://x' })).body.error, 'rerank.baseUrl 必须以 http:// 或 https:// 开头');
    assert.match((await put({ model: 1 })).body.error, /^rerank\.model/);
    assert.match((await put({ apiKey: 5 })).body.error, /^rerank\.apiKey/);
    assert.equal((await put('on')).status, 400);
    let r = await put({ enabled: true, baseUrl: '', model: 'm' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'rerank_base_url_required');
    r = await put({ enabled: true, baseUrl: 'https://api.jina.ai/v1', model: ' ' });
    assert.equal(r.body.code, 'rerank_model_required');
    assert.equal(t.ctx.getSettings().rerank.enabled, false);
    // 关着时随便填
    assert.equal((await put({ enabled: false, baseUrl: '', model: '' })).status, 200);
  });

  it('密钥：GET 只有 apiKeySet 和后 4 位；去掉首尾空白存；空串清空', async () => {
    const r = await t.req('PUT', '/api/settings', {
      body: { rerank: { enabled: true, baseUrl: ' https://api.jina.ai/v1 ', apiKey: ` ${KEY} `, model: ' jina-reranker-v2-base-multilingual ' } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rerank, {
      enabled: true,
      baseUrl: 'https://api.jina.ai/v1',
      model: 'jina-reranker-v2-base-multilingual',
      apiKeySet: true,
      apiKeyLast4: '4321',
    });
    assert.equal(t.ctx.getSettings().rerank.apiKey, KEY);
    assert.ok(!JSON.stringify((await t.req('GET', '/api/settings')).body).includes(KEY));
    // 只改别的字段不动密钥
    await t.req('PUT', '/api/settings', { body: { rerank: { model: 'jina-reranker-v3' } } });
    assert.equal(t.ctx.getSettings().rerank.apiKey, KEY);
    const c = await t.req('PUT', '/api/settings', { body: { rerank: { apiKey: '' } } });
    assert.equal(c.body.rerank.apiKeySet, false);
    assert.equal(t.ctx.getSettings().rerank.apiKey, '');
    await t.req('PUT', '/api/settings', { body: { rerank: { enabled: false } } });
  });

  it('库里存坏了的重排设置回到默认值；老库没有这一块时自动补上', () => {
    kvSet(t.ctx.db, 'settings', { ...t.ctx.getSettings(), rerank: { enabled: 'yes', baseUrl: 5, apiKey: null, model: ['x'] } });
    let s = loadSettings(t.ctx.db, t.config);
    assert.deepEqual(s.rerank, { enabled: false, baseUrl: '', apiKey: '', model: '' });
    const { rerank: _, ...old } = t.ctx.getSettings();
    kvSet(t.ctx.db, 'settings', old);
    s = loadSettings(t.ctx.db, t.config);
    assert.deepEqual(s.rerank, { enabled: false, baseUrl: '', apiKey: '', model: '' });
    kvSet(t.ctx.db, 'settings', t.ctx.getSettings());
  });

  it('演示模式的测试接口：不发网络请求，用 mock 排', async () => {
    const r = await t.req('POST', '/api/settings/rerank/test', { body: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.results, 3);
  });

  it('agent：改重排设置、测试都 403', async () => {
    const m = await t.addMember({ email: 'agent-rerank@example.com', role: 'agent' });
    assert.equal((await t.req('PUT', '/api/settings', { body: { rerank: { enabled: false } }, cookie: m.cookie })).status, 403);
    assert.equal((await t.req('POST', '/api/settings/rerank/test', { body: {}, cookie: m.cookie })).status, 403);
  });
});

describe('重排的测试接口（真实模式，本地假服务）', () => {
  let f;
  let t;
  before(async () => {
    f = await startFakeRerank();
    t = await startApp({ env: { INKDOVE_LLM_MOCK: '0' } });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { rerank: { baseUrl: `${f.url}/v1`, apiKey: KEY, model: 'rr-a' } } });
  });
  after(async () => {
    await t.close();
    await f.close();
  });

  it('用表单里还没保存的值：没传密钥用已保存的；回模型、耗时、几段、第一名对不对；llm_calls 记成测试连接', async () => {
    f.state.handler = (req) => [200, jinaReply(req.body.documents, (d) => (/Price/.test(d) ? 0.9 : 0.1))];
    const r = await t.req('POST', '/api/settings/rerank/test', { body: { model: 'rr-b', apiKey: '' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.model, 'rr-b');
    assert.equal(r.body.results, 3);
    assert.equal(r.body.topMatches, true);
    assert.ok(Number.isFinite(r.body.latencyMs));
    assert.equal(f.last().path, '/v1/rerank');
    assert.equal(f.last().body.model, 'rr-b');
    assert.equal(f.last().headers.authorization, `Bearer ${KEY}`);
    assert.equal(f.last().body.documents.length, 3);
    assert.equal(t.ctx.getSettings().rerank.model, 'rr-a', '测试不保存');
    const row = t.ctx.db.prepare('SELECT * FROM llm_calls ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(row.purpose, 'test');
    assert.equal(row.format, 'rerank');
    assert.equal(row.model, 'rr-b');
    assert.equal(row.input_tokens, 321);
    assert.equal(row.ok, 1);

    await t.req('POST', '/api/settings/rerank/test', { body: { apiKey: 'other-key-0000' } });
    assert.equal(f.last().headers.authorization, 'Bearer other-key-0000', '填了新密钥就用新的');
  });

  it('失败回 200 {ok:false, error, kind}，错误、日志里都没有密钥；没地址不发请求（config）；字段不合法回 400', async () => {
    f.state.handler = () => [401, { message: `invalid token ${KEY}` }];
    let r = await t.req('POST', '/api/settings/rerank/test', { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.kind, 'auth');
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.ok(!t.log.lines.some((l) => l.includes(KEY)));
    f.state.handler = () => [200, { results: [] }];
    assert.equal((await t.req('POST', '/api/settings/rerank/test', { body: {} })).body.kind, 'bad_response');
    assert.equal((await t.req('POST', '/api/settings/rerank/test', { body: { baseUrl: 'http://127.0.0.1:9/v1' } })).body.kind, 'network');
    const n = f.count();
    await t.req('PUT', '/api/settings', { body: { rerank: { baseUrl: '' } } });
    r = await t.req('POST', '/api/settings/rerank/test', { body: {} });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.kind, 'config');
    assert.equal(r.body.field, 'baseUrl');
    assert.equal((await t.req('POST', '/api/settings/rerank/test', { body: { baseUrl: 'ftp://x' } })).status, 400);
    assert.equal(f.count(), n);
    const failed = t.ctx.db.prepare("SELECT ok FROM llm_calls WHERE purpose = 'test' AND format = 'rerank' ORDER BY rowid").pluck().all();
    assert.ok(failed.includes(0), '失败的也记一行');
  });
});

/** 每条约 900 字、都带 thermos 的条目，50 条合计超过 40000 字（检索档） */
const filler = (i) => ({
  type: 'product',
  title: `Thermos model T${i}`,
  content: `Thermos T${i} spec. ${Array.from({ length: 120 }, (_, k) => `w${i}x${k}`).join(' ')}`,
  tags: ['thermos'],
  origin: 'manual',
});

describe('检索时重排（真实模式，本地假服务）', () => {
  let f;
  let t;
  let clock = Date.parse('2030-01-01T00:00:00Z');
  const QUERY = 'how much is the thermos price';
  const enable = (patch = {}) =>
    t.req('PUT', '/api/settings', { body: { rerank: { enabled: true, baseUrl: `${f.url}/v1`, apiKey: KEY, model: 'rr-model', ...patch } } });
  /** 不重排时的候选顺序（没开向量检索：关键词检索的前 60 条） */
  const merged = (texts) => t.ctx.kb.searchEntries(pickQueryTerms(texts), { limit: 60 });
  const select = (texts, o = {}) => selectEntries(t.ctx, { texts, rewrite: false, ...o });
  const rerankWarns = () => t.log.lines.filter((l) => l.startsWith('warn [rerank]'));

  before(async () => {
    f = await startFakeRerank();
    t = await startApp({ env: { INKDOVE_LLM_MOCK: '0' }, options: { rerankNow: () => clock, realAiOptions: { rerankTimeoutMs: 200 } } });
    await t.login();
  });
  after(async () => {
    await t.close();
    await f.close();
  });

  it('全带档（不超过 40000 字）不调重排接口', async () => {
    for (let i = 0; i < 5; i++) t.ctx.kb.insertEntry(filler(i));
    assert.equal((await enable()).status, 200);
    f.state.handler = (req) => [200, jinaReply(req.body.documents, reverseScore)];
    const r = await select([QUERY]);
    assert.equal(r.mode, 'all');
    assert.equal(r.rerank, false);
    assert.equal(f.count(), 0);
  });

  it('检索档：前 40 条候选按分数重新排，后面的接在后面；查询是同一段话，条目文字不带 id；llm_calls 记 rerank、记在号和会话上，不计入模型次数', async () => {
    for (let i = 5; i < 50; i++) t.ctx.kb.insertEntry(filler(i));
    const texts = [QUERY, 'hello'];
    const ranked = merged(texts);
    assert.equal(ranked.length, 50);
    const target = ranked[37];
    f.state.handler = (req) => [200, jinaReply(req.body.documents, (d, i) => (d.startsWith(`${target.title}\n`) ? 5 : reverseScore(d, i)))];

    const r = await llmScope({ accountId: 'acc-1', conversationId: 'acc-1:c1' }, () => select(texts));
    assert.equal(r.mode, 'search');
    assert.equal(r.rerank, true);
    assert.equal(r.llmCalls, 0, '重排不计入会话每天的模型次数');
    const req = f.last();
    assert.equal(req.body.query, queryTextOf(texts));
    assert.equal(req.body.documents.length, RERANK_CANDIDATES);
    assert.deepEqual(req.body.documents, ranked.slice(0, RERANK_CANDIDATES).map(rerankDocText));
    assert.ok(req.body.documents.every((d) => !d.includes('[id:')));
    const head = ranked.slice(0, RERANK_CANDIDATES);
    const expected = [target, ...[...head].reverse().filter((e) => e.id !== target.id), ...ranked.slice(RERANK_CANDIDATES)];
    assert.deepEqual(ids(r.entries), ids(expected).slice(0, 20));

    const row = t.ctx.db.prepare("SELECT * FROM llm_calls WHERE purpose = 'rerank' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(row.format, 'rerank');
    assert.equal(row.model, 'rr-model');
    assert.equal(row.input_tokens, 321);
    assert.equal(row.ok, 1);
    assert.equal(row.account_id, 'acc-1');
    assert.equal(row.conversation_id, 'acc-1:c1');

    // 回复上下文：searchCalls 只算改写
    const c = await buildReplyContext(t.ctx, { message: 'thermos price for 500 pcs?', history: [], searchRewrite: false });
    assert.equal(c.searchCalls, 0);
    // 红线体检里的记 redteam
    await llmScope({ purpose: 'redteam', accountId: null, conversationId: null }, () => select(['thermos for redteam']));
    const rt = t.ctx.db.prepare('SELECT * FROM llm_calls ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(rt.purpose, 'redteam');
    assert.equal(rt.format, 'rerank');
  });

  it('缓存：同一段话 + 同一批候选 30 分钟内不再请求；换话、改了候选条目、改了重排设置、过了 30 分钟都重新请求', async () => {
    f.state.handler = (req) => [200, jinaReply(req.body.documents, reverseScore)];
    const texts = ['thermos cache check'];
    const r1 = await select(texts);
    const n = f.count();
    const r2 = await select(texts);
    assert.equal(f.count(), n, '缓存命中');
    assert.equal(r2.rerank, true);
    assert.deepEqual(ids(r2.entries), ids(r1.entries));

    await select(['thermos cache check two']);
    assert.equal(f.count(), n + 1, '换了话');

    const e = merged(texts)[3];
    t.ctx.kb.updateEntry(e.id, { content: `${e.content} updated` });
    await select(texts);
    assert.equal(f.count(), n + 2, '候选条目改过');
    await select(texts);
    assert.equal(f.count(), n + 2);

    await enable({ model: 'rr-model-2' });
    assert.equal(t.ctx.reranker.cacheSize(), 0, '设置一变缓存清空');
    await select(texts);
    assert.equal(f.count(), n + 3);
    assert.equal(f.last().body.model, 'rr-model-2');

    clock += RERANK_CACHE_MS + 1;
    await select(texts);
    assert.equal(f.count(), n + 4, '过了 30 分钟');
    await enable();
  });

  it('接口只回一部分：回了的按分数在前，没回的按原来的顺序接在后面', async () => {
    f.state.handler = () => [200, { results: [{ index: 5, relevance_score: 0.9 }, { index: 2, relevance_score: 0.5 }, { index: 9, relevance_score: 0.7 }] }];
    const texts = ['thermos partial'];
    const ranked = merged(texts);
    const r = await select(texts);
    const rest = ranked.filter((_, i) => ![5, 2, 9].includes(i));
    assert.deepEqual(ids(r.entries), ids([ranked[5], ranked[9], ranked[2], ...rest]).slice(0, 20));
  });

  it('出错（500、非 JSON、超时、配置被清掉）：照原来的顺序，回复照常；同一类问题 5 分钟只记一行 warn，失败的调用也记 llm_calls', async () => {
    const texts = ['thermos failure'];
    const plain = ids(merged(texts)).slice(0, 20);
    const w0 = rerankWarns().length;

    f.state.handler = () => [500, { message: 'boom' }];
    let r = await select(texts);
    assert.equal(r.rerank, false);
    assert.deepEqual(ids(r.entries), plain);
    r = await select(texts);
    assert.deepEqual(ids(r.entries), plain);
    assert.equal(rerankWarns().length, w0 + 1, '500 两次只记一行');
    const bad = t.ctx.db.prepare("SELECT ok FROM llm_calls WHERE purpose = 'rerank' ORDER BY rowid DESC LIMIT 1").pluck().get();
    assert.equal(bad, 0);

    f.state.handler = () => [200, '<html>oops</html>'];
    r = await select(texts);
    assert.deepEqual(ids(r.entries), plain);
    assert.equal(rerankWarns().length, w0 + 2, '换一类问题再记一行');

    f.state.handler = () => [200, { results: [{ index: 0, relevance_score: 1 }] }, {}, 1000];
    const started = Date.now();
    r = await select(texts);
    assert.ok(Date.now() - started < 900, '超时就不等了');
    assert.equal(r.rerank, false);
    assert.deepEqual(ids(r.entries), plain);
    assert.ok(rerankWarns().some((l) => l.includes('超时')));

    f.state.handler = () => [500, {}];
    await select(texts);
    assert.equal(rerankWarns().filter((l) => l.includes('500')).length, 1, '5 分钟内同类不再记');
    clock += 5 * 60_000 + 1;
    await select(texts);
    assert.equal(rerankWarns().filter((l) => l.includes('500')).length, 2, '过了 5 分钟再记一行');

    // 开着但地址被直接改空（存坏了）：不发请求，照原来的顺序
    const n = f.count();
    t.ctx.updateSettings((s) => {
      s.rerank.baseUrl = '';
    });
    r = await select(texts);
    assert.equal(r.rerank, false);
    assert.deepEqual(ids(r.entries), plain);
    assert.equal(f.count(), n);
    assert.ok(rerankWarns().some((l) => l.includes('没配好')));
    assert.ok(!t.log.lines.some((l) => l.includes(KEY)), '日志里没有密钥');
    await enable();
  });

  it('没开：不调重排接口，结果和原来一样', async () => {
    await t.req('PUT', '/api/settings', { body: { rerank: { enabled: false } } });
    const n = f.count();
    const texts = ['thermos disabled'];
    const r = await select(texts);
    assert.equal(r.rerank, false);
    assert.equal(f.count(), n);
    assert.deepEqual(ids(r.entries), ids(merged(texts)).slice(0, 20));
  });
});

describe('检索时重排：和按意思搜一起用（mock，替换掉的方法）', () => {
  let t;
  let hooks;
  before(async () => {
    hooks = await aiHooks();
    t = await startApp({ options: { aiOverrides: hooks.overrides } });
    await t.login();
    for (let i = 0; i < 50; i++) t.ctx.kb.insertEntry(filler(i));
    await t.req('PUT', '/api/settings', {
      body: { embedding: { enabled: true, source: 'custom', format: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm1' } },
    });
    await t.ctx.vectors.run();
  });
  after(() => t.close());

  it('向量开着时：查询向量和重排用同一段话，重排的是两路合并后的候选；倒过来排就倒过来带', async () => {
    const texts = ['thermos T7 spec', 'earlier message'];
    const plain = await selectEntries(t.ctx, { texts, rewrite: false });
    assert.equal(plain.vector, true);
    assert.equal(plain.rerank, false);
    assert.equal(hooks.calls.rerank, 0, '没开不调');

    assert.equal(
      (await t.req('PUT', '/api/settings', { body: { rerank: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'rr' } } })).status,
      200,
    );
    hooks.rerank = ({ documents }) => ({
      results: documents.map((_, index) => ({ index, score: index })).reverse(),
      inputTokens: null,
      outputTokens: null,
      model: 'fake',
    });
    const r = await selectEntries(t.ctx, { texts: [...texts], rewrite: false });
    assert.equal(r.vector, true);
    assert.equal(r.rerank, true);
    assert.equal(hooks.calls.rerank, 1);
    assert.equal(hooks.args.rerank.query, hooks.args.embed.texts[0], '查询向量和重排用同一段话');
    assert.equal(hooks.args.rerank.documents.length, RERANK_CANDIDATES);
    // 第一名是合并后排第 40 的那条
    assert.equal(rerankDocText(r.entries[0]), hooks.args.rerank.documents[RERANK_CANDIDATES - 1]);
    const row = t.ctx.db.prepare("SELECT * FROM llm_calls WHERE purpose = 'rerank' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(row.format, 'mock');
  });

  it('mock 的重排：词对上得多的排前面', async () => {
    hooks.rerank = null;
    const r = await selectEntries(t.ctx, { texts: ['T42 spec w42x7'], rewrite: false });
    assert.equal(r.rerank, true);
    assert.equal(r.entries[0].title, 'Thermos model T42');
  });
});

describe('重排的操作日志', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(() => t.close());
  const last = (action) => t.ctx.db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action);
  const dump = () => JSON.stringify(t.ctx.db.prepare('SELECT * FROM audit_logs').all());

  it('设置：密钥只记已设置 / 已修改 / 已清空；地址里像令牌的部分去掉；中文标签；测试接口记一行', async () => {
    const token = 'tok9876543210abcdefXYZ';
    let r = await t.req('PUT', '/api/settings', {
      body: { rerank: { enabled: true, baseUrl: `https://rr.example.com/${token}/v1?key=${token}`, apiKey: KEY, model: 'rerank-v3.5' } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let by = Object.fromEntries(JSON.parse(last('settings.update').changes).map((c) => [c.field, c]));
    assert.deepEqual(by['rerank.apiKey'], { field: 'rerank.apiKey', label: '重排服务 · API 密钥', secret: true, note: '已设置' });
    assert.equal(by['rerank.enabled'].label, '重排');
    assert.equal(by['rerank.enabled'].to, '开');
    assert.equal(by['rerank.model'].label, '重排模型');
    assert.equal(by['rerank.model'].to, 'rerank-v3.5');
    assert.equal(by['rerank.baseUrl'].label, '重排服务 · 接口地址');
    assert.equal(by['rerank.baseUrl'].to, 'https://rr.example.com/…/v1?…');

    await t.req('PUT', '/api/settings', { body: { rerank: { apiKey: 'another-key-1111' } } });
    by = Object.fromEntries(JSON.parse(last('settings.update').changes).map((c) => [c.field, c]));
    assert.equal(by['rerank.apiKey'].note, '已修改');
    await t.req('PUT', '/api/settings', { body: { rerank: { apiKey: '' } } });
    by = Object.fromEntries(JSON.parse(last('settings.update').changes).map((c) => [c.field, c]));
    assert.equal(by['rerank.apiKey'].note, '已清空');
    const all = dump();
    for (const s of [KEY, 'another-key-1111', token]) assert.ok(!all.includes(s), `${s} 不落库`);

    r = await t.req('POST', '/api/settings/rerank/test', { body: { apiKey: 'typed-key-2222' } });
    assert.equal(r.body.ok, true);
    const row = last('settings.rerank_test');
    assert.equal(row.summary, '测试了重排服务连接（结果：通过）');
    assert.ok(!dump().includes('typed-key-2222'));
  });
});
