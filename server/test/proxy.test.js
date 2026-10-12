import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { parseTarget } from '../src/wa/relay.js';
import { testProxy } from '../src/wa/proxy-test.js';
import { startApp, startFakeWaha, waitFor } from './helpers.js';

/** 假的出口 IP 服务（代替 api.ipify.org） */
async function startIpService(ip = '203.0.113.9') {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ip }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/?format=json`, close: () => new Promise((r) => server.close(r)) };
}

/** 假 HTTP 代理：支持 CONNECT 隧道和普通转发，校验 Basic 认证 */
async function startHttpProxy({ user, pass }) {
  const state = { connects: [], auths: [] };
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    state.auths.push(req.headers['proxy-authorization'] || null);
    if (req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic' });
      return res.end();
    }
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    state.connects.push(req.url);
    state.auths.push(req.headers['proxy-authorization'] || null);
    if (req.headers['proxy-authorization'] !== expected) {
      sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
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

/** 最小的 SOCKS5 服务（RFC 1928 / 1929），只支持 CONNECT */
async function startSocks5({ user, pass }) {
  const state = { auths: [], targets: [] };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', (greet) => {
      const methods = [...greet.subarray(2, 2 + greet[1])];
      const useAuth = methods.includes(2);
      sock.write(Buffer.from([5, useAuth ? 2 : 0]));
      const onRequest = () =>
        sock.once('data', (req) => {
          let host;
          let off;
          if (req[3] === 1) {
            host = [...req.subarray(4, 8)].join('.');
            off = 8;
          } else if (req[3] === 3) {
            host = req.subarray(5, 5 + req[4]).toString();
            off = 5 + req[4];
          } else {
            sock.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const port = req.readUInt16BE(off);
          state.targets.push(`${host}:${port}`);
          const up = net.connect(port, host, () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            up.pipe(sock);
            sock.pipe(up);
          });
          up.on('error', () => sock.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])));
        });
      if (!useAuth) return onRequest();
      sock.once('data', (a) => {
        const ulen = a[1];
        const u = a.subarray(2, 2 + ulen).toString();
        const plen = a[2 + ulen];
        const p = a.subarray(3 + ulen, 3 + ulen + plen).toString();
        state.auths.push({ u, p });
        const ok = u === user && p === pass;
        sock.write(Buffer.from([1, ok ? 0 : 1]));
        if (ok) onRequest();
        else sock.end();
      });
    });
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

/** 最小的 SOCKS4 服务：只支持 CONNECT（含 4a 的域名形式） */
async function startSocks4() {
  const state = { targets: [], users: [] };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', (req) => {
      const reject = () => sock.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
      if (req[0] !== 4 || req[1] !== 1) return reject();
      const port = req.readUInt16BE(2);
      let host = [...req.subarray(4, 8)].join('.');
      const nul = req.indexOf(0, 8);
      state.users.push(req.subarray(8, nul).toString());
      if (req[4] === 0 && req[5] === 0 && req[6] === 0 && req[7] !== 0) host = req.subarray(nul + 1, req.indexOf(0, nul + 1)).toString();
      state.targets.push(`${host}:${port}`);
      const up = net.connect(port, host, () => {
        sock.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', reject);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, state, close: () => new Promise((r) => server.close(r)) };
}

/** 假目标服务：中继打通后经隧道访问它 */
async function startTarget() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    res.end('hello-from-target');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

/**
 * 像 WAHA 一样经中继发 CONNECT；200 时再经隧道发一个 GET，返回 {status, body}。
 * @param {number} port 中继端口
 * @param {string} target host:port
 * @param {string|null} auth Proxy-Authorization
 */
function viaRelay(port, target, auth) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let status = null;
    sock.setTimeout(4000, () => sock.destroy(new Error('relay timeout')));
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
    });
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (status !== null) return;
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString('latin1'))?.[1]);
      buf = buf.subarray(end + 4);
      if (status === 200) sock.write('GET / HTTP/1.1\r\nHost: target\r\nConnection: close\r\n\r\n');
    });
    sock.on('close', () => resolve({ status, body: buf.toString() }));
  });
}

describe('代理测试（从 kbwa 直连上游，不经中继）', () => {
  let ipsvc;
  let hp;
  let socks;
  let t;
  let acc;
  before(async () => {
    ipsvc = await startIpService();
    hp = await startHttpProxy({ user: 'proxy-user', pass: 'p@ss:w/rd' });
    socks = await startSocks5({ user: 'su', pass: 'sp' });
    t = await startApp({ options: { proxyTestUrl: ipsvc.url } });
    await t.login();
    acc = await t.createAccount();
  });
  after(async () => {
    await t.close();
    await hp.close();
    await socks.close();
    await ipsvc.close();
  });

  it('代理没启用时 400 proxy_disabled；Meta 号 400', async () => {
    const r = await t.req('POST', `/api/accounts/${acc.id}/proxy/test`);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'proxy_disabled');
    const meta = await t.createAccount({ channel: 'meta' });
    assert.equal((await t.req('POST', `/api/accounts/${meta.id}/proxy/test`)).status, 400);
  });

  it('POST /api/accounts/:id/proxy/test：经本地 HTTP 代理拿到出口 IP 和延迟', async () => {
    const put = await t.req('PUT', `/api/accounts/${acc.id}`, {
      body: { waha: { proxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: hp.port, username: 'proxy-user', password: 'p@ss:w/rd' } } },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const r = await t.req('POST', `/api/accounts/${acc.id}/proxy/test`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, r.body.error);
    assert.equal(r.body.ip, '203.0.113.9');
    assert.equal(typeof r.body.latencyMs, 'number');
    assert.ok(hp.state.auths.length >= 1, '请求确实经过了代理');
  });

  it('密码错误时返回 ok:false，错误信息里没有密码', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { password: 'wrong-secret-pw' } } } });
    const r = await t.req('POST', `/api/accounts/${acc.id}/proxy/test`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.error);
    assert.ok(!r.body.error.includes('wrong-secret-pw'), r.body.error);
  });

  it('socks5 号的代理测试也直连上游（不经中继）', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, {
      body: { waha: { proxy: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: socks.port, username: 'su', password: 'sp' } } },
    });
    const n = socks.state.auths.length;
    const r = await t.req('POST', `/api/accounts/${acc.id}/proxy/test`);
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual(socks.state.auths.slice(n), [{ u: 'su', p: 'sp' }]);
  });

  it('代理连不上时返回 ok:false', async () => {
    const r = await testProxy({ protocol: 'http', host: '127.0.0.1', port: 9, username: '', password: '' }, { url: ipsvc.url, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /代理测试失败/);
  });

  it('socks5（带账号密码）能测通；密码错时报错里没有密码', async () => {
    const r = await testProxy({ protocol: 'socks5', host: '127.0.0.1', port: socks.port, username: 'su', password: 'sp' }, { url: ipsvc.url, timeoutMs: 3000 });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.ip, '203.0.113.9');
    assert.deepEqual(socks.state.auths.at(-1), { u: 'su', p: 'sp' });
    const bad = await testProxy({ protocol: 'socks5', host: '127.0.0.1', port: socks.port, username: 'su', password: 'nope-pass' }, { url: ipsvc.url, timeoutMs: 3000 });
    assert.equal(bad.ok, false);
    assert.ok(!bad.error.includes('nope-pass'));
  });
});

describe('代理协议转换中继（F13）', () => {
  let fake;
  let t;
  let socksA;
  let socksB;
  let socks4;
  let target;
  let acc;
  let relay; // {port, username, password}
  const wahaProxy = () => fake.state.sessions.get(acc.waha.sessionName)?.config?.proxy;
  before(async () => {
    fake = await startFakeWaha();
    socksA = await startSocks5({ user: 'su', pass: 'sp' });
    socksB = await startSocks5({ user: 'su2', pass: 'sp2' });
    socks4 = await startSocks4();
    target = await startTarget();
    t = await startApp({ env: { KBWA_WAHA_URL: fake.url } });
    await t.login();
  });
  after(async () => {
    await t.close();
    await fake.close();
    await socksA.close();
    await socksB.close();
    await socks4.close();
    await target.close();
  });

  it('四种协议都能保存，默认 socks5；未知协议 400', async () => {
    const a = await t.createAccount({ name: '协议' });
    assert.equal(a.waha.proxy.protocol, 'socks5');
    for (const protocol of ['http', 'https', 'socks4', 'socks5']) {
      const r = await t.req('PUT', `/api/accounts/${a.id}`, { body: { waha: { proxy: { enabled: true, protocol, host: '127.0.0.1', port: 9 } } } });
      assert.equal(r.status, 200, `${protocol}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.waha.proxy.protocol, protocol);
    }
    const bad = await t.req('PUT', `/api/accounts/${a.id}`, { body: { waha: { proxy: { protocol: 'socks6' } } } });
    assert.equal(bad.status, 400);
    await t.req('DELETE', `/api/accounts/${a.id}`);
  });

  it('socks5 上游：start 时传给 WAHA 的代理指向中继 kbwa:<端口>，带随机账号密码', async () => {
    acc = await t.createAccount({
      name: '中继号',
      waha: { proxy: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: socksA.port, username: 'su', password: 'sp' } },
    });
    const st = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    const create = fake.state.requests.find((r) => r.method === 'POST' && r.path === '/api/sessions' && r.body.name === acc.waha.sessionName);
    const px = create.body.config.proxy;
    const m = /^kbwa:(\d+)$/.exec(px.server);
    assert.ok(m, px.server);
    relay = { port: Number(m[1]), username: px.username, password: px.password };
    assert.ok(relay.port >= t.config.proxyRelayPortBase);
    assert.match(relay.username, /^kbwa_[0-9a-f]{12}$/);
    assert.ok(relay.password.length >= 24);
    assert.ok(!JSON.stringify(create.body).includes('"sp"'), '上游密码不交给 WAHA');
    const row = t.ctx.db.prepare('SELECT relay_port, relay_username, relay_password FROM accounts WHERE id = ?').get(acc.id);
    assert.deepEqual(row, { relay_port: relay.port, relay_username: relay.username, relay_password: relay.password });
    // 中继凭证不出现在号接口里
    const got = await t.req('GET', `/api/accounts/${acc.id}`);
    assert.ok(!JSON.stringify(got.body).includes(relay.password));
  });

  it('CONNECT 经中继 → 假 SOCKS5 → 假目标，能打通', async () => {
    const r = await viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password));
    assert.equal(r.status, 200);
    assert.match(r.body, /hello-from-target/);
    assert.equal(socksA.state.targets.at(-1), `127.0.0.1:${target.port}`);
    assert.deepEqual(socksA.state.auths.at(-1), { u: 'su', p: 'sp' });
  });

  it('认证失败返回 407（缺失或错误）', async () => {
    const none = await viaRelay(relay.port, `127.0.0.1:${target.port}`, null);
    assert.equal(none.status, 407);
    const wrong = await viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, 'wrong'));
    assert.equal(wrong.status, 407);
  });

  it('非 CONNECT 方法返回 405', async () => {
    const r = await fetch(`http://127.0.0.1:${relay.port}/`, { headers: { 'proxy-authorization': basic(relay.username, relay.password) } });
    assert.equal(r.status, 405);
    await r.body?.cancel();
    const p = await fetch(`http://127.0.0.1:${relay.port}/x`, { method: 'POST', body: 'x' });
    assert.equal(p.status, 405);
    await p.body?.cancel();
  });

  it('上游连不上时 502；目标格式不对 400', async () => {
    const bad = await viaRelay(relay.port, 'not-a-target', basic(relay.username, relay.password));
    assert.equal(bad.status, 400);
    const down = await viaRelay(relay.port, '127.0.0.1:9', basic(relay.username, relay.password));
    assert.equal(down.status, 502);
    assert.deepEqual(parseTarget('[::1]:443'), { host: '::1', port: 443 });
    assert.equal(parseTarget('host:0'), null);
  });

  it('改配置后中继重启并更新 WAHA session；新上游生效', async () => {
    const puts = () => fake.state.requests.filter((r) => r.method === 'PUT' && r.path === `/api/sessions/${acc.waha.sessionName}`).length;
    const n = puts();
    const r = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { port: socksB.port, username: 'su2', password: 'sp2' } } } });
    assert.equal(r.status, 200);
    assert.equal(puts(), n + 1, '更新了 WAHA session');
    assert.ok(t.log.lines.some((l) => l.includes(`号 ${acc.id} 的代理中继已重启`)));
    assert.equal(wahaProxy().server, `kbwa:${relay.port}`);
    const a = socksA.state.targets.length;
    const ok = await viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password));
    assert.equal(ok.status, 200);
    assert.match(ok.body, /hello-from-target/);
    assert.equal(socksA.state.targets.length, a, '旧上游不再使用');
    assert.deepEqual(socksB.state.auths.at(-1), { u: 'su2', p: 'sp2' });
    // 改别的设置不重启
    const lines = t.log.lines.length;
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { autoReply: true } });
    assert.equal(puts(), n + 1);
    assert.ok(!t.log.lines.slice(lines).some((l) => l.includes('代理中继已')));
  });

  it('socks4 上游也能经中继打通', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { protocol: 'socks4', port: socks4.port, username: 'u4', password: '' } } } });
    const r = await viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password));
    assert.equal(r.status, 200);
    assert.match(r.body, /hello-from-target/);
    assert.equal(socks4.state.targets.at(-1), `127.0.0.1:${target.port}`);
    assert.equal(socks4.state.users.at(-1), 'u4');
  });

  it('进程重启时按配置重新拉起中继', async () => {
    await t.ctx.relays.closeAll();
    await assert.rejects(viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password)));
    await t.ctx.wa.init();
    const r = await viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password));
    assert.equal(r.status, 200);
  });

  it('改回 http 上游：中继关闭，WAHA 直接用上游代理；关掉代理后 proxy 去掉', async () => {
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { protocol: 'http', port: 3128, username: '', password: '' } } } });
    assert.equal(wahaProxy().server, '127.0.0.1:3128');
    await assert.rejects(viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password)));
    await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: false } } } });
    assert.equal(wahaProxy(), undefined);
  });

  it('中继端口被占用：start 返回 502 relay_failed，号状态里带错误', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(relay.port, '127.0.0.1', r));
    try {
      await t.req('PUT', `/api/accounts/${acc.id}`, { body: { waha: { proxy: { enabled: true, protocol: 'socks5', port: socksA.port, username: 'su', password: 'sp' } } } });
      const st = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
      assert.equal(st.status, 502);
      assert.equal(st.body.code, 'relay_failed');
      assert.match(st.body.error, /被占用/);
      const got = await t.req('GET', `/api/accounts/${acc.id}`);
      assert.match(got.body.status.error, /代理中继启动失败/);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
    const ok = await t.req('POST', `/api/accounts/${acc.id}/waha/start`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await waitFor(async () => (await viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password))).status === 200);
  });

  it('删除号后中继关闭', async () => {
    await t.req('DELETE', `/api/accounts/${acc.id}`);
    await assert.rejects(viaRelay(relay.port, `127.0.0.1:${target.port}`, basic(relay.username, relay.password)));
  });
});
