import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// src/builtin-fetch.js：加载 app.js 后，全局 fetch 用 Node 自带的连接，不用 npm undici 7.30（它在对方关连接时会让进程崩）。
// 但 Node 22 自带的 undici（6.28，22.23.3 上实测）也有同样的 bug：响应体读得慢（比如边下边写盘）时对方关连接，进程照样崩。
// 所以大文件绝不走 fetch（客户媒体用 node:http，见 wa/media-download.js，test/media.test.js 有并发回归测试）；
// 这里只测 fetch 的正式用法：一次读进内存（arrayBuffer），或像 sources/fetch-url.js 的 readLimited 那样逐块读进内存。
// 都在子进程里跑：测试进程的全局 dispatcher 早就定了（npm test 用 --import 先加载了 builtin-fetch.js；单独跑时可能先加载过 undici），
// 验证不了 app.js 自己的加载顺序；而且崩了会带走整个测试进程。子进程用 execFile 起，不继承 --import。

const run = promisify(execFile);
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = pathToFileURL(path.join(serverDir, 'src', 'app.js')).href;

/** 在 server 目录下用子进程跑一段 ESM 代码，返回 {code, stdout, stderr}（不因非 0 退出抛错） */
async function node(code) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', code], {
      cwd: serverDir,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('全局 fetch 不走 npm undici', () => {
  it('加载 app.js 后全局 dispatcher 不是 npm undici 的 Agent', async () => {
    const r = await node(`
      await import(${JSON.stringify(appUrl)});
      const u = await import('undici');
      const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
      console.log(JSON.stringify({ hasDispatcher: !!d, npmAgent: d instanceof u.Agent }));
    `);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { hasDispatcher: true, npmAgent: false });
  });

  describe('对方传完就关连接、几个大文件同时下载：读进内存（fetch 的正式用法）', () => {
    let server;
    let base;
    const BIG = Buffer.alloc(16 * 1024 * 1024, 7);
    const MID = Buffer.alloc(4 * 1024 * 1024, 9);

    before(async () => {
      server = http.createServer((req, res) => {
        const body = req.url === '/mid' ? MID : BIG;
        res.shouldKeepAlive = false;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, connection: 'close' });
        res.end(body);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => {
      server.closeAllConnections();
      server.close();
    });

    it('进程不崩，大小都对', async () => {
      const r = await node(`
        await import(${JSON.stringify(appUrl)});
        // 一次读完（调模型、WAHA / Meta 的 JSON 这类）
        const whole = async () => (await (await fetch(${JSON.stringify(`${base}/big`)})).arrayBuffer()).byteLength;
        // 逐块读进内存、超过上限就取消（同 sources/fetch-url.js 的 readLimited，上限 5MB）
        const limited = async () => {
          const reader = (await fetch(${JSON.stringify(`${base}/mid`)})).body.getReader();
          const chunks = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > 5 * 1024 * 1024) {
              await reader.cancel().catch(() => {});
              throw new Error('超过 5MB');
            }
            chunks.push(Buffer.from(value));
          }
          return Buffer.concat(chunks).length;
        };
        const big = [];
        const mid = [];
        for (let round = 0; round < 3; round++) big.push(...(await Promise.all([0, 1, 2].map(whole))));
        for (let round = 0; round < 3; round++) mid.push(...(await Promise.all([0, 1, 2].map(limited))));
        console.log(JSON.stringify({ big, mid }));
      `);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout.trim()), { big: Array(9).fill(BIG.length), mid: Array(9).fill(MID.length) });
    });
  });
});
