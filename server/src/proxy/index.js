// 全局代理（设置 → 代理）：墨鸽自己连外网的请求都经机场节点出去；扫码号可以选「用全局代理」，WAHA 也经它连 WhatsApp。
// - 节点来自 Clash 订阅（每天自动更新一次）或管理员粘贴的 Clash 配置，解析后存在 kv 表 proxy_nodes 里（含机场凭证，接口只给名字）；
// - 开着时起 mihomo（mihomo.js），按规则换掉全局 fetch 等的出口（route.js）；关着时什么都不起，也不发任何额外请求；
// - WAHA 连 mihomo 用一组共享的随机账号密码（kv 表 proxy_meta 里，进程重启不变）：mihomo 的账号写在配置里，
//   每个号一组的话，一个号开关「用全局代理」就要重启 mihomo，所有经它的连接（别的号、正在调的模型）都会断一下。
import fs from 'node:fs';
import path from 'node:path';
import { kvGet, kvSet } from '../db.js';
import { badRequest } from '../util.js';
import { createDirectMatcher } from './direct.js';
import { AUTO_GROUP, ClashFormatError, MAIN_GROUP, parseClashConfig } from './clash.js';
import {
  buildMihomoConfig,
  createMihomoRunner,
  DELAY_TEST_URL,
  DELAY_TIMEOUT_MS,
  dropInvalidNodes,
  freePort,
  nodeSecrets,
  randomToken,
} from './mihomo.js';
import { disableRouting, enableRouting, proxiedDispatcher } from './route.js';
import { clashErrorMessage, fetchSubscription, SubscriptionError } from './subscription.js';

export const MIHOMO_MISSING = '这台机器没有 mihomo，Docker 镜像里自带；本地开发可以用 INKDOVE_MIHOMO_PATH 指定';
/** 订阅多久自动更新一次；失败后多久再试 */
export const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
export const REFRESH_RETRY_MS = 60 * 60 * 1000;
/** 多久看一次订阅该不该更新了 */
const REFRESH_CHECK_MS = 10 * 60 * 1000;
const TEST_TIMEOUT_MS = 15_000;

/** kv 里存节点的键：{subscription, config}，各是 {proxies, skipped, invalid, updatedAt} 或 null（操作日志只取个数和时间） */
export const NODES_KEY = 'proxy_nodes';
const META_KEY = 'proxy_meta';

/** 扫码号是不是在用全局代理 */
export const usesGlobalProxy = (acc) => !!(acc?.channel === 'waha' && acc.waha?.proxy?.enabled && acc.waha.proxy.useGlobal);

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/**
 * @param {any} ctx 要用 config、db、log、accounts、getSettings / updateSettings、wa（同步 WAHA session）、proxyTestUrl
 * @param {{
 *   bindHost?: string, refreshCheckMs?: number, backoff?: object, readyTimeoutMs?: number, spawn?: Function,
 *   subscriptionTimeoutMs?: number, now?: () => number,
 * }} [options]
 *   bindHost：混合端口给 WAHA 用时听哪个地址（容器里 0.0.0.0，测试 127.0.0.1 时不对外）；refreshCheckMs 为 0 时不起定时器
 */
export function createGlobalProxy(ctx, options = {}) {
  const { config, db, log } = ctx;
  const now = options.now || Date.now;
  const allowLan = (options.bindHost ?? '0.0.0.0') !== '127.0.0.1';
  const runner = createMihomoRunner({
    binPath: config.mihomoPath,
    homeDir: path.join(config.dataDir, 'mihomo'),
    log,
    backoff: options.backoff,
    readyTimeoutMs: options.readyTimeoutMs,
    spawn: options.spawn,
  });
  /** 控制接口：每个进程第一次启动 mihomo 时定下来 */
  let controller = null;
  /** 正在进行的 apply（走代理的请求先等它） */
  let applying = Promise.resolve();
  let routed = false;
  let routeKey = '';
  /** 开着但起不来的原因（没有 mihomo、没有节点），runner 的错误之外的 */
  let blocked = null;
  let refreshing = null;
  let timer = null;
  let closed = false;

  const settings = () => ctx.getSettings().proxy;
  const loadNodes = () => {
    const v = kvGet(db, NODES_KEY, null);
    return { subscription: v?.subscription || null, config: v?.config || null };
  };
  const saveNodes = (v) => kvSet(db, NODES_KEY, v);
  const loadMeta = () => kvGet(db, META_KEY, null) || {};
  const saveMeta = (m) => kvSet(db, META_KEY, m);
  const updateMeta = (fn) => {
    const m = loadMeta();
    fn(m);
    saveMeta(m);
    return m;
  };

  /** WAHA 连混合端口用的账号密码：第一次用到时生成，之后不变 */
  function auth() {
    const m = loadMeta();
    if (m.auth?.username && m.auth?.password) return m.auth;
    const a = { username: `inkdove-${randomToken(6)}`, password: randomToken(24) };
    updateMeta((x) => {
      x.auth = a;
    });
    return a;
  }

  function available() {
    try {
      fs.accessSync(config.mihomoPath, fs.constants.X_OK);
      return fs.statSync(config.mihomoPath).isFile();
    } catch {
      return false;
    }
  }

  const nodesOf = (source, store = loadNodes()) => store[source]?.proxies || [];
  const usedBy = () => ctx.accounts.list().filter(usesGlobalProxy);

  /**
   * 解析出的节点再让 mihomo 查一遍（mihomo -t），去掉它不认的：一个坏节点会让整个 mihomo 起不来。
   * 没有 mihomo 的机器（本地开发）不查（反正也开不了）。
   * @returns {Promise<{proxies: object[], skipped: number, invalid: string[], updatedAt: string}>} invalid：mihomo 不认、去掉了的节点名
   */
  async function checkedNodes(r) {
    let proxies = r.proxies;
    let invalid = [];
    if (available()) {
      const c = await dropInvalidNodes({ binPath: config.mihomoPath, dir: path.join(config.dataDir, 'mihomo', 'check'), proxies, spawn: options.spawn });
      proxies = c.proxies;
      invalid = c.dropped;
    }
    return { proxies, skipped: r.skipped, invalid, updatedAt: new Date(now()).toISOString() };
  }

  /** 内部服务的主机名（WAHA、更新助手、中继主机名）：总是直连 */
  const internalHosts = () => [hostOf(config.wahaUrl), hostOf(config.updaterUrl), config.proxyRelayHost].filter(Boolean);

  /**
   * 设置保存前的检查和准备（会下载订阅、解析粘贴的配置）。不合法抛 400，信息以 proxy.<字段> 开头（前端放到字段下面）。
   * @param {any} cur 现在的 settings.proxy
   * @param {any} next applySettingsPatch 之后的 settings.proxy
   * @param {any} patch 请求里的 proxy（取粘贴的 config）
   * @returns {Promise<{proxy: any, commit: () => void}>} proxy：最终要存的 settings.proxy；commit：存设置之后调，写节点
   */
  async function prepare(cur, next, patch) {
    const out = { ...next, bypass: [...next.bypass] };
    const store = loadNodes();
    const nodes = { ...store };
    let subscriptionFetched = false;
    if (out.enabled && !cur.enabled) {
      if (!available()) throw badRequest(`proxy.enabled ${MIHOMO_MISSING}`, 'mihomo_unavailable');
    }
    if (!out.enabled && cur.enabled) {
      const users = usedBy();
      if (users.length) {
        throw badRequest(
          `proxy.enabled 这些号在用全局代理：${users.map((a) => a.name).join('、')}。先在号的设置里把代理改掉，再关全局代理`,
          'global_proxy_in_use',
        );
      }
    }
    // 粘贴的 Clash 配置：只存解析出来的节点
    if (patch?.config === null) nodes.config = null;
    else if (typeof patch?.config === 'string' && patch.config.trim()) {
      let r;
      try {
        r = parseClashConfig(patch.config);
      } catch (err) {
        if (err instanceof ClashFormatError) throw badRequest(`proxy.config ${clashErrorMessage(err, { pasted: true })}`, 'proxy_config_invalid');
        throw err;
      }
      try {
        nodes.config = await checkedNodes(r);
      } catch (err) {
        throw badRequest(`proxy.config ${err?.message || err}`, 'proxy_config_invalid');
      }
    }
    // 订阅：地址清空就清掉节点；地址变了，或者要开启、用订阅、却还没下载过时，现在下载（直连）
    if (!out.subscriptionUrl) nodes.subscription = null;
    else if (out.subscriptionUrl !== cur.subscriptionUrl || (out.enabled && out.source === 'subscription' && !nodes.subscription)) {
      let r;
      try {
        r = await fetchSubscription(out.subscriptionUrl, { timeoutMs: options.subscriptionTimeoutMs });
      } catch (err) {
        if (err instanceof SubscriptionError) throw badRequest(`proxy.subscriptionUrl ${err.message}`, 'proxy_subscription_failed');
        throw err;
      }
      try {
        nodes.subscription = await checkedNodes(r);
      } catch (err) {
        throw badRequest(`proxy.subscriptionUrl 订阅里的节点 ${err?.message || err}`, 'proxy_subscription_failed');
      }
      subscriptionFetched = true;
    }
    const list = nodesOf(out.source, nodes);
    if (out.enabled && !list.length) {
      throw badRequest(
        out.source === 'subscription' ? 'proxy.subscriptionUrl 还没有填订阅地址' : 'proxy.config 还没有粘贴 Clash 配置',
        'proxy_no_nodes',
      );
    }
    let notice = null;
    if (out.node && !list.some((p) => p.name === out.node)) {
      // 这次明确选的节点不存在：报错；原来选的节点在换了来源 / 订阅之后没了：改回自动并说明
      if (patch?.node !== undefined && patch.node === out.node) throw badRequest('proxy.node 没有这个节点，请重新选择', 'proxy_node_not_found');
      notice = `之前选的节点「${out.node}」现在的节点列表里没有了，已改成自动选最快的`;
      out.node = '';
    }
    return {
      proxy: out,
      commit() {
        saveNodes(nodes);
        updateMeta((m) => {
          // 管理员保存过一次设置，之前的提示就不用再显示了
          m.notice = notice;
          if (subscriptionFetched) m.subscription = { lastAttemptAt: new Date(now()).toISOString(), error: null };
          if (!out.subscriptionUrl) m.subscription = null;
        });
      },
    };
  }

  /**
   * 按现在的设置让 mihomo、出口路由和 WAHA session 到位。不抛错，问题记在状态里。
   * sync=false：不同步 WAHA（进程启动时由 wa.init 按配置指纹统一同步）
   */
  function apply({ sync = true } = {}) {
    const run = applying
      .catch(() => {})
      .then(() => doApply())
      .catch((err) => log.error(`[proxy] 应用全局代理设置出错：${err?.stack || err}`));
    // 走代理的请求只等 mihomo 这部分，不等下面同步 WAHA
    applying = run;
    return run.then(() => (sync && !closed && settings().enabled ? syncWaha() : null));
  }

  async function doApply() {
    if (closed) return;
    const s = settings();
    if (!s.enabled) {
      blocked = null;
      await runner.stop();
      if (routed) {
        routed = false;
        routeKey = '';
        await disableRouting();
        log.info('[proxy] 全局代理已关闭');
      }
      return;
    }
    // 开着：先换出口（起不来时请求失败，不退回直连）
    ensureRouting(s);
    const proxies = nodesOf(s.source);
    blocked = !available() ? MIHOMO_MISSING : !proxies.length ? '还没有节点：请填订阅地址或粘贴 Clash 配置' : null;
    if (blocked) {
      await runner.stop();
      return;
    }
    if (!controller) controller = { port: await freePort(), secret: randomToken(24) };
    const a = auth();
    const cfg = buildMihomoConfig({
      proxies,
      node: s.node,
      mixedPort: config.globalProxyPort,
      allowLan,
      controllerPort: controller.port,
      secret: controller.secret,
      auth: a,
    });
    const r = await runner.apply(cfg, [...nodeSecrets(proxies), a.password, controller.secret]);
    if (r !== 'unchanged') log.info(`[proxy] 全局代理：mihomo ${r === 'started' ? '启动' : '重启'}（${proxies.length} 个节点，${s.node ? '手动选的节点' : '自动选最快的'}）`);
  }

  /** 开着时换掉出口（同步：启动时要在别的模块发请求之前换好）。直连名单没变就不动 */
  function ensureRouting(s) {
    const key = JSON.stringify([config.globalProxyPort, s.bypass, internalHosts()]);
    if (routed && key === routeKey) return;
    enableRouting({
      port: config.globalProxyPort,
      isDirect: createDirectMatcher({ rules: s.bypass, internalHosts: internalHosts() }),
      waitReady,
    });
    routed = true;
    routeKey = key;
  }

  /** 在用全局代理的号：账号密码或端口变了时把新配置推给 WAHA（没变时 applyWahaConfig 什么也不做） */
  async function syncWaha() {
    for (const acc of usedBy()) {
      try {
        const r = await ctx.wa?.applyWahaConfig(acc);
        if (r === 'updated') log.info(`[proxy] 号 ${acc.id} 的 WAHA session 已改用新的全局代理配置`);
      } catch (err) {
        log.warn(`[proxy] 号 ${acc.id} 的 WAHA session 没能同步全局代理配置，下次连接时再试：${err?.message || err}`);
      }
    }
  }

  /** 走代理的连接等 mihomo 就绪；关着、起不来时抛出原因 */
  async function waitReady() {
    await applying;
    if (blocked) throw new Error(`全局代理没有在运行：${blocked}`);
    await runner.waitReady();
  }

  /**
   * 更新订阅（手动点「更新订阅」或每天自动）。成功后节点换新，选的节点没了就改回自动；失败时保留原来的节点。
   * @returns {Promise<{ok: true, nodeCount: number} | {ok: false, error: string}>}
   */
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const url = settings().subscriptionUrl;
      if (!url) return { ok: false, error: '还没有填订阅地址' };
      const at = new Date(now()).toISOString();
      try {
        const r = await checkedNodes(await fetchSubscription(url, { timeoutMs: options.subscriptionTimeoutMs }));
        if (closed || settings().subscriptionUrl !== url) return { ok: false, error: '订阅地址在更新期间改了，这次结果不用' };
        const store = loadNodes();
        store.subscription = { ...r, updatedAt: at };
        saveNodes(store);
        const s = settings();
        let notice = null;
        if (s.source === 'subscription' && s.node && !r.proxies.some((p) => p.name === s.node)) {
          notice = `订阅更新后没有之前选的节点「${s.node}」了，已改成自动选最快的`;
          ctx.updateSettings((x) => {
            x.proxy.node = '';
          });
          log.warn('[proxy] 订阅更新后选的节点没了，已改成自动选最快的');
        }
        updateMeta((m) => {
          m.subscription = { lastAttemptAt: at, error: null };
          if (notice) m.notice = notice;
        });
        log.info(`[proxy] 订阅已更新：${r.proxies.length} 个节点`);
        if (s.enabled && s.source === 'subscription') await apply();
        return { ok: true, nodeCount: r.proxies.length };
      } catch (err) {
        const error = err instanceof SubscriptionError ? err.message : `订阅里的节点 ${err?.message || err}`;
        updateMeta((m) => {
          m.subscription = { lastAttemptAt: at, error };
        });
        log.warn(`[proxy] ${error}`);
        return { ok: false, error };
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** 定时检查：开着、用订阅时，上次成功超过一天（失败后过一小时）就更新 */
  function tick() {
    const s = settings();
    if (closed || !s.enabled || s.source !== 'subscription' || !s.subscriptionUrl) return null;
    const meta = loadMeta();
    const updatedAt = Date.parse(loadNodes().subscription?.updatedAt || '') || 0;
    const lastAttempt = Date.parse(meta.subscription?.lastAttemptAt || '') || 0;
    const due = meta.subscription?.error ? lastAttempt + REFRESH_RETRY_MS : updatedAt + REFRESH_EVERY_MS;
    if (now() < due) return null;
    return refresh();
  }

  /**
   * 状态（设置页显示）。live=true 时还问一下 mihomo 现在实际用的是哪个节点。
   */
  async function status({ live = false } = {}) {
    const s = settings();
    const store = loadNodes();
    const meta = loadMeta();
    const list = nodesOf(s.source, store);
    const rs = runner.status();
    let state = 'off';
    let error = null;
    if (s.enabled) {
      if (blocked) {
        state = 'error';
        error = blocked;
      } else {
        state = rs.state === 'stopped' ? 'starting' : rs.state;
        error = rs.error;
      }
    }
    let current = null;
    if (live && state === 'running') {
      try {
        const main = await runner.api(`/proxies/${encodeURIComponent(MAIN_GROUP)}`, { timeoutMs: 2000 });
        current = main?.now === AUTO_GROUP ? (await runner.api(`/proxies/${encodeURIComponent(AUTO_GROUP)}`, { timeoutMs: 2000 }))?.now || null : main?.now || null;
      } catch {
        current = null;
      }
    }
    return {
      available: available(),
      enabled: s.enabled,
      state,
      error,
      restartAt: s.enabled ? rs.restartAt : null,
      port: config.globalProxyPort,
      source: s.source,
      node: s.node,
      current,
      nodes: list.map((p) => ({ name: p.name, type: p.type })),
      nodeCount: list.length,
      subscription: {
        set: !!s.subscriptionUrl,
        nodeCount: store.subscription?.proxies?.length || 0,
        skipped: store.subscription?.skipped || 0,
        invalid: store.subscription?.invalid || [],
        updatedAt: store.subscription?.updatedAt || null,
        lastAttemptAt: meta.subscription?.lastAttemptAt || null,
        error: meta.subscription?.error || null,
      },
      config: {
        set: !!store.config,
        nodeCount: store.config?.proxies?.length || 0,
        skipped: store.config?.skipped || 0,
        invalid: store.config?.invalid || [],
        updatedAt: store.config?.updatedAt || null,
      },
      notice: meta.notice || null,
      usedBy: usedBy().map((a) => ({ id: a.id, name: a.name })),
    };
  }

  /** 经全局代理请求 PROXY_TEST_URL，返回出口 IP 和耗时（只看代理本身，不管直连名单） */
  async function test() {
    if (!settings().enabled) return { ok: false, error: '全局代理没有开启' };
    const started = now();
    try {
      await waitReady();
      const dispatcher = proxiedDispatcher();
      if (!dispatcher) throw new Error('全局代理没有在运行');
      const res = await fetch(ctx.proxyTestUrl, { dispatcher, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let ip;
      try {
        ip = JSON.parse(body)?.ip;
      } catch {
        /* 下面统一报错 */
      }
      if (typeof ip !== 'string' || !ip) throw new Error('返回内容里没有 ip');
      return { ok: true, ip, latencyMs: now() - started };
    } catch (err) {
      const msg = err?.name === 'TimeoutError' ? `超时（${TEST_TIMEOUT_MS / 1000} 秒）` : err?.cause?.message || err?.message || String(err);
      return { ok: false, error: `全局代理测试失败：${msg}` };
    }
  }

  /** 给所有节点测一次延迟（经 mihomo 访问 DELAY_TEST_URL）。{ok, delays: {节点名: 毫秒或 null（超时、连不上）}} */
  async function delays() {
    const s = settings();
    if (!s.enabled) return { ok: false, error: '全局代理没有开启，开启后才能测速' };
    try {
      await waitReady();
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
    const names = nodesOf(s.source).map((p) => p.name);
    let got = {};
    try {
      got =
        (await runner.api(
          `/group/${encodeURIComponent(AUTO_GROUP)}/delay?url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=${DELAY_TIMEOUT_MS}`,
          { timeoutMs: DELAY_TIMEOUT_MS + 5000 },
        )) || {};
    } catch (err) {
      // 504：所有节点都超时
      if (err?.status !== 504) return { ok: false, error: `测速失败：${err?.message || err}` };
    }
    const out = {};
    for (const n of names) out[n] = Number.isFinite(got[n]) && got[n] > 0 ? got[n] : null;
    return { ok: true, delays: out, url: DELAY_TEST_URL };
  }

  return {
    available,
    prepare,
    apply,
    refresh,
    tick,
    status,
    test,
    delays,
    usedBy,
    /** 能不能给号选「用全局代理」：开关开着 */
    enabled: () => settings().enabled,
    /** 用全局代理的号在 WAHA session 里填的代理：经 compose 内网连墨鸽的混合端口，带共享的账号密码 */
    wahaProxy() {
      const a = auth();
      return { server: `${config.proxyRelayHost}:${config.globalProxyPort}`, username: a.username, password: a.password };
    },
    /** 启动：开着就换出口、起 mihomo；之后定时检查订阅 */
    start() {
      if (settings().enabled) ensureRouting(settings());
      apply({ sync: false });
      const every = options.refreshCheckMs ?? REFRESH_CHECK_MS;
      if (every > 0) {
        timer = setInterval(() => {
          tick()?.catch(() => {});
        }, every);
        timer.unref?.();
      }
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await applying.catch(() => {});
      await refreshing?.catch(() => {});
      await runner.stop();
      if (routed) {
        routed = false;
        await disableRouting();
      }
    },
    /** 测试用 */
    runner,
  };
}

