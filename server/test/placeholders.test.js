// 推荐回复和转人工草稿里外文的【待你确认：…】：起草后认得出的外文标签换回「待你确认」，括号里是外文的一次译成中文再放回去。
// 占位都是中文的不调；翻译出错、超时、行数对不上时草稿照原样；翻译调用记 llm_calls 的 translate，不计入会话每日模型次数。
// 翻译方式按「设置 → 翻译」：AI 翻译用 mock（aiHooks 记下参数），翻译 API 用本地假 DeepL。
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  foreignPlaceholderContents,
  isForeignContent,
  normalizePlaceholderLabels,
  replacePlaceholderContents,
} from '../src/reply/placeholders.js';
import { buildDraftSystemPrompt } from '../src/reply/prompts.js';
import { aiHooks, convIdOf, convPath, getConv, startApp, startFakeWaha, waitDecided, waitFor, wahaSend } from './helpers.js';

const BOSS = '8613900000000';
const BOSS_CHAT = `${BOSS}@c.us`;
let seq = 0;
const newChat = () => `86134${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;
const DEEPL_KEY = 'deepl-secret-0003:fx';
/** 测试里占位转中文最多等多久 */
const FIX_TIMEOUT_MS = 300;

/** 起草（suggest / draft）mock 的返回：只有正文 */
const drafted = (text) => () => ({ text, fileIds: [], entryIds: [] });

describe('【待你确认：…】：判断和替换（不调接口）', () => {
  it('外文标签换回「待你确认」：只认全角【】里认得的说法，大小写、重音符号不论；只有标签的换成【待你确认】', () => {
    const cases = [
      ['La fecha es 【Por confirmar: fecha de envío】.', 'La fecha es 【待你确认：fecha de envío】.'],
      ['Price: 【To confirm】', 'Price: 【待你确认】'],
      ['【TO BE CONFIRMED：price】', '【待你确认：price】'],
      ['Date : 【À confirmer : date de livraison】', 'Date : 【待你确认：date de livraison】'],
      ['【Zu bestätigen: Lieferdatum】', '【待你确认：Lieferdatum】'],
      ['【확인 필요: 배송일】', '【待你确认：배송일】'],
      ['【待你確認：出貨日期】', '【待你确认：出貨日期】'],
    ];
    for (const [input, want] of cases) assert.equal(normalizePlaceholderLabels(input), want, input);
    for (const same of ['【待你确认：单价】', '【Nota: algo】', '[To confirm: date]', '【Confirmed: yes】', 'no brackets']) {
      assert.equal(normalizePlaceholderLabels(same), same, `不动：${same}`);
    }
  });

  it('括号里是外文才要翻译：没有汉字、有外文词，或者有日文假名；只有数字、型号、符号的不算；去重', () => {
    assert.equal(isForeignContent('fecha de envío'), true);
    assert.equal(isForeignContent('MOQ'), true);
    assert.equal(isForeignContent('出荷日を確認'), true, '日文假名');
    assert.equal(isForeignContent('배송일'), true);
    for (const no of ['单价', 'A100 的单价', 'A100', '500', '$', 'B2-300', '']) assert.equal(isForeignContent(no), false, no);
    const text = '【待你确认：单价】【待你确认：A100】【待你确认：shipping date】【待你确认: shipping date】【待你确认】【待你确认：出荷日を確認】';
    assert.deepEqual(foreignPlaceholderContents(text), ['shipping date', '出荷日を確認']);
    assert.equal(
      replacePlaceholderContents(text, new Map([['shipping date', '发货日期']])),
      '【待你确认：单价】【待你确认：A100】【待你确认：发货日期】【待你确认：发货日期】【待你确认】【待你确认：出荷日を確認】',
      '两种冒号的同一处都换掉，没给译文的不动',
    );
  });

  it('提示词：占位固定用中文，「待你确认」不翻译，带一个外文草稿里写中文占位的例子', () => {
    const sys = buildDraftSystemPrompt({ profile: {}, persona: '', entries: [] });
    const rule3 = sys.split('\n').find((l) => l.startsWith('3. '));
    assert.match(rule3, /占位符固定用中文，草稿其余部分用客户的语言：「待你确认」四个字和全角括号、冒号照原样写，不翻译；括号里要确认的内容也只写中文，不写客户的语言/);
    assert.match(rule3, /"La fecha de envío de este pedido es 【待你确认：这单的发货日期】\."，不要写成【待你确认：fecha de envío】或【Por confirmar: fecha de envío】/);
  });
});

describe('【待你确认：…】：起草后译成中文（AI 翻译，mock）', () => {
  let t;
  let fake;
  let hooks;
  let manualAcc;
  let autoAcc;
  const warns = [];
  const log = { info() {}, error() {}, warn: (m) => warns.push(String(m)) };
  const manual = (convId) => t.req('POST', `${convPath(convId)}/suggest`);
  const convLlmCalls = (convId) => t.ctx.db.prepare('SELECT llm_calls FROM conversations WHERE id = ?').get(convId).llm_calls;
  const translateRows = (convId) =>
    t.ctx.db.prepare("SELECT purpose, ok, account_id FROM llm_calls WHERE conversation_id = ? AND purpose = 'translate' ORDER BY ts").all(convId);
  const notices = () => fake.sentTo(BOSS_CHAT).map((m) => m.text).filter((x) => x.startsWith('[待人工]'));
  /** 客户发一句，等处理完，返回会话 id */
  async function says(acc, chat, text, n = 1) {
    assert.equal((await wahaSend(t, acc, chat, text)).status, 200);
    const convId = convIdOf(acc, chat);
    await waitDecided(t, convId, n);
    await waitFor(() => t.ctx.wa.idle());
    return convId;
  }

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: fake.url },
      options: { aiOverrides: hooks.overrides, placeholderFixTimeoutMs: FIX_TIMEOUT_MS, log },
    });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    manualAcc = await t.createAccount({ name: '占位人工号' });
    autoAcc = await t.createAccount({ name: '占位自动号', replyMode: 'auto', notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    for (const a of [manualAcc, autoAcc]) await t.req('POST', `/api/accounts/${a.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });
  const reset = () => {
    hooks.suggest = null;
    hooks.draft = null;
    hooks.translateToChinese = null;
    warns.length = 0;
  };

  it('占位都是中文（或者只有型号、数字）：不调翻译，原样存下', async () => {
    reset();
    const text = 'The price of A100 is 【待你确认：单价】 per piece, model 【待你确认：A100】, 【待你确认：500】 pcs.';
    hooks.suggest = drafted(text);
    const convId = await says(manualAcc, newChat(), 'How much is A100?');
    const before = hooks.calls.translateToChinese;
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.draft.text, text);
    assert.equal(hooks.calls.translateToChinese, before, '没有多调');
    assert.deepEqual(translateRows(convId), []);
    assert.equal(convLlmCalls(convId), 1, '只有起草那一次');
  });

  it('括号里是外文：调一次翻译（只发括号里的字），译成中文放回原处；记 translate，不计入会话每日模型次数', async () => {
    reset();
    hooks.suggest = drafted('Sí, podemos. La fecha de envío de este pedido es 【待你确认：fecha de envío】. ¡Gracias!');
    const convId = await says(manualAcc, newChat(), 'Hola, ¿cuándo pueden enviar?');
    const before = hooks.calls.translateToChinese;
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const want = 'Sí, podemos. La fecha de envío de este pedido es 【待你确认：[译成中文] fecha de envío】. ¡Gracias!';
    assert.equal(r.body.draft.text, want);
    assert.equal(hooks.calls.translateToChinese, before + 1);
    assert.deepEqual(hooks.args.translateToChinese, { text: 'fecha de envío' }, '只发括号里的字');
    assert.equal((await getConv(t, convId)).draft.text, want, '存下的是改好的');
    assert.deepEqual(translateRows(convId), [{ purpose: 'translate', ok: 1, account_id: manualAcc.id }]);
    assert.equal(convLlmCalls(convId), 1, '翻译不计入会话每日模型次数');
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) n FROM llm_calls WHERE conversation_id = ? AND purpose = 'suggest'").get(convId).n, 1);
  });

  it('几处混在一起：中文的不动；外文的（含翻译了的标签、重复的）一次译完各回各位；某一处译出来没有汉字的照原样', async () => {
    reset();
    hooks.suggest = drafted(
      'Unit price 【待你确认：单价】, ship on 【待你确认：shipping date】, MOQ 【Por confirmar: cantidad mínima】, ' +
        'payment 【To confirm: payment terms】, again 【待你确认: shipping date】, model 【待你确认：A100】.',
    );
    hooks.translateToChinese = ({ text }) => {
      assert.equal(text, 'shipping date\ncantidad mínima\npayment terms', '每处一行、去重，标签换回后一起发');
      return { translation: '发货日期\n最小起订量\npayment terms' };
    };
    const convId = await says(manualAcc, newChat(), 'Can you ship next week?');
    const before = hooks.calls.translateToChinese;
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(hooks.calls.translateToChinese, before + 1, '只调一次');
    assert.equal(
      r.body.draft.text,
      'Unit price 【待你确认：单价】, ship on 【待你确认：发货日期】, MOQ 【待你确认：最小起订量】, ' +
        'payment 【待你确认：payment terms】, again 【待你确认：发货日期】, model 【待你确认：A100】.',
    );
  });

  it('翻译出错：草稿照原样返回、照样存下，记一条 warn 和一行失败的 translate', async () => {
    reset();
    const text = 'We can ship on 【待你确认：shipping date】.';
    hooks.suggest = drafted(text);
    hooks.translateToChinese = () => {
      throw new Error('模型挂了');
    };
    const convId = await says(manualAcc, newChat(), 'When can you ship?');
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.draft.text, text);
    assert.equal((await getConv(t, convId)).draft.text, text);
    assert.ok(warns.some((w) => w.includes('【待你确认】是外文') && w.includes('模型挂了')), warns.join('\n'));
    assert.deepEqual(translateRows(convId), [{ purpose: 'translate', ok: 0, account_id: manualAcc.id }]);
    assert.equal(convLlmCalls(convId), 1);
  });

  it('翻译超时：不等了，草稿照原样马上返回；外文标签照样换回', async () => {
    reset();
    hooks.suggest = drafted('We can ship on 【To confirm: shipping date】.');
    hooks.translateToChinese = () => new Promise((resolve) => setTimeout(() => resolve({ translation: '发货日期' }), FIX_TIMEOUT_MS * 5));
    const convId = await says(manualAcc, newChat(), 'When can you ship?');
    const started = Date.now();
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Date.now() - started < FIX_TIMEOUT_MS * 4, `最多多等 ${FIX_TIMEOUT_MS}ms`);
    assert.equal(r.body.draft.text, 'We can ship on 【待你确认：shipping date】.', '标签换回不用调接口');
    assert.ok(warns.some((w) => w.includes('未返回')), warns.join('\n'));
  });

  it('译文行数对不上：当失败，草稿照原样', async () => {
    reset();
    const text = 'Price 【待你确认：unit price】, ship 【待你确认：shipping date】.';
    hooks.suggest = drafted(text);
    hooks.translateToChinese = () => ({ translation: '单价和发货日期' });
    const convId = await says(manualAcc, newChat(), 'Price and date?');
    const r = await manual(convId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.draft.text, text);
    assert.ok(warns.some((w) => w.includes('行数不一致')), warns.join('\n'));
  });

  it('「换一条」和跟进也改：上一条推荐带的是改好的；跟进起草后同样译成中文', async () => {
    reset();
    hooks.suggest = (args, mock) => ({ text: `${args.previous ? 'Otra vez: ' : ''}Enviamos el 【待你确认：fecha de envío】.`, fileIds: [], entryIds: [] });
    const chat = newChat();
    const convId = await says(manualAcc, chat, 'Hola, ¿cuándo envían?');
    const first = await manual(convId);
    assert.equal(first.body.draft.text, 'Enviamos el 【待你确认：[译成中文] fecha de envío】.');
    const again = await manual(convId);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(hooks.args.suggest.previous, first.body.draft.text, '换一条：上一条是改好的那份');
    assert.equal(again.body.draft.text, 'Otra vez: Enviamos el 【待你确认：[译成中文] fecha de envío】.');

    assert.equal((await t.req('POST', `${convPath(convId)}/send`, { body: { text: 'Le confirmo la fecha mañana.' } })).status, 200);
    const follow = await manual(convId);
    assert.equal(follow.status, 200, JSON.stringify(follow.body));
    assert.equal(hooks.args.suggest.followUp, true, '我方说的是最后一条：跟进');
    assert.equal(follow.body.draft.text, 'Enviamos el 【待你确认：[译成中文] fecha de envío】.');
  });

  it('转人工草稿：存下之前改好，通知里带的也是改好的', async () => {
    reset();
    hooks.draft = drafted('Hello! A colleague will help you. Delivery date: 【To confirm: delivery date】.');
    const before = notices().length;
    const convId = await says(autoAcc, newChat(), 'I want to talk to a human');
    const conv = await getConv(t, convId);
    assert.equal(conv.needsHuman, true);
    assert.equal(conv.draft.kind, 'handoff');
    assert.equal(conv.draft.text, 'Hello! A colleague will help you. Delivery date: 【待你确认：[译成中文] delivery date】.');
    await waitFor(() => notices().length === before + 1);
    assert.ok(notices().at(-1).includes(conv.draft.text), notices().at(-1));
    assert.deepEqual(translateRows(convId), [{ purpose: 'translate', ok: 1, account_id: autoAcc.id }]);
    assert.equal(convLlmCalls(convId), 2, '生成 1 次 + 草稿 1 次，翻译不算');
  });
});

/** 本地假 DeepL：记下请求，译成中文时每一行前面加「（中文）」，detected_source_language 是 EN */
async function startFakeDeepl() {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    state.requests.push({ url: req.url, body });
    const text = String(body.text?.[0] ?? '')
      .split('\n')
      .map((l) => `（中文）${l}`)
      .join('\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ translations: [{ detected_source_language: 'EN', text }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

describe('【待你确认：…】：翻译方式选了翻译 API', () => {
  let t;
  let waha;
  let deepl;
  let hooks;
  let acc;

  before(async () => {
    waha = await startFakeWaha();
    deepl = await startFakeDeepl();
    hooks = await aiHooks();
    t = await startApp({
      env: { INKDOVE_WAHA_URL: waha.url },
      options: { aiOverrides: hooks.overrides, translateEndpoints: { deepl: deepl.url }, translateTimeoutMs: 300, placeholderFixTimeoutMs: FIX_TIMEOUT_MS },
    });
    await t.login();
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    const r = await t.req('PUT', '/api/settings', {
      body: { translation: { mode: 'api', provider: 'deepl', fallbackToAi: false, providers: { deepl: { apiKey: DEEPL_KEY } } } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    acc = await t.createAccount({ name: '占位翻译 API 号' });
    await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await waha.close();
    await deepl.close();
  });

  it('用选的翻译服务译一次（每处一行），不调模型；调用记 translate、format 是服务的 id', async () => {
    hooks.suggest = drafted('Ship on 【待你确认：shipping date】, pay by 【待你确认：payment terms】.');
    const chat = newChat();
    assert.equal((await wahaSend(t, acc, chat, 'When and how?')).status, 200);
    const convId = convIdOf(acc, chat);
    await waitDecided(t, convId, 1);
    await waitFor(() => t.ctx.wa.idle());
    const before = hooks.calls.translateToChinese;
    const r = await t.req('POST', `${convPath(convId)}/suggest`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.draft.text, 'Ship on 【待你确认：（中文）shipping date】, pay by 【待你确认：（中文）payment terms】.');
    assert.deepEqual(
      deepl.state.requests.map((q) => q.body),
      [{ text: ['shipping date\npayment terms'], target_lang: 'ZH-HANS' }],
    );
    assert.equal(hooks.calls.translateToChinese, before, '不用模型');
    const rows = t.ctx.db.prepare("SELECT purpose, format, ok FROM llm_calls WHERE conversation_id = ? AND purpose = 'translate'").all(convId);
    assert.deepEqual(rows, [{ purpose: 'translate', format: 'deepl', ok: 1 }]);
  });
});
