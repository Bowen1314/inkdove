// 在线更新：假 GitHub（GET /repos/<repo>/releases/latest）和假更新助手（POST /v1/update）都是本地 HTTP 服务，不访问外网；
// 时钟注入（createApp 的 updateNow）。覆盖：版本比较和钉版本判断、启动后延迟首查、关闭检测时不发请求、只有 admin、
// 60 秒内不重查、预发布不提示、GitHub 出错、自定义仓库、数据库备份文件和保留份数、备份失败不更新、
// 更新助手未配置 / 口令错 / 出错 / 连不上 / 成功 / 迟迟不回话（按已经开始更新处理）、同一时间只允许一个更新。
// 预约更新（定时检查用 updateScheduleTickMs=0 关掉，手动调 ctx.update.tick()；重启用预先写好 kv 的数据目录模拟）：
// 权限、时间范围和格式、条件不满足、覆盖旧预约、取消、到点执行（只执行一次、等重启期间不能改、10 分钟没重启记失败）、
// 到点时有更新的版本（x.y 浮动标签升不到新的小版本时按预约时的版本）、更新助手迟迟不回话、执行失败记原因不重试、
// 立即更新后预约作废、定时器、重启后已经是新版本 / 错过 1 小时以上 / 不到 1 小时照常执行 / 更新了没升上去 / 条件不满足、
// 重启不丢、等重启时记了失败但后来升上去了改记成功。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { kvGet, kvSet, openDb } from '../src/db.js';
import {
  KEEP_BACKUPS,
  SCHEDULE_MAX_AHEAD_MS,
  SCHEDULE_MIN_AHEAD_MS,
  SCHEDULE_MISS_MS,
  UPDATE_CHECK_MIN_GAP_MS,
  UPDATE_LOCK_MS,
  UPDATER_API,
  compareVersions,
  isPinned,
  parseVersion,
} from '../src/update.js';
import { ADMIN_EMAIL, sleep, startApp, waitFor } from './helpers.js';

const CURRENT = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const cur = parseVersion(CURRENT);
/** 比当前新一个小版本 */
const NEXT = `${cur.major}.${cur.minor + 1}.0`;
const TOKEN = 'updater-token-for-tests-0123456789';

const release = (tag, extra = {}) => ({
  tag_name: tag,
  name: `墨鸽 ${tag}`,
  html_url: `https://github.com/Bowen1314/inkdove/releases/tag/${tag}`,
  published_at: '2026-10-10T08:00:00Z',
  body: '## 更新\n- <b>修复</b> 一些问题',
  prerelease: false,
  draft: false,
  ...extra,
});

/** 假 GitHub：state.status 不是 200 时返回错误体，state.headers 附加响应头 */
async function startFakeGithub() {
  const state = { requests: [], status: 200, headers: {}, release: release(`v${NEXT}`) };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, path: req.url, headers: req.headers });
    res.writeHead(state.status, { 'content-type': 'application/json', ...state.headers });
    res.end(JSON.stringify(state.status === 200 ? state.release : { message: 'error' }));
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

/** 假更新助手：记录请求，state.status 是响应码，state.delayMs 让它晚点回 */
async function startFakeUpdater() {
  const state = { requests: [], status: 202, delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // 读完请求体
    }
    const u = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers });
    if (state.delayMs) await sleep(state.delayMs);
    res.writeHead(state.status, { 'content-type': 'text/plain' });
    res.end(state.status >= 400 ? 'something went wrong' : '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    reset() {
      state.requests = [];
      state.status = 202;
      state.delayMs = 0;
    },
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

let gh;
let updater;
const clock = { now: Date.parse('2026-10-12T08:00:00.000Z') };

/** 起一个打开了检查更新的实例并以 admin 登录 */
async function boot({ env = {}, options = {} } = {}) {
  const t = await startApp({
    env: { INKDOVE_UPDATE_CHECK: '1', INKDOVE_UPDATER_TOKEN: TOKEN, INKDOVE_UPDATER_URL: updater.url, ...env },
    options: { githubApiUrl: gh.url, updateNow: () => clock.now, ...options },
  });
  await t.login();
  return t;
}

/** 跳过 60 秒的最短间隔再查一次 */
async function recheck(t) {
  clock.now += UPDATE_CHECK_MIN_GAP_MS;
  const r = await t.req('POST', '/api/update/check');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** 把等更新助手回话的时间临时调短到 0.2 秒，假更新助手 1 秒后才回（app 和测试在同一个进程里，用的是同一个 UPDATER_API） */
async function withSlowUpdater(fn) {
  const saved = UPDATER_API.timeoutMs;
  UPDATER_API.timeoutMs = 200;
  updater.state.delayMs = 1000;
  try {
    return await fn();
  } finally {
    UPDATER_API.timeoutMs = saved;
  }
}

const backupsOf = (t) => {
  const dir = path.join(t.dataDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

before(async () => {
  gh = await startFakeGithub();
  updater = await startFakeUpdater();
});

after(async () => {
  await gh.close();
  await updater.close();
});

beforeEach(() => {
  gh.state.requests = [];
  gh.state.status = 200;
  gh.state.headers = {};
  gh.state.release = release(`v${NEXT}`);
  updater.reset();
});

describe('版本号', () => {
  it('解析和比较，预发布比正式版旧', () => {
    assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' });
    assert.equal(parseVersion('1.2.3-rc.1').pre, 'rc.1');
    assert.equal(parseVersion('1.2'), null);
    assert.equal(parseVersion('latest'), null);
    assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('v1.0.1', '1.0.0') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
    assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
    assert.equal(compareVersions('abc', '1.0.0'), 0);
  });

  it('钉版本：latest 和同一小版本的 x.y 不算钉，完整版本号、别的 x.y、自定义标签算钉', () => {
    assert.equal(isPinned('latest', '0.2.0'), false);
    assert.equal(isPinned('0.2', '0.2.5'), false);
    assert.equal(isPinned('0.2', undefined), false);
    assert.equal(isPinned('0.1', '0.2.0'), true);
    assert.equal(isPinned('0.1.0', '0.2.0'), true);
    assert.equal(isPinned('0.2.0', null), true);
    assert.equal(isPinned('main', '0.2.0'), true);
  });
});

describe('检查更新', () => {
  let t;
  before(async () => {
    t = await boot();
  });
  after(async () => {
    await t.close();
  });

  it('还没查过时没有最新版本；查到新版本后返回发布信息，正文原样当纯文本', async () => {
    const r0 = await t.req('GET', '/api/update');
    assert.equal(r0.status, 200);
    assert.equal(r0.body.current, CURRENT);
    assert.equal(r0.body.latest, null);
    assert.equal(r0.body.available, false);
    assert.equal(r0.body.checkedAt, null);
    assert.equal(r0.body.checkEnabled, true);
    assert.equal(gh.state.requests.length, 0, '没有定时器、也没人点检查时不请求 GitHub');

    const s = await recheck(t);
    assert.equal(gh.state.requests.length, 1);
    const req = gh.state.requests[0];
    assert.equal(req.path, '/repos/Bowen1314/inkdove/releases/latest');
    assert.equal(req.headers['user-agent'], `inkdove/${CURRENT}`);
    assert.match(req.headers.accept, /application\/vnd\.github\+json/);
    assert.equal(s.available, true);
    assert.deepEqual(s.latest, {
      version: NEXT,
      name: `墨鸽 v${NEXT}`,
      url: `https://github.com/Bowen1314/inkdove/releases/tag/v${NEXT}`,
      publishedAt: '2026-10-10T08:00:00.000Z',
      notes: '## 更新\n- <b>修复</b> 一些问题',
    });
    assert.equal(s.error, null);
    assert.equal(s.checkedAt, new Date(clock.now).toISOString());
    assert.equal(s.image, 'ghcr.io/bowen1314/inkdove:latest');
    assert.equal(s.pinned, false);
    assert.deepEqual(s.updater, { configured: true, reachable: true });
  });

  it('60 秒内再点检查直接给上次的结果，不再请求 GitHub', async () => {
    await recheck(t);
    assert.equal(gh.state.requests.length, 1);
    clock.now += UPDATE_CHECK_MIN_GAP_MS - 1000;
    const r = await t.req('POST', '/api/update/check');
    assert.equal(r.status, 200);
    assert.equal(r.body.latest.version, NEXT);
    assert.equal(gh.state.requests.length, 1);
    clock.now += 1000;
    await t.req('POST', '/api/update/check');
    assert.equal(gh.state.requests.length, 2);
  });

  it('同时点两次只请求一次', async () => {
    clock.now += UPDATE_CHECK_MIN_GAP_MS;
    const [a, b] = await Promise.all([t.req('POST', '/api/update/check'), t.req('POST', '/api/update/check')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(gh.state.requests.length, 1);
  });

  it('预发布、和当前一样的版本都不提示更新', async () => {
    gh.state.release = release(`v${NEXT}-rc.1`);
    let s = await recheck(t);
    assert.equal(s.latest, null);
    assert.equal(s.available, false);

    gh.state.release = release(`v${NEXT}`, { prerelease: true });
    s = await recheck(t);
    assert.equal(s.latest, null);

    gh.state.release = release(`v${CURRENT}`);
    s = await recheck(t);
    assert.equal(s.latest.version, CURRENT);
    assert.equal(s.available, false);
  });

  it('GitHub 出错时记下原因，保留上次查到的结果', async () => {
    await recheck(t);
    gh.state.status = 403;
    gh.state.headers = { 'x-ratelimit-remaining': '0' };
    let s = await recheck(t);
    assert.match(s.error, /限流/);
    assert.equal(s.latest.version, NEXT);
    assert.equal(s.available, true);

    gh.state.headers = {};
    gh.state.status = 404;
    s = await recheck(t);
    assert.match(s.error, /没找到 Bowen1314\/inkdove 的正式发布/);

    gh.state.status = 200;
    gh.state.release = release('nightly');
    s = await recheck(t);
    assert.match(s.error, /不是版本号/);

    gh.state.release = release(`v${NEXT}`);
    s = await recheck(t);
    assert.equal(s.error, null);
    assert.ok(t.log.lines.some((l) => l.startsWith('warn [update] 检查新版本失败')));
  });

  it('release 链接不是 https 时换成仓库的发布页', async () => {
    gh.state.release = release(`v${NEXT}`, { html_url: 'javascript:alert(1)' });
    const s = await recheck(t);
    assert.equal(s.latest.url, `https://github.com/Bowen1314/inkdove/releases/tag/v${NEXT}`);
  });

  it('只有 admin：agent 403，未登录 401', async () => {
    const { cookie } = await t.addMember({ email: 'agent-update@example.com', role: 'agent' });
    for (const [method, p] of [
      ['GET', '/api/update'],
      ['POST', '/api/update/check'],
      ['POST', '/api/update/apply'],
      ['POST', '/api/update/schedule'],
      ['DELETE', '/api/update/schedule'],
    ]) {
      assert.equal((await t.req(method, p, { cookie })).status, 403, `${method} ${p}`);
      assert.equal((await t.req(method, p, { auth: false })).status, 401, `${method} ${p}`);
    }
    assert.equal(updater.state.requests.length, 0);
  });
});

describe('定时检查和关闭检测', () => {
  it('启动后延迟一段时间先查一次', async () => {
    const t = await boot({ options: { updateFirstCheckMs: 20, updateCheckIntervalMs: 3600_000 } });
    try {
      await waitFor(() => gh.state.requests.length === 1, { message: '没有自动检查' });
      await waitFor(async () => (await t.req('GET', '/api/update')).body.available);
    } finally {
      await t.close();
    }
  });

  it('INKDOVE_UPDATE_CHECK=0 时不发任何请求，手动检查返回 400', async () => {
    const t = await boot({ env: { INKDOVE_UPDATE_CHECK: '0' }, options: { updateFirstCheckMs: 5, updateCheckIntervalMs: 20 } });
    try {
      await sleep(120);
      const s = await t.req('GET', '/api/update');
      assert.equal(s.status, 200);
      assert.equal(s.body.checkEnabled, false);
      assert.equal(s.body.latest, null);
      assert.equal(s.body.available, false);
      const c = await t.req('POST', '/api/update/check');
      assert.equal(c.status, 400);
      assert.equal(c.body.code, 'update_check_disabled');
      const a = await t.req('POST', '/api/update/apply');
      assert.equal(a.body.code, 'no_update');
      assert.equal(gh.state.requests.length, 0);
      assert.equal(updater.state.requests.length, 0);
    } finally {
      await t.close();
    }
  });

  it('INKDOVE_UPDATE_REPO 换仓库：查这个仓库，镜像名跟着变成小写', async () => {
    const t = await boot({ env: { INKDOVE_UPDATE_REPO: 'Acme/Inkdove-Fork' } });
    try {
      const s = await recheck(t);
      assert.equal(gh.state.requests[0].path, '/repos/Acme/Inkdove-Fork/releases/latest');
      assert.equal(s.image, 'ghcr.io/acme/inkdove-fork:latest');
    } finally {
      await t.close();
    }
  });

  it('INKDOVE_UPDATE_REPO、INKDOVE_IMAGE_TAG 格式不对时启动报错', () => {
    const base = {
      INKDOVE_ADMIN_EMAIL: 'admin@example.com',
      INKDOVE_ADMIN_PASSWORD: 'test-password-123',
      INKDOVE_SESSION_SECRET: 's',
      INKDOVE_WAHA_WEBHOOK_SECRET: 's',
    };
    assert.throws(() => loadConfig({ ...base, INKDOVE_UPDATE_REPO: 'not a repo' }), /INKDOVE_UPDATE_REPO/);
    assert.throws(() => loadConfig({ ...base, INKDOVE_IMAGE_TAG: 'a b' }), /INKDOVE_IMAGE_TAG/);
    const c = loadConfig(base);
    assert.equal(c.updateCheck, true);
    assert.equal(c.updateRepo, 'Bowen1314/inkdove');
    assert.equal(c.updaterUrl, 'http://updater:8080');
    assert.equal(c.updaterToken, '');
    assert.equal(c.imageTag, 'latest');
    assert.equal(loadConfig({ ...base, INKDOVE_UPDATE_CHECK: '0' }).updateCheck, false);
  });

  it('没设口令时更新助手算没装；口令设了但连不上时 reachable=false', async () => {
    const a = await boot({ env: { INKDOVE_UPDATER_TOKEN: '' } });
    const b = await boot({ env: { INKDOVE_UPDATER_URL: 'http://127.0.0.1:9' } });
    try {
      assert.deepEqual((await a.req('GET', '/api/update')).body.updater, { configured: false });
      assert.deepEqual((await b.req('GET', '/api/update')).body.updater, { configured: true, reachable: false });
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('一键更新', () => {
  let t;
  before(async () => {
    t = await boot();
  });
  after(async () => {
    await t.close();
  });
  afterEach(() => {
    // 成功后的锁过期，不影响下一个用例
    clock.now += UPDATE_LOCK_MS;
  });

  it('还没有新版本时 400 no_update，不备份也不调更新助手', async () => {
    const r = await t.req('POST', '/api/update/apply');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'no_update');
    gh.state.release = release(`v${CURRENT}`);
    await recheck(t);
    assert.equal((await t.req('POST', '/api/update/apply')).body.code, 'no_update');
    assert.deepEqual(backupsOf(t), []);
    assert.equal(updater.state.requests.length, 0);
  });

  it('成功：先备份数据库，再带口令调更新助手，只更新应用镜像', async () => {
    await recheck(t);
    const r = await t.req('POST', '/api/update/apply');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.from, CURRENT);
    assert.equal(r.body.to, NEXT);
    assert.match(r.body.backup, new RegExp(`^backups/inkdove-v${CURRENT.replace(/\./g, '\\.')}-\\d{8}T\\d{6}Z\\.db$`));

    assert.equal(updater.state.requests.length, 1);
    const req = updater.state.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/update');
    assert.deepEqual(req.query, { image: 'ghcr.io/bowen1314/inkdove', async: 'true' });
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);

    // 备份是一个完整可读的 SQLite 库
    const file = path.join(t.dataDir, r.body.backup);
    assert.ok(fs.existsSync(file));
    const copy = new Database(file, { readonly: true });
    try {
      assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 1);
    } finally {
      copy.close();
    }
    // 日志里不出现口令
    assert.ok(t.log.lines.every((l) => !l.includes(TOKEN)));
  });

  it('更新成功后一段时间内再点返回 409，过了这段时间可以再更新', async () => {
    await recheck(t);
    assert.equal((await t.req('POST', '/api/update/apply')).status, 200);
    const again = await t.req('POST', '/api/update/apply');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'update_in_progress');
    assert.equal(updater.state.requests.length, 1);
    clock.now += UPDATE_LOCK_MS;
    assert.equal((await t.req('POST', '/api/update/apply')).status, 200);
    assert.equal(updater.state.requests.length, 2);
  });

  it('同时点两次：只有一个去更新，另一个 409', async () => {
    await recheck(t);
    updater.state.delayMs = 200;
    const rs = await Promise.all([t.req('POST', '/api/update/apply'), t.req('POST', '/api/update/apply')]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(rs.find((r) => r.status === 409).body.code, 'update_in_progress');
    assert.equal(updater.state.requests.length, 1);
  });

  it('更新助手出错：502 updater_failed 带中文原因，锁放开可以重试', async () => {
    await recheck(t);
    updater.state.status = 500;
    let r = await t.req('POST', '/api/update/apply');
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'updater_failed');
    assert.match(r.body.error, /更新助手返回 HTTP 500：something went wrong/);

    updater.state.status = 401;
    r = await t.req('POST', '/api/update/apply');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /口令不对/);
    assert.equal(updater.state.requests.length, 2);

    updater.state.status = 200;
    r = await t.req('POST', '/api/update/apply');
    assert.equal(r.status, 200, '同步模式返回 200 也算成功');
  });

  it('更新助手迟迟不回话：按已经开始更新处理（返回成功、锁住），再点 409，不会再触发一次', async () => {
    await recheck(t);
    await withSlowUpdater(async () => {
      const r = await t.req('POST', '/api/update/apply');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.to, NEXT);
      assert.match(r.body.backup, /^backups\/inkdove-v.+\.db$/);
      const again = await t.req('POST', '/api/update/apply');
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'update_in_progress');
    });
    assert.equal(updater.state.requests.length, 1);
    assert.ok(t.log.lines.some((l) => l.startsWith('warn [update] 更新助手 0.2 秒没有回应，按已经开始更新处理')));
  });

  it('更新前的备份只留最近 5 份，别的文件不碰', async () => {
    await recheck(t);
    const dir = path.join(t.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    for (const n of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, n));
    // 6 份旧备份，修改时间从 2020 年往后排
    const old = [];
    for (let i = 1; i <= 6; i++) {
      const name = `inkdove-v0.0.${i}-2020010${i}T000000Z.db`;
      fs.writeFileSync(path.join(dir, name), 'old');
      const when = new Date(Date.UTC(2020, 0, i));
      fs.utimesSync(path.join(dir, name), when, when);
      old.push(name);
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), '别删我');

    updater.state.status = 500; // 失败也已经备份了，锁会放开，方便连着点
    for (let i = 0; i < 2; i++) assert.equal((await t.req('POST', '/api/update/apply')).status, 502);
    updater.state.status = 202;
    const ok = await t.req('POST', '/api/update/apply');
    assert.equal(ok.status, 200);

    const files = backupsOf(t);
    assert.ok(files.includes('notes.txt'));
    const kept = files.filter((n) => n.startsWith('inkdove-v'));
    assert.equal(kept.length, KEEP_BACKUPS);
    // 3 份新备份（同一秒里的加了序号）+ 最新的 2 份旧备份
    assert.equal(kept.filter((n) => n.startsWith(`inkdove-v${CURRENT}-`)).length, 3);
    assert.ok(kept.includes(path.basename(ok.body.backup)));
    assert.deepEqual(kept.filter((n) => old.includes(n)), [old[4], old[5]]);
  });

  it('备份失败就不更新（500 backup_failed，不调更新助手）', async () => {
    await recheck(t);
    const dir = path.join(t.dataDir, 'backups');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, '这里本该是目录');
    try {
      const r = await t.req('POST', '/api/update/apply');
      assert.equal(r.status, 500);
      assert.equal(r.body.code, 'backup_failed');
      assert.match(r.body.error, /备份数据库失败，没有更新/);
      assert.equal(updater.state.requests.length, 0);
    } finally {
      fs.rmSync(dir, { force: true });
    }
    // 锁已放开
    assert.equal((await t.req('POST', '/api/update/apply')).status, 200);
  });

  it('没配更新助手时 400 updater_not_configured；连不上时 502；镜像钉了版本时 400 image_pinned', async () => {
    const none = await boot({ env: { INKDOVE_UPDATER_TOKEN: '' } });
    const down = await boot({ env: { INKDOVE_UPDATER_URL: 'http://127.0.0.1:9' } });
    const pinned = await boot({ env: { INKDOVE_IMAGE_TAG: CURRENT } });
    const minor = await boot({ env: { INKDOVE_IMAGE_TAG: `${cur.major}.${cur.minor + 1}` } });
    try {
      await recheck(none);
      let r = await none.req('POST', '/api/update/apply');
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'updater_not_configured');
      assert.deepEqual(backupsOf(none), []);

      await recheck(down);
      r = await down.req('POST', '/api/update/apply');
      assert.equal(r.status, 502);
      assert.equal(r.body.code, 'updater_failed');
      assert.match(r.body.error, /连不上更新助手/);

      const s = await recheck(pinned);
      assert.equal(s.pinned, true);
      assert.equal(s.image, `ghcr.io/bowen1314/inkdove:${CURRENT}`);
      r = await pinned.req('POST', '/api/update/apply');
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'image_pinned');
      assert.deepEqual(backupsOf(pinned), []);

      // x.y 浮动标签和新版本同一个小版本：能一键升级
      assert.equal((await recheck(minor)).pinned, false);
      assert.equal((await minor.req('POST', '/api/update/apply')).status, 200);
      assert.equal(updater.state.requests.length, 1);
    } finally {
      await none.close();
      await down.close();
      await pinned.close();
      await minor.close();
    }
  });
});

// ============ 预约更新 ============

const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
/** 现在之后 ms 的 ISO 时间（UTC） */
const later = (ms) => iso(clock.now + ms);
/** 同一个时刻写成带 +HH:MM 的 ISO 时间 */
function withOffset(ms, offsetMin) {
  const local = new Date(ms + offsetMin * MIN).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMin);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${local}${offsetMin >= 0 ? '+' : '-'}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}
const scheduleOf = (t) => kvGet(t.ctx.db, 'update_schedule', null);
const resultOf = (t) => kvGet(t.ctx.db, 'update_schedule_result', null);
const scheduleAt = (t, at) => t.req('POST', '/api/update/schedule', { body: { at } });
const getStatus = async (t) => (await t.req('GET', '/api/update')).body;

describe('预约更新', () => {
  let t;
  let adminId;
  before(async () => {
    t = await boot({ options: { updateScheduleTickMs: 0 } });
    adminId = (await t.req('GET', '/api/auth/me')).body.user.id;
  });
  after(async () => {
    await t.close();
  });
  beforeEach(() => {
    // 清掉上一个用例留下的预约和结果，上一个用例的更新锁过期
    kvSet(t.ctx.db, 'update_schedule', null);
    kvSet(t.ctx.db, 'update_schedule_result', null);
    clock.now += UPDATE_LOCK_MS;
  });

  it('预约：存进库，GET /api/update 带上 schedule（没有时是 null）；没到点不更新', async () => {
    const s0 = await getStatus(t);
    assert.equal(s0.schedule, null);
    assert.equal(s0.scheduleResult, null);

    await recheck(t);
    const at = later(3 * HOUR);
    const r = await scheduleAt(t, at);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const expected = {
      at,
      targetVersion: NEXT,
      scheduledBy: { id: adminId, email: ADMIN_EMAIL },
      createdAt: iso(clock.now),
    };
    assert.deepEqual(r.body.schedule, expected, '返回的是 GET /api/update 的形状，带上新的预约');
    assert.equal(r.body.current, CURRENT);
    assert.deepEqual((await getStatus(t)).schedule, expected);
    assert.deepEqual(scheduleOf(t), expected);
    assert.ok(t.log.lines.some((l) => l === `info [update] ${ADMIN_EMAIL} 预约在 ${at} 更新到 v${NEXT}`));

    clock.now += 2 * HOUR;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 0);
    assert.deepEqual(scheduleOf(t), expected);
  });

  it('带时区偏移、不带秒、带微秒的 ISO 时间也行，统一存成 UTC', async () => {
    await recheck(t);
    const ms = clock.now + 2 * HOUR;
    let r = await scheduleAt(t, withOffset(ms, 8 * 60));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.schedule.at, iso(ms));
    r = await scheduleAt(t, withOffset(ms, -4 * 60).slice(0, 16) + '-04:00');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.schedule.at, iso(Math.floor(ms / MIN) * MIN));
    r = await scheduleAt(t, iso(ms).replace(/Z$/, '456Z'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.schedule.at, iso(ms));
  });

  it('时间要在 1 分钟之后、7 天之内，要写成带时区的 ISO 时间', async () => {
    await recheck(t);
    const bad = [
      undefined,
      '',
      12345,
      'tomorrow',
      '2026-10-14 03:00',
      later(2 * HOUR).replace(/Z$/, ''), // 没带时区
      later(SCHEDULE_MIN_AHEAD_MS - 1000),
      later(-MIN),
      later(SCHEDULE_MAX_AHEAD_MS + 1000),
    ];
    for (const at of bad) {
      const r = await scheduleAt(t, at);
      assert.equal(r.status, 400, `${at}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'bad_time', String(at));
    }
    assert.match((await scheduleAt(t, later(-MIN))).body.error, /1 分钟之后、7 天之内/);
    assert.equal(scheduleOf(t), null);
    // 边界：正好 1 分钟、正好 7 天都行
    assert.equal((await scheduleAt(t, later(SCHEDULE_MIN_AHEAD_MS))).status, 200);
    assert.equal((await scheduleAt(t, later(SCHEDULE_MAX_AHEAD_MS))).status, 200);
    assert.equal(scheduleOf(t).at, later(SCHEDULE_MAX_AHEAD_MS));
  });

  it('条件和立即更新一样：没装更新助手、镜像钉了版本、没有新版本时不能预约，什么都不存', async () => {
    const none = await boot({ env: { INKDOVE_UPDATER_TOKEN: '' }, options: { updateScheduleTickMs: 0 } });
    const pinned = await boot({ env: { INKDOVE_IMAGE_TAG: CURRENT }, options: { updateScheduleTickMs: 0 } });
    const fresh = await boot({ options: { updateScheduleTickMs: 0 } });
    try {
      await recheck(none);
      let r = await scheduleAt(none, later(HOUR));
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'updater_not_configured');

      await recheck(pinned);
      r = await scheduleAt(pinned, later(HOUR));
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'image_pinned');

      // 还没查过 GitHub
      r = await scheduleAt(fresh, later(HOUR));
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'no_update');
      // 查过了，已经是最新
      gh.state.release = release(`v${CURRENT}`);
      await recheck(fresh);
      r = await scheduleAt(fresh, later(HOUR));
      assert.equal(r.body.code, 'no_update');

      for (const x of [none, pinned, fresh]) assert.equal(scheduleOf(x), null);
    } finally {
      await none.close();
      await pinned.close();
      await fresh.close();
    }
  });

  it('再预约就覆盖旧的，同时只有一个；到旧时间不会更新', async () => {
    await recheck(t);
    const a = later(2 * HOUR);
    const b = later(5 * HOUR);
    assert.equal((await scheduleAt(t, a)).status, 200);
    const r = await scheduleAt(t, b);
    assert.equal(r.status, 200);
    assert.equal(r.body.schedule.at, b);
    assert.equal(scheduleOf(t).at, b);
    assert.ok(t.log.lines.some((l) => l.includes(`预约在 ${b} 更新到 v${NEXT}（替换了原来 ${a} 的预约）`)));

    clock.now = Date.parse(a) + MIN;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 0);
    assert.equal(scheduleOf(t).at, b);
  });

  it('取消：清掉预约，打日志；没有预约时取消也算成功；到原来的时间不更新', async () => {
    await recheck(t);
    const at = later(HOUR);
    await scheduleAt(t, at);
    const r = await t.req('DELETE', '/api/update/schedule');
    assert.equal(r.status, 200);
    assert.equal(r.body.schedule, null);
    assert.equal(scheduleOf(t), null);
    assert.ok(
      t.log.lines.some((l) => l === `info [update] ${ADMIN_EMAIL} 取消了预约（原定 ${at} 更新到 v${NEXT}，${ADMIN_EMAIL} 预约的）`),
    );
    assert.equal((await t.req('DELETE', '/api/update/schedule')).status, 200);

    clock.now += 2 * HOUR;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 0);
    assert.equal(resultOf(t), null);
  });

  it('到点执行：先查一次 GitHub、备份数据库、再调更新助手，只执行一次；等重启期间不能取消、改时间或立即更新', async () => {
    await recheck(t);
    const at = later(30 * MIN);
    await scheduleAt(t, at);

    clock.now = Date.parse(at) - 1000;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 0, '还差 1 秒');

    clock.now = Date.parse(at) + 20_000;
    const ghBefore = gh.state.requests.length;
    await t.ctx.update.tick();
    assert.equal(gh.state.requests.length, ghBefore + 1, '到点先查一次 GitHub');
    assert.equal(updater.state.requests.length, 1);
    const req = updater.state.requests[0];
    assert.equal(req.path, '/v1/update');
    assert.deepEqual(req.query, { image: 'ghcr.io/bowen1314/inkdove', async: 'true' });
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);

    const s = await getStatus(t);
    assert.equal(s.schedule.at, at);
    assert.equal(s.schedule.startedAt, iso(clock.now));
    assert.equal(s.schedule.from, CURRENT);
    assert.equal(s.schedule.to, NEXT);
    assert.match(s.schedule.backup, /^backups\/inkdove-v.+\.db$/);
    assert.ok(fs.existsSync(path.join(t.dataDir, s.schedule.backup)), '更新前备份了数据库');
    assert.equal(s.scheduleResult, null, '还在等新版本启动，没有结果');
    assert.ok(t.log.lines.some((l) => l === `info [update] 到了 ${ADMIN_EMAIL} 预约的时间（${at}），开始更新：v${CURRENT} → v${NEXT}`));
    assert.ok(t.log.lines.some((l) => l.startsWith(`info [update] 已让更新助手更新到 v${NEXT}`)));

    // 再看几次也不会再调更新助手
    clock.now += MIN;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 1);

    const del = await t.req('DELETE', '/api/update/schedule');
    assert.equal(del.status, 409);
    assert.equal(del.body.code, 'update_in_progress');
    assert.equal((await scheduleAt(t, later(HOUR))).status, 409);
    assert.equal((await t.req('POST', '/api/update/apply')).status, 409);
    assert.equal(scheduleOf(t).startedAt, s.schedule.startedAt);

    // 10 分钟了服务还没重启到新版本：清掉预约、记失败，不再调更新助手
    clock.now = Date.parse(s.schedule.startedAt) + UPDATE_LOCK_MS;
    await t.ctx.update.tick();
    assert.equal(scheduleOf(t), null);
    const res = resultOf(t);
    assert.equal(res.outcome, 'failed');
    assert.equal(res.at, at);
    assert.equal(res.from, CURRENT);
    assert.equal(res.to, NEXT);
    assert.match(res.error, new RegExp(`过了 10 分钟还是 v${CURRENT.replace(/\./g, '\\.')}，没有更新到 v${NEXT.replace(/\./g, '\\.')}`));
    assert.equal(res.updaterCalled, true, '已经让更新助手更新了：新版本后来起来了还能改记成功');
    assert.deepEqual((await getStatus(t)).scheduleResult, res);
    assert.equal(updater.state.requests.length, 1);
  });

  it('到点时 GitHub 上已经有更新的版本：更到最新', async () => {
    await recheck(t);
    await scheduleAt(t, later(HOUR));
    const NEWER = `${cur.major}.${cur.minor + 2}.0`;
    gh.state.release = release(`v${NEWER}`);
    clock.now += HOUR;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 1);
    const s = scheduleOf(t);
    assert.equal(s.targetVersion, NEXT);
    assert.equal(s.to, NEWER);
    assert.ok(t.log.lines.some((l) => l.endsWith(`开始更新：v${CURRENT} → v${NEWER}`)));
  });

  it('镜像是 x.y 浮动标签：到点时出了下一个小版本（升不上去）按预约时的版本更新，同一个小版本的更新照样更到最新', async () => {
    const tag = `${cur.major}.${cur.minor + 1}`;
    const a = await boot({ env: { INKDOVE_IMAGE_TAG: tag }, options: { updateScheduleTickMs: 0 } });
    const b = await boot({ env: { INKDOVE_IMAGE_TAG: tag }, options: { updateScheduleTickMs: 0 } });
    try {
      await recheck(a);
      await recheck(b);
      assert.equal((await scheduleAt(a, later(HOUR))).status, 200);
      assert.equal((await scheduleAt(b, later(HOUR))).status, 200);
      clock.now += HOUR;

      // 下一个小版本：x.y 标签拉不到，按预约时的 NEXT 更新，不记失败
      const OTHER_MINOR = `${cur.major}.${cur.minor + 2}.0`;
      gh.state.release = release(`v${OTHER_MINOR}`);
      await a.ctx.update.tick();
      assert.equal(updater.state.requests.length, 1);
      assert.equal(scheduleOf(a).to, NEXT);
      assert.ok(scheduleOf(a).startedAt);
      assert.equal(resultOf(a), null);
      assert.ok(a.log.lines.some((l) => l === `info [update] GitHub 上最新的 v${OTHER_MINOR} 一键更新升不上去，按预约时的 v${NEXT} 更新`));
      assert.ok(a.log.lines.some((l) => l.endsWith(`开始更新：v${CURRENT} → v${NEXT}`)));

      // 同一个小版本的补丁版：x.y 标签拉得到，更到它
      const PATCH = `${cur.major}.${cur.minor + 1}.3`;
      gh.state.release = release(`v${PATCH}`);
      clock.now += UPDATE_CHECK_MIN_GAP_MS;
      await b.ctx.update.tick();
      assert.equal(updater.state.requests.length, 2);
      assert.equal(scheduleOf(b).to, PATCH);
      assert.equal(resultOf(b), null);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('到点时更新助手迟迟不回话：按已经开始更新处理，等新版本启动，不记失败、不再触发；10 分钟还没升上去才记失败', async () => {
    await recheck(t);
    await scheduleAt(t, later(HOUR));
    clock.now += HOUR;
    await withSlowUpdater(() => t.ctx.update.tick());
    assert.equal(updater.state.requests.length, 1);
    const s = scheduleOf(t);
    assert.equal(s.startedAt, iso(clock.now));
    assert.equal(s.from, CURRENT);
    assert.equal(s.to, NEXT);
    assert.match(s.backup, /^backups\/inkdove-v.+\.db$/);
    assert.equal(resultOf(t), null, '没有记失败');

    // 等新版本启动期间：再看几次、点立即更新、改预约都不会再触发
    clock.now += MIN;
    await t.ctx.update.tick();
    assert.equal((await t.req('POST', '/api/update/apply')).status, 409);
    assert.equal((await scheduleAt(t, later(HOUR))).status, 409);
    assert.equal(updater.state.requests.length, 1);
    assert.equal(scheduleOf(t).startedAt, s.startedAt);

    clock.now = Date.parse(s.startedAt) + UPDATE_LOCK_MS;
    await t.ctx.update.tick();
    const res = resultOf(t);
    assert.equal(res.outcome, 'failed');
    assert.equal(res.updaterCalled, true);
    assert.match(res.error, /已经让更新助手更新，但过了 10 分钟还是 v/);
    assert.equal(scheduleOf(t), null);
    assert.equal(updater.state.requests.length, 1);
  });

  it('执行失败（更新助手出错、备份失败）：清掉预约、记下原因，不自动重试', async () => {
    await recheck(t);
    const at = later(HOUR);
    await scheduleAt(t, at);
    updater.state.status = 500;
    clock.now += HOUR;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 1);
    assert.equal(scheduleOf(t), null);
    const res = resultOf(t);
    assert.equal(res.outcome, 'failed');
    assert.equal(res.at, at);
    assert.equal(res.targetVersion, NEXT);
    assert.equal(res.from, CURRENT);
    assert.equal(res.to, NEXT);
    assert.deepEqual(res.scheduledBy, { id: adminId, email: ADMIN_EMAIL });
    assert.match(res.error, /更新助手返回 HTTP 500：something went wrong/);
    assert.equal(res.finishedAt, iso(clock.now));
    assert.equal(res.updaterCalled, undefined, '更新助手没接手：之后版本变了也不改成成功');
    assert.ok(t.log.lines.some((l) => l.startsWith(`warn [update] ${ADMIN_EMAIL} 预约在 ${at} 更新到 v${NEXT}：失败，更新助手返回 HTTP 500`)));

    clock.now += 5 * MIN;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 1, '不自动重试');

    // 备份失败：不调更新助手
    updater.state.status = 202;
    await scheduleAt(t, later(HOUR));
    const dir = path.join(t.dataDir, 'backups');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, '这里本该是目录');
    try {
      clock.now += HOUR;
      await t.ctx.update.tick();
    } finally {
      fs.rmSync(dir, { force: true });
    }
    assert.equal(updater.state.requests.length, 1);
    assert.equal(scheduleOf(t), null);
    assert.match(resultOf(t).error, /备份数据库失败，没有更新/);
  });

  it('立即更新成功后预约作废；立即更新失败时预约还在', async () => {
    await recheck(t);
    const at = later(HOUR);
    await scheduleAt(t, at);
    updater.state.status = 500;
    assert.equal((await t.req('POST', '/api/update/apply')).status, 502);
    assert.equal(scheduleOf(t).at, at);

    updater.state.status = 202;
    const r = await t.req('POST', '/api/update/apply');
    assert.equal(r.status, 200);
    assert.equal(scheduleOf(t), null);
    assert.equal(resultOf(t), null);
    assert.ok(t.log.lines.some((l) => l === `info [update] ${ADMIN_EMAIL} 点了立即更新，${ADMIN_EMAIL} 预约在 ${at} 的更新作废`));

    clock.now += HOUR;
    await t.ctx.update.tick();
    assert.equal(updater.state.requests.length, 2, '只有立即更新的两次');
  });

  it('不手动调时，定时器每隔一段时间自己看一次', async () => {
    const t2 = await boot({ options: { updateScheduleTickMs: 20 } });
    try {
      await recheck(t2);
      await scheduleAt(t2, later(2 * MIN));
      await sleep(80);
      assert.equal(updater.state.requests.length, 0);
      clock.now += 2 * MIN + 1000;
      await waitFor(() => updater.state.requests.length === 1, { message: '到点没有自动更新' });
      await waitFor(() => scheduleOf(t2)?.startedAt);
    } finally {
      await t2.close();
    }
  });
});

describe('预约更新：重启之后', () => {
  /** 先把预约写进一个新的数据目录，再用它启动（启动时会马上看一次预约） */
  async function bootWith(schedule, { env = {}, options = {}, result } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-test-'));
    const db = openDb(dir);
    kvSet(db, 'update_schedule', schedule);
    if (result) kvSet(db, 'update_schedule_result', result);
    db.close();
    const t = await boot({ env: { INKDOVE_DATA_DIR: dir, ...env }, options });
    const close = t.close;
    t.close = async () => {
      await close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    t.dataDir = dir;
    return t;
  }
  const seeded = (over = {}) => ({
    at: iso(clock.now - 10 * MIN),
    targetVersion: NEXT,
    scheduledBy: { id: 'u_admin', email: ADMIN_EMAIL },
    createdAt: iso(clock.now - 5 * HOUR),
    ...over,
  });

  it('预约存在库里，重启不丢；重启后还没查 GitHub 也能改时间和取消', async () => {
    const s = seeded({ at: iso(clock.now + 2 * HOUR) });
    gh.state.status = 500;
    const t = await bootWith(s);
    try {
      const st = await getStatus(t);
      assert.deepEqual(st.schedule, s);
      assert.equal(st.scheduleResult, null);
      assert.equal(st.latest, null);
      const r = await scheduleAt(t, later(3 * HOUR));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.schedule.targetVersion, NEXT);
      assert.equal((await t.req('DELETE', '/api/update/schedule')).body.schedule, null);
      assert.equal(updater.state.requests.length, 0);
    } finally {
      await t.close();
    }
  });

  it('已经是目标版本了（按预约更新后容器重建）：清掉预约、记成功', async () => {
    const t = await bootWith(
      seeded({ targetVersion: CURRENT, startedAt: iso(clock.now - 3 * MIN), from: '0.0.1', to: CURRENT, backup: 'backups/x.db' }),
    );
    try {
      const st = await getStatus(t);
      assert.equal(st.schedule, null);
      assert.equal(st.scheduleResult.outcome, 'success');
      assert.equal(st.scheduleResult.from, '0.0.1');
      assert.equal(st.scheduleResult.to, CURRENT);
      assert.equal(st.scheduleResult.backup, 'backups/x.db');
      assert.equal(st.scheduleResult.error, null);
      assert.ok(t.log.lines.some((l) => l.endsWith(`：已完成，现在是 v${CURRENT}`)));
      assert.equal(updater.state.requests.length, 0);
    } finally {
      await t.close();
    }
  });

  it('没到预约时间就已经用别的办法更新过了：也清掉、记成功', async () => {
    const t = await bootWith(seeded({ targetVersion: '0.0.1', at: iso(clock.now + HOUR) }));
    try {
      const st = await getStatus(t);
      assert.equal(st.schedule, null);
      assert.equal(st.scheduleResult.outcome, 'success');
      assert.equal(st.scheduleResult.from, null);
      assert.equal(st.scheduleResult.to, CURRENT);
    } finally {
      await t.close();
    }
  });

  it('预约时间已经过了 1 小时以上（服务当时没在运行）：不更新，记「错过了预约时间」', async () => {
    const at = iso(clock.now - SCHEDULE_MISS_MS - MIN);
    const t = await bootWith(seeded({ at }));
    try {
      const st = await getStatus(t);
      assert.equal(st.schedule, null);
      assert.equal(st.scheduleResult.outcome, 'missed');
      assert.equal(st.scheduleResult.at, at);
      assert.equal(st.scheduleResult.error, '错过了预约时间，没有更新');
      assert.ok(t.log.lines.some((l) => l === `warn [update] ${ADMIN_EMAIL} 预约在 ${at} 更新到 v${NEXT}：错过了预约时间，没有更新`));
      await sleep(50);
      assert.equal(updater.state.requests.length, 0);
      assert.deepEqual(backupsOf(t), []);
    } finally {
      await t.close();
    }
  });

  it('过了不到 1 小时：照常执行；GitHub 查不到时按预约里记的版本更新', async () => {
    gh.state.status = 500;
    const t = await bootWith(seeded({ at: iso(clock.now - SCHEDULE_MISS_MS + MIN) }));
    try {
      await waitFor(() => updater.state.requests.length === 1, { message: '启动后没有执行预约' });
      const s = await waitFor(() => scheduleOf(t)?.startedAt && scheduleOf(t));
      assert.equal(s.to, NEXT);
      assert.equal(s.from, CURRENT);
      assert.equal(gh.state.requests.length, 1, '执行前查过一次 GitHub');
      assert.equal(resultOf(t), null);
    } finally {
      await t.close();
    }
  });

  it('让更新助手更新了，重启后版本没变：记失败，不再执行', async () => {
    const t = await bootWith(seeded({ startedAt: iso(clock.now - 3 * MIN), from: CURRENT, to: NEXT }));
    try {
      const st = await getStatus(t);
      assert.equal(st.schedule, null);
      assert.equal(st.scheduleResult.outcome, 'failed');
      assert.match(st.scheduleResult.error, /已经让更新助手更新，但服务重启后还是 v/);
      await sleep(50);
      assert.equal(updater.state.requests.length, 0);
    } finally {
      await t.close();
    }
  });

  /** 上一次预约记下的失败：默认是等新版本启动时没等到（已经让更新助手更新了），目标是当前版本 */
  const failedResult = (over = {}) => ({
    outcome: 'failed',
    at: iso(clock.now - HOUR),
    targetVersion: CURRENT,
    scheduledBy: { id: 'u_admin', email: ADMIN_EMAIL },
    from: '0.0.1',
    to: CURRENT,
    backup: 'backups/x.db',
    error: `已经让更新助手更新，但过了 10 分钟还是 v0.0.1，没有更新到 v${CURRENT}`,
    finishedAt: iso(clock.now - 50 * MIN),
    updaterCalled: true,
    ...over,
  });

  it('等新版本启动时记了失败（拉镜像比预期慢），后来新版本起来了：改记成功，from / to 照旧，不再调更新助手', async () => {
    const r = failedResult();
    const t = await bootWith(null, { result: r });
    try {
      const st = await getStatus(t);
      assert.equal(st.schedule, null);
      assert.deepEqual(st.scheduleResult, { ...r, outcome: 'success', error: null, finishedAt: iso(clock.now) });
      assert.ok(
        t.log.lines.some(
          (l) => l === `info [update] ${ADMIN_EMAIL} 预约在 ${r.at} 更新到 v${CURRENT}：更新比预期慢，最后成功了，现在是 v${CURRENT}`,
        ),
      );
      // 之后再看也不会再改、不会触发更新
      await t.ctx.update.tick();
      assert.equal(resultOf(t).finishedAt, st.scheduleResult.finishedAt);
      await sleep(50);
      assert.equal(updater.state.requests.length, 0);
      assert.deepEqual(backupsOf(t), []);
    } finally {
      await t.close();
    }
  });

  it('没让更新助手更新的失败（后来是用别的办法升上去的）、还没升到目标版本的失败：都不改', async () => {
    const manual = await bootWith(null, { result: failedResult({ updaterCalled: undefined, backup: null, error: '镜像标签钉在了 …' }) });
    const behind = await bootWith(null, { result: failedResult({ targetVersion: NEXT, to: NEXT }) });
    try {
      for (const x of [manual, behind]) {
        await x.ctx.update.tick();
        assert.equal(resultOf(x).outcome, 'failed');
        assert.equal((await getStatus(x)).scheduleResult.outcome, 'failed');
      }
      assert.equal(updater.state.requests.length, 0);
    } finally {
      await manual.close();
      await behind.close();
    }
  });

  it('到点时条件不满足（没装更新助手、镜像钉了版本）：不更新，记失败原因', async () => {
    const none = await bootWith(seeded(), { env: { INKDOVE_UPDATER_TOKEN: '' } });
    const pinned = await bootWith(seeded(), { env: { INKDOVE_IMAGE_TAG: CURRENT } });
    try {
      for (const [x, re] of [
        [none, /没有装更新助手/],
        [pinned, /镜像标签钉在了/],
      ]) {
        const res = await waitFor(() => resultOf(x));
        assert.equal(res.outcome, 'failed');
        assert.match(res.error, re);
        assert.equal(scheduleOf(x), null);
        assert.deepEqual(backupsOf(x), []);
      }
      assert.equal(updater.state.requests.length, 0);
    } finally {
      await none.close();
      await pinned.close();
    }
  });
});
