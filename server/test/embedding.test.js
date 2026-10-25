// 向量检索（可选）：向量接口客户端（OpenAI 兼容、Gemini 的请求格式、鉴权头、解析、错误分类、错误里没有密钥）、设置（校验、
// 不返回密钥、测试接口、agent 403）、后台计算（分批、文字没变不重算、改一条只算一条、删了就没了、换模型全部重算、出错停下或
// 退避、一条都没算出来时放慢到 30 分钟一次、关掉就停、重新计算、长条目分段）和检索（排名融合、跨语言、覆盖率够了不改写、不够照常改写、查询向量失败退回、
// 全带档不算向量、int8 和 float 的排名一致、库里存 int8 读出来不再量化）。不调真实服务：客户端用本地假服务，其余用 mock 或替换掉的 embed。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { buildEmbedRequest, EmbedError, embedModelKey, embedTexts, normalizeVector, parseRetryAfter } from '../src/ai/embed.js';
import { queryTextOf, RRF_K, rrfMerge, selectEntries } from '../src/kb/retrieve.js';
import { CONTEXT_CHAR_LIMIT } from '../src/kb/search.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BATCH_SEGMENTS,
  COLD_FAIL_STREAK,
  COLD_RETRY_MS,
  entrySegments,
  MAX_SEGMENTS,
  QUANT,
  QuantizedIndex,
  quantize,
  SEGMENT_CHARS,
  segmentsHash,
  splitText,
} from '../src/kb/vectors.js';
import { buildReplyContext } from '../src/reply/engine.js';
import { aiHooks, startApp, waitFor } from './helpers.js';

const KEY = 'sk-embed-SECRET-9876';
const GKEY = 'AIza-embed-SECRET-5555';

/** 本地假向量服务：记下请求（方法、路径、头、JSON 体），按 handler 回复；handler 返回 [status, body, headers?, delayMs?] */
async function startFakeEmbed() {
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
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/** OpenAI 兼容的回复：每段文字一个 dims 维的向量（第 i 段第 i % dims 维是 1） */
const openaiReply = (texts, dims = 4, extra = {}) => ({
  object: 'list',
  data: texts.map((_, i) => ({ object: 'embedding', index: i, embedding: Array.from({ length: dims }, (__, k) => (k === i % dims ? 1 : 0)) })),
  usage: { prompt_tokens: 12, total_tokens: 12 },
  ...extra,
});

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const ids = (list) => list.map((e) => e.id);

describe('向量接口客户端：OpenAI 兼容和 Gemini（本地假服务）', () => {
  let f;
  before(async () => {
    f = await startFakeEmbed();
  });
  after(() => f.close());

  it('OpenAI 兼容：POST {地址}/embeddings，Bearer 密钥，{model, input, encoding_format:"float"}；乱序的 data 按 index 排回来，归一化，记输入 token', async () => {
    f.state.handler = (req) => {
      const r = openaiReply(req.body.input, 3);
      r.data.reverse();
      r.data[0].embedding = [3, 4, 0];
      return [200, r];
    };
    const cfg = { format: 'openai', baseUrl: `${f.url}/v1/`, apiKey: KEY, model: ' text-embedding-3-small ' };
    const r = await embedTexts(cfg, ['第一段', 'second', 'tercero']);
    const req = f.last();
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/embeddings');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(req.body, { model: 'text-embedding-3-small', input: ['第一段', 'second', 'tercero'], encoding_format: 'float' });
    assert.equal(r.vectors.length, 3);
    assert.equal(r.dims, 3);
    assert.equal(r.inputTokens, 12);
    // 第 1 段（index 0）是 [1,0,0]；第 3 段（index 2）被改成 [3,4,0]，归一化成 [0.6, 0.8, 0]
    assert.deepEqual([...r.vectors[0]], [1, 0, 0]);
    assert.ok(near(r.vectors[2][0], 0.6) && near(r.vectors[2][1], 0.8));
    assert.ok(r.vectors.every((v) => v instanceof Float32Array));
  });

  it('OpenAI 兼容：不认 encoding_format、返回 base64 的 float32 也能解析；没填密钥（本机 Ollama）不带鉴权头', async () => {
    const vec = new Float32Array([0, 2, 0, 0]);
    f.state.handler = () => [200, { data: [{ index: 0, embedding: Buffer.from(vec.buffer).toString('base64') }] }];
    const r = await embedTexts({ format: 'openai', baseUrl: `${f.url}/v1`, apiKey: '', model: 'bge-m3' }, ['hola']);
    assert.deepEqual([...r.vectors[0]], [0, 1, 0, 0]);
    assert.equal(r.inputTokens, null);
    assert.equal(f.last().headers.authorization, undefined);
  });

  it('Gemini：POST {地址}/v1beta/models/{模型}:batchEmbedContents，x-goog-api-key；文档 RETRIEVAL_DOCUMENT、查询 RETRIEVAL_QUERY；模型名去掉 models/', async () => {
    f.state.handler = (req) => [
      200,
      { embeddings: req.body.requests.map((_, i) => ({ values: [i + 1, 0] })), usageMetadata: { promptTokenCount: 7 } },
    ];
    const cfg = { format: 'gemini', baseUrl: f.url, apiKey: GKEY, model: 'models/gemini-embedding-001' };
    const r = await embedTexts(cfg, ['价格', 'precio']);
    const req = f.last();
    assert.equal(req.path, '/v1beta/models/gemini-embedding-001:batchEmbedContents');
    assert.equal(req.headers['x-goog-api-key'], GKEY);
    assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(req.body, {
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: '价格' }] }, taskType: 'RETRIEVAL_DOCUMENT' },
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'precio' }] }, taskType: 'RETRIEVAL_DOCUMENT' },
      ],
    });
    assert.deepEqual([...r.vectors[1]], [1, 0]);
    assert.equal(r.inputTokens, 7, '用量取 usageMetadata.promptTokenCount');

    f.state.handler = () => [200, { embeddings: [{ values: [0, 1] }] }];
    assert.equal((await embedTexts({ ...cfg, baseUrl: `${f.url}/v1beta` }, ['x'], { task: 'query' })).inputTokens, null, '没给用量记 null');
    assert.equal(f.last().path, '/v1beta/models/gemini-embedding-001:batchEmbedContents', '地址已经带 /v1beta 不再补');
    assert.equal(f.last().body.requests[0].taskType, 'RETRIEVAL_QUERY');
  });

  it('模型 + 服务的标识：换格式、地址、模型名都变，换密钥不变；末尾的 / 和 Gemini 的 models/ 前缀不算', () => {
    const base = { format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'a', model: 'm1' };
    const k = embedModelKey(base);
    assert.equal(embedModelKey({ ...base, apiKey: 'b' }), k);
    assert.equal(embedModelKey({ ...base, baseUrl: 'https://api.example.com/v1/' }), k);
    assert.notEqual(embedModelKey({ ...base, model: 'm2' }), k);
    assert.notEqual(embedModelKey({ ...base, baseUrl: 'https://other.example.com/v1' }), k);
    assert.notEqual(embedModelKey({ ...base, format: 'gemini' }), k);
    const g = { format: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-embedding-001' };
    assert.equal(embedModelKey({ ...g, model: 'models/gemini-embedding-001' }), embedModelKey(g));
    assert.equal(buildEmbedRequest(g, ['x']).url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
  });

  it('HTTP 错误分类：401/403 鉴权、404 模型或地址不对（带 /v1 的提示）、429 限流（带 Retry-After）、5xx、其他 4xx；信息里没有密钥', async () => {
    const cfg = { format: 'openai', baseUrl: f.url, apiKey: KEY, model: 'm' };
    const errOf = async (status, body, headers) => {
      f.state.handler = () => [status, body, headers];
      return embedTexts(cfg, ['x']).catch((e) => e);
    };
    let e = await errOf(401, { error: { message: `Incorrect API key provided: ${KEY}` } });
    assert.ok(e instanceof EmbedError);
    assert.equal(e.kind, 'auth');
    assert.match(e.message, /鉴权失败（401）/);
    assert.ok(!e.message.includes(KEY));
    assert.equal((await errOf(403, { error: 'forbidden' })).kind, 'auth');
    e = await errOf(404, { error: { message: 'model not found' } });
    assert.equal(e.kind, 'not_found');
    assert.match(e.message, /\/v1/);
    e = await errOf(429, { error: { message: 'slow down' } }, { 'retry-after': '7' });
    assert.equal(e.kind, 'rate_limit');
    assert.equal(e.retryAfterMs, 7000);
    assert.equal((await errOf(429, {})).retryAfterMs, null, '没给 Retry-After');
    assert.equal((await errOf(503, 'Service Unavailable')).kind, 'server');
    assert.equal((await errOf(408, {})).kind, 'server');
    e = await errOf(400, { error: { message: `input too long ${KEY}` } });
    assert.equal(e.kind, 'bad_request');
    assert.ok(!e.message.includes(KEY));
    assert.equal(parseRetryAfter(new Date(Date.parse('2030-01-01T00:00:30Z')).toUTCString(), Date.parse('2030-01-01T00:00:00Z')), 30_000);
    assert.equal(parseRetryAfter('abc'), null);
    assert.equal(parseRetryAfter('999999'), 3_600_000, '最多信 1 小时');
  });

  it('返回格式错误：非 JSON、缺 data、条数不对、不是数字、维度不一致都是 bad_response', async () => {
    const cfg = { format: 'openai', baseUrl: f.url, apiKey: KEY, model: 'm' };
    const kindOf = async (body) => {
      f.state.handler = () => [200, body];
      return (await embedTexts(cfg, ['a', 'b']).catch((e) => e)).kind;
    };
    assert.equal(await kindOf('<!doctype html><title>首页</title>'), 'bad_response');
    assert.equal(await kindOf({ object: 'list' }), 'bad_response');
    assert.equal(await kindOf(openaiReply(['a'])), 'bad_response');
    assert.equal(await kindOf({ data: [{ index: 0, embedding: ['x'] }, { index: 1, embedding: [1] }] }), 'bad_response');
    assert.equal(await kindOf({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0, 0] }] }), 'bad_response');
    f.state.handler = () => [200, { embeddings: [{ values: [1] }] }];
    assert.equal((await embedTexts({ ...cfg, format: 'gemini' }, ['a', 'b']).catch((e) => e)).kind, 'bad_response');
  });

  it('连不上、超时、配置不对（密钥里有中文、地址不是 http）：分别是 network、timeout、config；config 不发请求', async () => {
    const e = await embedTexts({ format: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: KEY, model: 'm' }, ['x']).catch((x) => x);
    assert.equal(e.kind, 'network');
    assert.match(e.message, /^无法连接向量接口/);
    assert.ok(!e.message.includes(KEY));
    f.state.handler = () => [200, openaiReply(['x']), {}, 2000];
    const slow = await embedTexts({ format: 'openai', baseUrl: f.url, apiKey: KEY, model: 'm' }, ['x'], { timeoutMs: 50 }).catch((x) => x);
    assert.equal(slow.kind, 'timeout');
    const n = f.state.requests.length;
    const bad = await embedTexts({ format: 'openai', baseUrl: f.url, apiKey: `${KEY}中文`, model: 'm' }, ['x']).catch((x) => x);
    assert.equal(bad.kind, 'config');
    assert.ok(!bad.message.includes(KEY));
    assert.equal((await embedTexts({ format: 'openai', baseUrl: 'ftp://x', apiKey: '', model: 'm' }, ['x']).catch((x) => x)).kind, 'config');
    assert.equal((await embedTexts({ format: 'anthropic', baseUrl: f.url, apiKey: '', model: 'm' }, ['x']).catch((x) => x)).kind, 'config');
    assert.equal(f.state.requests.length, n);
  });
});

describe('向量检索的设置', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(() => t.close());

  it('字段校验：source、format、baseUrl、enabled 类型不对回 400，错误以 embedding.<字段> 开头', async () => {
    const put = (embedding) => t.req('PUT', '/api/settings', { body: { embedding } });
    assert.match((await put({ source: 'other' })).body.error, /^embedding\.source/);
    assert.match((await put({ format: 'anthropic' })).body.error, /^embedding\.format/);
    assert.equal((await put({ baseUrl: 'ftp://x' })).body.error, 'embedding.baseUrl 必须以 http:// 或 https:// 开头');
    assert.match((await put({ enabled: 'yes' })).body.error, /^embedding\.enabled/);
    assert.equal((await put('on')).status, 400);
  });

  it('开着时：用回复模型的服务而回复模型是 Anthropic → 400；单独配置没地址 → 400；没模型 → 400；之后把回复模型换成 Anthropic 也 400', async () => {
    const put = (body) => t.req('PUT', '/api/settings', { body });
    await put({ llm: { format: 'anthropic' } });
    let r = await put({ embedding: { enabled: true, source: 'llm', model: 'text-embedding-3-small' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'embedding_unsupported_for_format');
    r = await put({ embedding: { enabled: true, source: 'custom', baseUrl: '', model: 'm' } });
    assert.equal(r.body.code, 'embedding_base_url_required');
    r = await put({ embedding: { enabled: true, source: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: '' } });
    assert.equal(r.body.code, 'embedding_model_required');

    await put({ llm: { format: 'openai' } });
    r = await put({ embedding: { enabled: true, source: 'llm', model: 'text-embedding-3-small' } });
    assert.equal(r.status, 200);
    r = await put({ llm: { format: 'anthropic' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'embedding_unsupported_for_format');
    assert.equal(t.ctx.getSettings().llm.format, 'openai', '没保存');
    // 关着时随便改
    await put({ embedding: { enabled: false } });
    assert.equal((await put({ llm: { format: 'anthropic' } })).status, 200);
    await put({ llm: { format: 'openai' } });
  });

  it('GET /api/settings 不返回密钥原文，只有 apiKeySet 和后 4 位', async () => {
    const r = await t.req('PUT', '/api/settings', {
      body: { embedding: { enabled: false, source: 'custom', format: 'gemini', baseUrl: ' https://generativelanguage.googleapis.com ', apiKey: ` ${GKEY} `, model: 'gemini-embedding-001' } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.embedding, {
      enabled: false,
      source: 'custom',
      format: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-embedding-001',
      apiKeySet: true,
      apiKeyLast4: '5555',
    });
    assert.ok(!JSON.stringify((await t.req('GET', '/api/settings')).body).includes(GKEY));
    assert.equal(t.ctx.getSettings().embedding.apiKey, GKEY);
  });

  it('agent：设置、测试、向量状态、重新计算、重试都 403', async () => {
    const m = await t.addMember({ email: 'agent-embed@example.com', role: 'agent' });
    const as = (method, p, body) => t.req(method, p, { body, cookie: m.cookie });
    assert.equal((await as('PUT', '/api/settings', { embedding: { enabled: true } })).status, 403);
    assert.equal((await as('POST', '/api/settings/embedding/test', {})).status, 403);
    assert.equal((await as('GET', '/api/kb/vectors')).status, 403);
    assert.equal((await as('POST', '/api/kb/vectors/rebuild')).status, 403);
    assert.equal((await as('POST', '/api/kb/vectors/retry')).status, 403);
  });
});

describe('向量检索的测试接口（真实模式，本地假服务）', () => {
  let f;
  let t;
  before(async () => {
    f = await startFakeEmbed();
    t = await startApp({ env: { INKDOVE_LLM_MOCK: '0' } });
    await t.login();
    await t.req('PUT', '/api/settings', {
      body: { embedding: { source: 'custom', format: 'openai', baseUrl: `${f.url}/v1`, apiKey: KEY, model: 'emb-a' } },
    });
  });
  after(async () => {
    await t.close();
    await f.close();
  });

  it('用表单里还没保存的值：没传密钥用已保存的；返回维度、模型、耗时；llm_calls 记成测试连接', async () => {
    f.state.handler = (req) => [200, openaiReply(req.body.input, 1024)];
    const r = await t.req('POST', '/api/settings/embedding/test', { body: { model: 'emb-b', apiKey: '' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.dims, 1024);
    assert.equal(r.body.model, 'emb-b');
    assert.ok(Number.isFinite(r.body.latencyMs));
    assert.equal(f.last().path, '/v1/embeddings');
    assert.equal(f.last().body.model, 'emb-b');
    assert.equal(f.last().headers.authorization, `Bearer ${KEY}`);
    assert.equal(t.ctx.getSettings().embedding.model, 'emb-a', '测试不保存');
    const row = t.ctx.db.prepare('SELECT * FROM llm_calls ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(row.purpose, 'test');
    assert.equal(row.format, 'openai');
    assert.equal(row.model, 'emb-b');
    assert.equal(row.input_tokens, 12);
  });

  it('失败回 200 {ok:false, error, kind}，错误里和日志里都没有密钥', async () => {
    f.state.handler = () => [401, { error: { message: `Incorrect API key provided: ${KEY}` } }];
    const r = await t.req('POST', '/api/settings/embedding/test', { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.kind, 'auth');
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.ok(!t.log.lines.some((l) => l.includes(KEY)));
    f.state.handler = () => [404, { error: { message: 'no such model' } }];
    assert.equal((await t.req('POST', '/api/settings/embedding/test', { body: {} })).body.kind, 'not_found');
    const net = await t.req('POST', '/api/settings/embedding/test', { body: { baseUrl: 'http://127.0.0.1:9/v1' } });
    assert.equal(net.body.kind, 'network');
  });

  it('用回复模型的服务而回复模型是 Anthropic：不发请求，kind 是 config；字段不合法回 400', async () => {
    await t.req('PUT', '/api/settings', { body: { llm: { format: 'anthropic', baseUrl: f.url, apiKey: 'x', model: 'c' } } });
    const n = f.state.requests.length;
    const r = await t.req('POST', '/api/settings/embedding/test', { body: { source: 'llm' } });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.kind, 'config');
    assert.match(r.body.error, /Anthropic/);
    const bad = await t.req('POST', '/api/settings/embedding/test', { body: { format: 'cohere' } });
    assert.equal(bad.status, 400);
    assert.equal(f.state.requests.length, n);
  });

  it('用回复模型的服务（OpenAI 兼容）：地址和密钥用回复模型的', async () => {
    await t.req('PUT', '/api/settings', { body: { llm: { format: 'openai', baseUrl: `${f.url}/llm/v1`, apiKey: 'sk-llm-key', model: 'gpt' } } });
    f.state.handler = (req) => [200, openaiReply(req.body.input, 8)];
    const r = await t.req('POST', '/api/settings/embedding/test', { body: { source: 'llm' } });
    assert.equal(r.body.ok, true);
    assert.equal(f.last().path, '/llm/v1/embeddings');
    assert.equal(f.last().headers.authorization, 'Bearer sk-llm-key');
  });
});

/** 演示模式开向量检索（单独配置，地址不会真的访问） */
const enableBody = (patch = {}) => ({
  embedding: { enabled: true, source: 'custom', format: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm1', ...patch },
});
const short = (i) => ({ type: 'fact', title: `短条目 ${i}`, content: `内容 ${i} beta${i}`, origin: 'manual' });
const vecRows = (db) => db.prepare("SELECT ref_id, chunk, model_key, dims FROM embeddings WHERE kind = 'entry' ORDER BY ref_id, chunk").all();

describe('后台计算', () => {
  let t;
  let hooks;
  let clock = Date.parse('2030-01-01T00:00:00Z');
  /** 每次 embed 调用的段数（只算后台的文档向量） */
  let docBatches = [];
  const vectors = () => t.ctx.vectors;
  before(async () => {
    hooks = await aiHooks();
    t = await startApp({ options: { aiOverrides: hooks.overrides, vectorNow: () => clock } });
    await t.login();
    hooks.embed = (args, mock) => {
      if (args.task !== 'query') docBatches.push(args.texts.length);
      return mock.embed(args);
    };
  });
  after(() => t.close());
  const reset = () => {
    docBatches = [];
  };

  it('没开时什么也不算；开了以后分批算（每批最多 32 段，同一条目的几段不拆开），算完状态是 70 / 70', async () => {
    for (let i = 0; i < 70; i++) t.ctx.kb.insertEntry(short(i));
    await vectors().run();
    assert.deepEqual(docBatches, []);
    assert.equal(vectors().status().state, 'disabled');

    assert.equal((await t.req('PUT', '/api/settings', { body: enableBody() })).status, 200);
    await vectors().run();
    assert.deepEqual(docBatches, [BATCH_SEGMENTS, BATCH_SEGMENTS, 6]);
    const s = (await t.req('GET', '/api/kb/vectors')).body;
    assert.equal(s.enabled, true);
    assert.equal(s.model, 'm1');
    assert.equal(s.activeEntries, 70);
    assert.equal(s.embeddedEntries, 70);
    assert.equal(s.state, 'idle');
    assert.equal(s.running, false);
    assert.equal(s.lastError, null);
    assert.equal(s.dims, 256);
    assert.equal(vecRows(t.ctx.db).length, 70);
    const calls = t.ctx.db.prepare("SELECT COUNT(*) FROM llm_calls WHERE purpose = 'embedding'").pluck().get();
    assert.equal(calls, 3, '每批记一行 llm_calls（向量检索）');

    reset();
    await vectors().run();
    assert.deepEqual(docBatches, [], '都算过了，再跑不调接口');
  });

  it('文字没变不重算：停用再启用、重启后（新的一份后台计算读库里的向量）都不调接口', async () => {
    reset();
    const e = t.ctx.kb.listEntries({ q: '短条目 3' })[0];
    t.ctx.kb.updateEntry(e.id, { status: 'disabled' });
    assert.equal(vectors().index().has(e.id), false, '停用的马上从内存里拿掉');
    assert.equal(vecRows(t.ctx.db).filter((r) => r.ref_id === e.id).length, 1, '库里的向量留着');
    t.ctx.kb.updateEntry(e.id, { status: 'active' });
    await vectors().run();
    assert.deepEqual(docBatches, []);
    assert.equal(vectors().index().has(e.id), true);
    assert.equal(vectors().status().embeddedEntries, 70);

    const { createVectorIndexer } = await import('../src/kb/vectors.js');
    const fresh = createVectorIndexer(t.ctx, { debounceMs: 0 });
    await fresh.run();
    assert.deepEqual(docBatches, []);
    assert.equal(fresh.index().entryCount, 70);
    await fresh.close();
  });

  it('库里存 int8 量化后的字节 + 缩放系数：读进内存不再量化，和算完直接放进内存的一模一样；存法不认识的行当作没算过', async () => {
    reset();
    const rows = t.ctx.db.prepare("SELECT ref_id, chunk, dims, quant, scale, vec FROM embeddings WHERE kind = 'entry'").all();
    assert.equal(rows.length, 70);
    for (const r of rows) {
      assert.equal(r.quant, QUANT);
      assert.equal(r.vec.length, r.dims, '每个数 1 字节');
      assert.ok(r.scale > 0);
      const q = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
      assert.equal(Math.max(...q.map(Math.abs)), 127, '最大绝对值量化成 127');
    }

    const { createVectorIndexer } = await import('../src/kb/vectors.js');
    const fresh = createVectorIndexer(t.ctx, { debounceMs: 0 });
    await fresh.run();
    assert.deepEqual(docBatches, []);
    const live = vectors().index();
    const loaded = fresh.index();
    const d = loaded.dims;
    const slotBytes = (idx, id, chunk) => {
      const s = idx.byId.get(id).slots[chunk];
      return { bytes: Buffer.from(idx.q.buffer, idx.q.byteOffset + s * d, d), scale: idx.scale[s] };
    };
    for (const r of rows) {
      const a = slotBytes(loaded, r.ref_id, r.chunk);
      assert.deepEqual(a.bytes, r.vec, '内存里的就是库里存的字节');
      assert.equal(a.scale, Math.fround(r.scale));
      assert.deepEqual(slotBytes(live, r.ref_id, r.chunk), a, '和算完直接放进内存的一样');
    }
    const qv = normalizeVector(Float32Array.from({ length: d }, (_, i) => Math.sin(i * 0.7)));
    assert.deepEqual(loaded.search(qv, 20), live.search(qv, 20), '排名和分数都一样');
    await fresh.close();

    // 以后换了存法：旧格式的行当作没算过，重算后按现在的存法覆盖
    const id = rows[0].ref_id;
    t.ctx.db.prepare("UPDATE embeddings SET quant = 'f32-old' WHERE ref_id = ?").run(id);
    const again = createVectorIndexer(t.ctx, { debounceMs: 0 });
    await again.run();
    assert.deepEqual(docBatches, [1]);
    assert.equal(t.ctx.db.prepare('SELECT quant FROM embeddings WHERE ref_id = ?').pluck().get(id), QUANT);
    assert.equal(again.index().entryCount, 70);
    await again.close();
  });

  it('改一条只重算这一条；删一条库里和内存里都没了', async () => {
    reset();
    const [a, b] = t.ctx.kb.listEntries({ q: '短条目 1' });
    t.ctx.kb.updateEntry(a.id, { content: '改过的内容 gamma' });
    assert.equal(vectors().index().has(a.id), false, '文字变了的马上从内存里拿掉');
    await vectors().run();
    assert.deepEqual(docBatches, [1]);
    assert.equal(hooks.args.embed.texts[0], `${a.title}\n改过的内容 gamma`);
    assert.equal(vectors().index().has(a.id), true);

    t.ctx.kb.deleteEntry(b.id);
    assert.equal(vecRows(t.ctx.db).some((r) => r.ref_id === b.id), false);
    assert.equal(vectors().index().has(b.id), false);
    assert.equal(vectors().status().embeddedEntries, 69);
  });

  it('换模型：全部重算，旧模型的向量算完后删掉；查询缓存也作废', async () => {
    reset();
    const before = new Set(vecRows(t.ctx.db).map((r) => r.model_key));
    assert.equal(before.size, 1);
    await t.req('PUT', '/api/settings', { body: enableBody({ model: 'm2' }) });
    assert.equal(vectors().status().embeddedEntries, 0);
    await vectors().run();
    assert.equal(docBatches.reduce((a, b) => a + b, 0), 69);
    const after = new Set(vecRows(t.ctx.db).map((r) => r.model_key));
    assert.equal(after.size, 1);
    assert.notDeepEqual([...after], [...before]);
    assert.equal(vectors().status().model, 'm2');
    assert.equal(vectors().status().embeddedEntries, 69);
  });

  it('鉴权失败：停下、记下错误和时间；再跑、加条目都不调接口；手动重试或改了设置才再算', async () => {
    reset();
    hooks.embed = () => {
      docBatches.push('fail');
      throw new EmbedError('向量接口鉴权失败（401）：bad key', 'auth');
    };
    const x = t.ctx.kb.insertEntry(short('x'));
    await vectors().run();
    assert.deepEqual(docBatches, ['fail']);
    let s = vectors().status();
    assert.equal(s.state, 'stopped');
    assert.equal(s.lastError.kind, 'auth');
    assert.match(s.lastError.message, /401/);
    assert.ok(s.lastError.at);
    await vectors().run();
    t.ctx.kb.insertEntry(short('y'));
    await vectors().run();
    assert.deepEqual(docBatches, ['fail'], '停下后不再请求');
    assert.ok(t.log.lines.some((l) => l.includes('向量计算停下了')));

    hooks.embed = (args, mock) => {
      docBatches.push(args.texts.length);
      return mock.embed(args);
    };
    const r = await t.req('POST', '/api/kb/vectors/retry');
    assert.equal(r.status, 200);
    assert.equal(r.body.lastError, null);
    await vectors().run();
    assert.deepEqual(docBatches, ['fail', 2]);
    assert.equal(vectors().status().state, 'idle');
    assert.equal(vectors().index().has(x.id), true);

    // 改了设置（换密钥）也清掉停下的状态
    hooks.embed = () => {
      throw new EmbedError('向量接口返回 404：no model', 'not_found');
    };
    t.ctx.kb.updateEntry(x.id, { content: '又改了' });
    await vectors().run();
    assert.equal(vectors().status().state, 'stopped');
    hooks.embed = (args, mock) => mock.embed(args);
    await t.req('PUT', '/api/settings', { body: enableBody({ model: 'm2', apiKey: 'sk-new' }) });
    assert.equal(vectors().status().state, 'idle');
    await vectors().run();
    assert.equal(vectors().index().has(x.id), true);
  });

  it('限流：按 Retry-After 等；5xx、连不上按 5 秒起翻倍退避；没到点不请求，到点再算，成功后清掉错误', async () => {
    let n = 0;
    hooks.embed = () => {
      n++;
      throw new EmbedError('向量接口限流（429）', 'rate_limit', { status: 429, retryAfterMs: 30_000 });
    };
    const e = t.ctx.kb.insertEntry(short('rl'));
    await vectors().run();
    assert.equal(n, 1);
    let s = vectors().status();
    assert.equal(s.state, 'waiting');
    assert.equal(s.lastError.kind, 'rate_limit');
    assert.equal(s.retryAt, new Date(clock + 30_000).toISOString());
    await vectors().run();
    assert.equal(n, 1, '没到点不请求');

    hooks.embed = () => {
      n++;
      throw new EmbedError('向量接口返回 503', 'server', { status: 503 });
    };
    clock += 30_001;
    await vectors().run();
    assert.equal(n, 2);
    assert.equal(vectors().status().retryAt, new Date(clock + BACKOFF_BASE_MS * 2).toISOString(), '第二次失败：5 秒 × 2');
    clock += BACKOFF_BASE_MS * 2 + 1;
    hooks.embed = () => {
      n++;
      throw new EmbedError('无法连接向量接口：拒绝连接', 'network');
    };
    await vectors().run();
    assert.equal(n, 3);
    assert.equal(vectors().status().retryAt, new Date(clock + BACKOFF_BASE_MS * 4).toISOString());

    hooks.embed = (args, mock) => mock.embed(args);
    clock += BACKOFF_BASE_MS * 4 + 1;
    await vectors().run();
    s = vectors().status();
    assert.equal(s.state, 'idle');
    assert.equal(s.lastError, null);
    assert.equal(s.retryAt, null);
    assert.equal(vectors().index().has(e.id), true);
  });

  it('一批被拒（4xx，比如某条太长）：拆成一条一条算，算不了的那条跳过并记下，文字改了再试', async () => {
    let calls = [];
    hooks.embed = (args, mock) => {
      calls.push(args.texts.length);
      if (args.texts.some((x) => x.includes('坏条目'))) throw new EmbedError('向量接口返回 400：input too long', 'bad_request', { status: 400 });
      return mock.embed(args);
    };
    const good = [0, 1, 2].map((i) => t.ctx.kb.insertEntry(short(`ok${i}`)));
    const bad = t.ctx.kb.insertEntry({ type: 'fact', title: '坏条目', content: '这一条接口不收', origin: 'manual' });
    await vectors().run();
    assert.deepEqual(calls, [4, 1, 1, 1, 1], '整批失败后一条一条算');
    let s = vectors().status();
    assert.equal(s.state, 'idle');
    assert.equal(s.skippedEntries, 1);
    assert.match(s.lastError.message, /1 条条目无法计算向量/);
    assert.ok(good.every((e) => vectors().index().has(e.id)));
    assert.equal(vectors().index().has(bad.id), false);

    calls = [];
    await vectors().run();
    assert.deepEqual(calls, [], '文字没变不再试');
    t.ctx.kb.updateEntry(bad.id, { title: '修好的条目' });
    await vectors().run();
    assert.deepEqual(calls, [1]);
    s = vectors().status();
    assert.equal(s.skippedEntries, 0);
    assert.equal(s.lastError, null);
    hooks.embed = (args, mock) => mock.embed(args);
  });

  it('维度和之前不一样（服务那边换了模型）：停下，提示点重新计算；重新计算清掉全部重算', async () => {
    hooks.embed = ({ texts }) => ({ vectors: texts.map(() => normalizeVector(Float32Array.from([1, 2, 3]))), dims: 3, inputTokens: null, model: 'x' });
    const e = t.ctx.kb.insertEntry(short('dims'));
    await vectors().run();
    let s = vectors().status();
    assert.equal(s.state, 'stopped');
    assert.equal(s.lastError.kind, 'dims');
    assert.match(s.lastError.message, /重新计算/);
    assert.equal(vectors().index().has(e.id), false);

    reset();
    hooks.embed = (args, mock) => {
      docBatches.push(args.texts.length);
      return mock.embed(args);
    };
    const r = await t.req('POST', '/api/kb/vectors/rebuild');
    assert.equal(r.status, 200);
    assert.equal(r.body.embeddedEntries, 0);
    assert.equal(vecRows(t.ctx.db).length, 0);
    await vectors().run();
    const active = t.ctx.kb.countActive();
    assert.equal(docBatches.reduce((a, b) => a + b, 0), active);
    assert.equal(vectors().status().embeddedEntries, active);
    assert.equal(vectors().status().lastError, null);
  });

  it('长条目：按段算（每段不超过 1500 字、开头带标题、最多 12 段），检索时按最像的那一段算分', async () => {
    const tail = '尾段专有词 ZETA 只在最后出现。';
    const content = `${'这是很长的产品说明，讲材料、工艺和包装。'.repeat(400)}${tail}`;
    const segs = entrySegments({ title: '长说明', content, tags: [] });
    assert.ok(segs.length >= 5 && segs.length <= MAX_SEGMENTS);
    assert.equal(entrySegments({ title: '最长的条目', content: '字'.repeat(20000), tags: [] }).length, MAX_SEGMENTS, '再长的部分不算');
    assert.ok(segs.every((s) => s.length <= SEGMENT_CHARS && s.startsWith('长说明\n')));
    assert.ok(segs.at(-1).includes('ZETA') && !segs[0].includes('ZETA'));

    hooks.embed = ({ texts }) => ({
      vectors: texts.map((x) => {
        const v = new Float32Array(8);
        v[x.includes('ZETA') ? 0 : 1 + (x.length % 7)] = 1;
        return v;
      }),
      dims: 8,
      inputTokens: null,
      model: 'x',
    });
    await t.req('POST', '/api/kb/vectors/rebuild');
    const long = t.ctx.kb.insertEntry({ type: 'fact', title: '长说明', content, origin: 'manual' });
    await vectors().run();
    assert.equal(vecRows(t.ctx.db).filter((r) => r.ref_id === long.id).length, segs.length);
    assert.equal(vectors().index().byId.get(long.id).slots.length, segs.length);
    const r = await vectors().search('ZETA');
    assert.equal(r.hits[0].id, long.id);
    assert.ok(near(r.hits[0].score, 1, 0.02));
    // 同一条目只出现一次
    assert.equal(r.hits.filter((h) => h.id === long.id).length, 1);
    hooks.embed = (args, mock) => mock.embed(args);
  });

  it('关掉：状态 disabled，不算也不检索，内存放掉；再开回来读库里的向量，不用重算', async () => {
    await t.req('POST', '/api/kb/vectors/rebuild');
    await vectors().run();
    const n = vectors().status().embeddedEntries;
    assert.ok(n > 0);
    await t.req('PUT', '/api/settings', { body: { embedding: { enabled: false } } });
    assert.equal(vectors().status().state, 'disabled');
    assert.equal(vectors().index(), null);
    assert.equal(await vectors().search('内容'), null);
    reset();
    hooks.embed = (args, mock) => {
      docBatches.push(args.texts.length);
      return mock.embed(args);
    };
    t.ctx.kb.insertEntry(short('off'));
    await vectors().run();
    assert.deepEqual(docBatches, []);
    assert.equal((await t.req('POST', '/api/kb/vectors/rebuild')).status, 400, '没开时不能重新计算');

    await t.req('PUT', '/api/settings', { body: { embedding: { enabled: true } } });
    await vectors().run();
    assert.deepEqual(docBatches, [1], '只算关着时加的那一条');
    assert.equal(vectors().status().embeddedEntries, n + 1);
  });
});

describe('后台计算：一条都没算出来时放慢重试', () => {
  let t;
  let hooks;
  let clock = Date.parse('2030-01-01T00:00:00Z');
  /** 后台算文档向量的请求次数 */
  let n = 0;
  const vectors = () => t.ctx.vectors;
  const KINDS = ['server', 'timeout', 'network', 'rate_limit'];
  before(async () => {
    hooks = await aiHooks();
    t = await startApp({ options: { aiOverrides: hooks.overrides, vectorNow: () => clock } });
    await t.login();
  });
  after(() => t.close());

  /** 向量接口一直失败：会退避的几种错误轮着来（限流不带 Retry-After） */
  const failing = () => {
    hooks.embed = (args, mock) => {
      if (args.task === 'query') return mock.embed(args);
      const kind = KINDS[n++ % KINDS.length];
      throw new EmbedError(`向量接口出错（${kind}）`, kind, { status: kind === 'server' ? 503 : kind === 'rate_limit' ? 429 : 0 });
    };
  };
  /** 跑一次，应该马上请求一次并失败；返回状态和这次要等多久 */
  const failOnce = async () => {
    const before = n;
    await vectors().run();
    assert.equal(n, before + 1, '该请求时没有请求');
    const s = vectors().status();
    assert.equal(s.state, 'waiting');
    return { s, wait: Date.parse(s.retryAt) - clock };
  };
  /** 时钟拨到重试的时间之后 */
  const due = (s) => {
    clock = Date.parse(s.retryAt) + 1;
  };
  /** 一直失败到放慢为止 */
  const failUntilCold = async () => {
    for (let i = 0; i < 20 && !vectors().status().hint; i++) {
      const s = vectors().status();
      if (s.state === 'waiting') due(s);
      await failOnce();
    }
    const s = vectors().status();
    assert.ok(s.hint, '没有放慢');
    return s;
  };

  it('一条都没算出来：前 4 次按 5 秒起翻倍退避，连续失败 5 次（不论哪种）后改成 30 分钟一次，状态里有提示；没到点不请求', async () => {
    for (let i = 0; i < 3; i++) t.ctx.kb.insertEntry(short(`cold${i}`));
    failing();
    assert.equal((await t.req('PUT', '/api/settings', { body: enableBody() })).status, 200);
    let r;
    for (let i = 0; i < COLD_FAIL_STREAK - 1; i++) {
      if (r) due(r.s);
      r = await failOnce();
      assert.equal(r.wait, BACKOFF_BASE_MS * 2 ** i, `第 ${i + 1} 次失败（${r.s.lastError.kind}）`);
      assert.equal(r.s.hint, null);
      assert.equal(r.s.embeddedEntries, 0);
    }
    due(r.s);
    r = await failOnce();
    assert.equal(r.wait, COLD_RETRY_MS, '第 5 次失败后等 30 分钟');
    assert.equal(
      r.s.hint,
      '所有条目均计算失败，已连续失败 5 次，可能是模型名或服务地址有误（部分中转站分组不含向量模型）。已改为每 30 分钟重试一次；修改设置或点击「重试」将立即重试。',
    );
    assert.equal((await t.req('GET', '/api/kb/vectors')).body.hint, r.s.hint);
    assert.ok(t.log.lines.some((l) => l.includes('一条向量都没算出来，连续失败 5 次')));

    clock += COLD_RETRY_MS - 1000;
    await vectors().run();
    assert.equal(n, COLD_FAIL_STREAK, '没到点不请求');
    due(vectors().status());
    r = await failOnce();
    assert.equal(r.wait, COLD_RETRY_MS);
    assert.match(r.s.hint, /连续失败 6 次/);
  });

  it('放慢以后：手动重试、条目变动、设置改动、重新计算都清掉提示，马上再试、从 5 秒起退避', async () => {
    assert.ok(vectors().status().hint);
    let res = await t.req('POST', '/api/kb/vectors/retry');
    assert.equal(res.status, 200);
    assert.equal(res.body.hint, null);
    assert.equal(res.body.state, 'idle');
    assert.equal(res.body.retryAt, null);
    let r = await failOnce();
    assert.equal(r.wait, BACKOFF_BASE_MS);
    assert.equal(r.s.hint, null);

    await failUntilCold();
    t.ctx.kb.insertEntry(short('cold-new'));
    let s = vectors().status();
    assert.equal(s.hint, null, '条目变了就清掉');
    assert.equal(s.state, 'idle');
    assert.equal(s.retryAt, null);
    r = await failOnce();
    assert.equal(r.wait, BACKOFF_BASE_MS);

    await failUntilCold();
    await t.req('PUT', '/api/settings', { body: enableBody({ model: 'm-cold' }) });
    s = vectors().status();
    assert.equal(s.hint, null, '设置改了就清掉');
    assert.equal(s.state, 'idle');
    r = await failOnce();
    assert.equal(r.wait, BACKOFF_BASE_MS);

    await failUntilCold();
    res = await t.req('POST', '/api/kb/vectors/rebuild');
    assert.equal(res.body.hint, null, '重新计算也清掉');
    assert.equal(res.body.state, 'idle');
    r = await failOnce();
    assert.equal(r.wait, BACKOFF_BASE_MS);
  });

  it('已经算出过向量（比如服务临时 503）：连续失败多少次都照原来的退避（5 秒起翻倍、最多 5 分钟），不放慢', async () => {
    hooks.embed = (args, mock) => mock.embed(args);
    await t.req('POST', '/api/kb/vectors/retry');
    await vectors().run();
    let s = vectors().status();
    assert.equal(s.state, 'idle');
    assert.equal(s.embeddedEntries, s.activeEntries);

    failing();
    t.ctx.kb.insertEntry(short('warm'));
    for (let i = 0; i < 8; i++) {
      if (i) due(vectors().status());
      const r = await failOnce();
      assert.equal(r.wait, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** i), `第 ${i + 1} 次失败`);
      assert.equal(r.s.hint, null);
    }
    s = vectors().status();
    assert.ok(s.embeddedEntries > 0);
    hooks.embed = (args, mock) => mock.embed(args);
  });
});

describe('后台计算：自动触发（防抖定时器）', () => {
  it('开了以后自动算；加条目后防抖再算；关闭应用时停掉定时器和在算的', async () => {
    const t = await startApp({ options: { vectorDebounceMs: 30 } });
    try {
      await t.login();
      for (let i = 0; i < 5; i++) t.ctx.kb.insertEntry(short(i));
      await t.req('PUT', '/api/settings', { body: enableBody() });
      await waitFor(() => t.ctx.vectors.status().embeddedEntries === 5, { message: '开了以后没有自动算' });
      t.ctx.kb.insertEntry(short(5));
      await waitFor(() => t.ctx.vectors.status().embeddedEntries === 6 && t.ctx.vectors.status().state === 'idle', {
        message: '加条目后没有自动补算',
      });
      for (let i = 6; i < 40; i++) t.ctx.kb.insertEntry(short(i));
    } finally {
      await t.close();
    }
  });
});

describe('分段和内存里的向量', () => {
  /** 可复现的伪随机数 */
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const randomVec = (r, d) => normalizeVector(Float32Array.from({ length: d }, () => r() * 2 - 1));
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

  it('切段：短的一段；长的在断句处切开，最多 max 段，不切开 emoji', () => {
    assert.deepEqual(splitText('短短一句', 100, 3), ['短短一句']);
    const parts = splitText(`${'甲'.repeat(60)}。${'乙'.repeat(60)}。${'丙'.repeat(60)}`, 100, 5);
    assert.deepEqual(parts, [`${'甲'.repeat(60)}。`, `${'乙'.repeat(60)}。`, '丙'.repeat(60)]);
    assert.equal(splitText('字'.repeat(1000), 100, 3).length, 3);
    const emoji = splitText(`${'a'.repeat(99)}😀${'b'.repeat(50)}`, 100, 3);
    assert.ok(emoji.every((p) => !/^[\uDC00-\uDFFF]/.test(p) && !/[\uD800-\uDBFF]$/.test(p)));
    const one = entrySegments({ title: '标题', content: '内容', tags: ['标签'] });
    assert.deepEqual(one, ['标题\n内容\n标签']);
    assert.notEqual(segmentsHash(one), segmentsHash(['标题\n内容']));
  });

  it('int8 量化和 float 的排名：随机 400 个 64 维向量、20 个查询，第 1 名都一样，前 10 名至少重合 9 个', () => {
    const r = rng(42);
    const d = 64;
    const docs = Array.from({ length: 400 }, () => randomVec(r, d));
    const idx = new QuantizedIndex();
    docs.forEach((v, i) => idx.set(`e${i}`, 'h', [v]));
    for (let q = 0; q < 20; q++) {
      const qv = randomVec(r, d);
      const exact = docs
        .map((v, i) => ({ id: `e${i}`, score: dot(v, qv) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      const got = idx.search(qv, 10);
      assert.equal(got[0].id, exact[0].id);
      assert.ok(near(got[0].score, exact[0].score, 0.02));
      const overlap = got.filter((g) => exact.some((e) => e.id === g.id)).length;
      assert.ok(overlap >= 9, `第 ${q} 个查询前 10 名只重合 ${overlap} 个`);
    }
  });

  it('量化：最大绝对值成 127，误差不超过半个缩放系数，全 0 的缩放系数是 0；放量化好的段和放 float 的结果一样', () => {
    const r = rng(9);
    const d = 48;
    const docs = Array.from({ length: 50 }, () => randomVec(r, d));
    const { q, scale } = quantize(docs[0]);
    assert.equal(Math.max(...q.map(Math.abs)), 127);
    docs[0].forEach((x, i) => assert.ok(Math.abs(q[i] * scale - x) <= scale / 2 + 1e-7));
    const zero = quantize(new Float32Array(4));
    assert.equal(zero.scale, 0);
    assert.deepEqual([...zero.q], [0, 0, 0, 0]);

    const a = new QuantizedIndex();
    const b = new QuantizedIndex();
    docs.forEach((v, i) => {
      a.set(`e${i}`, 'h', [v]);
      b.set(`e${i}`, 'h', [quantize(v)]);
    });
    assert.deepEqual(b.q, a.q);
    assert.deepEqual(b.scale, a.scale);
    const qv = randomVec(r, d);
    assert.deepEqual(b.search(qv, 10), a.search(qv, 10));
  });

  it('删掉的多了整理一次，检索结果不变；同一条目几段取最高分', () => {
    const r = rng(7);
    const d = 32;
    const idx = new QuantizedIndex();
    const docs = new Map();
    for (let i = 0; i < 600; i++) {
      const vs = [randomVec(r, d), randomVec(r, d)];
      docs.set(`e${i}`, vs);
      idx.set(`e${i}`, 'h', vs);
    }
    for (let i = 0; i < 450; i++) {
      idx.remove(`e${i}`);
      docs.delete(`e${i}`);
    }
    assert.equal(idx.entryCount, 150);
    assert.equal(idx.segmentCount, 300);
    assert.ok(idx.n < 1200, '整理过');
    const qv = randomVec(r, d);
    const exact = [...docs].map(([id, vs]) => ({ id, score: Math.max(...vs.map((v) => dot(v, qv))) })).sort((a, b) => b.score - a.score);
    const got = idx.search(qv, 5);
    assert.equal(got[0].id, exact[0].id);
    assert.equal(new Set(got.map((g) => g.id)).size, 5);
    // 放回去、换内容
    idx.set('e500', 'h2', [qv]);
    assert.equal(idx.search(qv, 1)[0].id, 'e500');
    assert.equal(idx.hashOf('e500'), 'h2');
  });
});

describe('回复检索：按意思搜和关键词合并', () => {
  let t;
  let hooks;
  let queries = 0;
  let price;
  /** 假的「懂意思」的向量：价格、保温杯、起订量三个意思各占一维，中文西语英语都认；其余几维按文字哈希放一点噪声 */
  const CONCEPTS = [/precio|price|价格|报价/i, /termo|thermos|保温杯/i, /起订|mínimo|minimum/i];
  const conceptEmbed = (text) => {
    const v = new Float32Array(16);
    CONCEPTS.forEach((re, i) => {
      if (re.test(text)) v[i] = 1;
    });
    const h = crypto.createHash('md5').update(text).digest();
    for (let i = 4; i < 16; i++) v[i] = (h[i] - 128) / 1280;
    return normalizeVector(v);
  };
  const conceptHook = (args) => {
    if (args.task === 'query') queries++;
    return { vectors: args.texts.map(conceptEmbed), dims: 16, inputTokens: null, model: 'fake' };
  };
  const filler = (i) => ({
    type: 'fact',
    title: `填充资料 ${i}`,
    content: Array.from({ length: 160 }, (_, k) => `alpha${i}x${k}`).join(' '),
    origin: 'manual',
  });

  before(async () => {
    hooks = await aiHooks();
    t = await startApp({ options: { aiOverrides: hooks.overrides } });
    await t.login();
    hooks.embed = conceptHook;
    price = t.ctx.kb.insertEntry({ type: 'product', title: '保温杯 A100 价格', content: '保温杯 A100 价格 59 元，容量 500ml。', origin: 'manual' });
    t.ctx.kb.insertEntry({ type: 'policy', title: '起订量', content: '起订量 100 件，下单后 15 天发货。', origin: 'manual' });
    await t.req('PUT', '/api/settings', { body: enableBody() });
    await t.ctx.vectors.run();
  });
  after(() => t.close());

  it('排名融合：分数 = Σ 1/(60+名次)，一样的关键词那一路在前；只在向量那一路的按 id 读出来，读不到（停用、删了）的不要', () => {
    const e = (id) => ({ id });
    const kb = { entriesByIds: (list) => list.filter((id) => id !== 'gone').map(e) };
    const merged = rrfMerge([e('a'), e('b'), e('c')], [{ id: 'c' }, { id: 'd' }, { id: 'a' }, { id: 'gone' }], kb);
    assert.equal(RRF_K, 60);
    assert.deepEqual(ids(merged), ['a', 'c', 'b', 'd']);
    assert.deepEqual(ids(rrfMerge([], [{ id: 'x' }, { id: 'y' }], kb)), ['x', 'y']);
  });

  it('查询用的那段话：按说话先后，最多 1500 字，从最近的往前取', () => {
    assert.equal(queryTextOf(['现在这句', '上一句', '更早的']), '更早的\n上一句\n现在这句');
    assert.equal(queryTextOf(['现在这句', 'x'.repeat(2000)]), '现在这句');
    assert.equal(queryTextOf(['y'.repeat(2000)]).length, 1500);
  });

  it('全带档（不超过 40000 字）：不算查询向量', async () => {
    const r = await selectEntries(t.ctx, { texts: ['¿Cuál es el precio del termo?'], rewrite: true });
    assert.equal(r.mode, 'all');
    assert.equal(r.vector, false);
    assert.equal(queries, 0);
  });

  it('跨语言：西班牙语问价，关键词一条都对不上，按意思找到中文的价格条目；覆盖率 100% 不调模型改写；同一段话再查用缓存', async () => {
    for (let i = 0; i < 25; i++) t.ctx.kb.insertEntry(filler(i));
    await t.ctx.vectors.run();
    assert.equal(t.ctx.kb.activeEntriesWithin(CONTEXT_CHAR_LIMIT), null);
    assert.equal(t.ctx.vectors.status().embeddedEntries, 27);

    const message = '¿Cuál es el precio del termo?';
    const c = await buildReplyContext(t.ctx, { message, history: [{ role: 'customer', text: 'Hola' }], searchRewrite: true });
    assert.equal(c.entries[0].id, price.id);
    assert.equal(c.searchCalls, 0, '没改写，不计入会话的每日模型次数');
    assert.equal(hooks.calls.searchTerms, 0);
    assert.equal(queries, 1);
    assert.equal(hooks.args.embed.texts[0], `Hola\n${message}`, '查询向量用的话和改写用的一样');
    const row = t.ctx.db.prepare("SELECT * FROM llm_calls WHERE purpose = 'embedding' ORDER BY rowid DESC LIMIT 1").get();
    assert.ok(row, 'llm_calls 照记（向量检索）');

    await buildReplyContext(t.ctx, { message, history: [{ role: 'customer', text: 'Hola' }], searchRewrite: true });
    assert.equal(queries, 1, '30 分钟内同一段话不重复算');
  });

  it('关键词和向量两路都有：都命中的排在前面', async () => {
    const r = await selectEntries(t.ctx, { texts: ['保温杯 起订量'], rewrite: false });
    assert.equal(r.vector, true);
    const top = ids(r.entries.slice(0, 2));
    assert.ok(top.includes(price.id));
    assert.ok(r.entries.length <= 20);
  });

  it('覆盖率不到 90%（新加的条目还没算）：照常调模型改写，向量那一路也用', async () => {
    for (let i = 25; i < 30; i++) t.ctx.kb.insertEntry(filler(i));
    const s = t.ctx.vectors.status();
    assert.ok(s.embeddedEntries / s.activeEntries < 0.9);
    const before = hooks.calls.searchTerms;
    const r = await selectEntries(t.ctx, { texts: ['¿Y el precio del termo grande?'], rewrite: true });
    assert.equal(hooks.calls.searchTerms, before + 1);
    assert.equal(r.llmCalls, 1);
    assert.equal(r.vector, true);
    assert.equal(r.entries[0].id, price.id);
    await t.ctx.vectors.run();
  });

  it('查询向量失败：退回关键词 + 改写，日志 5 分钟内只记一行', async () => {
    hooks.embed = (args) => {
      if (args.task === 'query') throw new EmbedError('向量接口请求超时（8 秒）', 'timeout');
      return conceptHook(args);
    };
    const before = hooks.calls.searchTerms;
    const r1 = await selectEntries(t.ctx, { texts: ['precio termo uno'], rewrite: true });
    const r2 = await selectEntries(t.ctx, { texts: ['precio termo dos'], rewrite: true });
    assert.equal(r1.vector, false);
    assert.equal(r2.vector, false);
    assert.equal(hooks.calls.searchTerms, before + 2, '向量不能用时照原来的流程改写');
    assert.equal(t.log.lines.filter((l) => l.includes('查询向量没算出来')).length, 1);
    hooks.embed = conceptHook;
  });

  it('没开向量检索：不算查询向量，结果和原来一样', async () => {
    await t.req('PUT', '/api/settings', { body: { embedding: { enabled: false } } });
    const q0 = queries;
    const r = await selectEntries(t.ctx, { texts: ['保温杯 A100 价格多少'], rewrite: false });
    assert.equal(r.vector, false);
    assert.equal(queries, q0);
    assert.equal(r.entries[0].id, price.id);
  });
});
