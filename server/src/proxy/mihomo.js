// 全局代理：生成 mihomo（Clash Meta 内核，github.com/MetaCubeX/mihomo，GPL-3.0）的配置，并作为子进程管起来。
// - 配置写在数据目录下（目录 700、文件 600），用 JSON 写（JSON 是合法的 YAML，节点名里有什么字符都不用操心转义）；
// - 混合端口（HTTP + SOCKS5）：本机免密，给墨鸽自己用；对外（compose 内网里的 WAHA）必须带账号密码；
// - 控制接口只听 127.0.0.1，带每次启动随机生成的 secret；
// - 规则只有一条 MATCH：所有连接都交给选中的节点（内网、直连的地址在墨鸽这边就分走了，不会到 mihomo），
//   所以 mihomo 不需要 GeoIP 之类的数据库，也不会去下载；
// - 配置一改就重启；意外退出时按退避时间自动拉起；关掉开关就停；墨鸽退出时一起退。
import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { AUTO_GROUP, MAIN_GROUP } from './clash.js';

/** 节点测速用的地址（mihomo 默认的那个） */
export const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204';
export const DELAY_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3000;
export const RESTART_BACKOFF = Object.freeze({ minMs: 1000, maxMs: 60_000, stableMs: 60_000 });
const OUTPUT_LINES = 30;

/**
 * 生成 mihomo 配置。
 * @param {{proxies: object[], node: string, mixedPort: number, allowLan: boolean, controllerPort: number, secret: string,
 *          auth: {username: string, password: string}}} o
 *   node：'' 是自动（最快），否则是手动选的节点名（必须在 proxies 里）
 */
export function buildMihomoConfig(o) {
  const names = o.proxies.map((p) => p.name);
  const chosen = o.node && names.includes(o.node) ? o.node : '';
  return {
    'mixed-port': o.mixedPort,
    'allow-lan': o.allowLan,
    'bind-address': o.allowLan ? '*' : '127.0.0.1',
    authentication: [`${o.auth.username}:${o.auth.password}`],
    'skip-auth-prefixes': ['127.0.0.1/8', '::1/128'],
    'external-controller': `127.0.0.1:${o.controllerPort}`,
    secret: o.secret,
    mode: 'rule',
    'log-level': 'warning',
    'unified-delay': true,
    'find-process-mode': 'off',
    'geo-auto-update': false,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: o.proxies,
    'proxy-groups': [
      // 自动：按延迟选最快的（只在用到时才测，5 分钟一次）
      { name: AUTO_GROUP, type: 'url-test', proxies: names, url: DELAY_TEST_URL, interval: 300, tolerance: 50, lazy: true },
      // 总出口：手动选了节点时它排第一（select 默认用第一个），否则用自动
      { name: MAIN_GROUP, type: 'select', proxies: chosen ? [chosen, AUTO_GROUP] : [AUTO_GROUP] },
    ],
    rules: [`MATCH,${MAIN_GROUP}`],
  };
}

/** 本机找一个空闲端口（给控制接口用） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 把字符串里的这些片段替换成 *** */
export function redactAll(text, secrets) {
  let s = String(text ?? '');
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join('***');
  return s;
}

/**
 * 节点里要当密钥抹掉的值：服务器地址、密码、uuid、各种 key 和 token（含嵌套的 ws-opts、reality-opts 等）。
 * mihomo 报错时可能带出节点的字段，这些不能进日志和状态里的错误信息。
 */
export function nodeSecrets(proxies) {
  const KEYS = /^(server|ip|ipv6|password|uuid|private-key|public-key|pre-shared-key|psk|auth|auth-str|auth_str|obfs-password|token|username|short-id|servername|sni|host|path)$/i;
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string' || typeof v === 'number') {
      if (key && KEYS.test(key)) out.add(String(v));
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(proxies, '');
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

/** mihomo 一行日志里的 msg="..."，没有就整行 */
function messageOf(line) {
  const m = /msg="((?:[^"\\]|\\.)*)"/.exec(line);
  return (m ? m[1].replace(/\\"/g, '"') : line).trim();
}

/** 只认 0600 / 0700：数据目录在宿主机上，别的用户不该读到机场的凭证和控制接口的 secret */
function writePrivate(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const CHECK_TIMEOUT_MS = 20_000;
/** 一次最多去掉几个 mihomo 不认的节点（每去掉一个要再查一遍） */
const MAX_DROPS = 50;

/** 用 mihomo -t 查一份配置（只解析、不监听端口）。{ok, error}：error 是最后一行报错，已抹掉 redactions */
function testConfig({ binPath, dir, config, redactions, spawn = nodeSpawn }) {
  // 同时可能有两次检查（保存设置和定时更新订阅），文件名不能撞
  const file = path.join(dir, `check-${crypto.randomBytes(4).toString('hex')}.yaml`);
  writePrivate(file, JSON.stringify(config));
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(binPath, ['-t', '-d', dir, '-f', file], { cwd: dir, env: { HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, error: `mihomo 启动失败：${err?.code || err?.message || err}` });
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    const onData = (b) => {
      if (out.length < 200_000) out += b;
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `mihomo 启动失败：${err?.code || err?.message || err}` });
    });
    p.once('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(file, { force: true });
      if (code === 0) return resolve({ ok: true, error: null });
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      const bad = [...lines].reverse().find((l) => /level=(error|fatal)/.test(l)) || lines.find((l) => /test failed/.test(l)) || `退出码 ${code}`;
      resolve({ ok: false, error: redactAll(messageOf(bad), redactions).slice(0, 300) });
    });
  });
}

/**
 * 机场的节点里偶尔有 mihomo 不认的（字段写错、不支持的加密方式）：写在 proxies 里时一个坏节点就让整个 mihomo 起不来。
 * 这里先用 mihomo -t 查，按报错里的「proxy N:」去掉那个节点再查，直到通过。
 * @param {{binPath: string, dir: string, proxies: object[], spawn?: Function}} o dir：放临时配置的目录（700）
 * @returns {Promise<{proxies: object[], dropped: string[]}>} dropped：去掉的节点名
 * @throws {Error} 不是某个节点的问题（信息可以给用户看，已抹掉节点的凭证）
 */
export async function dropInvalidNodes({ binPath, dir, proxies, spawn }) {
  let list = proxies;
  const dropped = [];
  const redactions = nodeSecrets(proxies);
  for (;;) {
    const config = buildMihomoConfig({
      proxies: list,
      node: '',
      mixedPort: 7890,
      allowLan: false,
      controllerPort: 9090,
      secret: 'check',
      auth: { username: 'check', password: 'check' },
    });
    const r = await testConfig({ binPath, dir, config, redactions, spawn });
    if (r.ok) return { proxies: list, dropped };
    const m = /^proxy (\d+):/.exec(r.error);
    const i = m ? Number(m[1]) : -1;
    if (i < 0 || i >= list.length || dropped.length >= MAX_DROPS || list.length <= 1) {
      throw new Error(`mihomo 不接受这些节点：${r.error}`);
    }
    dropped.push(list[i].name);
    list = list.filter((_, j) => j !== i);
  }
}

/**
 * 管一个 mihomo 子进程。
 * @param {{
 *   binPath: string, homeDir: string, log: {info: Function, warn: Function, error: Function},
 *   backoff?: Partial<typeof RESTART_BACKOFF>, readyTimeoutMs?: number, spawn?: typeof nodeSpawn,
 * }} o
 */
export function createMihomoRunner(o) {
  const backoff = { ...RESTART_BACKOFF, ...(o.backoff || {}) };
  const spawnImpl = o.spawn || nodeSpawn;
  const configPath = path.join(o.homeDir, 'config.yaml');
  /** 要跑的配置；null 表示应该停着 */
  let desired = null;
  /** @type {{config: any, fingerprint: string, redactions: string[]}|null} */
  let current = null;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let state = 'stopped'; // stopped | starting | running | error
  let error = null;
  let startedAt = 0;
  let failures = 0;
  let restartTimer = null;
  let restartAt = null;
  /** 最近的输出（已抹掉密钥） */
  let output = [];
  /** 等 running 的人 */
  let waiters = [];
  /** 递增的启动编号：旧进程的回调不影响新进程 */
  let gen = 0;

  const settleWaiters = (err) => {
    const ws = waiters;
    waiters = [];
    for (const w of ws) (err ? w.reject(err) : w.resolve());
  };

  const killOnExit = () => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  };

  /** 调控制接口（只连 127.0.0.1，不走任何代理） */
  function api(pathname, { timeoutMs = 5000 } = {}) {
    const cfg = current?.config;
    if (!cfg) return Promise.reject(new Error('mihomo 没在运行'));
    const [, port] = cfg['external-controller'].split(':');
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: Number(port), path: pathname, headers: { authorization: `Bearer ${cfg.secret}` }, timeout: timeoutMs },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
            if (body.length > 2_000_000) req.destroy(new Error('控制接口返回的内容过大'));
          });
          res.on('end', () => {
            let data = null;
            try {
              data = body ? JSON.parse(body) : null;
            } catch {
              /* 不是 JSON */
            }
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
            else reject(Object.assign(new Error(data?.message || `控制接口返回 ${res.statusCode}`), { status: res.statusCode }));
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('控制接口超时'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
    });
  }

  async function waitApiReady(myGen) {
    const deadline = Date.now() + (o.readyTimeoutMs ?? READY_TIMEOUT_MS);
    while (myGen === gen && child && Date.now() < deadline) {
      try {
        await api('/version', { timeoutMs: 1000 });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return false;
  }

  /** 输出里最后一行像报错的（只看 level=error / fatal 和带 error、failed 这些词的行），没有返回 '' */
  function lastError() {
    const bad = [...output].reverse().find((l) => /level=(error|fatal|panic)|fatal|error|failed|panic|invalid|parse/i.test(l) && !/level=(info|debug)/.test(l));
    return bad ? messageOf(bad).slice(0, 300) : '';
  }

  function launch() {
    if (!desired) return;
    const run = desired;
    const myGen = ++gen;
    output = [];
    // error 留着：崩溃后重启期间状态里还能看到上次为什么退出，起来了再清掉
    state = 'starting';
    current = run;
    try {
      writePrivate(configPath, JSON.stringify(run.config, null, 1));
    } catch (err) {
      state = 'error';
      error = `写配置文件失败：${err?.code || err?.message || err}`;
      settleWaiters(new Error(error));
      return;
    }
    let p;
    // 一个进程的 error 和 exit 可能都会来，只处理第一次
    let ended = false;
    /** 这次启动自己判定的失败原因（控制接口一直不通） */
    let failReason = null;
    const end = (code, signal, reason) => {
      if (ended) return;
      ended = true;
      onExit(myGen, code, signal, reason);
    };
    try {
      // 环境变量只给 HOME：墨鸽自己的环境变量里有管理员密码等密钥，不传给子进程
      p = spawnImpl(o.binPath, ['-d', o.homeDir, '-f', configPath], {
        cwd: o.homeDir,
        env: { HOME: o.homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      end(null, null, `启动失败：${err?.code || err?.message || err}`);
      return;
    }
    child = p;
    startedAt = Date.now();
    process.on('exit', killOnExit);
    const onData = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        output.push(redactAll(line, run.redactions).slice(0, 500));
        if (output.length > OUTPUT_LINES) output.shift();
      }
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.once('error', (err) => end(null, null, `启动失败：${err?.code || err?.message || err}`));
    // close 在输出都读完之后才来，最后那行报错不会漏
    p.once('close', (code, signal) => end(code, signal, failReason));
    waitApiReady(myGen).then((ok) => {
      if (myGen !== gen || child !== p) return;
      if (ok) {
        state = 'running';
        error = null;
        o.log.info(`[proxy] mihomo 已启动（${run.config.proxies.length} 个节点）`);
        settleWaiters(null);
      } else {
        // 控制接口一直不通：当成启动失败，杀掉重来
        failReason = lastError() || 'mihomo 启动后控制接口一直连不上';
        error = failReason;
        try {
          p.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    });
  }

  function onExit(myGen, code, signal, reason) {
    if (myGen !== gen) return;
    process.off('exit', killOnExit);
    child = null;
    if (!desired) {
      state = 'stopped';
      return;
    }
    // 意外退出：记原因，退避后重启。正常跑过一阵（stableMs）的从头算退避
    if (Date.now() - startedAt >= backoff.stableMs) failures = 0;
    failures++;
    const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** (failures - 1));
    const why = reason || lastError() || (signal ? `被信号 ${signal} 结束` : `退出码 ${code}`);
    state = 'error';
    error = why;
    o.log.warn(`[proxy] mihomo 退出了（${signal || `退出码 ${code}`}）：${why}；${Math.round(delay / 1000)} 秒后重启`);
    settleWaiters(new Error(why));
    restartAt = Date.now() + delay;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartAt = null;
      launch();
    }, delay);
    restartTimer.unref?.();
  }

  async function killChild() {
    const p = child;
    if (!p) return;
    gen++; // 之后的退出事件、就绪检查都不再算数
    child = null;
    process.off('exit', killOnExit);
    await new Promise((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        setTimeout(resolve, 1000).unref?.();
      }, STOP_TIMEOUT_MS);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        p.kill('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  return {
    configPath,
    /**
     * 按这份配置运行：和正在跑的一样就不动，否则写配置、重启。
     * @param {any} config buildMihomoConfig 的结果
     * @param {string[]} redactions 输出里要抹掉的字符串
     */
    async apply(config, redactions = []) {
      const fingerprint = JSON.stringify(config);
      if (desired && desired.fingerprint === fingerprint && (state === 'running' || state === 'starting' || restartTimer)) return 'unchanged';
      desired = { config, fingerprint, redactions };
      error = null;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      restartAt = null;
      failures = 0;
      const had = !!child;
      await killChild();
      launch();
      return had ? 'restarted' : 'started';
    },
    async stop() {
      desired = null;
      current = null;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      restartAt = null;
      failures = 0;
      await killChild();
      state = 'stopped';
      error = null;
      settleWaiters(new Error('全局代理已关闭'));
    },
    /** 等到 running；出错、超时或停了时抛错（信息可以直接给用户看） */
    waitReady(timeoutMs = READY_TIMEOUT_MS) {
      if (state === 'running') return Promise.resolve();
      if (!desired) return Promise.reject(new Error('全局代理没有在运行'));
      if (state === 'error' && error) return Promise.reject(new Error(error));
      return new Promise((resolve, reject) => {
        const w = { resolve, reject };
        const t = setTimeout(() => {
          waiters = waiters.filter((x) => x !== w);
          reject(new Error('全局代理还没启动好，请稍后再试'));
        }, timeoutMs);
        t.unref?.();
        w.resolve = () => {
          clearTimeout(t);
          resolve();
        };
        w.reject = (err) => {
          clearTimeout(t);
          reject(err);
        };
        waiters.push(w);
      });
    },
    status() {
      return { state, error, pid: child?.pid ?? null, restartAt: restartAt ? new Date(restartAt).toISOString() : null, output: [...output] };
    },
    api,
  };
}

/** 随机的账号或密码（只有字母数字和 -_，拼进代理地址不用编码） */
export const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');
