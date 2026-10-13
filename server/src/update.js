import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { kvGet, kvSet } from './db.js';
import { HttpError } from './util.js';

/** 启动后多久查第一次、之后多久查一次 */
export const UPDATE_FIRST_CHECK_MS = 60_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000;
/** 两次检查之间至少隔这么久（GitHub 匿名接口每个 IP 每小时 60 次）。60 秒内再点「检查更新」直接给上次的结果 */
export const UPDATE_CHECK_MIN_GAP_MS = 60_000;
/** 让更新助手更新成功后，这么久之内不再接受新的更新请求（容器马上要重建；万一没重建，过了这段时间可以再点） */
export const UPDATE_LOCK_MS = 10 * 60_000;
/** 更新前的数据库备份只留最近几份 */
export const KEEP_BACKUPS = 5;
/** 预约更新：多久看一次到没到点 */
export const SCHEDULE_TICK_MS = 60_000;
/** 预约时间只能选 1 分钟之后、7 天之内 */
export const SCHEDULE_MIN_AHEAD_MS = 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 7 * 86400_000;
/** 到点时服务没在运行：启动后发现预约时间已经过了这么久的，不再更新 */
export const SCHEDULE_MISS_MS = 3600_000;
/** kv 表里的键：当前的预约（没有时存 null）、最近一次预约执行的结果 */
const SCHEDULE_KEY = 'update_schedule';
const SCHEDULE_RESULT_KEY = 'update_schedule_result';
/** 预约时间要写成带时区的 ISO 时间（Z 或 +08:00），免得服务器按自己的时区理解 */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 15_000;
/** release 正文最多带这么多字 */
const NOTES_MAX = 20_000;

/**
 * 更新助手（compose 里的 updater 服务，镜像 nickfedor/watchtower:1.23.0）的 HTTP API。
 * 参数按它的文档写的，没有实测过；以后要调整只改这里。
 * POST <INKDOVE_UPDATER_URL>/v1/update?image=<镜像名，不带标签>&async=true，头 Authorization: Bearer <口令>。
 * image= 让它只更新这个镜像的容器；async=true 时立刻返回 202，在后台拉镜像、重建容器（同步时是 200）。
 * 注意它只会重新拉「同一个标签」的新镜像，所以 compose 里钉了完整版本号时升不上去。
 */
export const UPDATER_API = {
  path: '/v1/update',
  query: (imageName) => ({ image: imageName, async: 'true' }),
  okStatus: [200, 202],
  timeoutMs: 15_000,
  /** GET /api/update 时探一下能不能连上（只建 TCP 连接，不发 HTTP 请求，免得误触发更新） */
  probeTimeoutMs: 1500,
};

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v1.2.3" / "1.2.3-rc.1" → {major, minor, patch, pre}；不是版本号返回 null */
export function parseVersion(s) {
  const m = SEMVER.exec(String(s ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

/**
 * a 比 b 新返回正数，旧返回负数，一样（或有一个不是版本号）返回 0。
 * 预发布只看有没有：1.0.0-rc.1 比 1.0.0 旧，两个预发布之间不细比。
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

/**
 * 镜像标签是不是钉死了：latest 和 x.y 这种浮动标签，更新助手重新拉同一个标签就能升到 latestVersion；
 * 完整版本号（0.2.0）、别的 x.y、自定义标签都升不上去。latestVersion 不知道时 x.y 算没钉。
 */
export function isPinned(tag, latestVersion) {
  if (tag === 'latest') return false;
  const m = /^v?(\d+)\.(\d+)$/.exec(tag);
  if (!m) return true;
  const v = parseVersion(latestVersion);
  return !!v && (v.major !== Number(m[1]) || v.minor !== Number(m[2]));
}

/** 两个版本号里新的那个；空的不算 */
function newerOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

const BACKUP_FILE = /^inkdove-v.+\.db$/;

/**
 * 用 SQLite 的在线备份把数据库拷到 <dataDir>/backups/inkdove-v<版本>-<UTC 时间>.db，再删到只剩最近 keep 份。
 * 备份失败时删掉写了一半的文件并抛错。→ {name, file}
 * @param {import('better-sqlite3').Database} db
 */
export async function backupDb(db, dataDir, version, { keep = KEEP_BACKUPS, now = Date.now, log } = {}) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let name = `inkdove-v${version}-${stamp}.db`;
  // 同一秒里备份两次时加序号，不覆盖
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `inkdove-v${version}-${stamp}-${i}.db`;
  const file = path.join(dir, name);
  try {
    await db.backup(file);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  pruneBackups(dir, keep, log);
  return { name, file };
}

/** 按修改时间从新到旧，只留 keep 份。只动 inkdove-v*.db，别的文件不碰；删不掉只记日志 */
function pruneBackups(dir, keep, log) {
  const files = fs
    .readdirSync(dir)
    .filter((n) => BACKUP_FILE.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  for (const f of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, f.n));
    } catch (err) {
      log?.warn(`[update] 删除旧备份 ${f.n} 失败：${err?.message || err}`);
    }
  }
}

/** 只建 TCP 连接看看通不通 */
function canConnect(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(false);
    }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const sock = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

/**
 * 在线更新：定时查 GitHub 最新发布，管理员点「立即更新」时先备份数据库，再让更新助手拉新镜像、重建应用容器。
 * 也可以预约一个时间点（只管这一次）：每分钟看一次，到点走和「立即更新」一样的流程。预约存在 kv 表里，重启不丢。
 * 只读 config 里的 INKDOVE_ 变量；INKDOVE_UPDATE_CHECK=0 时不发任何外部请求。
 * @param {any} ctx
 * @param {{version: string, githubApiUrl?: string, now?: () => number}} opts githubApiUrl、now 是测试用的
 */
export function createUpdateService(ctx, { version, githubApiUrl, now = Date.now }) {
  const { config, log, db } = ctx;
  const apiBase = (githubApiUrl || GITHUB_API).replace(/\/+$/, '');
  // ghcr.io 的镜像名必须小写（和 release.yml 一致），不带标签
  const imageName = `ghcr.io/${config.updateRepo.toLowerCase()}`;
  const closing = new AbortController();
  const timers = { first: null, every: null, schedule: null };
  const state = {
    /** {version, name, url, publishedAt, notes} | null */
    latest: null,
    checkedAt: null,
    error: null,
    lastAttemptAt: 0,
    inflight: null,
    /** 正在更新：{until}，until 为 null 表示还在备份或等更新助手回话 */
    applying: null,
    /** 正在执行预约（查 GitHub、备份、等更新助手回话）。这时不能取消或改预约 */
    scheduleRunning: false,
    /** 这个进程按预约让更新助手更新的那一次的 startedAt（用来区分「还在等重启」和「重启了但没升上去」） */
    firedStartedAt: null,
    /** 正在跑的 tick() */
    ticking: null,
  };

  async function fetchLatest() {
    let res;
    try {
      res = await fetch(`${apiBase}/repos/${config.updateRepo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          // GitHub 要求带 User-Agent，没有会 403
          'user-agent': `inkdove/${version}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.any([closing.signal, AbortSignal.timeout(GITHUB_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error('连接 GitHub 超时');
      throw new Error(`连不上 GitHub：${err?.cause?.code || err?.message || err}`);
    }
    if (res.status === 404) throw new Error(`没找到 ${config.updateRepo} 的正式发布（仓库名不对，或者还没发布过版本）`);
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub 接口限流了（每个 IP 每小时 60 次），稍后会自动再查');
    }
    if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    const tag = String(body?.tag_name || '');
    const v = parseVersion(tag);
    if (!v) throw new Error(`最新发布的标签「${tag.slice(0, 40)}」不是版本号`);
    // /releases/latest 本来就不含预发布和草稿，这里再兜一层：预发布不提示
    if (v.pre || body.prerelease || body.draft) return null;
    const published = body.published_at ? new Date(body.published_at) : null;
    return {
      version: `${v.major}.${v.minor}.${v.patch}`,
      name: String(body.name || tag).slice(0, 200),
      url: httpsOnly(body.html_url) || `https://github.com/${config.updateRepo}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
      // 纯文本原样给前端（Markdown 不渲染），太长截断
      notes: String(body.body || '').slice(0, NOTES_MAX),
    };
  }

  /** 查一次；同时只跑一个，正在查时直接等那一次 */
  function check() {
    if (!config.updateCheck) return Promise.resolve();
    if (state.inflight) return state.inflight;
    state.lastAttemptAt = now();
    state.inflight = (async () => {
      try {
        const latest = await fetchLatest();
        if (latest && latest.version !== state.latest?.version && compareVersions(latest.version, version) > 0) {
          log.info(`[update] 有新版本 v${latest.version}（当前 v${version}）`);
        }
        state.latest = latest;
        state.error = null;
      } catch (err) {
        if (closing.signal.aborted) return;
        state.error = err?.message || String(err);
        log.warn(`[update] 检查新版本失败：${state.error}`);
      } finally {
        state.checkedAt = new Date(now()).toISOString();
        state.inflight = null;
      }
    })();
    return state.inflight;
  }

  async function status() {
    const latest = state.latest;
    const configured = !!config.updaterToken;
    return {
      current: version,
      latest,
      available: !!latest && compareVersions(latest.version, version) > 0,
      checkedAt: state.checkedAt,
      error: state.error,
      checkEnabled: config.updateCheck,
      updater: configured
        ? { configured, reachable: await canConnect(config.updaterUrl, UPDATER_API.probeTimeoutMs) }
        : { configured },
      image: `${imageName}:${config.imageTag}`,
      pinned: isPinned(config.imageTag, latest?.version),
      // 预约更新：当前的预约（没有是 null），最近一次预约执行的结果（没有是 null）
      schedule: readSchedule(),
      scheduleResult: kvGet(db, SCHEDULE_RESULT_KEY, null),
    };
  }

  const updaterFailed = (msg) => new HttpError(502, 'updater_failed', msg);

  async function callUpdater() {
    const u = new URL(config.updaterUrl + UPDATER_API.path);
    for (const [k, v] of Object.entries(UPDATER_API.query(imageName))) u.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(u, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.updaterToken}` },
        signal: AbortSignal.timeout(UPDATER_API.timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw updaterFailed(`更新助手 ${UPDATER_API.timeoutMs / 1000} 秒没有回应，更新可能还在进行，请过几分钟刷新页面看版本号`);
      }
      throw updaterFailed(`连不上更新助手（${config.updaterUrl}），请检查 compose 里的 updater 服务有没有在运行`);
    }
    const text = await res.text().catch(() => '');
    if (UPDATER_API.okStatus.includes(res.status)) return;
    if (res.status === 401 || res.status === 403) {
      throw updaterFailed('更新助手拒绝了请求：口令不对，请检查两边用的是不是同一个 INKDOVE_UPDATER_TOKEN');
    }
    const detail = text.trim().slice(0, 200);
    throw updaterFailed(`更新助手返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  // ============ 立即更新和预约更新共用 ============

  /** 能不能一键更新到 target：装了更新助手、确实比当前新、镜像标签没钉死。不能时抛和 /apply 一样的错 */
  function assertCanUpdate(target) {
    if (!config.updaterToken) {
      throw new HttpError(400, 'updater_not_configured', '没有装更新助手（没设 INKDOVE_UPDATER_TOKEN），请在服务器上用命令更新');
    }
    if (!target || compareVersions(target, version) <= 0) throw new HttpError(400, 'no_update', '已经是最新版本');
    if (isPinned(config.imageTag, target)) {
      throw new HttpError(
        400,
        'image_pinned',
        `镜像标签钉在了 ${config.imageTag}，一键更新升不到 v${target}，请在服务器上改镜像标签后用命令更新`,
      );
    }
  }

  /** 正在更新：还在备份 / 等更新助手回话，或者更新助手接手后的那段时间 */
  const busy = () => !!state.applying && (state.applying.until === null || now() < state.applying.until);

  /** 先备份数据库，备份成功才让更新助手更新。同一时间只允许一个 → {ok, from, to, backup} */
  async function runUpdate(to) {
    if (busy()) throw new HttpError(409, 'update_in_progress', '已经在更新了，请稍候');
    state.applying = { until: null };
    try {
      let backup;
      try {
        backup = await backupDb(db, config.dataDir, version, { now, log });
      } catch (err) {
        log.error(`[update] 备份数据库失败：${err?.message || err}`);
        throw new HttpError(500, 'backup_failed', `备份数据库失败，没有更新：${err?.message || err}`);
      }
      await callUpdater();
      state.applying.until = now() + UPDATE_LOCK_MS;
      log.info(`[update] 已让更新助手更新到 v${to}，更新前的数据库备份在 backups/${backup.name}`);
      return { ok: true, from: version, to, backup: `backups/${backup.name}` };
    } catch (err) {
      state.applying = null;
      if (err instanceof HttpError && err.code === 'updater_failed') log.warn(`[update] ${err.message}`);
      throw err;
    }
  }

  // ============ 预约更新 ============

  const iso = (ms) => new Date(ms).toISOString();
  const who = (user) => user?.email || '管理员';

  /**
   * 当前的预约：{at, targetVersion, scheduledBy:{id, email}, createdAt}，没有是 null。
   * 到点让更新助手更新之后再加上 {startedAt, from, to, backup}，留到新版本启动时才清掉（这期间不会再执行）。
   */
  function readSchedule() {
    const s = kvGet(db, SCHEDULE_KEY, null);
    if (!s) return null;
    if (typeof s !== 'object' || !parseVersion(s.targetVersion) || !Number.isFinite(Date.parse(s.at))) {
      log.warn('[update] 库里的预约格式不对，已清掉');
      kvSet(db, SCHEDULE_KEY, null);
      return null;
    }
    return s;
  }
  const writeSchedule = (s) => kvSet(db, SCHEDULE_KEY, s);

  /**
   * 已知的最新版本：GitHub 上查到的，和还没执行的预约记下的目标版本里新的那个
   * （重启后 1 分钟内还没查 GitHub，靠预约里记的版本也能改时间、立即更新、到点执行）
   */
  function knownLatest() {
    const s = readSchedule();
    return newerOf(state.latest?.version, s && !s.startedAt ? s.targetVersion : null);
  }

  /** 清掉预约，记下这次的结果，打一行日志 */
  function finish(s, { outcome, from = version, to = version, error = null }) {
    writeSchedule(null);
    kvSet(db, SCHEDULE_RESULT_KEY, {
      /** success | failed | missed */
      outcome,
      at: s.at,
      targetVersion: s.targetVersion,
      scheduledBy: s.scheduledBy ?? null,
      from,
      to,
      backup: s.backup ?? null,
      error,
      finishedAt: iso(now()),
    });
    const head = `[update] ${who(s.scheduledBy)} 预约在 ${s.at} 更新到 v${s.targetVersion}`;
    if (outcome === 'success') log.info(`${head}：已完成，现在是 v${version}`);
    else log.warn(`${head}：${outcome === 'missed' ? '' : '失败，'}${error}`);
  }

  /** 到点了：先查一次 GitHub（有更新的版本就更到最新），再走和立即更新一样的流程 */
  async function execute(s) {
    state.scheduleRunning = true;
    try {
      if (config.updateCheck && now() - state.lastAttemptAt >= UPDATE_CHECK_MIN_GAP_MS) await check();
      if (closing.signal.aborted) return;
      const to = newerOf(state.latest?.version, s.targetVersion);
      log.info(`[update] 到了 ${who(s.scheduledBy)} 预约的时间（${s.at}），开始更新：v${version} → v${to}`);
      let r;
      try {
        assertCanUpdate(to);
        r = await runUpdate(to);
      } catch (err) {
        // 有人同时点了「立即更新」：它成功会清掉预约；失败的话下一分钟再看
        if (err instanceof HttpError && err.code === 'update_in_progress') return;
        finish(s, { outcome: 'failed', to, error: err?.message || String(err) });
        return;
      }
      const startedAt = iso(now());
      state.firedStartedAt = startedAt;
      writeSchedule({ ...s, startedAt, from: version, to, backup: r.backup });
    } finally {
      state.scheduleRunning = false;
    }
  }

  /**
   * 看一眼预约（启动时一次，之后每分钟一次）：
   * 当前版本已经 ≥ 目标版本 → 清掉、记成功；让更新助手更新了但没升上去 → 清掉、记失败；
   * 还没到点 → 不动；过了 1 小时以上（服务当时没在运行）→ 清掉、记「错过了」；否则执行。失败不自动重试。
   */
  async function runSchedule() {
    const s = readSchedule();
    if (!s) return;
    if (compareVersions(version, s.targetVersion) >= 0) {
      finish(s, { outcome: 'success', from: s.from ?? null, to: version });
      return;
    }
    const t = now();
    if (s.startedAt) {
      const firedHere = state.firedStartedAt === s.startedAt;
      // 这个进程刚让更新助手更新：等它重建容器
      if (firedHere && t - Date.parse(s.startedAt) < UPDATE_LOCK_MS) return;
      const why = firedHere ? `过了 ${UPDATE_LOCK_MS / 60_000} 分钟还是` : '服务重启后还是';
      finish(s, {
        outcome: 'failed',
        from: s.from,
        to: s.to,
        error: `更新助手收到了请求，但${why} v${version}，没有更新到 v${s.to}。可以在服务器上用 docker compose logs updater 看看更新助手的日志`,
      });
      return;
    }
    const at = Date.parse(s.at);
    if (t < at) return;
    if (t - at > SCHEDULE_MISS_MS) {
      finish(s, { outcome: 'missed', to: s.targetVersion, error: '错过了预约时间，没有更新' });
      return;
    }
    // 有人正在点「立即更新」：它成功会清掉预约；失败的话下一分钟再看
    if (busy()) return;
    await execute(s);
  }

  /** 同一时间只跑一个 */
  function tick() {
    if (!state.ticking) {
      state.ticking = runSchedule()
        .catch((err) => log.error(`[update] 处理预约更新出错：${err?.stack || err}`))
        .finally(() => {
          state.ticking = null;
        });
    }
    return state.ticking;
  }

  return {
    /** 启动定时检查。intervalMs 为 0（测试）或关闭了检查时不启动 */
    start(firstDelayMs = UPDATE_FIRST_CHECK_MS, intervalMs = UPDATE_CHECK_INTERVAL_MS) {
      if (!config.updateCheck || !intervalMs) return;
      timers.first = setTimeout(() => {
        check();
        timers.every = setInterval(check, intervalMs);
        timers.every.unref?.();
      }, firstDelayMs);
      timers.first.unref?.();
    },
    /** 预约更新：马上看一次（处理重启前留下的预约），之后每 tickMs 看一次。tickMs 为 0（测试）时都不做，手动调 tick() */
    startSchedule(tickMs = SCHEDULE_TICK_MS) {
      if (!tickMs) return;
      tick();
      timers.schedule = setInterval(tick, tickMs);
      timers.schedule.unref?.();
    },
    /** 停掉定时器；正在处理预约时等它跑完（免得关库之后还在写） */
    stop() {
      clearTimeout(timers.first);
      clearInterval(timers.every);
      clearInterval(timers.schedule);
      closing.abort();
      return state.ticking || Promise.resolve();
    },
    check,
    status,
    tick,
    /** POST /api/update/check：60 秒内查过就直接给上次的结果，不再请求 GitHub */
    async checkNow() {
      if (!config.updateCheck) throw new HttpError(400, 'update_check_disabled', '已用 INKDOVE_UPDATE_CHECK=0 关闭了检查更新');
      if (state.inflight || !state.lastAttemptAt || now() - state.lastAttemptAt >= UPDATE_CHECK_MIN_GAP_MS) await check();
      return status();
    },
    /** POST /api/update/apply：先备份数据库，备份成功才让更新助手更新。同一时间只允许一个。成功后已有的预约作废 */
    async apply(user) {
      const to = knownLatest();
      assertCanUpdate(to);
      const r = await runUpdate(to);
      const s = readSchedule();
      if (s && !s.startedAt) {
        writeSchedule(null);
        log.info(`[update] ${who(user)} 点了立即更新，${who(s.scheduledBy)} 预约在 ${s.at} 的更新作废`);
      }
      return r;
    },
    /**
     * POST /api/update/schedule {at}：预约在 at（带时区的 ISO 时间，1 分钟之后、7 天之内）更新到现在查到的最新版。
     * 条件和立即更新一样。同时只能有一个预约，再预约就覆盖 → 同 status()
     */
    async schedule(atInput, user) {
      const raw = typeof atInput === 'string' ? atInput.trim() : '';
      const at = ISO_WITH_ZONE.test(raw) ? Date.parse(raw) : NaN;
      if (!Number.isFinite(at)) {
        throw new HttpError(400, 'bad_time', '预约时间要写成带时区的 ISO 时间，比如 2026-10-14T03:00:00+08:00');
      }
      const ahead = at - now();
      if (ahead < SCHEDULE_MIN_AHEAD_MS || ahead > SCHEDULE_MAX_AHEAD_MS) {
        throw new HttpError(400, 'bad_time', '预约时间要在 1 分钟之后、7 天之内');
      }
      const target = knownLatest();
      assertCanUpdate(target);
      const prev = readSchedule();
      if (busy() || state.scheduleRunning || prev?.startedAt) throw new HttpError(409, 'update_in_progress', '已经在更新了，请稍候');
      const s = {
        at: iso(at),
        targetVersion: target,
        scheduledBy: { id: user?.id ?? null, email: user?.email ?? null },
        createdAt: iso(now()),
      };
      writeSchedule(s);
      log.info(`[update] ${who(user)} 预约在 ${s.at} 更新到 v${target}${prev ? `（替换了原来 ${prev.at} 的预约）` : ''}`);
      return status();
    },
    /** DELETE /api/update/schedule：取消预约（没有预约也算成功）。已经开始按预约更新时 409 → 同 status() */
    async cancelSchedule(user) {
      const s = readSchedule();
      if (s) {
        if (s.startedAt || state.scheduleRunning) {
          throw new HttpError(409, 'update_in_progress', '已经开始按预约更新了，不能取消');
        }
        writeSchedule(null);
        log.info(`[update] ${who(user)} 取消了预约（原定 ${s.at} 更新到 v${s.targetVersion}，${who(s.scheduledBy)} 预约的）`);
      }
      return status();
    },
  };
}
