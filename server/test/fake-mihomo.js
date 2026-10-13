// 测试用的假 mihomo：按墨鸽生成的配置（-f，JSON）起混合端口（只做 HTTP CONNECT）和控制接口，不连任何外网。
// 由测试生成的 sh 包装脚本启动（墨鸽给子进程的环境变量只有 HOME），包装脚本里带这些环境变量：
//   FAKE_LOG：每件事追加一行 JSON（check、start、connect、sni）
//   FAKE_TARGET：CONNECT 的目标不是 127.0.0.1 时，改连这个地址（host:port），443 端口的读 TLS 的 SNI 记下来后断开
//   FAKE_CRASH：设了就在启动后马上以退出码 3 退出（测崩溃重启）
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const args = process.argv.slice(2);
const cfgPath = args[args.indexOf('-f') + 1];
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ ...o, pid: process.pid })}\n`);

// -t：只查配置。名字里带 BAD 的节点当成 mihomo 不认的（和真的 mihomo 一样报「proxy 序号: 原因」）
if (args.includes('-t')) {
  const bad = cfg.proxies.findIndex((p) => p.name.includes('BAD'));
  log({ event: 'check', nodes: cfg.proxies.length });
  if (bad >= 0) {
    process.stdout.write(`time="2026-01-01T00:00:00Z" level=error msg="proxy ${bad}: fake invalid node (${cfg.proxies[bad].password})"\n`);
    process.stdout.write(`configuration file ${cfgPath} test failed\n`);
    process.exit(1);
  }
  process.stdout.write(`configuration file ${cfgPath} test is successful\n`);
  process.exit(0);
}
log({ event: 'start', mixedPort: cfg['mixed-port'], bind: cfg['bind-address'], groups: cfg['proxy-groups'], nodes: cfg.proxies.map((p) => p.name) });
if (process.env.FAKE_CRASH) {
  process.stderr.write('time="2026-01-01T00:00:00Z" level=fatal msg="Parse config error: fake crash"\n');
  process.exit(3);
}

/** 从 TLS ClientHello 里取 SNI */
function sniOf(buf) {
  try {
    if (buf[0] !== 0x16 || buf[5] !== 0x01) return null;
    let p = 9 + 2 + 32; // 记录头 5 + 握手头 4 + 版本 2 + random 32
    p += 1 + buf[p]; // session id
    p += 2 + buf.readUInt16BE(p); // cipher suites
    p += 1 + buf[p]; // compression
    const end = p + 2 + buf.readUInt16BE(p);
    p += 2;
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      if (type === 0) return buf.subarray(p + 9, p + 9 + buf.readUInt16BE(p + 7)).toString('utf8');
      p += 4 + len;
    }
  } catch {
    /* 不是完整的 ClientHello */
  }
  return null;
}

const [authUser, authPass] = String(cfg.authentication?.[0] || ':').split(':');
const mixed = http.createServer((_req, res) => {
  res.writeHead(405);
  res.end();
});
mixed.on('connect', (req, sock, head) => {
  sock.on('error', () => {});
  const from = sock.remoteAddress;
  const got = String(req.headers['proxy-authorization'] || '');
  const local = /^(::ffff:)?127\./.test(from) || from === '::1';
  const authOk = got === `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`;
  log({ event: 'connect', target: req.url, from, auth: got ? (authOk ? 'ok' : 'bad') : 'none' });
  if (!local && !authOk) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  const i = req.url.lastIndexOf(':');
  const host = req.url.slice(0, i).replace(/^\[(.*)\]$/, '$1');
  const port = Number(req.url.slice(i + 1));
  sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
  if (port === 443) {
    const onData = (chunk) => {
      log({ event: 'sni', target: req.url, sni: sniOf(chunk) });
      sock.destroy();
    };
    if (head?.length) onData(head);
    else sock.once('data', onData);
    return;
  }
  const [th, tp] = host === '127.0.0.1' ? [host, port] : String(process.env.FAKE_TARGET || '127.0.0.1:9').split(':');
  const up = net.connect(Number(tp), th, () => {
    if (head?.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on('error', () => sock.destroy());
});
mixed.listen(cfg['mixed-port'], cfg['bind-address'] === '*' ? '0.0.0.0' : cfg['bind-address']);

const [, cport] = cfg['external-controller'].split(':');
const names = cfg.proxies.map((p) => p.name);
const main = cfg['proxy-groups'].find((g) => g.name === 'inkdove');
const api = http.createServer((req, res) => {
  const json = (code, o) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (req.headers.authorization !== `Bearer ${cfg.secret}`) return json(401, { message: 'Unauthorized' });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/version') return json(200, { meta: true, version: 'fake' });
  if (u.pathname === '/proxies/inkdove') return json(200, { name: 'inkdove', now: main.proxies[0] });
  if (u.pathname === '/proxies/inkdove-auto') return json(200, { name: 'inkdove-auto', now: names[0] });
  if (u.pathname === '/group/inkdove-auto/delay') {
    // 第一个节点超时（不在结果里），其余按顺序 100、110……
    return json(200, Object.fromEntries(names.slice(1).map((n, i) => [n, 100 + i * 10])));
  }
  json(404, { message: 'not found' });
});
api.listen(Number(cport), '127.0.0.1');
