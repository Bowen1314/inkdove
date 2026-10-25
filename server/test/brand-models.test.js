import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listModels } from '../src/ai/models.js';
import { loadConfig } from '../src/config.js';
import { kvGet, kvSet, openDb } from '../src/db.js';
import { loadSettings } from '../src/settings.js';
import { startApp, TINY_PNG } from './helpers.js';

const KEY = 'sk-test-SECRET-models-4321';

/** 本地假模型服务：记录请求（path 带查询串），按 handler 回复；handler 返回 [status, body(对象或原文), delayMs?] */
async function startFakeProvider() {
  const state = { requests: [], handler: null };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* GET 没有请求体 */
    }
    const u = new URL(req.url, 'http://x');
    const rec = { method: req.method, path: req.url, pathname: u.pathname, query: u.searchParams, headers: req.headers };
    state.requests.push(rec);
    const [status, data, delayMs = 0] = await state.handler(rec);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (res.destroyed) return;
    const raw = typeof data === 'string';
    res.writeHead(status, { 'content-type': raw ? 'text/html' : 'application/json' });
    res.end(raw ? data : JSON.stringify(data));
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

/** 上传一个 logo（字段 file） */
function logoForm(buf, name = 'logo.png', type = 'image/png') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  return fd;
}

const SVG = Buffer.from(
  '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- 由设计工具导出 -->\n  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>\n',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(14)]);

describe('获取模型列表：listModels（假服务）', () => {
  let f;
  before(async () => {
    f = await startFakeProvider();
  });
  after(() => f.close());

  it('openai：{base}/models，Bearer 鉴权；按 id 去重、排序，不带 label', async () => {
    f.state.handler = () => [200, { object: 'list', data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-b' }, { id: '' }, { foo: 1 }, { id: 'gpt-10' }, { id: 'gpt-9' }] }];
    const models = await listModels({ format: 'openai', baseUrl: `${f.url}/v1/`, apiKey: KEY });
    assert.deepEqual(models, [{ id: 'gpt-9' }, { id: 'gpt-10' }, { id: 'gpt-a' }, { id: 'gpt-b' }]);
    const req = f.last();
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['x-api-key'], undefined);
  });

  it('anthropic：带不带 /v1 都拼对，limit=1000；x-api-key + anthropic-version；display_name 当 label，和 id 一样时不带', async () => {
    f.state.handler = () => [
      200,
      {
        data: [
          { type: 'model', id: 'claude-b', display_name: 'Claude B' },
          { type: 'model', id: 'claude-a', display_name: 'claude-a' },
        ],
        has_more: false,
      },
    ];
    for (const [baseUrl, pathname] of [
      [f.url, '/v1/models'],
      [`${f.url}/`, '/v1/models'],
      [`${f.url}/v1`, '/v1/models'],
      [`${f.url}/proxy/v1/`, '/proxy/v1/models'],
    ]) {
      const models = await listModels({ format: 'anthropic', baseUrl, apiKey: KEY });
      assert.deepEqual(models, [{ id: 'claude-a' }, { id: 'claude-b', label: 'Claude B' }]);
      const req = f.last();
      assert.equal(req.pathname, pathname, baseUrl);
      assert.equal(req.query.get('limit'), '1000');
      assert.equal(req.headers['x-api-key'], KEY);
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(req.headers.authorization, undefined);
    }
  });

  it('gemini：/v1beta 与 /v1 的拼接、x-goog-api-key；去掉 models/ 前缀、只留 generateContent；按 nextPageToken 翻页', async () => {
    const pages = {
      '': {
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/no-methods', displayName: 'X' },
        ],
        nextPageToken: 'p2',
      },
      p2: {
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        ],
        nextPageToken: 'p3',
      },
      p3: { models: [{ name: 'models/gemma-3', displayName: 'gemma-3', supportedGenerationMethods: ['generateContent'] }] },
    };
    f.state.handler = (req) => [200, pages[req.query.get('pageToken') || '']];
    for (const [baseUrl, pathname] of [
      [f.url, '/v1beta/models'],
      [`${f.url}/v1beta/`, '/v1beta/models'],
      [`${f.url}/v1`, '/v1/models'],
    ]) {
      const n = f.state.requests.length;
      const models = await listModels({ format: 'gemini', baseUrl, apiKey: KEY });
      assert.deepEqual(models, [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { id: 'gemma-3' },
      ]);
      const reqs = f.state.requests.slice(n);
      assert.equal(reqs.length, 3, '翻了 3 页');
      assert.deepEqual(
        reqs.map((r) => r.query.get('pageToken')),
        [null, 'p2', 'p3'],
      );
      for (const r of reqs) {
        assert.equal(r.pathname, pathname, baseUrl);
        assert.equal(r.query.get('pageSize'), '1000');
        assert.equal(r.headers['x-goog-api-key'], KEY);
        assert.equal(r.headers.authorization, undefined);
      }
    }
  });

  it('gemini：一直有 nextPageToken 时最多翻 5 页', async () => {
    let i = 0;
    f.state.handler = () => {
      i++;
      return [200, { models: [{ name: `models/m-${i}`, supportedGenerationMethods: ['generateContent'] }], nextPageToken: `t${i}` }];
    };
    const n = f.state.requests.length;
    const models = await listModels({ format: 'gemini', baseUrl: f.url, apiKey: KEY });
    assert.equal(f.state.requests.length - n, 5);
    assert.deepEqual(
      models.map((m) => m.id),
      ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'],
    );
  });

  it('没有密钥时照样发请求，只是不带认证头', async () => {
    f.state.handler = (req) => [200, req.pathname.endsWith('/models') && req.query.has('pageSize') ? { models: [] } : { data: [{ id: 'local-1' }] }];
    for (const format of ['openai', 'anthropic', 'gemini']) {
      await listModels({ format, baseUrl: f.url, apiKey: '' });
      const h = f.last().headers;
      assert.equal(h.authorization, undefined, format);
      assert.equal(h['x-api-key'], undefined, format);
      assert.equal(h['x-goog-api-key'], undefined, format);
    }
  });

  it('HTTP 错误：带状态码和服务商的说明，不带密钥原文', async () => {
    const cases = {
      openai: [401, { error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at https://example.com`, type: 'invalid_request_error' } }],
      anthropic: [401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }],
      gemini: [400, [{ error: { code: 400, message: `API key not valid: ${encodeURIComponent(KEY)}`, status: 'INVALID_ARGUMENT' } }]],
    };
    for (const [format, resp] of Object.entries(cases)) {
      f.state.handler = () => resp;
      const err = await listModels({ format, baseUrl: f.url, apiKey: KEY }).catch((e) => e);
      assert.ok(err instanceof Error, format);
      assert.match(err.message, new RegExp(`^接口返回 ${resp[0]}：`), format);
      assert.match(err.message, /API key|x-api-key/, format);
      assert.ok(!err.message.includes(KEY), `${format}: ${err.message}`);
      assert.ok(err.message.includes('***'), `${format}: ${err.message}`);
    }
    // 服务商的错误信息很长时截到 200 字；密钥在截断位置附近也不会露出半截
    f.state.handler = () => [403, { error: { message: `${'x'.repeat(190)}${KEY}${'y'.repeat(300)}` } }];
    const err = await listModels({ format: 'openai', baseUrl: f.url, apiKey: KEY }).catch((e) => e);
    assert.equal(err.message, `接口返回 403：${'x'.repeat(190)}***${'y'.repeat(7)}`);
    // 非 JSON 的错误页
    f.state.handler = () => [502, '<html><body>Bad Gateway</body></html>'];
    assert.match((await listModels({ format: 'openai', baseUrl: f.url, apiKey: KEY }).catch((e) => e)).message, /^接口返回 502：/);
  });

  it('返回的非 JSON 或格式错误时说清楚', async () => {
    f.state.handler = () => [200, '<!doctype html><title>首页</title>'];
    await assert.rejects(listModels({ format: 'openai', baseUrl: f.url, apiKey: KEY }), /非 JSON/);
    f.state.handler = () => [200, { object: 'list' }];
    await assert.rejects(listModels({ format: 'openai', baseUrl: f.url, apiKey: KEY }), /格式错误/);
    f.state.handler = () => [200, { models: 'nope' }];
    await assert.rejects(listModels({ format: 'gemini', baseUrl: f.url, apiKey: KEY }), /格式错误/);
  });

  it('超时和连不上都给出看得懂的说明', async () => {
    f.state.handler = () => [200, { data: [] }, 500];
    const started = Date.now();
    await assert.rejects(listModels({ format: 'openai', baseUrl: f.url, apiKey: KEY, timeoutMs: 80 }), /请求超时（0\.1 秒）/);
    assert.ok(Date.now() - started < 450, '没有等到服务端回复');
    const err = await listModels({ format: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: KEY }).catch((e) => e);
    assert.match(err.message, /^无法连接接口地址：/);
    assert.ok(!err.message.includes(KEY));
  });

  it('密钥里有非 ASCII 字符时直接报错，不发请求', async () => {
    const n = f.state.requests.length;
    const bad = `${KEY}中文`;
    const err = await listModels({ format: 'openai', baseUrl: f.url, apiKey: bad }).catch((e) => e);
    assert.match(err.message, /密钥/);
    assert.ok(!err.message.includes(KEY));
    assert.equal(f.state.requests.length, n);
  });
});

describe('获取模型列表：POST /api/settings/llm/models', () => {
  let f;
  let t;
  before(async () => {
    f = await startFakeProvider();
    t = await startApp({ env: { INKDOVE_LLM_MOCK: '0' } });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { llm: { format: 'openai', baseUrl: `${f.url}/v1`, apiKey: KEY, model: 'gpt-a' } } });
  });
  after(async () => {
    await t.close();
    await f.close();
  });

  it('body 不传 apiKey 时用已保存的密钥；传了就用传的；空字段用已保存的值', async () => {
    f.state.handler = () => [200, { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }];
    const r = await t.req('POST', '/api/settings/llm/models', { body: { format: 'openai', baseUrl: f.url } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, models: [{ id: 'gpt-a' }, { id: 'gpt-b' }] });
    assert.equal(f.last().path, '/models');
    assert.equal(f.last().headers.authorization, `Bearer ${KEY}`);

    await t.req('POST', '/api/settings/llm/models', { body: { apiKey: ' sk-other ' } });
    assert.equal(f.last().path, '/v1/models', '没传 baseUrl 用已保存的');
    assert.equal(f.last().headers.authorization, 'Bearer sk-other');

    f.state.handler = () => [200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] }];
    const a = await t.req('POST', '/api/settings/llm/models', { body: { format: 'anthropic', baseUrl: '', apiKey: '' } });
    assert.deepEqual(a.body, { ok: true, models: [{ id: 'claude-x', label: 'Claude X' }] });
    assert.equal(f.last().path, '/v1/models?limit=1000');
    assert.equal(f.last().headers['x-api-key'], KEY);

    // 没有请求体也行
    f.state.handler = () => [200, { data: [] }];
    const empty = await t.req('POST', '/api/settings/llm/models');
    assert.deepEqual(empty.body, { ok: true, models: [] });
  });

  it('参数不合法回 400，错误写法和保存设置一致', async () => {
    const n = f.state.requests.length;
    const bad = await t.req('POST', '/api/settings/llm/models', { body: { format: 'cohere' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'llm.format 只能是 openai、anthropic 或 gemini');
    const badUrl = await t.req('POST', '/api/settings/llm/models', { body: { baseUrl: 'ftp://example.com' } });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.body.error, 'llm.baseUrl 必须以 http:// 或 https:// 开头');
    const notStr = await t.req('POST', '/api/settings/llm/models', { body: { apiKey: 123 } });
    assert.equal(notStr.status, 400);
    assert.equal(f.state.requests.length, n, '参数不对时不发请求');
  });

  it('失败时回 200 {ok:false, error}，错误里没有密钥', async () => {
    f.state.handler = () => [401, { error: { message: `Incorrect API key provided: ${KEY}` } }];
    const r = await t.req('POST', '/api/settings/llm/models', { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /^接口返回 401：Incorrect API key provided: \*\*\*/);
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.ok(!t.log.lines.some((l) => l.includes(KEY)), '日志里也没有密钥');
  });

  it('agent 角色访问返回 403', async () => {
    const m = await t.addMember({ email: 'agent-models@example.com', role: 'agent' });
    const n = f.state.requests.length;
    const r = await t.req('POST', '/api/settings/llm/models', { body: {}, cookie: m.cookie });
    assert.equal(r.status, 403);
    assert.equal(f.state.requests.length, n);
  });
});

describe('获取模型列表：演示模式', () => {
  let f;
  let t;
  before(async () => {
    f = await startFakeProvider();
    f.state.handler = () => [200, { data: [{ id: 'real-model' }] }];
    t = await startApp();
    await t.login();
    await t.req('PUT', '/api/settings', { body: { llm: { baseUrl: f.url, apiKey: KEY } } });
  });
  after(async () => {
    await t.close();
    await f.close();
  });

  it('返回固定的假列表，不发网络请求；没填地址也行', async () => {
    const r = await t.req('POST', '/api/settings/llm/models', { body: { format: 'gemini', baseUrl: f.url } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const ids = r.body.models.map((m) => m.id);
    assert.ok(ids.includes('mock-fast') && ids.includes('mock-smart'), ids.join(','));
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(f.state.requests.length, 0);
    await t.req('PUT', '/api/settings', { body: { llm: { baseUrl: '' } } });
    const noUrl = await t.req('POST', '/api/settings/llm/models', { body: {} });
    assert.equal(noUrl.body.ok, true);
    assert.equal(f.state.requests.length, 0);
  });
});

describe('品牌：网站名称和 Logo', () => {
  let t;
  let agent;
  const logoDir = () => path.join(t.dataDir, 'branding');
  const logoFiles = () => (fs.existsSync(logoDir()) ? fs.readdirSync(logoDir()) : []);
  before(async () => {
    t = await startApp();
    await t.login();
    agent = await t.addMember({ email: 'agent-brand@example.com', role: 'agent' });
  });
  after(() => t.close());

  it('默认没有名称和 Logo；公开接口不登录也能访问，只带名称和 logo 地址', async () => {
    const s = await t.req('GET', '/api/settings');
    assert.deepEqual(s.body.branding, { title: '', logoSet: false, logoUrl: null });
    const b = await t.req('GET', '/api/branding', { auth: false });
    assert.equal(b.status, 200);
    assert.deepEqual(b.body, { title: '', logoUrl: null });
    const logo = await t.req('GET', '/api/branding/logo', { auth: false });
    assert.equal(logo.status, 404);
    assert.equal(logo.body.code, 'not_found');
  });

  it('名称：去掉首尾空白、最多 40 个字符、不能有换行和控制字符；错误以 branding.title 开头', async () => {
    const long = await t.req('PUT', '/api/settings', { body: { branding: { title: '字'.repeat(41) } } });
    assert.equal(long.status, 400);
    assert.match(long.body.error, /^branding\.title 最多 40 个字符/);
    for (const title of ['第一行\n第二行', 'a\rb', 'tab\there', 'x\u0000y', 'a b']) {
      const r = await t.req('PUT', '/api/settings', { body: { branding: { title } } });
      assert.equal(r.status, 400, JSON.stringify(title));
      assert.match(r.body.error, /^branding\.title /);
    }
    const notStr = await t.req('PUT', '/api/settings', { body: { branding: { title: 5 } } });
    assert.equal(notStr.status, 400);
    assert.match(notStr.body.error, /^branding\.title /);
    const notObj = await t.req('PUT', '/api/settings', { body: { branding: 'x' } });
    assert.equal(notObj.status, 400);

    // 40 个字（emoji 按 1 个算）加首尾空白可以
    const ok40 = `${'名'.repeat(39)}🙂`;
    const ok = await t.req('PUT', '/api/settings', { body: { branding: { title: `  ${ok40}\n` } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.branding.title, ok40);

    // 客户端改不了 logo，branding 里的别的键忽略
    const r = await t.req('PUT', '/api/settings', {
      body: { branding: { title: '小王的店', logo: { filename: '../../inkdove.db', mime: 'text/plain', updatedAt: 1 }, logoUrl: 'https://evil' } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.branding, { title: '小王的店', logoSet: false, logoUrl: null });
    assert.equal(t.ctx.getSettings().branding.logo, null);

    const pub = await t.req('GET', '/api/branding', { auth: false });
    assert.deepEqual(pub.body, { title: '小王的店', logoUrl: null });
    assert.deepEqual(Object.keys(pub.body).sort(), ['logoUrl', 'title']);
  });

  it('上传 PNG：按内容识别，logoUrl 带 v；不登录也能取到，带 nosniff、CSP 和缓存头', async () => {
    const r = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(TINY_PNG, 'logo.bin', 'application/octet-stream') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.branding.logoSet, true);
    assert.match(r.body.branding.logoUrl, /^\/api\/branding\/logo\?v=\d+$/);
    assert.ok(r.body.llm, '返回的是完整设置');
    const pub = await t.req('GET', '/api/branding', { auth: false });
    assert.equal(pub.body.logoUrl, r.body.branding.logoUrl);

    const img = await t.req('GET', pub.body.logoUrl, { auth: false });
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /^image\/png/);
    assert.ok(Buffer.compare(img.body, TINY_PNG) === 0);
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(img.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(img.headers.get('cache-control'), 'public, max-age=86400');
    assert.deepEqual(
      logoFiles().filter((n) => !n.startsWith('logo-')),
      [],
      '没有留下临时文件',
    );
  });

  it('JPEG 和 WebP 也能上传', async () => {
    for (const [buf, mime] of [
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp'],
    ]) {
      const r = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(buf, 'x.png') });
      assert.equal(r.status, 200, mime);
      const img = await t.req('GET', r.body.branding.logoUrl, { auth: false });
      assert.match(img.headers.get('content-type'), new RegExp(`^${mime}`));
    }
  });

  it('伪造扩展名和类型的非图片被拒', async () => {
    const before = t.ctx.getSettings().branding.logo;
    for (const [buf, name, type] of [
      [Buffer.from('hello, not an image'), 'evil.png', 'image/png'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'evil.svg', 'image/svg+xml'],
      [Buffer.from('GIF89a\x01\x00\x01\x00'), 'anim.gif', 'image/gif'],
      [Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00]), 'utf16.svg', 'image/svg+xml'],
      [Buffer.alloc(0), 'empty.png', 'image/png'],
    ]) {
      const r = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(buf, name, type) });
      assert.equal(r.status, 400, name);
      assert.equal(r.body.error, '仅支持 PNG、JPG、WebP 或 SVG 图片', name);
    }
    assert.deepEqual(t.ctx.getSettings().branding.logo, before, '被拒时 logo 不变');
  });

  it('SVG 能上传（BOM、XML 声明、注释之后是 <svg）；取的时候带 CSP sandbox 和 nosniff', async () => {
    const r = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(SVG, 'logo.txt', 'text/plain') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const img = await t.req('GET', r.body.branding.logoUrl, { auth: false });
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /^image\/svg\+xml/);
    assert.ok(Buffer.compare(img.body, SVG) === 0);
    assert.match(img.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  });

  it('超过 512 KB 被拒；没有文件、多个文件、字段名不对也被拒', async () => {
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(512 * 1024 + 1 - TINY_PNG.length)]);
    const r = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(big) });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, '图片不能超过 512 KB');
    // 正好 512 KB 可以
    const exact = Buffer.concat([TINY_PNG, Buffer.alloc(512 * 1024 - TINY_PNG.length)]);
    assert.equal((await t.req('POST', '/api/settings/branding/logo', { body: logoForm(exact) })).status, 200);

    assert.equal((await t.req('POST', '/api/settings/branding/logo', { body: new FormData() })).status, 400);
    const two = logoForm(TINY_PNG);
    two.append('file', new Blob([TINY_PNG]), 'b.png');
    assert.equal((await t.req('POST', '/api/settings/branding/logo', { body: two })).status, 400);
    const wrong = new FormData();
    wrong.append('files', new Blob([TINY_PNG]), 'a.png');
    assert.equal((await t.req('POST', '/api/settings/branding/logo', { body: wrong })).status, 400);
  });

  it('替换后旧文件被删，v 变了', async () => {
    const a = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(TINY_PNG) });
    const oldName = t.ctx.getSettings().branding.logo.filename;
    assert.deepEqual(logoFiles(), [oldName]);
    const b = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(SVG, 'logo.svg', 'image/svg+xml') });
    assert.equal(b.status, 200);
    const newName = t.ctx.getSettings().branding.logo.filename;
    assert.notEqual(newName, oldName);
    assert.notEqual(b.body.branding.logoUrl, a.body.branding.logoUrl);
    assert.deepEqual(logoFiles(), [newName]);
    // 旧地址的 v 只是缓存用的，取到的是新 logo
    const img = await t.req('GET', a.body.branding.logoUrl, { auth: false });
    assert.match(img.headers.get('content-type'), /^image\/svg\+xml/);
  });

  it('agent 角色上传、移除返回 403', async () => {
    const before = t.ctx.getSettings().branding.logo;
    const up = await t.req('POST', '/api/settings/branding/logo', { body: logoForm(TINY_PNG), cookie: agent.cookie });
    assert.equal(up.status, 403);
    const del = await t.req('DELETE', '/api/settings/branding/logo', { cookie: agent.cookie });
    assert.equal(del.status, 403);
    assert.deepEqual(t.ctx.getSettings().branding.logo, before);
    // agent 也能读公开接口
    assert.equal((await t.req('GET', '/api/branding', { cookie: agent.cookie })).status, 200);
  });

  it('DELETE 后文件删掉、公开接口回 404；本来就没有也返回 200', async () => {
    const r = await t.req('DELETE', '/api/settings/branding/logo');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.branding, { title: '小王的店', logoSet: false, logoUrl: null });
    assert.deepEqual(logoFiles(), []);
    assert.equal((await t.req('GET', '/api/branding/logo', { auth: false })).status, 404);
    assert.deepEqual((await t.req('GET', '/api/branding', { auth: false })).body, { title: '小王的店', logoUrl: null });
    const again = await t.req('DELETE', '/api/settings/branding/logo');
    assert.equal(again.status, 200);
    assert.equal(again.body.branding.logoSet, false);
  });

  it('logo 元数据在但文件丢了时回 404', async () => {
    await t.req('POST', '/api/settings/branding/logo', { body: logoForm(TINY_PNG) });
    const name = t.ctx.getSettings().branding.logo.filename;
    fs.rmSync(path.join(logoDir(), name));
    assert.equal((await t.req('GET', '/api/branding/logo', { auth: false })).status, 404);
    await t.req('DELETE', '/api/settings/branding/logo');
  });
});

describe('品牌：旧数据', () => {
  it('loadSettings 给没有 branding 的旧设置补上默认值，坏掉的 logo 元数据当成没有', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-test-'));
    const config = loadConfig({
      INKDOVE_DATA_DIR: dataDir,
      INKDOVE_ADMIN_EMAIL: 'admin@example.com',
      INKDOVE_ADMIN_PASSWORD: 'test-password-123',
      INKDOVE_SESSION_SECRET: 's',
      INKDOVE_WAHA_WEBHOOK_SECRET: 'w',
    });
    const db = openDb(dataDir);
    try {
      const old = loadSettings(db, config);
      delete old.branding;
      kvSet(db, 'settings', old);
      assert.equal(kvGet(db, 'settings', null).branding, undefined);
      assert.deepEqual(loadSettings(db, config).branding, { title: '', logo: null });

      kvSet(db, 'settings', { ...old, branding: { title: '旧店名', logo: { filename: '../inkdove.db', mime: 'image/png', updatedAt: 1 } } });
      assert.deepEqual(loadSettings(db, config).branding, { title: '旧店名', logo: null });

      const meta = { filename: 'logo-abc.png', mime: 'image/png', updatedAt: 1700000000000 };
      kvSet(db, 'settings', { ...old, branding: { title: '店', logo: meta } });
      assert.deepEqual(loadSettings(db, config).branding, { title: '店', logo: meta });
    } finally {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
