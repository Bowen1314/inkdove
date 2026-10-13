import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent as NpmUndiciAgent } from 'undici';
import { parseAccountsExport } from '../src/accounts.js';
import { builtinDispatcher } from '../src/builtin-fetch.js';
import { smtpOptions } from '../src/email.js';
import { checkBypassList } from '../src/proxy/bypass.js';
import { ClashFormatError, NOT_CLASH_HINT, parseClashConfig } from '../src/proxy/clash.js';
import { alwaysDirect, createDirectMatcher } from '../src/proxy/direct.js';
import { MIHOMO_MISSING } from '../src/proxy/index.js';
import { buildMihomoConfig, freePort, nodeSecrets } from '../src/proxy/mihomo.js';
import { createConnectionFor, disableRouting, enableRouting, proxiedDispatcher, smtpProxyFor } from '../src/proxy/route.js';
import { fetchSubscription, SubscriptionError } from '../src/proxy/subscription.js';
import { applySettingsPatch, loadSettings } from '../src/settings.js';
import { fetchSite } from '../src/sources/fetch-url.js';
import { httpGet } from '../src/wa/media-download.js';
import { startApp, startFakeWaha, waitFor } from './helpers.js';

// 全局代理（设置 → 代理）：设置校验和密钥不回传、订阅解析、生成的 mihomo 配置、进程管理（假 mihomo）、
// 全局 fetch 和 node:http 经代理 / 直连、SSRF 防护照旧、号「用全局代理」。不连任何外网，机场节点都是假的。

const here = path.dirname(fileURLToPath(import.meta.url));
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

/** 订阅地址里的 token（假的）：接口、日志、错误信息里都不能出现 */
const TOKEN = `subtoken${crypto.randomBytes(6).toString('hex')}`;

const NODES_YAML = `
mixed-port: 7890
proxies:
  - name: 香港 01
    type: ss
    server: hk1.node.example.test
    port: 8388
    cipher: aes-128-gcm
    password: "fake-ss-password-1"
  - name: Japan 02
    type: vmess
    server: jp2.node.example.test
    port: 443
    uuid: 00000000-0000-4000-8000-000000000002
    alterId: 0
    cipher: auto
    tls: true
  - name: US 03
    type: Trojan
    server: us3.node.example.test
    port: "443"
    password: 0123456
    sni: us3.node.example.test
  - name: 直连
    type: direct
  - name: SG 04
    type: hysteria2
    server: sg4.node.example.test
    port: 8443
    password: fake-hy2-password-4
proxy-groups:
  - name: 节点选择
    type: select
    proxies: [香港 01, Japan 02]
rules:
  - MATCH,节点选择
`;
const NODE_NAMES = ['香港 01', 'Japan 02', 'US 03', 'SG 04'];
const SECRETS = ['fake-ss-password-1', '00000000-0000-4000-8000-000000000002', 'fake-hy2-password-4', 'hk1.node.example.test'];
/** 订阅更新后少了 Japan 02 */
const NODES_YAML_2 = NODES_YAML.replace(/  - name: Japan 02[\s\S]*?tls: true\n/, '');
const LINK_LIST = Buffer.from('ss://YWVzLTEyOC1nY206ZmFrZQ@hk.node.example.test:8388#HK\nvmess://e30=\n').toString('base64');

/** 起一个本机 HTTP 服务 */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/** 进程还在不在 */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('不走代理的地址', () => {
  it('校验：域名、*.域名、IP、网段，规范化去重；不认识的行报第几行', () => {
    assert.deepEqual(checkBypassList('Example.COM\n\n*.corp.example.com\n10.1.0.0/16\n 2001:db8::1 \nexample.com'), [
      'example.com',
      '*.corp.example.com',
      '10.1.0.0/16',
      '2001:db8::1',
    ]);
    assert.throws(() => checkBypassList(['ok.example.com', 'bad host']), /proxy\.bypass 第 2 行/);
    assert.throws(() => checkBypassList(['10.0.0.0/33']), /proxy\.bypass 第 1 行/);
    assert.throws(() => checkBypassList('x'.repeat(10) && 5), /proxy\.bypass 必须是数组/);
  });

  it('永远直连：本机、内网、不带点的主机名、保留后缀；公网地址走代理', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '10.2.3.4', '192.168.1.1', '172.20.0.5', '169.254.1.1', 'fd00::1', 'waha', 'inkdove', 'host.docker.internal', 'printer.local', 'a.localhost']) {
      assert.equal(alwaysDirect(h), true, h);
    }
    for (const h of ['api.openai.com', '8.8.8.8', '2606:4700::1111', 'example.com']) assert.equal(alwaysDirect(h), false, h);
  });

  it('管理员的规则和内部服务的主机名直连，其余走代理', () => {
    const direct = createDirectMatcher({
      // 文档用的 IP 段（203.0.113.0/24 等）本来就是保留地址、总是直连，这里用公网地址
      rules: ['example.com', '*.corp.example.net', '93.184.216.0/24', '1.0.0.1'],
      internalHosts: ['waha.internal.example.org'],
    });
    assert.equal(direct('example.com'), true);
    assert.equal(direct('www.example.com'), false); // 只匹配它自己
    assert.equal(direct('corp.example.net'), true);
    assert.equal(direct('a.b.corp.example.net'), true);
    assert.equal(direct('xcorp.example.net'), false);
    assert.equal(direct('93.184.216.34'), true);
    assert.equal(direct('93.184.217.1'), false);
    assert.equal(direct('1.0.0.1'), true);
    assert.equal(direct('1.0.0.2'), false);
    assert.equal(direct('WAHA.internal.example.org.'), true);
    assert.equal(direct('api.deepl.com'), false);
  });
});

describe('Clash 配置解析', () => {
  it('取出支持的节点：类型转小写、去掉 direct、端口可以是字符串、看着像数字的密码按原文', () => {
    const { proxies, skipped } = parseClashConfig(NODES_YAML);
    assert.deepEqual(
      proxies.map((p) => p.name),
      NODE_NAMES,
    );
    assert.equal(skipped, 1);
    const us = proxies.find((p) => p.name === 'US 03');
    assert.equal(us.type, 'trojan');
    assert.equal(us.password, '0123456');
  });

  it('不是 Clash：节点链接列表（base64 或明文）、解析不了、没有 proxies；信息里不带内容', () => {
    for (const text of [LINK_LIST, 'trojan://fake@us.node.example.test:443#US', 'just: [broken', 'port: 7890\n', '   ']) {
      assert.throws(
        () => parseClashConfig(text),
        (err) => err instanceof ClashFormatError && !err.message.includes('node.example.test'),
      );
    }
    assert.throws(() => parseClashConfig(LINK_LIST), (err) => err.notClash && /节点链接列表/.test(err.message));
    assert.throws(() => parseClashConfig('proxies:\n  - {name: a, type: direct}\n'), /没有能用的节点/);
  });

  it('重名、保留名、墨鸽分组名的节点去掉；dialer-proxy 指向不存在的节点时删掉', () => {
    const { proxies } = parseClashConfig(`
proxies:
  - {name: A, type: ss, server: a.example.test, port: 1, cipher: aes-128-gcm, password: x1, dialer-proxy: 不存在}
  - {name: A, type: ss, server: b.example.test, port: 2, cipher: aes-128-gcm, password: x2}
  - {name: DIRECT, type: ss, server: c.example.test, port: 3, cipher: aes-128-gcm, password: x3}
  - {name: inkdove-auto, type: ss, server: d.example.test, port: 4, cipher: aes-128-gcm, password: x4}
  - {name: B, type: ss, server: e.example.test, port: 5, cipher: aes-128-gcm, password: x5, dialer-proxy: A}
`);
    assert.deepEqual(
      proxies.map((p) => [p.name, p['dialer-proxy']]),
      [
        ['A', undefined],
        ['B', 'A'],
      ],
    );
  });
});

describe('生成的 mihomo 配置', () => {
  const { proxies } = parseClashConfig(NODES_YAML);
  const base = { proxies, mixedPort: 17890, controllerPort: 40001, secret: 'controller-secret-x', auth: { username: 'u1', password: 'p1' } };

  it('对外要账号密码、本机免密；控制接口只听 127.0.0.1；所有连接交给 inkdove 分组', () => {
    const c = buildMihomoConfig({ ...base, node: '', allowLan: true });
    assert.equal(c['mixed-port'], 17890);
    assert.equal(c['allow-lan'], true);
    assert.equal(c['bind-address'], '*');
    assert.deepEqual(c.authentication, ['u1:p1']);
    assert.deepEqual(c['skip-auth-prefixes'], ['127.0.0.1/8', '::1/128']);
    assert.equal(c['external-controller'], '127.0.0.1:40001');
    assert.equal(c.secret, 'controller-secret-x');
    assert.deepEqual(c.rules, ['MATCH,inkdove']);
    assert.equal(c['geo-auto-update'], false);
    const [auto, main] = c['proxy-groups'];
    assert.deepEqual(auto, { name: 'inkdove-auto', type: 'url-test', proxies: NODE_NAMES, url: 'https://www.gstatic.com/generate_204', interval: 300, tolerance: 50, lazy: true });
    assert.deepEqual(main, { name: 'inkdove', type: 'select', proxies: ['inkdove-auto'] });
    // 没有 DIRECT：自动选最快的不会选到直连
    assert.ok(!JSON.stringify(c['proxy-groups']).includes('DIRECT'));
  });

  it('手动选的节点排第一；不在列表里的当自动；不对外时只听 127.0.0.1', () => {
    const c = buildMihomoConfig({ ...base, node: 'Japan 02', allowLan: false });
    assert.equal(c['bind-address'], '127.0.0.1');
    assert.equal(c['allow-lan'], false);
    assert.deepEqual(c['proxy-groups'][1].proxies, ['Japan 02', 'inkdove-auto']);
    assert.deepEqual(buildMihomoConfig({ ...base, node: '没有这个', allowLan: false })['proxy-groups'][1].proxies, ['inkdove-auto']);
  });

  it('要从 mihomo 输出里抹掉的值：服务器、密码、uuid', () => {
    const s = nodeSecrets(proxies);
    for (const v of SECRETS) assert.ok(s.includes(v), v);
  });
});

describe('下载订阅', () => {
  let sub;
  const seen = [];
  before(async () => {
    sub = await serve((req, res) => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] });
      if (req.url === `/clash/${TOKEN}`) return res.end(NODES_YAML);
      if (req.url === `/b64/${TOKEN}`) return res.end(LINK_LIST);
      if (req.url === `/big/${TOKEN}`) {
        res.writeHead(200);
        res.end(Buffer.alloc(300_000, 'a'));
        return;
      }
      if (req.url === `/redirect/${TOKEN}`) {
        res.writeHead(302, { location: `/clash/${TOKEN}` });
        return res.end();
      }
      if (req.url === `/slow/${TOKEN}`) return; // 一直不回
      if (req.url === `/forbidden/${TOKEN}`) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: `token ${TOKEN} expired` }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  after(() => sub.close());

  const noSecret = (err) => {
    assert.ok(err instanceof SubscriptionError, String(err));
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.ok(!err.message.includes(`127.0.0.1:${sub.port}`), err.message);
    return true;
  };

  it('Clash 订阅：用 Clash 的 User-Agent，跟重定向，取出节点', async () => {
    const r = await fetchSubscription(`${sub.url}/redirect/${TOKEN}`);
    assert.deepEqual(
      r.proxies.map((p) => p.name),
      NODE_NAMES,
    );
    assert.equal(seen.at(-1).ua, 'clash.meta');
  });

  it('不是 Clash 订阅：提示换成 Clash 订阅链接', async () => {
    await assert.rejects(fetchSubscription(`${sub.url}/b64/${TOKEN}`), (err) => noSecret(err) && err.message.includes(NOT_CLASH_HINT));
  });

  it('太大、超时、机场返回错误：信息里不带订阅地址和 token', async () => {
    await assert.rejects(fetchSubscription(`${sub.url}/big/${TOKEN}`, { maxBytes: 100_000 }), (err) => noSecret(err) && /太大/.test(err.message));
    await assert.rejects(fetchSubscription(`${sub.url}/slow/${TOKEN}`, { timeoutMs: 300 }), (err) => noSecret(err) && /超时/.test(err.message));
    await assert.rejects(fetchSubscription(`${sub.url}/forbidden/${TOKEN}`), (err) => noSecret(err) && /403/.test(err.message));
    await assert.rejects(fetchSubscription(`http://127.0.0.1:9/${TOKEN}`), noSecret);
  });
});

/** 进程内的假 HTTP CONNECT 代理：记下每个 CONNECT 的目标；目标是 example.test 的改连 mapTo；443 端口的只读 SNI */
async function startConnectProxy(mapTo) {
  const state = { connects: [], sni: [] };
  const server = http.createServer((_q, s) => s.writeHead(405).end());
  server.on('connect', (req, sock, head) => {
    sock.on('error', () => {});
    state.connects.push(req.url);
    const i = req.url.lastIndexOf(':');
    const host = req.url.slice(0, i).replace(/^\[(.*)\]$/, '$1');
    const port = Number(req.url.slice(i + 1));
    sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (port === 443) {
      sock.once('data', (b) => {
        state.sni.push(b.includes(Buffer.from('secure.example.test')) ? 'secure.example.test' : null);
        sock.destroy();
      });
      return;
    }
    const up = host.endsWith('example.test') ? net.connect(mapTo, '127.0.0.1') : net.connect(port, host);
    up.on('connect', () => {
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

describe('出口路由：全局 fetch、node:http、SMTP（Node 自带的 undici，不是 npm 的）', () => {
  let target;
  let proxy;
  const hits = [];
  before(async () => {
    target = await serve((req, res) => {
      hits.push({ host: req.headers.host, url: req.url });
      res.end(`hello ${req.url}`);
    });
    proxy = await startConnectProxy(target.port);
  });
  after(async () => {
    await disableRouting();
    await proxy.close();
    await target.close();
  });

  it('前提：全局 dispatcher 是 Node 自带的 Agent，和 npm undici 的 Agent 不是一个类', () => {
    assert.ok(builtinDispatcher);
    assert.equal(globalThis[GLOBAL_DISPATCHER], builtinDispatcher);
    assert.ok(!(builtinDispatcher instanceof NpmUndiciAgent));
    assert.notEqual(builtinDispatcher.constructor, NpmUndiciAgent);
  });

  it('开启后：公网主机名经 CONNECT（域名不在本地解析），本机地址直连；走代理的也是 Node 自带的 Agent', async () => {
    enableRouting({ port: proxy.port, isDirect: createDirectMatcher({ rules: ['direct.example.test'] }) });
    const d = globalThis[GLOBAL_DISPATCHER];
    assert.notEqual(d, builtinDispatcher);
    assert.ok(!(d instanceof NpmUndiciAgent));
    assert.ok(!(proxiedDispatcher() instanceof NpmUndiciAgent));
    assert.equal(proxiedDispatcher().constructor, builtinDispatcher.constructor);

    const r = await fetch(`http://api.example.test:${target.port}/v1/chat`);
    assert.equal(await r.text(), 'hello /v1/chat');
    assert.deepEqual(proxy.state.connects, [`api.example.test:${target.port}`]);
    assert.equal(hits.at(-1).host, `api.example.test:${target.port}`);

    const before = proxy.state.connects.length;
    const local = await fetch(`${target.url}/local`);
    assert.equal(await local.text(), 'hello /local');
    assert.equal(proxy.state.connects.length, before);
  });

  it('https：隧道里做 TLS，SNI 是原来的主机名', async () => {
    await assert.rejects(fetch('https://secure.example.test/x'));
    assert.deepEqual(proxy.state.sni, ['secure.example.test']);
    assert.ok(proxy.state.connects.includes('secure.example.test:443'));
  });

  it('客户媒体下载（node:http）经代理；direct=true 时直连', async () => {
    const n0 = proxy.state.connects.length;
    const { stream } = await httpGet(`http://media.example.test:${target.port}/file.jpg`);
    let body = '';
    for await (const c of stream) body += c;
    assert.equal(body, 'hello /file.jpg');
    assert.equal(proxy.state.connects[n0], `media.example.test:${target.port}`);
    // 换成什么都走代理的规则：127.0.0.1 也走；direct=true 时不走
    enableRouting({ port: proxy.port, isDirect: () => false });
    const a = await httpGet(`${target.url}/via`);
    a.stream.resume();
    assert.equal(proxy.state.connects.at(-1), `127.0.0.1:${target.port}`);
    const n1 = proxy.state.connects.length;
    const b = await httpGet(`${target.url}/direct`, { direct: true });
    b.stream.resume();
    assert.equal(proxy.state.connects.length, n1);
    assert.equal(createConnectionFor(new URL(`${target.url}/x`)) !== null, true);
  });

  it('SMTP：不在直连名单里的服务器给 nodemailer 本机代理地址', () => {
    enableRouting({ port: proxy.port, isDirect: createDirectMatcher({ rules: ['smtp.corp.example.test'] }) });
    assert.equal(smtpProxyFor('smtp.example.test'), `http://127.0.0.1:${proxy.port}`);
    assert.equal(smtpOptions({ host: 'smtp.example.test', port: 465, secure: true, user: '', password: '' }).proxy, `http://127.0.0.1:${proxy.port}`);
    assert.equal(smtpProxyFor('smtp.corp.example.test'), null);
    assert.equal(smtpProxyFor('192.168.1.10'), null);
  });

  it('开着但代理没就绪：请求失败，不退回直连', async () => {
    enableRouting({ port: proxy.port, isDirect: () => false, waitReady: () => Promise.reject(new Error('全局代理没有在运行：测试')) });
    const n = hits.length;
    const c = proxy.state.connects.length;
    await assert.rejects(fetch(`${target.url}/never`), (err) => /全局代理没有在运行/.test(err?.cause?.message || err.message));
    await assert.rejects(httpGet(`${target.url}/never`), /全局代理没有在运行/);
    assert.equal(hits.length, n);
    assert.equal(proxy.state.connects.length, c);
  });

  it('SSRF 防护照旧：所有请求都走代理时，内网和本机地址仍然在本地被拦下，代理收不到', async () => {
    enableRouting({ port: proxy.port, isDirect: () => false });
    const c = proxy.state.connects.length;
    for (const u of [`${target.url}/`, 'http://10.1.2.3/', `http://[::1]:${target.port}/`, 'http://localhost/', 'http://169.254.169.254/latest']) {
      await assert.rejects(fetchSite(u, { crawl: false, maxPages: 1 }), (err) => err.status === 400, u);
    }
    assert.equal(proxy.state.connects.length, c);
  });

  it('关掉后：全局 dispatcher 原样放回，SMTP 不再给代理', async () => {
    await disableRouting();
    assert.equal(globalThis[GLOBAL_DISPATCHER], builtinDispatcher);
    assert.equal(proxiedDispatcher(), null);
    assert.equal(smtpProxyFor('smtp.example.test'), null);
    assert.equal(smtpOptions({ host: 'smtp.example.test', port: 465, secure: true, user: '', password: '' }).proxy, undefined);
    const n = proxy.state.connects.length;
    await (await fetch(`${target.url}/after`)).text();
    assert.equal(proxy.state.connects.length, n);
  });
});

describe('设置：全局代理字段', () => {
  const cur = loadSettings({ prepare: () => ({ get: () => null, run: () => {} }) }, { llmInit: {} });

  it('默认关；订阅地址留空不改、null 清空；只收 http(s)', () => {
    assert.deepEqual(cur.proxy, { enabled: false, source: 'subscription', subscriptionUrl: '', node: '', bypass: [] });
    const a = applySettingsPatch(cur, { proxy: { subscriptionUrl: ' https://sub.example.test/a ' } });
    assert.equal(a.proxy.subscriptionUrl, 'https://sub.example.test/a');
    assert.equal(applySettingsPatch(a, { proxy: { subscriptionUrl: '' } }).proxy.subscriptionUrl, 'https://sub.example.test/a');
    assert.equal(applySettingsPatch(a, { proxy: { subscriptionUrl: null } }).proxy.subscriptionUrl, '');
    assert.throws(() => applySettingsPatch(cur, { proxy: { subscriptionUrl: 'ftp://x.example.test' } }), /proxy\.subscriptionUrl/);
    assert.throws(() => applySettingsPatch(cur, { proxy: { source: 'v2ray' } }), /proxy\.source/);
    assert.throws(() => applySettingsPatch(cur, { proxy: { enabled: 'yes' } }), /proxy\.enabled/);
    assert.throws(() => applySettingsPatch(cur, { proxy: { config: 123 } }), /proxy\.config/);
    // 粘贴的配置不存进设置
    assert.equal(applySettingsPatch(cur, { proxy: { config: NODES_YAML } }).proxy.config, undefined);
  });
});

describe('号的导入：用全局代理', () => {
  const doc = {
    format: 'inkdove-accounts',
    version: 1,
    accounts: [{ name: '扫码 A', channel: 'waha', waha: { proxy: { enabled: true, useGlobal: true } } }],
  };
  it('全局代理没开：关掉这个号的代理并说明；开着时照原样', () => {
    const [off] = parseAccountsExport(doc, { emailReady: false, globalProxyReady: false });
    assert.equal(off.config.waha.proxy.enabled, false);
    assert.equal(off.config.waha.proxy.useGlobal, true);
    assert.match(off.notices.join(), /全局代理没开/);
    const [on] = parseAccountsExport(doc, { emailReady: false, globalProxyReady: true });
    assert.equal(on.config.waha.proxy.enabled, true);
    assert.equal(on.notices, undefined);
  });
});

describe('没有 mihomo 的机器', () => {
  let t;
  before(async () => {
    t = await startApp({ env: { INKDOVE_MIHOMO_PATH: path.join(os.tmpdir(), `no-mihomo-${process.pid}`) }, options: { globalProxy: { refreshCheckMs: 0 } } });
    await t.login();
  });
  after(() => t.close());

  it('状态里说明没有 mihomo，开关打不开', async () => {
    const st = await t.req('GET', '/api/settings/proxy/status');
    assert.equal(st.body.available, false);
    assert.equal(st.body.state, 'off');
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { enabled: true, source: 'config', config: NODES_YAML } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'mihomo_unavailable');
    assert.equal(r.body.error, `proxy.enabled ${MIHOMO_MISSING}`);
    assert.equal((await t.req('GET', '/api/settings')).body.proxy.enabled, false);
  });
});

describe('全局代理：设置页、mihomo 进程、号用全局代理（假 mihomo）', () => {
  let t;
  let waha;
  let sub;
  let target;
  let dir;
  let logFile;
  let crashFlag;
  let mixedPort;
  let subBody = NODES_YAML;
  const subSeen = [];

  /** 假 mihomo 记下的事 */
  const events = (event) =>
    fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => !event || e.event === event);
  const status = async () => (await t.req('GET', '/api/settings/proxy/status')).body;
  const running = () => waitFor(async () => (await status()).state === 'running', { timeout: 8000, message: '全局代理没有进入 running' });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-gp-'));
    logFile = path.join(dir, 'fake.log');
    crashFlag = path.join(dir, 'crash');
    fs.writeFileSync(logFile, '');
    target = await serve((req, res) => {
      if (req.url === '/ip') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ip: '203.0.113.50' }));
      }
      res.end(`via-target ${req.url}`);
    });
    sub = await serve((req, res) => {
      subSeen.push(req.headers['user-agent']);
      if (req.url === `/sub/${TOKEN}`) return res.end(subBody);
      if (req.url === `/b64/${TOKEN}`) return res.end(LINK_LIST);
      res.writeHead(404);
      res.end();
    });
    // 墨鸽给 mihomo 的环境变量只有 HOME：包装脚本里写死 node 的绝对路径和假 mihomo 要的变量
    const wrapper = path.join(dir, 'mihomo');
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        `export FAKE_LOG=${q(logFile)}`,
        `export FAKE_TARGET=${q(`127.0.0.1:${target.port}`)}`,
        `if [ -f ${q(crashFlag)} ]; then export FAKE_CRASH=1; fi`,
        `exec ${q(process.execPath)} ${q(path.join(here, 'fake-mihomo.js'))} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    mixedPort = await freePort();
    waha = await startFakeWaha();
    t = await startApp({
      env: { INKDOVE_MIHOMO_PATH: wrapper, INKDOVE_GLOBAL_PROXY_PORT: String(mixedPort), INKDOVE_WAHA_URL: waha.url },
      options: {
        proxyTestUrl: 'http://ipcheck.example.test/ip',
        globalProxy: { refreshCheckMs: 0, backoff: { minMs: 50, maxMs: 200, stableMs: 60_000 }, readyTimeoutMs: 5000, subscriptionTimeoutMs: 2000 },
      },
    });
    await t.login();
  });
  after(async () => {
    await t?.close();
    await waha.close();
    await sub.close();
    await target.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('默认关：没有 mihomo 进程，状态 off', async () => {
    const s = (await t.req('GET', '/api/settings')).body.proxy;
    assert.deepEqual(s, { enabled: false, source: 'subscription', node: '', bypass: [], subscriptionUrlSet: false });
    const st = await status();
    assert.equal(st.available, true);
    assert.equal(st.state, 'off');
    assert.equal(events('start').length, 0);
    assert.equal(globalThis[GLOBAL_DISPATCHER], builtinDispatcher);
  });

  it('字段错误放在字段下面；没有节点时开不了', async () => {
    const bad = async (proxy, re, code) => {
      const r = await t.req('PUT', '/api/settings', { body: { proxy } });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, re);
      if (code) assert.equal(r.body.code, code);
    };
    await bad({ bypass: ['ok.example.com', 'bad host'] }, /^proxy\.bypass 第 2 行/);
    await bad({ subscriptionUrl: 'ftp://x.example.test' }, /^proxy\.subscriptionUrl/);
    await bad({ enabled: true }, /^proxy\.subscriptionUrl 还没有填订阅地址/, 'proxy_no_nodes');
    await bad({ source: 'config', config: 'trojan://fake@us.node.example.test:443#US' }, /^proxy\.config 粘贴的配置不对：内容是节点链接列表/, 'proxy_config_invalid');
  });

  it('不是 Clash 的订阅：400，提示换成 Clash 订阅链接，信息里不带地址', async () => {
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: `${sub.url}/b64/${TOKEN}` } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'proxy_subscription_failed');
    assert.ok(r.body.error.includes(NOT_CLASH_HINT), r.body.error);
    assert.ok(!r.body.error.includes(TOKEN));
    assert.equal((await t.req('GET', '/api/settings')).body.proxy.subscriptionUrlSet, false);
  });

  it('订阅地址和节点的凭证不回传、不进日志，只给填没填、节点名和个数', async () => {
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: `${sub.url}/sub/${TOKEN}`, bypass: '*.corp.example.test' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.proxy.subscriptionUrlSet, true);
    assert.deepEqual(r.body.proxy.bypass, ['*.corp.example.test']);
    assert.equal(subSeen.at(-1), 'clash.meta');
    const st = await status();
    assert.deepEqual(
      st.nodes.map((n) => n.name),
      NODE_NAMES,
    );
    assert.equal(st.nodeCount, 4);
    assert.equal(st.subscription.skipped, 1);
    assert.ok(st.subscription.updatedAt);
    const all = JSON.stringify([r.body, st, (await t.req('GET', '/api/settings')).body, t.log.lines]);
    for (const s of [TOKEN, `127.0.0.1:${sub.port}`, ...SECRETS]) assert.ok(!all.includes(s), s);
    // 粘贴的配置：也只回传有没有、几个节点
    const p = await t.req('PUT', '/api/settings', { body: { proxy: { config: NODES_YAML_2 } } });
    assert.equal(p.status, 200);
    const st2 = await status();
    assert.deepEqual(st2.config, { set: true, nodeCount: 3, skipped: 1, invalid: [], updatedAt: st2.config.updatedAt });
    assert.ok(!JSON.stringify(st2).includes('fake-ss-password-1'));
    // 还关着：没起 mihomo（只用 mihomo -t 查过节点）
    assert.equal(events('start').length, 0);
    assert.ok(events('check').length >= 2);
  });

  it('mihomo 不认的节点（mihomo -t 报「proxy N:」）去掉并列出名字；全是坏的时 400，信息里不带节点的凭证', async () => {
    const bad = NODES_YAML_2.replace(
      'proxies:\n',
      'proxies:\n  - {name: BAD 节点, type: ss, server: bad.node.example.test, port: 8388, cipher: aes-128-gcm, password: fake-bad-password-9}\n',
    );
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { config: bad } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await status();
    assert.equal(st.config.nodeCount, 3);
    assert.deepEqual(st.config.invalid, ['BAD 节点']);
    const only = 'proxies:\n  - {name: BAD 唯一, type: ss, server: bad.node.example.test, port: 8388, cipher: aes-128-gcm, password: fake-bad-password-9}\n';
    const r2 = await t.req('PUT', '/api/settings', { body: { proxy: { config: only } } });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.code, 'proxy_config_invalid');
    assert.match(r2.body.error, /^proxy\.config mihomo 不接受这些节点：proxy 0: fake invalid node/);
    assert.ok(!r2.body.error.includes('fake-bad-password-9'), r2.body.error);
    assert.equal((await status()).config.nodeCount, 3);
    // 设置页的「清除」：config: null 清掉粘贴的节点
    const c = await t.req('PUT', '/api/settings', { body: { proxy: { config: null } } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual((await status()).config, { set: false, nodeCount: 0, skipped: 0, invalid: [], updatedAt: null });
  });

  it('开启：起 mihomo（配置文件 600、目录 700、只在本机听），全局 fetch 经它出去，本机地址直连', async () => {
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { enabled: true } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await running();
    const [start] = events('start');
    assert.equal(start.mixedPort, mixedPort);
    assert.equal(start.bind, '127.0.0.1');
    const cfgFile = path.join(t.dataDir, 'mihomo', 'config.yaml');
    assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(cfgFile)).mode & 0o777, 0o700);
    const st = await status();
    assert.equal(st.current, '香港 01');
    assert.equal(st.error, null);

    const res = await fetch('http://api.example.test/v1/models');
    assert.equal(await res.text(), 'via-target /v1/models');
    const c = events('connect');
    assert.equal(c.at(-1).target, 'api.example.test:80');
    assert.equal(c.at(-1).auth, 'none');
    // 本机（墨鸽自己的接口、WAHA）不经代理
    await t.req('GET', '/api/health');
    await fetch(`${waha.url}/api/sessions`).then((x) => x.text());
    assert.equal(events('connect').length, c.length);
  });

  it('测试：经全局代理拿到出口 IP；测速：每个节点的延迟，超时的为 null', async () => {
    const r = await t.req('POST', '/api/settings/proxy/test');
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.ip, '203.0.113.50');
    assert.equal(typeof r.body.latencyMs, 'number');
    assert.equal(events('connect').at(-1).target, 'ipcheck.example.test:80');
    const d = await t.req('POST', '/api/settings/proxy/delay');
    assert.equal(d.body.ok, true);
    assert.deepEqual(d.body.delays, { '香港 01': null, 'Japan 02': 100, 'US 03': 110, 'SG 04': 120 });
  });

  it('网址抓取的 SSRF 防护照旧：内网地址 400，代理收不到', async () => {
    const n = events('connect').length;
    for (const url of [`${target.url}/`, 'http://10.0.0.8/', 'http://169.254.169.254/']) {
      const r = await t.req('POST', '/api/sources/url', { body: { url } });
      assert.equal(r.status, 400, url);
    }
    assert.equal(events('connect').length, n);
  });

  it('手动选节点：mihomo 用新配置重启，旧进程退出；选不存在的节点 400', async () => {
    const old = events('start').at(-1).pid;
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { node: 'Japan 02' } } });
    assert.equal(r.status, 200);
    await waitFor(() => events('start').length === 2);
    await running();
    assert.deepEqual(events('start').at(-1).groups[1].proxies, ['Japan 02', 'inkdove-auto']);
    await waitFor(() => !alive(old), { message: '旧的 mihomo 没退出' });
    assert.equal((await status()).current, 'Japan 02');
    const bad = await t.req('PUT', '/api/settings', { body: { proxy: { node: '没有这个节点' } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'proxy_node_not_found');
  });

  it('更新订阅后选的节点没了：改回自动并在状态里说明', async () => {
    subBody = NODES_YAML_2;
    const r = await t.req('POST', '/api/settings/proxy/refresh');
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.nodeCount, 3);
    assert.equal((await t.req('GET', '/api/settings')).body.proxy.node, '');
    assert.match(r.body.status.notice, /Japan 02/);
    await waitFor(() => events('start').length === 3);
    assert.deepEqual(events('start').at(-1).groups[1].proxies, ['inkdove-auto']);
    await running();
  });

  let acc;
  it('号「用全局代理」：WAHA session 指向 inkdove 的混合端口，带共享的账号密码；不起中继', async () => {
    acc = await t.createAccount({ name: '扫码一号' });
    const st = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    const r = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: true, useGlobal: true } } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.waha.proxy.useGlobal, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'mihomo', 'config.yaml'), 'utf8'));
    const [user, pass] = cfg.authentication[0].split(':');
    const sess = waha.state.sessions.get(acc.waha.sessionName);
    assert.deepEqual(sess.config.proxy, { server: `inkdove:${mixedPort}`, username: user, password: pass });
    assert.equal(t.ctx.relays.get(acc.id), null);
    const test = await t.req('POST', `/api/accounts/${acc.id}/proxy/test`);
    assert.equal(test.body.ok, true, JSON.stringify(test.body));
    assert.equal(test.body.ip, '203.0.113.50');
    assert.deepEqual((await status()).usedBy, [{ id: acc.id, name: '扫码一号' }]);
  });

  it('有号在用时关全局代理：400，列出这些号', async () => {
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { enabled: false } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'global_proxy_in_use');
    assert.match(r.body.error, /扫码一号/);
    assert.equal((await status()).state, 'running');
  });

  it('mihomo 崩了：按退避自动拉起，期间走代理的请求失败、不退回直连；好了以后恢复', async () => {
    fs.writeFileSync(crashFlag, '1');
    const n = events('start').length;
    // 改了配置（选节点）才会重启
    assert.equal((await t.req('PUT', '/api/settings', { body: { proxy: { node: 'US 03' } } })).status, 200);
    await waitFor(() => events('start').length >= n + 3, { timeout: 8000, message: '崩溃后没有自动重启' });
    // 重启间隙是 error，拉起时是 starting；两种状态里都能看到上次退出的原因
    const st = await waitFor(async () => {
      const x = await status();
      return x.state === 'error' && x;
    });
    assert.match(st.error, /fake crash/);
    assert.ok(st.restartAt);
    const hits = events('connect').length;
    await assert.rejects(fetch('http://api.example.test/should-fail'));
    assert.equal(events('connect').length, hits);
    fs.rmSync(crashFlag);
    await running();
    const ok = await fetch('http://api.example.test/back');
    assert.equal(await ok.text(), 'via-target /back');
  });

  it('关掉：先把号的代理改掉才能关；关了以后 mihomo 退出、出口还原，号不能再选「用全局代理」', async () => {
    const pid = events('start').at(-1).pid;
    // 开着、用订阅时不能清掉订阅地址（清了就没有节点）
    const busy = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: null } } });
    assert.equal(busy.status, 400);
    assert.equal(busy.body.code, 'proxy_no_nodes');
    assert.equal((await t.req('GET', '/api/settings')).body.proxy.subscriptionUrlSet, true);
    assert.equal((await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: false } } } })).status, 200);
    const r = await t.req('PUT', '/api/settings', { body: { proxy: { enabled: false } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => !alive(pid), { message: 'mihomo 没退出' });
    assert.equal((await status()).state, 'off');
    assert.equal(globalThis[GLOBAL_DISPATCHER], builtinDispatcher);
    const again = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: true, useGlobal: true } } } });
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'global_proxy_off');
    // 关着时设置页的「清除」：subscriptionUrl: null 清掉地址和节点
    const c = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: null } } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.proxy.subscriptionUrlSet, false);
    const st = await status();
    assert.equal(st.subscription.set, false);
    assert.equal(st.subscription.nodeCount, 0);
  });

  it('墨鸽退出时 mihomo 一起退出', async () => {
    const on = await t.req('PUT', '/api/settings', { body: { proxy: { enabled: true, subscriptionUrl: `${sub.url}/sub/${TOKEN}` } } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    await running();
    const pid = events('start').at(-1).pid;
    assert.ok(alive(pid));
    await t.close();
    t = null;
    await waitFor(() => !alive(pid), { message: 'mihomo 没跟着退出' });
    assert.equal(globalThis[GLOBAL_DISPATCHER], builtinDispatcher);
  });
});
