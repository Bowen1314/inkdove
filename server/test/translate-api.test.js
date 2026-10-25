// 一键翻译选「翻译 API」：设置（校验、密钥只给后四位、留空不改）、测试接口、会话里的翻译流程（判断客户语言、记住结果、
// 原文已是客户语言、出错改用 AI 翻译、不支持的语言、调用记录）。翻译服务都是本地假服务。
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createMockAi } from '../src/ai/mock.js';
import { kvGet, kvSet } from '../src/db.js';
import { loadSettings } from '../src/settings.js';
import { convIdOf, convPath, startApp, startFakeWaha, waitDecided, waitFor, wahaSend } from './helpers.js';

let seq = 0;
const newChat = () => `86137${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;
const today = () => new Date().toISOString().slice(0, 10);

const DEEPL_KEY = 'deepl-secret-0001:fx';
const BAIDU_KEY = 'baidu-secret-key-77';

/** 本地假翻译服务（DeepL 和百度都挂在这里）：记下请求，按 handler 回复；handler 返回 'hang' 就一直不回 */
async function startFakeTranslator() {
  const state = { requests: [], handler: null };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const rec = { url: req.url, headers: req.headers, raw };
    state.requests.push(rec);
    const out = await state.handler(rec);
    if (out === 'hang') return;
    const [status, body] = out;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
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

/**
 * 假 DeepL 的常规回复：译成中文（判断语言那次）时 detected_source_language 用 detect；
 * 译成别的语言时译文是「[目标语言] 原文」，detected_source_language 用 source（默认 ZH）。
 */
const deeplOk =
  ({ detect = 'ES', source = 'ZH' } = {}) =>
  (req) => {
    const b = JSON.parse(req.raw);
    if (b.target_lang === 'ZH-HANS') return [200, { translations: [{ detected_source_language: detect, text: '（中文）' }] }];
    return [200, { translations: [{ detected_source_language: source, text: `[${b.target_lang}] ${b.text[0]}` }] }];
  };

describe('翻译 API：设置', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(async () => {
    await t.close();
  });

  const put = (translation) => t.req('PUT', '/api/settings', { body: { translation } });
  const pub = async () => (await t.req('GET', '/api/settings')).body.translation;

  it('默认是 AI 翻译（升级后行为不变）；每家服务都在，都没配好', async () => {
    const tr = await pub();
    assert.equal(tr.mode, 'ai');
    assert.equal(tr.provider, 'deepl');
    assert.equal(tr.fallbackToAi, true);
    assert.deepEqual(Object.keys(tr.providers), ['deepl', 'deeplx', 'azure', 'google', 'tencent', 'baidu', 'volcengine', 'libretranslate']);
    assert.deepEqual(tr.providers.deepl, { ready: false, apiKeySet: false, apiKeyLast4: null });
    assert.deepEqual(tr.providers.deeplx, { ready: false, urlSet: false, urlDisplay: '', tokenSet: false, tokenLast4: null });
    assert.deepEqual(tr.providers.tencent, { ready: false, secretIdSet: false, secretIdLast4: null, secretKeySet: false, secretKeyLast4: null, region: 'ap-guangzhou' });
    assert.deepEqual(tr.providers.libretranslate, { ready: false, url: '', apiKeySet: false, apiKeyLast4: null });
  });

  it('校验：方式、服务、开关、地址协议、密钥里的特殊字符、区域格式；错误信息以字段路径开头、不带填的值', async () => {
    const cases = [
      [{ mode: 'google' }, /^translation\.mode /],
      [{ provider: 'bing' }, /^translation\.provider /],
      [{ fallbackToAi: 'yes' }, /^translation\.fallbackToAi /],
      [{ providers: 'x' }, /^translation\.providers /],
      [{ providers: { deeplx: { url: 'ftp://deeplx.example.com/SECRET-1' } } }, /^translation\.providers\.deeplx\.url .*http/],
      [{ providers: { libretranslate: { url: 'javascript:alert(1)' } } }, /^translation\.providers\.libretranslate\.url /],
      [{ providers: { deepl: { apiKey: '密钥 secret-zzzz' } } }, /^translation\.providers\.deepl\.apiKey .*特殊字符/],
      [{ providers: { tencent: { region: 'Guangzhou!' } } }, /^translation\.providers\.tencent\.region 格式错误/],
      [{ providers: { azure: { region: 'east asia' } } }, /^translation\.providers\.azure\.region 格式错误/],
      [{ providers: { azure: { endpoint: 'myres.cognitiveservices.azure.com' } } }, /^translation\.providers\.azure\.endpoint /],
      [{ providers: { deepl: 'k' } }, /^translation\.providers\.deepl 必须是对象/],
      [{ providers: { deepl: { apiKey: 'a'.repeat(201) } } }, /^translation\.providers\.deepl\.apiKey /],
    ];
    for (const [body, re] of cases) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, re, JSON.stringify(body));
      assert.ok(!r.body.error.includes('SECRET-1') && !r.body.error.includes('secret-zzzz'), r.body.error);
    }
    assert.equal((await pub()).mode, 'ai', '都没保存');
    assert.equal((await pub()).providers.deepl.apiKeySet, false);
    // 不认识的服务忽略
    assert.equal((await put({ providers: { bing: { apiKey: 'x' } } })).status, 200);
  });

  it('选「翻译 API」时选的那家要配好：没配好 400 translation_provider_not_configured，信息指向缺的字段', async () => {
    const r = await put({ mode: 'api', provider: 'tencent' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'translation_provider_not_configured');
    assert.match(r.body.error, /^translation\.providers\.tencent\.secretId /);
    assert.equal((await pub()).mode, 'ai');
  });

  it('密钥只给「已设置」和后四位；留空或不给表示不改，null 表示清空；换服务不丢别家的密钥', async () => {
    let r = await put({ provider: 'deepl', providers: { deepl: { apiKey: `  ${DEEPL_KEY}  ` } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.translation.providers.deepl, { ready: true, apiKeySet: true, apiKeyLast4: '1:fx' });
    assert.ok(!JSON.stringify(r.body).includes('deepl-secret'), '设置接口的返回里没有密钥');
    assert.equal(t.ctx.getSettings().translation.providers.deepl.apiKey, DEEPL_KEY, '存的时候去掉首尾空白');

    r = await put({ mode: 'api', providers: { deepl: { apiKey: '' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.translation.mode, 'api');
    assert.equal(t.ctx.getSettings().translation.providers.deepl.apiKey, DEEPL_KEY, '空串不改');
    r = await put({ providers: { deepl: {} } });
    assert.equal(t.ctx.getSettings().translation.providers.deepl.apiKey, DEEPL_KEY, '不给不改');

    // 别家：填了腾讯的，换来换去都还在
    r = await put({ providers: { tencent: { secretId: 'AKIDsecretid0001', secretKey: 'tencent-secret-0002', region: 'ap-shanghai' } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.translation.providers.tencent, {
      ready: true,
      secretIdSet: true,
      secretIdLast4: '0001',
      secretKeySet: true,
      secretKeyLast4: '0002',
      region: 'ap-shanghai',
    });
    r = await put({ provider: 'tencent' });
    r = await put({ provider: 'deepl' });
    assert.equal(r.body.translation.providers.tencent.ready, true);
    assert.equal(r.body.translation.providers.deepl.ready, true);

    // 选着翻译 API 时把在用的那家的密钥清掉：不行
    r = await put({ providers: { deepl: { apiKey: null } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'translation_provider_not_configured');
    // 换回 AI 翻译再清：可以；区域这种普通字段空串就是清空
    r = await put({ mode: 'ai', providers: { deepl: { apiKey: null }, tencent: { region: '' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.translation.providers.deepl, { ready: false, apiKeySet: false, apiKeyLast4: null });
    assert.equal(r.body.translation.providers.tencent.ready, false, '腾讯云的区域是必填');
    assert.equal(t.ctx.getSettings().translation.providers.deepl.apiKey, '');
  });

  it('DeepLX 的地址按密钥处理：只显示协议和主机，路径不出现在任何返回里', async () => {
    const url = 'https://deeplx.example.com/SECRET-PATH-abc123/translate';
    const r = await put({ providers: { deeplx: { url, token: 'tok-9876' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.translation.providers.deeplx, {
      ready: true,
      urlSet: true,
      urlDisplay: 'https://deeplx.example.com/***',
      tokenSet: true,
      tokenLast4: '9876',
    });
    const all = JSON.stringify((await t.req('GET', '/api/settings')).body);
    assert.ok(!all.includes('SECRET-PATH'), '路径不出现');
    assert.ok(!all.includes('tok-9876'));
    // LibreTranslate 的地址不是密钥，照常显示
    const lr = await put({ providers: { libretranslate: { url: 'http://127.0.0.1:5000' } } });
    assert.equal(lr.body.translation.providers.libretranslate.url, 'http://127.0.0.1:5000');
  });

  it('存坏了的翻译设置读出来时修好：不认识的方式回到 AI 翻译，字段类型不对回到默认值', () => {
    const db = t.ctx.db;
    const saved = kvGet(db, 'settings', null);
    try {
      kvSet(db, 'settings', {
        ...saved,
        translation: { mode: 'magic', provider: 'bing', fallbackToAi: 'yes', providers: { deepl: { apiKey: 42 }, tencent: { region: null } } },
      });
      const tr = loadSettings(db, t.config).translation;
      assert.equal(tr.mode, 'ai');
      assert.equal(tr.provider, 'deepl');
      assert.equal(tr.fallbackToAi, true);
      assert.equal(tr.providers.deepl.apiKey, '');
      assert.equal(tr.providers.tencent.region, 'ap-guangzhou');
      assert.deepEqual(tr.providers.volcengine, { accessKeyId: '', secretAccessKey: '' });

      // 老版本没有 translation：补上默认值
      const { translation: _drop, ...old } = saved;
      kvSet(db, 'settings', old);
      assert.equal(loadSettings(db, t.config).translation.mode, 'ai');
    } finally {
      kvSet(db, 'settings', saved);
    }
  });
});

describe('翻译 API：测试接口', () => {
  let t;
  let fake;
  before(async () => {
    fake = await startFakeTranslator();
    t = await startApp({ options: { translateEndpoints: { deepl: fake.url, deeplx: fake.url }, translateTimeoutMs: 300 } });
    await t.login();
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  const test = (body, o) => t.req('POST', '/api/settings/translation/test', { body, ...o });

  it('用表单里的值把一段固定的中文译成英语，不保存；返回译文、检测出的源语言、耗时；记一行调用（purpose=test）', async () => {
    fake.state.handler = deeplOk();
    const r = await test({ provider: 'deepl', config: { apiKey: DEEPL_KEY } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.match(r.body.text, /^\[EN-US\] 你好，很高兴认识你。/);
    assert.equal(r.body.detectedSource, 'zh');
    assert.equal(typeof r.body.latencyMs, 'number');
    const req = fake.state.requests.at(-1);
    assert.equal(req.headers.authorization, `DeepL-Auth-Key ${DEEPL_KEY}`);
    assert.equal(JSON.parse(req.raw).target_lang, 'EN-US');
    assert.equal(t.ctx.getSettings().translation.providers.deepl.apiKey, '', '测试不保存');
    const row = t.ctx.db.prepare("SELECT purpose, format, model, input_tokens, output_tokens, ok, account_id, conversation_id FROM llm_calls WHERE purpose = 'test' ORDER BY ts DESC LIMIT 1").get();
    assert.deepEqual(row, { purpose: 'test', format: 'deepl', model: 'deepl', input_tokens: null, output_tokens: null, ok: 1, account_id: null, conversation_id: null });
  });

  it('密钥没填时用已保存的；都没有时不发请求，返回 {ok:false, kind:config, field}', async () => {
    fake.state.requests.length = 0;
    const none = await test({ provider: 'deepl', config: { apiKey: '' } });
    assert.deepEqual(none.body, { ok: false, error: '未填写 DeepL 的 API Key', kind: 'config', field: 'apiKey' });
    assert.equal(fake.state.requests.length, 0);
    await t.req('PUT', '/api/settings', { body: { translation: { providers: { deepl: { apiKey: DEEPL_KEY } } } } });
    const r = await test({ provider: 'deepl', config: {} });
    assert.equal(r.body.ok, true);
    assert.equal(fake.state.requests.at(-1).headers.authorization, `DeepL-Auth-Key ${DEEPL_KEY}`);
  });

  it('对方报错：{ok:false, error, kind}，错误里不带密钥和 DeepLX 地址里的令牌；调用记成失败', async () => {
    fake.state.handler = () => [403, { message: `Authorization failed for ${DEEPL_KEY}` }];
    const r = await test({ provider: 'deepl', config: { apiKey: DEEPL_KEY } });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.kind, 'auth');
    assert.match(r.body.error, /DeepL/);
    assert.ok(!r.body.error.includes('deepl-secret'), r.body.error);
    assert.equal(t.ctx.db.prepare("SELECT ok FROM llm_calls WHERE purpose = 'test' ORDER BY ts DESC LIMIT 1").get().ok, 0);

    fake.state.handler = (req) => [503, { code: 503, message: `no route ${req.url}` }];
    const x = await test({ provider: 'deeplx', config: { url: 'https://deeplx.example.com/SECRET-PATH-abc123/translate' } });
    assert.equal(x.body.ok, false);
    assert.equal(x.body.kind, 'server');
    assert.ok(!x.body.error.includes('SECRET-PATH'), x.body.error);

    fake.state.handler = () => 'hang';
    const slow = await test({ provider: 'deepl', config: { apiKey: DEEPL_KEY } });
    assert.equal(slow.body.kind, 'timeout');
  });

  it('参数：不认识的服务 400；表单值不合法 400（和保存一样的校验）；只有管理员能用', async () => {
    assert.equal((await test({ provider: 'bing' })).status, 400);
    assert.equal((await test({})).status, 400);
    const bad = await test({ provider: 'deeplx', config: { url: 'ftp://x.example.com' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^translation\.providers\.deeplx\.url /);
    const agent = await t.addMember({ email: 'translate-test-agent@example.com' });
    assert.equal((await test({ provider: 'deepl', config: { apiKey: DEEPL_KEY } }, { cookie: agent.cookie })).status, 403);
  });
});

describe('翻译 API：会话里的一键翻译', () => {
  let t;
  let waha;
  let fake;
  let quiet;
  const mock = createMockAi({ delayMs: 0 });
  const spy = { calls: 0 };

  const translate = (convId, text) => t.req('POST', `${convPath(convId)}/translate`, { body: { text } });
  const putTr = (translation) => t.req('PUT', '/api/settings', { body: { translation } });
  const convRow = (id) => t.ctx.db.prepare('SELECT llm_day, llm_calls FROM conversations WHERE id = ?').get(id);
  const deeplRequests = () => fake.state.requests.filter((r) => r.url === '/v2/translate').map((r) => JSON.parse(r.raw));

  async function customer(texts, chat = newChat()) {
    for (const text of texts) await wahaSend(t, quiet, chat, text, { pushName: '客户' });
    const id = convIdOf(quiet, chat);
    await waitDecided(t, id, texts.length);
    await waitFor(() => t.ctx.wa.idle());
    return { id, chat };
  }

  before(async () => {
    waha = await startFakeWaha();
    fake = await startFakeTranslator();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: waha.url },
      options: {
        translateEndpoints: { deepl: fake.url, baidu: fake.url },
        translateTimeoutMs: 300,
        aiOverrides: {
          translate: (args) => {
            spy.calls++;
            return mock.translate(args);
          },
        },
      },
    });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    quiet = await t.createAccount({ name: '翻译号' });
    await t.req('POST', `/api/accounts/${quiet.id}/waha/start`);
    const r = await putTr({ mode: 'api', provider: 'deepl', fallbackToAi: false, providers: { deepl: { apiKey: DEEPL_KEY }, baidu: { appId: '20240001000123', appKey: BAIDU_KEY } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  after(async () => {
    await t.close();
    await waha.close();
    await fake.close();
  });

  it('先判断客户语言（DeepL 没有检测接口：把客户原话译成中文一次，看检测出的源语言），再译成那种语言；via 是服务；不用模型、不计入每日次数', async () => {
    fake.state.handler = deeplOk({ detect: 'ES' });
    const { id } = await customer(['Hola, ¿cuánto cuesta el envío a Madrid?', 'Necesito 200 piezas']);
    t.ctx.db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = 3 WHERE id = ?').run(today(), id);
    fake.state.requests.length = 0;
    spy.calls = 0;
    const r = await translate(id, '运费 10 元，满 300 包邮');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { text: '[ES] 运费 10 元，满 300 包邮', language: '西班牙语', via: 'deepl' });
    const reqs = deeplRequests();
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs[0], { text: ['Hola, ¿cuánto cuesta el envío a Madrid?\nNecesito 200 piezas'], target_lang: 'ZH-HANS' });
    assert.deepEqual(reqs[1], { text: ['运费 10 元，满 300 包邮'], target_lang: 'ES' });
    assert.equal(spy.calls, 0, '不用模型');
    assert.equal(convRow(id).llm_calls, 3, '不计入会话每日模型次数');
    const rows = t.ctx.db
      .prepare("SELECT purpose, format, model, input_tokens, ok, account_id, conversation_id FROM llm_calls WHERE conversation_id = ? AND format = 'deepl'")
      .all(id);
    assert.equal(rows.length, 2, '两次调用各记一行');
    for (const row of rows) assert.deepEqual(row, { purpose: 'translate', format: 'deepl', model: 'deepl', input_tokens: null, ok: 1, account_id: quiet.id, conversation_id: id });
  });

  it('客户语言按会话记住：再翻译不重新判断；客户发了新消息才重新判断', async () => {
    fake.state.handler = deeplOk({ detect: 'PT' });
    const { id, chat } = await customer(['Olá, quanto custa o frete para Lisboa?']);
    fake.state.requests.length = 0;
    assert.equal((await translate(id, '你好')).body.text, '[PT-BR] 你好');
    assert.equal((await translate(id, '谢谢')).body.text, '[PT-BR] 谢谢');
    assert.deepEqual(
      deeplRequests().map((b) => b.target_lang),
      ['ZH-HANS', 'PT-BR', 'PT-BR'],
      '第二次没有再判断',
    );
    // 客户改说英语
    fake.state.handler = deeplOk({ detect: 'EN' });
    await customer(['Sorry, can you write in English please?'], chat);
    fake.state.requests.length = 0;
    const r = await translate(id, '好的');
    assert.deepEqual(r.body, { text: '[EN-US] 好的', language: '英语', via: 'deepl' });
    assert.deepEqual(
      deeplRequests().map((b) => b.target_lang),
      ['ZH-HANS', 'EN-US'],
    );
  });

  it('原文已经是客户的语言：原样返回（本地判断得出的不调接口；本地判断不出的看对方检测出的源语言）', async () => {
    fake.state.handler = deeplOk({ detect: 'ZH' });
    const zh = await customer(['你好，请问这个有现货吗？']);
    fake.state.requests.length = 0;
    const r = await translate(zh.id, '有的，今天下单明天就能发货');
    assert.deepEqual(r.body, { text: '有的，今天下单明天就能发货', language: '中文', via: 'deepl' });
    assert.deepEqual(
      deeplRequests().map((b) => b.target_lang),
      ['ZH-HANS'],
      '只有判断客户语言那一次',
    );

    // 客户说英语，业务员写的英文太短本地判断不出：对方检测出的源语言就是英语 → 原样返回
    fake.state.handler = deeplOk({ detect: 'EN', source: 'EN' });
    const en = await customer(['Hello, do you have this in stock?']);
    const ok = await translate(en.id, 'OK!');
    assert.deepEqual(ok.body, { text: 'OK!', language: '英语', via: 'deepl' });
  });

  it('关着「改用 AI 翻译」：出错时报错，说清楚是哪家、什么问题，不带密钥；记一行失败的调用', async () => {
    const { id } = await customer(['Bonjour, quel est le prix ?']);
    fake.state.handler = () => [403, { message: `Wrong key ${DEEPL_KEY}` }];
    spy.calls = 0;
    const r = await translate(id, '价格是 5 美元');
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'translation_api_error');
    assert.match(r.body.error, /^翻译失败：DeepL/);
    assert.ok(!r.body.error.includes('deepl-secret'), r.body.error);
    assert.equal(spy.calls, 0);
    const row = t.ctx.db.prepare("SELECT ok FROM llm_calls WHERE conversation_id = ? AND format = 'deepl' ORDER BY ts DESC LIMIT 1").get(id);
    assert.equal(row.ok, 0);
    assert.ok(!t.log.lines.some((l) => l.includes('deepl-secret')), '日志里也没有密钥');

    // 超时
    fake.state.handler = () => 'hang';
    const slow = await translate(id, '价格是 5 美元');
    assert.equal(slow.status, 502);
    assert.match(slow.body.error, /超时/);
  });

  it('客户消息判断不出语言（都是数字符号、对方也没给结果）：400 language_unknown', async () => {
    fake.state.handler = (req) => {
      const b = JSON.parse(req.raw);
      return [200, { translations: [{ text: b.text[0] }] }];
    };
    const { id } = await customer(['12345 ???']);
    const r = await translate(id, '你好');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'language_unknown');
  });

  it('选的服务不支持客户的语言（百度个人版和印尼语）：400 translation_unsupported_language，不发翻译请求', async () => {
    assert.equal((await putTr({ provider: 'baidu' })).status, 200);
    try {
      fake.state.handler = (req) => {
        const f = new URLSearchParams(req.raw);
        if (f.get('to') === 'zh') return [200, { from: 'id', to: 'zh', trans_result: [{ src: f.get('q'), dst: '（中文）' }] }];
        return [200, { from: 'zh', to: f.get('to'), trans_result: [{ src: f.get('q'), dst: `[${f.get('to')}] ${f.get('q')}` }] }];
      };
      const { id } = await customer(['Halo, berapa harga produk ini? Saya mau pesan sepuluh buah']);
      fake.state.requests.length = 0;
      const r = await translate(id, '一件 5 美元');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, 'translation_unsupported_language');
      assert.match(r.body.error, /百度翻译.*印尼语/);
      assert.equal(fake.state.requests.length, 1, '只有判断语言那一次');

      // 支持的语言照常（日语 → 百度代码 jp）
      fake.state.handler = (req) => {
        const f = new URLSearchParams(req.raw);
        if (f.get('to') === 'zh') return [200, { from: 'jp', to: 'zh', trans_result: [{ src: f.get('q'), dst: '（中文）' }] }];
        return [200, { from: 'zh', to: f.get('to'), trans_result: [{ src: f.get('q'), dst: `[${f.get('to')}] ${f.get('q')}` }] }];
      };
      const ja = await customer(['こんにちは、この商品はいくらですか？']);
      const ok = await translate(ja.id, '一件 5 美元');
      assert.deepEqual(ok.body, { text: '[jp] 一件 5 美元', language: '日语', via: 'baidu' });
    } finally {
      await putTr({ provider: 'deepl' });
    }
  });

  it('开着「改用 AI 翻译」：接口出错、不支持的语言都改用回复模型，via=ai 并说明原因', async () => {
    assert.equal((await putTr({ fallbackToAi: true })).status, 200);
    try {
      const { id } = await customer(['Hola, ¿cuánto cuesta el envío a Barcelona?']);
      fake.state.handler = () => [456, { message: 'Quota exceeded' }];
      spy.calls = 0;
      const r = await translate(id, '运费 10 欧元');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.via, 'ai');
      assert.equal(r.body.text, '[译成 西班牙语] 运费 10 欧元');
      assert.equal(r.body.language, '西班牙语');
      assert.match(r.body.fallbackReason, /DeepL.*额度/);
      assert.equal(spy.calls, 1);
      assert.ok(t.log.lines.some((l) => l.startsWith('warn') && l.includes('[translate]')), '出错记一条警告');

      assert.equal((await putTr({ provider: 'baidu' })).status, 200);
      fake.state.handler = (req) => {
        const f = new URLSearchParams(req.raw);
        return [200, { from: 'id', to: f.get('to'), trans_result: [{ src: f.get('q'), dst: '（中文）' }] }];
      };
      const idn = await customer(['Halo, berapa harga produk ini? Saya mau pesan sepuluh buah']);
      const u = await translate(idn.id, '一件 5 美元');
      assert.equal(u.status, 200, JSON.stringify(u.body));
      assert.equal(u.body.via, 'ai');
      assert.match(u.body.fallbackReason, /百度翻译.*印尼语/);
    } finally {
      await putTr({ provider: 'deepl', fallbackToAi: false });
    }
  });

  it('AI 翻译方式下完全不碰翻译接口（就算填好了）', async () => {
    assert.equal((await putTr({ mode: 'ai' })).status, 200);
    try {
      const { id } = await customer(['Hello, any discount for 500 pieces?']);
      fake.state.requests.length = 0;
      const r = await translate(id, '可以打九五折');
      assert.deepEqual(r.body, { text: '[译成 英语] 可以打九五折', language: '英语', via: 'ai' });
      assert.equal(fake.state.requests.length, 0);
    } finally {
      await putTr({ mode: 'api' });
    }
  });
});

describe('翻译 API：没配回复模型时', () => {
  let t;
  let waha;
  let fake;
  let acc;
  before(async () => {
    waha = await startFakeWaha();
    fake = await startFakeTranslator();
    t = await startApp({ env: { INKDOVE_LLM_MOCK: '0', INKDOVE_WAHA_URL: waha.url }, options: { translateEndpoints: { deepl: fake.url }, translateTimeoutMs: 300 } });
    await t.login();
    acc = await t.createAccount({ name: '一号' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    const r = await t.req('PUT', '/api/settings', { body: { translation: { mode: 'api', providers: { deepl: { apiKey: DEEPL_KEY } } } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  after(async () => {
    await t.close();
    await waha.close();
    await fake.close();
  });

  it('翻译 API 不需要回复模型；接口出错时开着「改用 AI 翻译」也说清楚没法改用', async () => {
    const chat = newChat();
    const id = convIdOf(acc, chat);
    await wahaSend(t, acc, chat, 'Ciao, quanto costa la spedizione per Roma?');
    await waitDecided(t, id, 1);
    fake.state.handler = deeplOk({ detect: 'IT' });
    const ok = await t.req('POST', `${convPath(id)}/translate`, { body: { text: '运费 10 欧元' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { text: '[IT] 运费 10 欧元', language: '意大利语', via: 'deepl' });

    fake.state.handler = () => [500, { message: 'boom' }];
    t.ctx.translationLanguages.clear();
    const bad = await t.req('POST', `${convPath(id)}/translate`, { body: { text: '运费 10 欧元' } });
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /DeepL.*回复模型未配置/);
  });
});
