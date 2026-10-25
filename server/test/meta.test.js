import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { convIdOf, convPath, getConv, getMessages, sleep, startApp, waitDecided, waitFor } from './helpers.js';

const APP_SECRET = 'meta-app-secret';
const TOKEN = 'EAAG-test-token';
const PNID = '106540352242922';

/** 假 Graph API：记录请求；发消息返回 wamid.SENT<n> */
async function startFakeGraph() {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    state.requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.SENT${state.requests.length}` }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    /** 发出去的文本消息（不含标已读） */
    texts: (to) => state.requests.filter((r) => r.body?.type === 'text' && (!to || r.body.to === to)),
    reads: () => state.requests.filter((r) => r.body?.status === 'read'),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

let seq = 0;
function metaPayload(from, text, { name = '客户', id, context, pnid = PNID } = {}) {
  seq++;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: pnid },
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [
                {
                  from,
                  id: id || `wamid.IN${seq}${Date.now()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                  ...(context ? { context } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function postMeta(t, acc, payload, { signature, secret } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature ?? sign(raw, secret);
  return t.req('POST', `/webhooks/meta/${acc.id}`, { body: raw, headers, auth: false });
}

describe('Meta Cloud API 号', () => {
  let t;
  let graph;
  let acc;
  const cid = (n) => convIdOf(acc, n);
  before(async () => {
    graph = await startFakeGraph();
    t = await startApp({ env: { INKDOVE_META_GRAPH_URL: graph.url } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    acc = await t.createAccount({ name: 'Meta 号', channel: 'meta' });
  });
  after(async () => {
    await t.close();
    await graph.close();
  });

  it('未配置 app secret 时拒绝 POST（403）；没有 verifyToken 时 GET 校验 403；未知号或 WAHA 号 404', async () => {
    assert.equal(acc.status.state, 'not_configured');
    const r = await postMeta(t, acc, metaPayload('8613700000001', '你好'));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'meta_not_configured');
    const g = await t.req('GET', `/webhooks/meta/${acc.id}?hub.mode=subscribe&hub.verify_token=&hub.challenge=123`, { auth: false });
    assert.equal(g.status, 403);
    assert.equal((await t.req('GET', '/webhooks/meta/nope?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1', { auth: false })).status, 404);
    const waha = await t.createAccount({ name: 'WAHA 号' });
    assert.equal((await postMeta(t, waha, metaPayload('8613700000001', '你好'))).status, 404);
    assert.equal((await t.req('POST', '/webhooks/meta', { body: '{}', auth: false })).status, 404, '第一期的公共回调地址已移除');
    await t.req('DELETE', `/api/accounts/${waha.id}`);
  });

  it('配置后：state=configured，webhookUrl 是这个号自己的；GET 校验成功原样返回 challenge，token 不对 403', async () => {
    const s = await t.req('PUT', `/api/accounts/${acc.id}`, {
      body: {
        autoReply: true,
        blocklist: ['8613700000099'],
        meta: { phoneNumberId: PNID, verifyToken: 'my-verify', accessToken: TOKEN, appSecret: APP_SECRET },
      },
    });
    assert.equal(s.status, 200);
    assert.equal(s.body.meta.webhookUrl, `https://kb.example.com/webhooks/meta/${acc.id}`);
    assert.equal(s.body.meta.accessTokenSet, true);
    assert.equal(s.body.meta.appSecretSet, true);
    assert.equal(s.body.waha, null);
    const st = await t.req('GET', `/api/accounts/${acc.id}`);
    assert.equal(st.body.status.state, 'configured');
    const ok = await t.req('GET', `/webhooks/meta/${acc.id}?hub.mode=subscribe&hub.verify_token=my-verify&hub.challenge=1158201444`, { auth: false });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '1158201444');
    const bad = await t.req('GET', `/webhooks/meta/${acc.id}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`, { auth: false });
    assert.equal(bad.status, 403);
    const badMode = await t.req('GET', `/webhooks/meta/${acc.id}?hub.mode=unsubscribe&hub.verify_token=my-verify&hub.challenge=1`, { auth: false });
    assert.equal(badMode.status, 403);
    // Meta 号不能改 WAHA 代理；通道不能改
    assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: true } } } })).status, 400);
    assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { channel: 'waha' } })).status, 400);
  });

  it('X-Hub-Signature-256 错误或缺失返回 401，不处理', async () => {
    const p = metaPayload('8613700000002', '保温杯多少钱');
    assert.equal((await postMeta(t, acc, p, { secret: 'wrong-secret' })).status, 401);
    assert.equal((await postMeta(t, acc, p, { signature: null })).status, 401);
    await sleep(150);
    assert.equal(await getConv(t, cid('8613700000002')), null);
  });

  it('replied：先标已读并显示正在输入（同一请求带 typing_indicator），再经 Graph API 回复', async () => {
    const n = graph.state.requests.length;
    const inId = `wamid.IN-reply-${Date.now()}`;
    const r = await postMeta(t, acc, metaPayload('8613700000003', '保温杯多少钱', { name: '张三', id: inId }));
    assert.equal(r.status, 200);
    const msgs = await waitDecided(t, cid('8613700000003'), 1);
    assert.equal(msgs[0].botDecision, 'replied');
    await waitFor(() => graph.texts('8613700000003').length >= 1);
    const reqs = graph.state.requests.slice(n);
    const read = reqs.find((q) => q.body?.status === 'read');
    assert.deepEqual(read.body, { messaging_product: 'whatsapp', status: 'read', message_id: inId, typing_indicator: { type: 'text' } });
    assert.ok(reqs.indexOf(read) < reqs.findIndex((q) => q.body?.type === 'text'), '先标已读再发');
    const req = graph.texts('8613700000003').at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.path, `/v26.0/${PNID}/messages`);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.body.messaging_product, 'whatsapp');
    assert.equal(req.body.recipient_type, 'individual');
    assert.equal(req.body.to, '8613700000003');
    assert.match(req.body.text.body, /59 元/);
    const conv = await getConv(t, cid('8613700000003'));
    assert.equal(conv.contactName, '张三');
    assert.equal(conv.contactNumber, '8613700000003');
    assert.equal(conv.accountId, acc.id);
    const out = (await getMessages(t, cid('8613700000003'))).find((m) => m.direction === 'out');
    assert.equal(out.status, 'sent');
  });

  it('转人工、离题：不标已读、不显示正在输入（F1）', async () => {
    const n = graph.reads().length;
    await postMeta(t, acc, metaPayload('8613700000005', '我要找人工'));
    await postMeta(t, acc, metaPayload('8613700000006', '帮我写代码'));
    await waitDecided(t, cid('8613700000005'), 1);
    await waitDecided(t, cid('8613700000006'), 1);
    await sleep(150);
    assert.equal(graph.reads().length, n);
    assert.equal(graph.texts('8613700000005').length + graph.texts('8613700000006').length, 0);
  });

  it('人工从后台发送：不等待、不标已读', async () => {
    const n = graph.reads().length;
    const r = await t.req('POST', `${convPath(cid('8613700000005'))}/send`, { body: { text: '您好，我是店长' } });
    assert.equal(r.body.status, 'sent');
    assert.equal(graph.reads().length, n);
    assert.equal(graph.texts('8613700000005').at(-1).body.text.body, '您好，我是店长');
  });

  it('黑名单号码不存档、不回复；apiVersion 改了就用新版本', async () => {
    const n = graph.texts().length;
    await postMeta(t, acc, metaPayload('8613700000099', '保温杯多少钱'));
    await sleep(200);
    assert.equal(await getConv(t, cid('8613700000099')), null);
    assert.equal(graph.texts().length, n);
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { meta: { apiVersion: 'v25.0' } } });
    await postMeta(t, acc, metaPayload('8613700000004', '保温杯多少钱'));
    await waitFor(() => graph.texts().length === n + 1);
    assert.equal(graph.texts().at(-1).path, `/v25.0/${PNID}/messages`);
  });

  it('两个 Meta 号各用自己的 app secret 校验，消息分到各自的号', async () => {
    const acc2 = await t.createAccount({
      name: 'Meta 二号',
      channel: 'meta',
      autoReply: true,
      meta: { phoneNumberId: '2222', verifyToken: 'v2', accessToken: 'EAAG-second', appSecret: 'second-secret' },
    });
    const p = metaPayload('8613700000007', '保温杯多少钱', { pnid: '2222' });
    assert.equal((await postMeta(t, acc2, p)).status, 401, '用一号的 secret 签名不行');
    // phone_number_id 对不上的消息忽略
    await postMeta(t, acc2, metaPayload('8613700000017', '保温杯多少钱'), { secret: 'second-secret' });
    assert.equal((await postMeta(t, acc2, p, { secret: 'second-secret' })).status, 200);
    await waitDecided(t, convIdOf(acc2, '8613700000007'), 1);
    assert.equal(await getConv(t, cid('8613700000007')), null);
    assert.equal(await getConv(t, convIdOf(acc2, '8613700000017')), null);
    await waitFor(() => graph.texts('8613700000007').length === 1);
    const req = graph.texts('8613700000007')[0];
    assert.equal(req.path, `/v26.0/2222/messages`);
    assert.equal(req.headers.authorization, 'Bearer EAAG-second');
  });

  it('F3：通知号码引用通知回复，内容转发给客户（引用 id 来自 context.id）', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { notify: { whatsapp: { enabled: true, number: '+86 139 0000 1111' } } } });
    await postMeta(t, acc, metaPayload('8613700000008', '我要找人工', { name: '李四' }));
    await waitDecided(t, cid('8613700000008'), 1);
    const notice = await waitFor(() => graph.texts('8613900001111').at(-1));
    assert.match(notice.body.text.body, /李四/);
    assert.match(notice.body.text.body, /引用本消息回复/);
    const noticeId = `wamid.SENT${graph.state.requests.indexOf(notice) + 1}`;
    await postMeta(t, acc, metaPayload('8613900001111', '您好，我是店长小王', { context: { from: '15550000000', id: noticeId } }));
    await waitFor(() => graph.texts('8613700000008').length === 1);
    assert.equal(graph.texts('8613700000008')[0].body.text.body, '您好，我是店长小王');
    await waitFor(() => graph.texts('8613900001111').some((q) => q.body.text.body === '✅ 已发送给 李四'));
    const out = (await getMessages(t, cid('8613700000008'))).filter((m) => m.direction === 'out');
    assert.equal(out.at(-1).via, 'whatsapp');
    assert.equal(out.at(-1).author, 'operator');
    assert.equal(await getConv(t, convIdOf(acc, '8613900001111')), null, '通知号码的命令不进会话列表');
  });

  it('密钥不出现在号接口、设置接口和日志里', async () => {
    const all = JSON.stringify((await t.req('GET', '/api/accounts')).body) + JSON.stringify((await t.req('GET', '/api/settings')).body);
    assert.ok(!all.includes(TOKEN) && !all.includes(APP_SECRET) && !all.includes('second-secret'));
    assert.ok(!t.log.lines.some((l) => l.includes(TOKEN) || l.includes(APP_SECRET)));
  });
});
