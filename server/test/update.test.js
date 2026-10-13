// 在线更新：假 GitHub（GET /repos/<repo>/releases/latest）和假更新助手（POST /v1/update）都是本地 HTTP 服务，不访问外网；
// 时钟注入（createApp 的 updateNow）。覆盖：版本比较和钉版本判断、启动后延迟首查、关闭检测时不发请求、只有 admin、
// 60 秒内不重查、预发布不提示、GitHub 出错、自定义仓库、数据库备份文件和保留份数、备份失败不更新、
// 更新助手未配置 / 口令错 / 出错 / 连不上 / 成功、同一时间只允许一个更新。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { KEEP_BACKUPS, UPDATE_CHECK_MIN_GAP_MS, UPDATE_LOCK_MS, compareVersions, isPinned, parseVersion } from '../src/update.js';
import { sleep, startApp, waitFor } from './helpers.js';

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
