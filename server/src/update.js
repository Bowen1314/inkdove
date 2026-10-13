import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
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
 * 只读 config 里的 INKDOVE_ 变量；INKDOVE_UPDATE_CHECK=0 时不发任何外部请求。
 * @param {any} ctx
 * @param {{version: string, githubApiUrl?: string, now?: () => number}} opts githubApiUrl、now 是测试用的
 */
export function createUpdateService(ctx, { version, githubApiUrl, now = Date.now }) {
  const { config, log } = ctx;
  const apiBase = (githubApiUrl || GITHUB_API).replace(/\/+$/, '');
  // ghcr.io 的镜像名必须小写（和 release.yml 一致），不带标签
  const imageName = `ghcr.io/${config.updateRepo.toLowerCase()}`;
  const closing = new AbortController();
  const timers = { first: null, every: null };
  const state = {
    /** {version, name, url, publishedAt, notes} | null */
    latest: null,
    checkedAt: null,
    error: null,
    lastAttemptAt: 0,
    inflight: null,
    /** 正在更新：{until}，until 为 null 表示还在备份或等更新助手回话 */
    applying: null,
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
    stop() {
      clearTimeout(timers.first);
      clearInterval(timers.every);
      closing.abort();
    },
    check,
    status,
    /** POST /api/update/check：60 秒内查过就直接给上次的结果，不再请求 GitHub */
    async checkNow() {
      if (!config.updateCheck) throw new HttpError(400, 'update_check_disabled', '已用 INKDOVE_UPDATE_CHECK=0 关闭了检查更新');
      if (state.inflight || !state.lastAttemptAt || now() - state.lastAttemptAt >= UPDATE_CHECK_MIN_GAP_MS) await check();
      return status();
    },
    /** POST /api/update/apply：先备份数据库，备份成功才让更新助手更新。同一时间只允许一个 */
    async apply() {
      if (!config.updaterToken) {
        throw new HttpError(400, 'updater_not_configured', '没有装更新助手（没设 INKDOVE_UPDATER_TOKEN），请在服务器上用命令更新');
      }
      const latest = state.latest;
      if (!latest || compareVersions(latest.version, version) <= 0) throw new HttpError(400, 'no_update', '已经是最新版本');
      if (isPinned(config.imageTag, latest.version)) {
        throw new HttpError(
          400,
          'image_pinned',
          `镜像标签钉在了 ${config.imageTag}，一键更新升不到 v${latest.version}，请在服务器上改镜像标签后用命令更新`,
        );
      }
      if (state.applying && (state.applying.until === null || now() < state.applying.until)) {
        throw new HttpError(409, 'update_in_progress', '已经在更新了，请稍候');
      }
      state.applying = { until: null };
      try {
        let backup;
        try {
          backup = await backupDb(ctx.db, config.dataDir, version, { now, log });
        } catch (err) {
          log.error(`[update] 备份数据库失败：${err?.message || err}`);
          throw new HttpError(500, 'backup_failed', `备份数据库失败，没有更新：${err?.message || err}`);
        }
        await callUpdater();
        state.applying.until = now() + UPDATE_LOCK_MS;
        log.info(`[update] 已让更新助手更新到 v${latest.version}，更新前的数据库备份在 backups/${backup.name}`);
        return { ok: true, from: version, to: latest.version, backup: `backups/${backup.name}` };
      } catch (err) {
        state.applying = null;
        if (err instanceof HttpError && err.code === 'updater_failed') log.warn(`[update] ${err.message}`);
        throw err;
      }
    },
  };
}
