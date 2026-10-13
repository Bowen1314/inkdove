import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// src/builtin-fetch.js：加载 app.js 后，全局 fetch 用 Node 自带的连接，不用 npm undici 7.30（它在对方关连接时会让进程崩）。
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

  describe('对方传完就关连接、几个大文件同时边下边写盘', () => {
    let server;
    let base;
    let dir;
    const BIG = Buffer.alloc(16 * 1024 * 1024, 7);

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-fetch-'));
      server = http.createServer((req, res) => {
        res.shouldKeepAlive = false;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG.length, connection: 'close' });
        res.end(BIG);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => {
      server.closeAllConnections();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // 加载 app.js 之前（即不先占住 dispatcher）这段在 Node 20 + undici 7.30 上稳定崩（assert(!this.paused)）
    it('进程不崩，文件完整', async () => {
      const r = await node(`
        import fs from 'node:fs';
        import { Readable } from 'node:stream';
        import { pipeline } from 'node:stream/promises';
        await import(${JSON.stringify(appUrl)});
        const one = async (i) => {
          const res = await fetch(${JSON.stringify(`${base}/big`)});
          const out = ${JSON.stringify(dir)} + '/f' + i;
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out));
          return fs.statSync(out).size;
        };
        const sizes = [];
        for (let round = 0; round < 3; round++) sizes.push(...(await Promise.all([0, 1, 2].map(one))));
        console.log(JSON.stringify(sizes));
      `);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout.trim()), Array(9).fill(BIG.length));
    });
  });
});
