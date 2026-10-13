// F7 一个企业多个号（Account）：存储、对外视图、部分更新的校验、第一期数据迁移。
import crypto from 'node:crypto';
import net from 'node:net';
import { kvGet, kvSet } from './db.js';
import { DEFAULT_META_API_VERSION, boolField, normalizeEmails, normalizeNumbers, str } from './settings.js';
import { badRequest, HttpError, isPlainObject, nowIso, safeJsonParse } from './util.js';
import { releaseLostAccess } from './wa/assign.js';

export const CHANNELS = ['waha', 'meta'];
/** 回复方式：off 不回复（只存消息）、suggest 推荐回复（AI 起草，业务员确认后发）、auto 自动回复 */
export const REPLY_MODES = ['off', 'suggest', 'auto'];
export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];
export const DELETED_ACCOUNT_NAME = '（已删除）';

export const newAccountId = () => crypto.randomBytes(6).toString('hex');
/** 会话 id：<accountId>:<chatId> */
export const conversationIdOf = (accountId, chatId) => `${accountId}:${chatId}`;

function defaultConfig(channel) {
  return {
    replyMode: 'suggest',
    persona: '',
    scope: 'all',
    allowlist: [],
    blocklist: [],
    waha: channel === 'waha' ? { proxy: { enabled: false, protocol: 'socks5', host: '', port: null, username: '', password: '' } } : null,
    meta:
      channel === 'meta'
        ? { phoneNumberId: '', apiVersion: DEFAULT_META_API_VERSION, verifyToken: '', accessToken: '', appSecret: '' }
        : null,
    notify: { email: { enabled: false, to: [] }, whatsapp: { enabled: false, number: '' } },
  };
}

/** 旧的 autoReply 开关 → 回复方式：开 → auto，关（或没有）→ off */
const replyModeOfLegacy = (autoReply) => (autoReply === true ? 'auto' : 'off');

/** DB 行 → 内部对象（含密钥，只在服务端用） */
export function rowToAccount(r) {
  if (!r) return null;
  const base = defaultConfig(r.channel);
  const { autoReply, replyMode, ...c } = safeJsonParse(r.config, {}) || {};
  const cfg = {
    ...base,
    ...c,
    // 升级前存的是 autoReply，没有 replyMode：开着的算 auto，关着的算 off（不会变成默认的 suggest）
    replyMode: REPLY_MODES.includes(replyMode) ? replyMode : replyModeOfLegacy(autoReply),
    waha: base.waha ? { proxy: { ...base.waha.proxy, ...(c.waha?.proxy || {}) } } : null,
    meta: base.meta ? { ...base.meta, ...(c.meta || {}) } : null,
    notify: {
      email: { ...base.notify.email, ...(c.notify?.email || {}) },
      whatsapp: { ...base.notify.whatsapp, ...(c.notify?.whatsapp || {}) },
    },
  };
  return {
    id: r.id,
    name: r.name,
    channel: r.channel,
    sessionName: r.session_name,
    createdAt: r.created_at,
    wahaConfigHash: r.waha_config_hash || null,
    relay: r.relay_port ? { port: r.relay_port, username: r.relay_username, password: r.relay_password } : null,
    ...cfg,
  };
}

/** 号是否连上了（Meta 凭证齐全视为 configured） */
export function metaConfigured(acc) {
  const m = acc.meta;
  return !!(m && m.phoneNumberId && m.accessToken && m.appSecret && m.verifyToken);
}

/**
 * 对外视图：密钥不回传。viewer 是 agent 时再去掉 Meta 的 verifyToken 和通知的收件人（邮箱、号码），
 * 这些只有 admin 能看能改
 * @param {any} acc
 * @param {any} config
 * @param {any} status
 * @param {{role:string}|null} [viewer]
 */
export function publicAccount(acc, config, status, viewer = null) {
  const px = acc.waha?.proxy;
  const hide = viewer?.role === 'agent';
  return {
    id: acc.id,
    name: acc.name,
    channel: acc.channel,
    createdAt: acc.createdAt,
    replyMode: acc.replyMode,
    // 兼容旧前端：只有 auto 算开着自动回复
    autoReply: acc.replyMode === 'auto',
    persona: acc.persona,
    scope: acc.scope,
    allowlist: [...acc.allowlist],
    blocklist: [...acc.blocklist],
    waha: acc.waha
      ? {
          sessionName: acc.sessionName,
          proxy: {
            enabled: px.enabled,
            protocol: px.protocol,
            host: px.host,
            port: px.port,
            username: px.username,
            passwordSet: !!px.password,
          },
        }
      : null,
    meta: acc.meta
      ? {
          phoneNumberId: acc.meta.phoneNumberId,
          apiVersion: acc.meta.apiVersion,
          verifyToken: hide ? null : acc.meta.verifyToken,
          accessTokenSet: !!acc.meta.accessToken,
          appSecretSet: !!acc.meta.appSecret,
          webhookUrl: `${config.publicBaseUrl}/webhooks/meta/${acc.id}`,
        }
      : null,
    notify: {
      email: { enabled: acc.notify.email.enabled, to: hide ? [] : [...acc.notify.email.to] },
      whatsapp: { enabled: acc.notify.whatsapp.enabled, number: hide ? '' : acc.notify.whatsapp.number },
    },
    status: status || { state: 'not_configured', me: null, error: null, lastWebhookAt: null },
  };
}

function storedConfig(acc) {
  return JSON.stringify({
    replyMode: acc.replyMode,
    persona: acc.persona,
    scope: acc.scope,
    allowlist: acc.allowlist,
    blocklist: acc.blocklist,
    waha: acc.waha,
    meta: acc.meta,
    notify: acc.notify,
  });
}

/** 代理部分（含协议）的指纹：变了就要重启中继并更新 WAHA session */
export const proxyFingerprint = (acc) => JSON.stringify(acc.waha?.proxy || null);

function applyProxyPatch(px, q) {
  if (!isPlainObject(q)) throw badRequest('waha.proxy 必须是对象');
  if (q.enabled !== undefined) px.enabled = boolField(q.enabled, 'waha.proxy.enabled');
  if (q.protocol !== undefined) {
    if (!PROXY_PROTOCOLS.includes(q.protocol)) throw badRequest('proxy.protocol 只能是 http、https、socks4 或 socks5');
    px.protocol = q.protocol;
  }
  if (q.host !== undefined) {
    const v = str(q.host, 'waha.proxy.host', 255).trim();
    if (v && (/\s|\/|@/.test(v) || v.includes('://'))) throw badRequest('proxy.host 只填主机名或 IP，不带协议头、端口和账号');
    const bare = v.replace(/^\[(.*)\]$/, '$1');
    if (bare.includes(':') && !net.isIPv6(bare)) throw badRequest('proxy.host 不要带端口，端口填在 port');
    px.host = bare;
  }
  if (q.port !== undefined) {
    if (q.port !== null && (!Number.isInteger(q.port) || q.port < 1 || q.port > 65535)) {
      throw badRequest('proxy.port 必须是 1–65535 的整数或 null');
    }
    px.port = q.port;
  }
  if (q.username !== undefined) px.username = str(q.username, 'waha.proxy.username', 255);
  if (q.password !== undefined) px.password = str(q.password, 'waha.proxy.password', 1000);
  if (px.enabled && (!px.host || !px.port)) throw badRequest('启用代理时必须填写 host 和 port');
}

const forbidden = () => new HttpError(403, 'forbidden', '没有权限');

/**
 * 号的部分更新。接口层面整个 PUT 只有 admin 能调（agent 一律 403，见 routes/accounts.js）；
 * isAdmin=false 时 name、waha.proxy、meta.* 仍然拒绝，留作第二道防线。
 * 回复方式：replyMode（off / suggest / auto）；也接受旧的 autoReply（true → auto，false → off），两个都给时以 replyMode 为准。
 * @param {any} current 内部对象
 * @param {any} patch
 * @param {{isAdmin:boolean, emailReady:boolean}} o
 */
export function applyAccountPatch(current, patch, { isAdmin, emailReady }) {
  if (!isPlainObject(patch)) throw badRequest('请求体必须是对象');
  const a = structuredClone(current);
  const adminOnly = () => {
    if (!isAdmin) throw forbidden();
  };
  if (patch.channel !== undefined && patch.channel !== a.channel) {
    throw badRequest('接入方式创建后不能改，要换就删掉这个号再新建', 'channel_immutable');
  }
  if (patch.name !== undefined) {
    adminOnly();
    const v = str(patch.name, 'name', 100).trim();
    if (!v) throw badRequest('name 不能为空');
    a.name = v;
  }
  if (patch.replyMode !== undefined) {
    if (!REPLY_MODES.includes(patch.replyMode)) throw badRequest('replyMode 只能是 off、suggest 或 auto');
    a.replyMode = patch.replyMode;
  } else if (patch.autoReply !== undefined) {
    a.replyMode = replyModeOfLegacy(boolField(patch.autoReply, 'autoReply'));
  }
  if (patch.persona !== undefined) a.persona = str(patch.persona, 'persona', 4000);
  if (patch.scope !== undefined) {
    if (!['all', 'allowlist'].includes(patch.scope)) throw badRequest('scope 只能是 all 或 allowlist');
    a.scope = patch.scope;
  }
  if (patch.allowlist !== undefined) a.allowlist = normalizeNumbers(patch.allowlist, 'allowlist ');
  if (patch.blocklist !== undefined) a.blocklist = normalizeNumbers(patch.blocklist, 'blocklist ');

  if (patch.waha !== undefined && patch.waha !== null) {
    if (!isPlainObject(patch.waha)) throw badRequest('waha 必须是对象');
    if (patch.waha.proxy !== undefined) {
      adminOnly();
      if (a.channel !== 'waha') throw badRequest('只有扫码号才有 IP 代理');
      applyProxyPatch(a.waha.proxy, patch.waha.proxy);
    }
  }
  if (patch.meta !== undefined && patch.meta !== null) {
    const m = patch.meta;
    if (!isPlainObject(m)) throw badRequest('meta 必须是对象');
    adminOnly();
    if (a.channel !== 'meta') throw badRequest('只有 Meta 号才有这些字段');
    if (m.phoneNumberId !== undefined) {
      const v = str(m.phoneNumberId, 'meta.phoneNumberId', 100).trim();
      if (v && !/^\d+$/.test(v)) throw badRequest('phoneNumberId 只能是数字');
      a.meta.phoneNumberId = v;
    }
    if (m.apiVersion !== undefined) {
      const v = str(m.apiVersion, 'meta.apiVersion', 20).trim();
      if (v && !/^v\d+\.\d+$/.test(v)) throw badRequest('apiVersion 格式应为 v26.0 这样');
      a.meta.apiVersion = v || DEFAULT_META_API_VERSION;
    }
    if (m.verifyToken !== undefined) a.meta.verifyToken = str(m.verifyToken, 'meta.verifyToken', 500);
    if (m.accessToken !== undefined) a.meta.accessToken = str(m.accessToken, 'meta.accessToken', 2000).trim();
    if (m.appSecret !== undefined) a.meta.appSecret = str(m.appSecret, 'meta.appSecret', 500).trim();
  }
  if (patch.notify !== undefined) {
    const p = patch.notify;
    if (!isPlainObject(p)) throw badRequest('notify 必须是对象');
    if (p.email !== undefined) {
      if (!isPlainObject(p.email)) throw badRequest('notify.email 必须是对象');
      if (p.email.enabled !== undefined) {
        const on = boolField(p.email.enabled, 'notify.email.enabled');
        // 只拦"开启"：已经开着的再提交一次不报错，免得全局发信方式被撤掉后号的其他设置存不了
        if (on && !a.notify.email.enabled && !emailReady) {
          throw badRequest('请管理员先在设置里配置发信方式', 'email_not_configured');
        }
        a.notify.email.enabled = on;
      }
      if (p.email.to !== undefined) a.notify.email.to = normalizeEmails(p.email.to, 'notify.email.to');
    }
    if (p.whatsapp !== undefined) {
      const w = p.whatsapp;
      if (!isPlainObject(w)) throw badRequest('notify.whatsapp 必须是对象');
      if (w.enabled !== undefined) a.notify.whatsapp.enabled = boolField(w.enabled, 'notify.whatsapp.enabled');
      if (w.number !== undefined) {
        if (typeof w.number !== 'string' && typeof w.number !== 'number') throw badRequest('notify.whatsapp.number 必须是字符串');
        a.notify.whatsapp.number = String(w.number).replace(/\D+/g, '');
      }
    }
  }
  return a;
}

// 号码配置导出 / 导入（规格外新增，只有 admin）。文件里是密钥明文。
export const ACCOUNTS_EXPORT_FORMAT = 'inkdove-accounts';
export const ACCOUNTS_EXPORT_VERSION = 1;

/** 导出一个号的配置（含密钥明文）。不含 id、WAHA session 名、状态、时间、会话消息和成员分配 */
export function exportAccount(acc) {
  const px = acc.waha?.proxy;
  const m = acc.meta;
  return {
    name: acc.name,
    channel: acc.channel,
    replyMode: acc.replyMode,
    persona: acc.persona,
    scope: acc.scope,
    allowlist: [...acc.allowlist],
    blocklist: [...acc.blocklist],
    waha: px
      ? {
          proxy: {
            enabled: px.enabled,
            protocol: px.protocol,
            host: px.host,
            port: px.port,
            username: px.username,
            password: px.password,
          },
        }
      : null,
    meta: m
      ? {
          phoneNumberId: m.phoneNumberId,
          apiVersion: m.apiVersion,
          verifyToken: m.verifyToken,
          accessToken: m.accessToken,
          appSecret: m.appSecret,
        }
      : null,
    notify: {
      email: { enabled: acc.notify.email.enabled, to: [...acc.notify.email.to] },
      whatsapp: { enabled: acc.notify.whatsapp.enabled, number: acc.notify.whatsapp.number },
    },
  };
}

/**
 * 校验导入文件。全部合法才返回要新建的号；有一个不合法就抛 400（说明第几个号、哪个字段），一个都不建。
 * 每个号的校验和新建、更新共用（applyAccountPatch），缺的字段按新建号的默认值。
 * 回复方式：有 replyMode 用 replyMode；升级前导出的文件只有 autoReply，按 true → auto、false → off 换算；两个都没有按默认（suggest）。
 * 唯一的例外是邮件通知：号里开了邮件通知、但这里还没配发信方式时不报错，
 * 而是把它关掉（收件人 to 保留），并在返回项的 notices 里说明，别让一个号拖垮整批导入。
 * @param {any} doc 解析后的 JSON
 * @param {{emailReady:boolean}} o
 * @returns {{name:string, channel:'waha'|'meta', config:any, notices?:string[]}[]}
 */
export function parseAccountsExport(doc, { emailReady }) {
  if (!isPlainObject(doc) || doc.format !== ACCOUNTS_EXPORT_FORMAT) {
    throw badRequest('这不是墨鸽导出的号码配置文件（format 应为 inkdove-accounts）', 'bad_format');
  }
  if (doc.version !== ACCOUNTS_EXPORT_VERSION) {
    throw badRequest(`不支持这个文件版本（version: ${JSON.stringify(doc.version ?? null)}），只能导入 version 1`, 'unsupported_version');
  }
  if (!Array.isArray(doc.accounts)) throw badRequest('accounts 必须是数组', 'bad_format');
  return doc.accounts.map((item, i) => {
    let label = `第 ${i + 1} 个号`;
    try {
      if (!isPlainObject(item)) throw badRequest('必须是对象');
      const name = str(item.name ?? '', 'name', 100).trim();
      if (!name) throw badRequest('name 不能为空');
      label += `（${name}）`;
      if (!CHANNELS.includes(item.channel)) throw badRequest('channel 只能是 waha 或 meta');
      // applyAccountPatch 在这两种情况下的提示不带字段名，先拦下来
      if (item.channel !== 'waha' && item.waha != null) throw badRequest('waha 只有扫码号才有，Meta 号应为 null');
      if (item.channel !== 'meta' && item.meta != null) throw badRequest('meta 只有 Meta 号才有，扫码号应为 null');
      const draft = { name, channel: item.channel, ...defaultConfig(item.channel) };
      // 没配发信方式时，开着的邮件通知先关掉再校验（拷一份，不改解析出来的原文件内容）；
      // notify 不是对象之类的格式问题仍交给 applyAccountPatch 报错
      /** @type {string[]} */
      const notices = [];
      let patch = item;
      if (!emailReady && isPlainObject(item.notify) && isPlainObject(item.notify.email) && item.notify.email.enabled === true) {
        patch = { ...item, notify: { ...item.notify, email: { ...item.notify.email, enabled: false } } };
        notices.push('没配发信方式，已关掉邮件通知');
      }
      const { name: n, channel, ...config } = applyAccountPatch(draft, patch, { isAdmin: true, emailReady });
      return { name: n, channel, config, ...(notices.length ? { notices } : {}) };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      throw new HttpError(err.status, err.code, `${label}：${err.message}`);
    }
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./config.js').Config} config
 */
export function createAccountStore(db, config) {
  const getRow = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  /** 给中继分一个没被别的号占用的端口 */
  function allocateRelayPort() {
    const used = new Set(db.prepare('SELECT relay_port FROM accounts WHERE relay_port IS NOT NULL').all().map((r) => r.relay_port));
    let p = config.proxyRelayPortBase;
    while (used.has(p)) p++;
    return p;
  }

  const store = {
    get(id) {
      return rowToAccount(getRow(id));
    },
    list() {
      return db.prepare('SELECT * FROM accounts ORDER BY created_at, rowid').all().map(rowToAccount);
    },
    bySession(name) {
      return rowToAccount(db.prepare("SELECT * FROM accounts WHERE channel = 'waha' AND session_name = ?").get(name));
    },
    /** @param {{name:string, channel:'waha'|'meta', sessionName?:string, config?:any}} p */
    create({ name, channel, sessionName, config: cfg }) {
      const id = newAccountId();
      const acc = { ...defaultConfig(channel), ...(cfg || {}) };
      const isWaha = channel === 'waha';
      db.prepare(
        `INSERT INTO accounts(id, name, channel, session_name, config, relay_port, relay_username, relay_password, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        name,
        channel,
        isWaha ? sessionName || `inkdove_${id}` : null,
        storedConfig(acc),
        isWaha ? allocateRelayPort() : null,
        isWaha ? `inkdove_${crypto.randomBytes(6).toString('hex')}` : null,
        isWaha ? crypto.randomBytes(24).toString('base64url') : null,
        nowIso(),
      );
      return store.get(id);
    },
    /**
     * 导入：在一个事务里逐个新建（新 id、新 session 名，不启动 WAHA）。名称可以重复；
     * Meta 号的 phoneNumberId 和已有的号、或文件里前面的号重复时跳过（空的不算重复）。
     * @param {{name:string, channel:'waha'|'meta', config:any, notices?:string[]}[]} items 已经过 parseAccountsExport 校验；
     *   notices 是导入时自动调整过什么的说明，原样带到返回的 created 项里
     */
    importMany(items) {
      return db.transaction(() => {
        /** @type {Map<string, {name:string, inFile:boolean}>} */
        const pnids = new Map();
        for (const a of store.list()) {
          if (a.channel === 'meta' && a.meta.phoneNumberId) pnids.set(a.meta.phoneNumberId, { name: a.name, inFile: false });
        }
        const created = [];
        const skipped = [];
        for (const it of items) {
          const pnid = it.channel === 'meta' ? it.config.meta.phoneNumberId : '';
          const dup = pnid && pnids.get(pnid);
          if (dup) {
            skipped.push({
              name: it.name,
              reason: dup.inFile
                ? `phoneNumberId ${pnid} 和文件里前面的号「${dup.name}」重复，只导入了前面那个`
                : `phoneNumberId ${pnid} 已经被号「${dup.name}」使用，同一个 Meta 号码不重复导入`,
            });
            continue;
          }
          const acc = store.create(it);
          if (pnid) pnids.set(pnid, { name: acc.name, inFile: true });
          created.push({ id: acc.id, name: acc.name, ...(it.notices?.length ? { notices: it.notices } : {}) });
        }
        return { created, skipped };
      })();
    },
    save(acc) {
      db.prepare('UPDATE accounts SET name = ?, config = ? WHERE id = ?').run(acc.name, storedConfig(acc), acc.id);
      return store.get(acc.id);
    },
    setWahaConfigHash(id, hash) {
      db.prepare('UPDATE accounts SET waha_config_hash = ? WHERE id = ?').run(hash, id);
    },
    /** @param {{id:string}|null} [by] 删号的人（记进分配记录） */
    delete(id, by = null) {
      db.transaction(() => {
        db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
        db.prepare('DELETE FROM notice_messages WHERE account_id = ?').run(id);
        // 同时从所有人的 accountIds 里移除；agent 在这个号上负责的会话变成未分配（access_removed），admin 的不动
        for (const u of db.prepare('SELECT id, account_ids FROM users').all()) {
          const ids = safeJsonParse(u.account_ids, []);
          if (!ids.includes(id)) continue;
          db.prepare('UPDATE users SET account_ids = ? WHERE id = ?').run(JSON.stringify(ids.filter((x) => x !== id)), u.id);
          releaseLostAccess(db, u.id, by);
        }
      })();
    },
  };
  return store;
}

/**
 * 第一期数据迁移：库里有第一期的单通道设置、还没有任何号时，按旧设置建一个号，把旧会话挂到这个号下；
 * 旧的 SMTP 设置挪到全局发信方式。只跑一次（建出号之后就不再满足条件）。
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof createAccountStore>} accounts
 * @param {{info: Function}} log
 * @param {import('./config.js').Config} [config]
 */
export function migrateLegacy(db, accounts, log, config) {
  const stored = kvGet(db, 'settings', null);
  if (!stored || !isPlainObject(stored.channel)) return null;
  if (db.prepare('SELECT COUNT(*) n FROM accounts').get().n > 0) return null;
  const ch = stored.channel;
  const n = stored.notify || {};
  const r = stored.reply || {};
  // 旧 SMTP → 全局 email
  if (n.email?.host && !stored.email) {
    stored.email = {
      provider: n.email.enabled ? 'smtp' : null,
      from: n.email.from || n.email.user || '',
      smtp: { host: n.email.host, port: n.email.port || 465, secure: n.email.secure !== false, user: n.email.user || '', password: n.email.password || '' },
      resend: { apiKey: '' },
    };
  }
  let acc = null;
  if (ch.type === 'waha' || ch.type === 'meta') {
    acc = accounts.create({
      name: '默认号',
      channel: ch.type,
      // 沿用第一期的 session 名，已扫码的登录态不用重扫
      sessionName: ch.type === 'waha' ? ch.waha?.sessionName || config?.legacyWahaSession || 'default' : undefined,
      config: {
        replyMode: replyModeOfLegacy(!!r.autoReply),
        scope: r.scope === 'allowlist' ? 'allowlist' : 'all',
        allowlist: Array.isArray(r.allowlist) ? r.allowlist : [],
        blocklist: Array.isArray(r.blocklist) ? r.blocklist : [],
        waha: ch.type === 'waha' ? { proxy: { enabled: false, protocol: 'socks5', host: '', port: null, username: '', password: '', ...(ch.waha?.proxy || {}) } } : null,
        meta: ch.type === 'meta' ? { phoneNumberId: '', apiVersion: DEFAULT_META_API_VERSION, verifyToken: '', accessToken: '', appSecret: '', ...(ch.meta || {}) } : null,
        notify: {
          email: { enabled: !!(n.email?.enabled && stored.email?.provider), to: Array.isArray(n.email?.to) ? n.email.to : [] },
          whatsapp: { enabled: !!n.whatsapp?.enabled, number: n.whatsapp?.number || '' },
        },
      },
    });
    db.transaction(() => {
      const convs = db.prepare('SELECT id FROM conversations WHERE account_id IS NULL').all();
      for (const c of convs) {
        const nid = conversationIdOf(acc.id, c.id);
        db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?').run(nid, c.id);
        db.prepare('UPDATE conversations SET id = ?, account_id = ?, chat_id = ? WHERE id = ?').run(nid, acc.id, c.id, c.id);
      }
    })();
    log.info(`[migrate] 已把第一期的 ${ch.type} 通道迁移成号「默认号」（${acc.id}）`);
  }
  delete stored.channel;
  delete stored.notify;
  if (stored.reply) {
    delete stored.reply.autoReply;
    delete stored.reply.scope;
    delete stored.reply.allowlist;
    delete stored.reply.blocklist;
  }
  kvSet(db, 'settings', stored);
  return acc;
}
