// 翻译接口（translate/）：每家服务对着本地假服务测请求格式、签名头、语言代码转换、检测结果解析、错误分类和抹密钥；
// 签名算法对着官方文档的固定示例测。不调任何真实服务。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import azure, { azureRoot } from '../src/translate/azure.js';
import baidu, { baiduSign, fromBaidu } from '../src/translate/baidu.js';
import { maskUrl, redact, TranslateError } from '../src/translate/common.js';
import deepl, { deeplBase } from '../src/translate/deepl.js';
import deeplx, { deeplxUrl } from '../src/translate/deeplx.js';
import { detectLocal } from '../src/translate/detect-local.js';
import google from '../src/translate/google.js';
import { missingField, publicProviders, TRANSLATION_PROVIDERS } from '../src/translate/index.js';
import { languageName, normalizeLang } from '../src/translate/languages.js';
import libretranslate, { libreRoot } from '../src/translate/libretranslate.js';
import tencent, { tc3Authorization, tc3CanonicalRequest, tc3KeyFromDateKey, tc3Signature, tc3StringToSign } from '../src/translate/tencent.js';
import volcengine, { volcSign } from '../src/translate/volcengine.js';

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 本地假服务：记下每个请求（方法、地址、头、原始请求体），按 handler 回复；handler 返回 'hang' 就一直不回 */
async function startFake() {
  const state = { requests: [], handler: () => [200, {}] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const rec = { method: req.method, url: req.url, headers: req.headers, raw };
    state.requests.push(rec);
    const out = await state.handler(rec);
    if (out === 'hang') return;
    const [status, body, headers = {}] = out;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    /** 设置回复，清空请求记录 */
    on(handler) {
      state.handler = handler;
      state.requests.length = 0;
    },
    get last() {
      return state.requests.at(-1);
    },
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/** 断言抛 TranslateError 且 kind 对；返回错误 */
async function rejectsKind(promise, kind) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TranslateError, `应该是 TranslateError：${err}`);
    assert.equal(err.kind, kind, `kind 应该是 ${kind}，实际 ${err.kind}：${err.message}`);
    return err;
  }
  assert.fail(`应该抛 ${kind}`);
}

describe('翻译接口：公共部分', () => {
  it('maskUrl 只露出协议和主机，路径、查询串、用户名密码都不露', () => {
    assert.equal(maskUrl('https://api.deeplx.org/abcdef123456/translate'), 'https://api.deeplx.org/***');
    assert.equal(maskUrl('http://127.0.0.1:1188'), 'http://127.0.0.1:1188');
    assert.equal(maskUrl('http://127.0.0.1:1188/'), 'http://127.0.0.1:1188');
    assert.equal(maskUrl('https://user:pass@host.example.com/'), 'https://host.example.com/***');
    assert.equal(maskUrl('https://h.example.com/?token=abc'), 'https://h.example.com/***');
    assert.equal(maskUrl('ftp://h.example.com/x'), '');
    assert.equal(maskUrl('不是地址'), '');
  });

  it('redact 抹掉密钥（原样和 URL 编码后的）和带密钥的地址（整个地址、路径、路径里的每一段）', () => {
    const out = redact('key=a+b/c== and a%2Bb%2Fc%3D%3D', { secrets: ['a+b/c=='] });
    assert.ok(!out.includes('a+b/c==') && !out.includes('a%2Bb%2Fc%3D%3D'), out);
    const url = 'https://api.deeplx.org/SECRET-TOKEN-123/translate';
    const r = redact(`POST ${url} failed; path /SECRET-TOKEN-123/translate; token SECRET-TOKEN-123`, { secretUrls: [url] });
    assert.ok(!r.includes('SECRET-TOKEN-123'), r);
    assert.ok(r.includes('POST ***'), r);
    // 太短的不抹（免得把正常文字抹花）
    assert.equal(redact('ab cd', { secrets: ['ab'] }), 'ab cd');
  });

  it('normalizeLang：去掉地区和变体，认识常见别名；auto 和乱写的返回 null', () => {
    assert.equal(normalizeLang('EN-US'), 'en');
    assert.equal(normalizeLang('zh-Hans'), 'zh');
    assert.equal(normalizeLang('zh-TW'), 'zh');
    assert.equal(normalizeLang('pt_BR'), 'pt');
    assert.equal(normalizeLang('iw'), 'he');
    assert.equal(normalizeLang('jw'), 'jv');
    assert.equal(normalizeLang('fil'), 'tl');
    assert.equal(normalizeLang('nb'), 'no');
    assert.equal(normalizeLang('auto'), null);
    assert.equal(normalizeLang('x1'), null);
    assert.equal(normalizeLang(''), null);
    assert.equal(normalizeLang(null), null);
    assert.equal(languageName('es'), '西班牙语');
    assert.equal(languageName('xx'), 'xx', '表里没有的照原样显示');
  });

  it('本地判断语言（tinyld）：常见语言的短句能判断，数字符号和空串判断不出来', () => {
    assert.equal(detectLocal('Hola, ¿cuánto cuesta el envío a Madrid?'), 'es');
    assert.equal(detectLocal('Olá, quanto custa isso?'), 'pt');
    assert.equal(detectLocal('こんにちは、いくらですか'), 'ja');
    assert.equal(detectLocal('مرحبا كم السعر'), 'ar');
    assert.equal(detectLocal('你好，请问多少钱'), 'zh');
    assert.equal(detectLocal('12345 !!!'), null);
    assert.equal(detectLocal(''), null);
    assert.equal(detectLocal('ok'), null, '太短，把握不够');
  });

  it('登记表：八家服务；必填字段、对外视图（密钥只给后四位，DeepLX 地址只给协议和主机）', () => {
    assert.deepEqual(
      TRANSLATION_PROVIDERS.map((p) => p.id),
      ['deepl', 'deeplx', 'azure', 'google', 'tencent', 'baidu', 'volcengine', 'libretranslate'],
    );
    assert.equal(missingField('tencent', { secretId: 'a', secretKey: '', region: 'ap-guangzhou' }), 'secretKey');
    assert.equal(missingField('azure', { apiKey: 'k' }), null, '区域和终结点可以不填');
    assert.equal(missingField('deeplx', { url: '', token: '' }), 'url');
    const view = publicProviders({
      deepl: { apiKey: 'abcdefgh-1234:fx' },
      deeplx: { url: 'https://api.deeplx.org/SECRET-TOKEN/translate', token: '' },
      libretranslate: { url: 'http://127.0.0.1:5000', apiKey: 'libkey99' },
    });
    assert.deepEqual(view.deepl, { ready: true, apiKeySet: true, apiKeyLast4: '4:fx' });
    assert.deepEqual(view.deeplx, { ready: true, urlSet: true, urlDisplay: 'https://api.deeplx.org/***', tokenSet: false, tokenLast4: null });
    assert.deepEqual(view.libretranslate, { ready: true, url: 'http://127.0.0.1:5000', apiKeySet: true, apiKeyLast4: 'ey99' });
    assert.equal(view.tencent.ready, false);
    assert.ok(!JSON.stringify(view).includes('SECRET-TOKEN'));
    assert.ok(!JSON.stringify(view).includes('abcdefgh'));
  });
});

describe('签名：官方文档的固定示例', () => {
  // 腾讯云 签名方法 v3（https://cloud.tencent.com/document/api/213/30654）：示例的 SecretKey 打了码，
  // 所以从规范请求、待签名字符串、文档给出的 SecretDate 往下派生、最后的签名逐步核对（SecretKey → SecretDate 这一步核对不了）。
  it('腾讯云 TC3-HMAC-SHA256', () => {
    const payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
    assert.equal(sha256Hex(payload), '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064');
    const canonicalRequest = tc3CanonicalRequest({
      contentType: 'application/json; charset=utf-8',
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      payload,
    });
    assert.equal(
      canonicalRequest,
      'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:cvm.tencentcloudapi.com\nx-tc-action:describeinstances\n\n' +
        'content-type;host;x-tc-action\n35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064',
    );
    assert.equal(sha256Hex(canonicalRequest), '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84');
    const stringToSign = tc3StringToSign({ timestamp: 1551113065, service: 'cvm', canonicalRequest });
    assert.equal(
      stringToSign,
      'TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
    );
    const secretDate = Buffer.from('da98fb70dcf6b112dc21038d1eeeb3a95c74b4dcb12c1131f864f6066bd02be0', 'hex');
    const secretSigning = tc3KeyFromDateKey(secretDate, 'cvm');
    assert.equal(secretSigning.toString('hex'), 'b596b923aad85185e2d1f6659d2a062e0a86731226e021e61bfe06f7ed05f5af');
    assert.equal(tc3Signature(secretSigning, stringToSign), '10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f');
  });

  // 火山引擎 签名方法（https://docs.volcengine.com/docs/APISignatureCallGuide/Signaturemethod-9）：示例给了完整的 AK / SK。
  // 文档示例的 AK 拆成两段写：整串会被 GitHub 的密钥扫描当成真密钥拦下推送
  const VOLC_DOC_AK = 'AKLT' + 'YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg';
  it('火山引擎 HMAC-SHA256（GET 和 POST 两个示例）', () => {
    const base = {
      accessKeyId: VOLC_DOC_AK,
      secretAccessKey: 'WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==',
      region: 'cn-beijing',
      service: 'billing',
      xDate: '20250329T180937Z',
      signedHeaders: [
        ['host', 'billing.volcengineapi.com'],
        ['x-date', '20250329T180937Z'],
      ],
    };
    const get = volcSign({ ...base, method: 'GET', query: { Version: '2022-01-01', Action: 'QueryBalanceAcct' }, body: '' });
    assert.equal(
      get.canonicalRequest,
      'GET\n/\nAction=QueryBalanceAcct&Version=2022-01-01\nhost:billing.volcengineapi.com\nx-date:20250329T180937Z\n\nhost;x-date\n' +
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(sha256Hex(get.canonicalRequest), '43171c1658c64b5db55c58d54988a4598d2d09a5613136beaa5eef40eae6e2c1');
    assert.equal(get.signature, '1eda9e7e6b1728151a8e8791fdaf67cfbd28bd5c80d0fce2eb208746cf483105');
    assert.equal(
      get.authorization,
      `HMAC-SHA256 Credential=${VOLC_DOC_AK}/20250329/cn-beijing/billing/request, SignedHeaders=host;x-date, ` +
        'Signature=1eda9e7e6b1728151a8e8791fdaf67cfbd28bd5c80d0fce2eb208746cf483105',
    );
    const post = volcSign({ ...base, method: 'POST', query: { Action: 'ListBill', Version: '2022-01-01' }, body: '{"Limit":10,"BillPeriod":"2023-08"}' });
    assert.equal(sha256Hex('{"Limit":10,"BillPeriod":"2023-08"}'), 'e8cc56e129d9759d56c936e679a345d001a4235b58bee8e935ccad97f23ed663');
    assert.equal(sha256Hex(post.canonicalRequest), '27383e3b56d03850f5634483527fbddcbf06cf98de1bc8a6679ef2300bff3b15');
    assert.equal(post.signature, '5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658');
  });

  // 百度 通用文本翻译（https://fanyi-api.baidu.com/doc/23）和语种识别（https://fanyi-api.baidu.com/doc/25）文档里的两个示例
  it('百度 MD5 签名', () => {
    assert.equal(baiduSign('2015063000000001', 'apple', '65478', '1234567890'), 'a1a7461d92e5194c5cae3182b5b24de1');
    assert.equal(baiduSign('2015063000000001', 'apple', '1435660288', '12345678'), 'f89f9594663708c1605f3d736d01d2d4');
  });
});

describe('翻译接口：每家服务对着本地假服务', () => {
  let fake;
  before(async () => {
    fake = await startFake();
  });
  after(async () => {
    await fake.close();
  });
  const o = () => ({ endpoint: fake.url, timeoutMs: 2000 });

  describe('DeepL', () => {
    const cfg = { apiKey: 'deepl-key-1234:fx' };

    it('请求格式：POST /v2/translate，DeepL-Auth-Key 头，目标语言用变体；返回检测出的源语言', async () => {
      fake.on(() => [200, { translations: [{ detected_source_language: 'ZH', text: 'Hello' }] }]);
      const r = await deepl.translate(cfg, { text: '你好', source: 'auto', target: 'en' }, o());
      assert.deepEqual(r, { text: 'Hello', detectedSource: 'zh' });
      const req = fake.last;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v2/translate');
      assert.equal(req.headers.authorization, 'DeepL-Auth-Key deepl-key-1234:fx');
      assert.deepEqual(JSON.parse(req.raw), { text: ['你好'], target_lang: 'EN-US' });
      for (const [lang, code] of [
        ['pt', 'PT-BR'],
        ['zh', 'ZH-HANS'],
        ['no', 'NB'],
        ['es', 'ES'],
      ]) {
        await deepl.translate(cfg, { text: 'x', source: 'auto', target: lang }, o());
        assert.equal(JSON.parse(fake.last.raw).target_lang, code);
      }
      assert.equal(deeplBase('k:fx'), 'https://api-free.deepl.com');
      assert.equal(deeplBase('k'), 'https://api.deepl.com');
    });

    it('错误分类：403 鉴权、456 额度、429 / 529 限流、400 语言不支持、500；错误信息不带密钥', async () => {
      fake.on(() => [403, { message: 'Wrong key deepl-key-1234:fx' }]);
      const err = await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'auth');
      assert.ok(!err.message.includes('deepl-key-1234'), err.message);
      assert.match(err.message, /DeepL/);
      fake.on(() => [456, { message: 'Quota exceeded' }]);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'quota');
      fake.on(() => [429, { message: 'Too many requests' }]);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'rate_limit');
      fake.on(() => [529, '']);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'rate_limit');
      fake.on(() => [400, { message: "Value for 'target_lang' not supported." }]);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'xx' }, o()), 'unsupported_language');
      fake.on(() => [500, 'boom']);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'server');
      fake.on(() => [200, 'not json']);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'bad_response');
      fake.on(() => [302, '', { location: 'http://evil.example.com/' }]);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o()), 'config');
    });

    it('没填密钥、密钥里有中文：不发请求，config', async () => {
      fake.on(() => [200, {}]);
      let attempted = false;
      await rejectsKind(deepl.translate({ apiKey: '' }, { text: 'x', source: 'auto', target: 'en' }, { ...o(), onAttempt: () => (attempted = true) }), 'config');
      await rejectsKind(deepl.translate({ apiKey: '密钥 abc' }, { text: 'x', source: 'auto', target: 'en' }, o()), 'config');
      assert.equal(attempted, false);
      assert.equal(fake.state.requests.length, 0);
    });

    it('超时（timeout）和连不上（network）', async () => {
      fake.on(() => 'hang');
      const err = await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, { endpoint: fake.url, timeoutMs: 150 }), 'timeout');
      assert.match(err.message, /超时/);
      await rejectsKind(deepl.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, { endpoint: 'http://127.0.0.1:9', timeoutMs: 2000 }), 'network');
    });
  });

  describe('DeepLX', () => {
    it('地址按密钥处理：路径里的令牌不出现在错误信息里；Bearer 令牌；补 /translate', async () => {
      const url = `${fake.url}/SECRET-PATH-TOKEN`;
      fake.on(() => [200, { code: 200, id: 1, data: 'Hola', alternatives: null, source_lang: 'ZH', target_lang: 'ES', method: 'Free' }]);
      const r = await deeplx.translate({ url, token: 'tok-abcdef' }, { text: '你好', source: 'auto', target: 'es' }, { timeoutMs: 2000 });
      assert.deepEqual(r, { text: 'Hola', detectedSource: 'zh' });
      assert.equal(fake.last.url, '/SECRET-PATH-TOKEN/translate');
      assert.equal(fake.last.headers.authorization, 'Bearer tok-abcdef');
      assert.deepEqual(JSON.parse(fake.last.raw), { text: '你好', source_lang: 'auto', target_lang: 'ES' });
      assert.equal(deeplxUrl('http://h:1188/'), 'http://h:1188/translate');
      assert.equal(deeplxUrl('http://h:1188/translate'), 'http://h:1188/translate');

      fake.on((req) => [503, { code: 503, message: `Translation failed for ${req.url}` }]);
      const err = await rejectsKind(deeplx.translate({ url, token: '' }, { text: 'x', source: 'auto', target: 'es' }, { timeoutMs: 2000 }), 'server');
      assert.ok(!err.message.includes('SECRET-PATH-TOKEN'), err.message);
      assert.match(err.message, /自己部署/);
      fake.on(() => [429, { code: 429, message: 'Too many requests' }]);
      await rejectsKind(deeplx.translate({ url, token: '' }, { text: 'x', source: 'auto', target: 'es' }, { timeoutMs: 2000 }), 'rate_limit');
      fake.on(() => [401, { code: 401, message: 'Invalid access token' }]);
      await rejectsKind(deeplx.translate({ url, token: 'bad-token' }, { text: 'x', source: 'auto', target: 'es' }, { timeoutMs: 2000 }), 'auth');
      // 连不上时的信息里也不能有地址里的令牌
      const netErr = await rejectsKind(
        deeplx.translate({ url: 'http://127.0.0.1:9/SECRET-PATH-TOKEN', token: '' }, { text: 'x', source: 'auto', target: 'es' }, { timeoutMs: 2000 }),
        'network',
      );
      assert.ok(!netErr.message.includes('SECRET-PATH-TOKEN'), netErr.message);
    });
  });

  describe('Azure 翻译', () => {
    const cfg = { apiKey: 'azure-key-5678', region: 'eastasia', endpoint: '' };

    it('翻译：/translate?api-version=3.0&to=zh-Hans，订阅密钥和区域头；检测：/detect', async () => {
      fake.on((req) =>
        req.url.startsWith('/detect')
          ? [200, [{ language: 'es', score: 0.98, isTranslationSupported: true }]]
          : [200, [{ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '你好', to: 'zh-Hans' }] }]],
      );
      const r = await azure.translate(cfg, { text: 'Hello', source: 'auto', target: 'zh' }, o());
      assert.deepEqual(r, { text: '你好', detectedSource: 'en' });
      assert.equal(fake.last.url, '/translate?api-version=3.0&to=zh-Hans');
      assert.equal(fake.last.headers['ocp-apim-subscription-key'], 'azure-key-5678');
      assert.equal(fake.last.headers['ocp-apim-subscription-region'], 'eastasia');
      assert.deepEqual(JSON.parse(fake.last.raw), [{ Text: 'Hello' }]);
      await azure.translate({ ...cfg, region: '' }, { text: 'x', source: 'auto', target: 'no' }, o());
      assert.equal(fake.last.headers['ocp-apim-subscription-region'], undefined, 'Global 资源不发区域头');
      assert.equal(fake.last.url, '/translate?api-version=3.0&to=nb');
      assert.equal(await azure.detect(cfg, 'Hola amigo', o()), 'es');
      assert.equal(fake.last.url, '/detect?api-version=3.0');
      assert.equal(azureRoot(''), 'https://api.cognitive.microsofttranslator.com');
      assert.equal(azureRoot('https://myres.cognitiveservices.azure.com/'), 'https://myres.cognitiveservices.azure.com/translator/text/v3.0');
      assert.equal(azureRoot('https://api-eur.cognitive.microsofttranslator.com/'), 'https://api-eur.cognitive.microsofttranslator.com');
    });

    it('错误分类：403001 额度、401 鉴权、400 语言不对、429', async () => {
      fake.on(() => [403, { error: { code: 403001, message: 'The operation is not allowed because the subscription has exceeded its free quota.' } }]);
      await rejectsKind(azure.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o()), 'quota');
      fake.on(() => [401, { error: { code: 401000, message: 'Invalid key azure-key-5678' } }]);
      const err = await rejectsKind(azure.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o()), 'auth');
      assert.ok(!err.message.includes('azure-key-5678'), err.message);
      fake.on(() => [400, { error: { code: 400036, message: 'The target language is not valid.' } }]);
      await rejectsKind(azure.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o()), 'unsupported_language');
      fake.on(() => [429, { error: { code: 429001, message: 'Too many requests' } }]);
      await rejectsKind(azure.detect(cfg, 'x', o()), 'rate_limit');
    });
  });

  describe('谷歌翻译', () => {
    const cfg = { apiKey: 'google-key-abcd' };

    it('翻译：密钥放 x-goog-api-key 头（不在地址里），format=text，希伯来语用 iw；检测：/detect', async () => {
      fake.on((req) =>
        req.url.endsWith('/detect')
          ? [200, { data: { detections: [[{ language: 'iw', isReliable: false, confidence: 1 }]] } }]
          : [200, { data: { translations: [{ translatedText: 'שלום', detectedSourceLanguage: 'zh-CN' }] } }],
      );
      const r = await google.translate(cfg, { text: '你好', source: 'auto', target: 'he' }, o());
      assert.deepEqual(r, { text: 'שלום', detectedSource: 'zh' });
      assert.equal(fake.last.url, '/language/translate/v2');
      assert.equal(fake.last.headers['x-goog-api-key'], 'google-key-abcd');
      assert.deepEqual(JSON.parse(fake.last.raw), { q: ['你好'], target: 'iw', format: 'text' });
      await google.translate(cfg, { text: 'x', source: 'auto', target: 'zh' }, o());
      assert.equal(JSON.parse(fake.last.raw).target, 'zh-CN');
      assert.equal(await google.detect(cfg, 'shalom', o()), 'he');
      assert.equal(fake.last.url, '/language/translate/v2/detect');
      assert.ok(!fake.state.requests.some((q) => q.url.includes('google-key')), '密钥不进地址');
    });

    it('错误分类：Daily Limit 额度、User Rate Limit 限流、API key not valid 鉴权、Invalid Value 语言', async () => {
      fake.on(() => [403, { error: { code: 403, message: 'Daily Limit Exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } }]);
      await rejectsKind(google.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o()), 'quota');
      fake.on(() => [403, { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } }]);
      await rejectsKind(google.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o()), 'rate_limit');
      fake.on(() => [400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]);
      await rejectsKind(google.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o()), 'auth');
      fake.on(() => [400, { error: { code: 400, message: 'Invalid Value', errors: [{ reason: 'invalid' }] } }]);
      await rejectsKind(google.translate(cfg, { text: 'x', source: 'auto', target: 'xx' }, o()), 'unsupported_language');
    });
  });

  describe('腾讯云翻译', () => {
    const cfg = { secretId: 'AKIDtest0001', secretKey: 'tencent-secret-key-9999', region: 'ap-guangzhou' };

    it('请求格式和 TC3 签名头（按收到的 host、请求体、时间戳重算一遍，签名一致）', async () => {
      fake.on(() => [200, { Response: { TargetText: 'Hello', Source: 'zh', Target: 'en', RequestId: 'r1' } }]);
      const r = await tencent.translate(cfg, { text: '你好', source: 'auto', target: 'en' }, o());
      assert.deepEqual(r, { text: 'Hello', detectedSource: 'zh' });
      const req = fake.last;
      assert.equal(req.url, '/');
      assert.equal(req.headers['x-tc-action'], 'TextTranslate');
      assert.equal(req.headers['x-tc-version'], '2018-03-21');
      assert.equal(req.headers['x-tc-region'], 'ap-guangzhou');
      assert.equal(req.headers['content-type'], 'application/json; charset=utf-8');
      assert.deepEqual(JSON.parse(req.raw), { SourceText: '你好', Source: 'auto', Target: 'en', ProjectId: 0 });
      const timestamp = Number(req.headers['x-tc-timestamp']);
      assert.ok(Math.abs(timestamp - Date.now() / 1000) < 60);
      const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
      assert.match(req.headers.authorization, new RegExp(`^TC3-HMAC-SHA256 Credential=AKIDtest0001/${date}/tmt/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$`));
      const expected = tc3Authorization({ secretId: cfg.secretId, secretKey: cfg.secretKey, service: 'tmt', host: req.headers.host, action: 'TextTranslate', payload: req.raw, timestamp });
      assert.equal(req.headers.authorization, expected);
    });

    it('错误（HTTP 200 + Response.Error）：鉴权、额度、限流、语言不支持、接口已下线、没开通', async () => {
      const fail = (Code) => () => [200, { Response: { Error: { Code, Message: `msg AKIDtest0001` }, RequestId: 'r' } }];
      const t = () => tencent.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o());
      fake.on(fail('AuthFailure.SignatureFailure'));
      const err = await rejectsKind(t(), 'auth');
      assert.ok(!err.message.includes('AKIDtest0001'), err.message);
      fake.on(fail('FailedOperation.NoFreeAmount'));
      await rejectsKind(t(), 'quota');
      fake.on(fail('RequestLimitExceeded.UinLimitExceeded'));
      await rejectsKind(t(), 'rate_limit');
      fake.on(fail('UnsupportedOperation.UnSupportedTargetLanguage'));
      await rejectsKind(t(), 'unsupported_language');
      fake.on(fail('ActionOffline'));
      assert.match((await rejectsKind(t(), 'config')).message, /下线/);
      fake.on(fail('FailedOperation.UserNotRegistered'));
      assert.match((await rejectsKind(t(), 'auth')).message, /不再接受/);
    });
  });

  describe('百度翻译', () => {
    const cfg = { appId: '20240001000123', appKey: 'baidu-secret-key-77' };

    it('表单格式、MD5 签名（按收到的 salt 重算）、百度语种代码；多行译文按换行拼回去', async () => {
      fake.on(() => [200, { from: 'zh', to: 'jp', trans_result: [{ src: '你好', dst: 'こんにちは' }, { src: '谢谢', dst: 'ありがとう' }] }]);
      const r = await baidu.translate(cfg, { text: '你好\n谢谢', source: 'auto', target: 'ja' }, o());
      assert.deepEqual(r, { text: 'こんにちは\nありがとう', detectedSource: 'zh' });
      const req = fake.last;
      assert.equal(req.url, '/api/trans/vip/translate');
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      const f = new URLSearchParams(req.raw);
      assert.equal(f.get('q'), '你好\n谢谢');
      assert.equal(f.get('from'), 'auto');
      assert.equal(f.get('to'), 'jp');
      assert.equal(f.get('appid'), cfg.appId);
      assert.match(f.get('salt'), /^\d+$/);
      assert.equal(f.get('sign'), baiduSign(cfg.appId, '你好\n谢谢', f.get('salt'), cfg.appKey));
      assert.ok(!req.raw.includes(cfg.appKey), '密钥本身不发出去');
      for (const [lang, code] of [
        ['ko', 'kor'],
        ['es', 'spa'],
        ['vi', 'vie'],
        ['sl', 'slo'],
        ['ro', 'rom'],
      ]) {
        await baidu.translate(cfg, { text: 'x', source: 'auto', target: lang }, o());
        assert.equal(new URLSearchParams(fake.last.raw).get('to'), code);
      }
      assert.equal(fromBaidu('kor'), 'ko');
      assert.equal(fromBaidu('slo'), 'sl');
      assert.equal(fromBaidu('sk'), 'sk');
      assert.equal(fromBaidu('cht'), 'zh');
      assert.equal(fromBaidu('ro'), null, '百度的 ro 是罗姆语，不能当罗马尼亚语');
    });

    it('个人版不支持的语言（印尼语）不发请求；错误码分类（字符串和数字都认）', async () => {
      fake.on(() => [200, {}]);
      await rejectsKind(baidu.translate(cfg, { text: 'x', source: 'auto', target: 'id' }, o()), 'unsupported_language');
      assert.equal(fake.state.requests.length, 0);
      const fail = (code) => () => [200, { error_code: code, error_msg: `err for ${cfg.appId}` }];
      const t = () => baidu.translate(cfg, { text: 'x', source: 'auto', target: 'en' }, o());
      fake.on(fail('54001'));
      const err = await rejectsKind(t(), 'auth');
      assert.ok(!err.message.includes(cfg.appId), err.message);
      fake.on(fail(52003));
      await rejectsKind(t(), 'auth');
      fake.on(fail('54004'));
      await rejectsKind(t(), 'quota');
      fake.on(fail('54003'));
      await rejectsKind(t(), 'rate_limit');
      fake.on(fail('58001'));
      await rejectsKind(t(), 'unsupported_language');
      fake.on(fail('52002'));
      await rejectsKind(t(), 'server');
    });
  });

  describe('火山翻译', () => {
    const cfg = { accessKeyId: 'AKLTvolctest0001', secretAccessKey: 'volc-secret-access-key==' };

    it('翻译：Action=TranslateText、X-Date、HMAC-SHA256 签名头（按收到的 host、x-date、请求体重算，一致）；检测：LangDetect', async () => {
      fake.on((req) =>
        req.url.includes('Action=LangDetect')
          ? [200, { DetectedLanguageList: [{ Language: 'pt', Confidence: 0.93 }], ResponseMetadata: { Action: 'LangDetect', Error: null } }]
          : [200, { TranslationList: [{ Translation: 'Hola', DetectedSourceLanguage: 'zh' }], ResponseMetadata: { Action: 'TranslateText', Error: null } }],
      );
      const r = await volcengine.translate(cfg, { text: '你好', source: 'auto', target: 'es' }, o());
      assert.deepEqual(r, { text: 'Hola', detectedSource: 'zh' });
      const req = fake.last;
      assert.equal(req.url, '/?Action=TranslateText&Version=2020-06-01');
      assert.deepEqual(JSON.parse(req.raw), { TargetLanguage: 'es', TextList: ['你好'] });
      const xDate = req.headers['x-date'];
      assert.match(xDate, /^\d{8}T\d{6}Z$/);
      const { authorization } = volcSign({
        ...cfg,
        region: 'cn-north-1',
        service: 'translate',
        method: 'POST',
        query: { Action: 'TranslateText', Version: '2020-06-01' },
        signedHeaders: [
          ['host', req.headers.host],
          ['x-date', xDate],
        ],
        body: req.raw,
        xDate,
      });
      assert.equal(req.headers.authorization, authorization);
      assert.match(authorization, new RegExp(`^HMAC-SHA256 Credential=AKLTvolctest0001/${xDate.slice(0, 8)}/cn-north-1/translate/request, SignedHeaders=host;x-date, Signature=[0-9a-f]{64}$`));
      assert.equal(await volcengine.detect(cfg, 'Olá, tudo bem?', o()), 'pt');
      assert.equal(fake.last.url, '/?Action=LangDetect&Version=2020-06-01');
      assert.deepEqual(JSON.parse(fake.last.raw), { TextList: ['Olá, tudo bem?'] });
    });

    it('错误在 ResponseMetadata.Error：-415 语向不支持、签名不对、限流', async () => {
      const t = () => volcengine.translate(cfg, { text: 'x', source: 'auto', target: 'es' }, o());
      fake.on(() => [200, { ResponseMetadata: { Error: { Code: '-415', Message: 'unsupported language pair' } } }]);
      await rejectsKind(t(), 'unsupported_language');
      fake.on(() => [401, { ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', CodeN: 100010, Message: 'bad sig for AKLTvolctest0001' } } }]);
      const err = await rejectsKind(t(), 'auth');
      assert.ok(!err.message.includes('AKLTvolctest0001'), err.message);
      fake.on(() => [429, { ResponseMetadata: { Error: { Code: 'FlowLimitExceeded', CodeN: 100018, Message: 'flow limit' } } }]);
      await rejectsKind(t(), 'rate_limit');
      fake.on(() => [200, { ResponseMetadata: { Error: { Code: '-429', Message: 'too many' } } }]);
      await rejectsKind(t(), 'rate_limit');
    });
  });

  describe('LibreTranslate', () => {
    it('翻译：/translate（填的地址带 /translate 也行），简体中文 zh-Hans，api_key 在请求体；检测：/detect', async () => {
      fake.on((req) =>
        req.url === '/detect'
          ? [200, [{ confidence: 90, language: 'pt' }]]
          : [200, { translatedText: '你好', detectedLanguage: { confidence: 90, language: 'en' } }],
      );
      const cfg = { url: `${fake.url}/translate`, apiKey: 'libre-key-42' };
      const r = await libretranslate.translate(cfg, { text: 'Hello', source: 'auto', target: 'zh' }, { timeoutMs: 2000 });
      assert.deepEqual(r, { text: '你好', detectedSource: 'en' });
      assert.equal(fake.last.url, '/translate');
      assert.deepEqual(JSON.parse(fake.last.raw), { q: 'Hello', source: 'auto', target: 'zh-Hans', format: 'text', api_key: 'libre-key-42' });
      assert.equal(await libretranslate.detect(cfg, 'Olá', { timeoutMs: 2000 }), 'pt');
      assert.equal(fake.last.url, '/detect');
      assert.equal(libreRoot('http://h:5000/'), 'http://h:5000');
    });

    it('错误分类：400 不支持、403 密钥不对、429 限流', async () => {
      const cfg = { url: fake.url, apiKey: 'libre-key-42' };
      const t = () => libretranslate.translate(cfg, { text: 'x', source: 'auto', target: 'xx' }, { timeoutMs: 2000 });
      fake.on(() => [400, { error: 'xx is not supported' }]);
      await rejectsKind(t(), 'unsupported_language');
      fake.on(() => [403, { error: 'Invalid API key libre-key-42' }]);
      const err = await rejectsKind(t(), 'auth');
      assert.ok(!err.message.includes('libre-key-42'), err.message);
      fake.on(() => [429, { error: 'Slowdown: 10 per 1 minute' }]);
      await rejectsKind(t(), 'rate_limit');
    });
  });
});
