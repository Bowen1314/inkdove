// F7 一个企业多个号（Account）：存储、对外视图、部分更新的校验、第一期数据迁移。
import crypto from 'node:crypto';
import net from 'node:net';
import { kvGet, kvSet } from './db.js';
import { DEFAULT_META_API_VERSION, boolField, normalizeEmails, normalizeNumbers, str } from './settings.js';
import { badRequest, HttpError, isPlainObject, nowIso, safeJsonParse } from './util.js';
import { releaseLostAccess } from './wa/assign.js';
import { botIdOf, TG_TOKEN_RE } from './wa/telegram.js';

/**
 * 接入方式：waha 扫码、meta Meta 官方 Cloud API、line LINE 官方帐号（LINE Messaging API）、
 * tgbot Telegram 机器人（客户和机器人聊）、tgbiz Telegram 私人号（Telegram 的「聊天自动化」：把机器人连到自己的号上，
 * 客户和这个私人号聊，机器人代收代发）。两种 Telegram 都走 Telegram Bot API
 */
export const CHANNELS = ['waha', 'meta', 'line', 'tgbot', 'tgbiz'];
export const isTelegram = (channel) => channel === 'tgbot' || channel === 'tgbiz';
/** 发 WhatsApp 消息的接入方式：只有它们能开 WhatsApp 通知、能外联群发 */
export const isWhatsapp = (channel) => channel === 'waha' || channel === 'meta';
/** 客户没有手机号的接入方式，没名字时这样称呼客户（不露 LINE 的 userId、Telegram 的用户 id） */
export const NO_NUMBER_NAMES = { line: 'LINE 用户', tgbot: 'Telegram 用户', tgbiz: 'Telegram 用户' };
export const CHANNEL_NAMES = { line: 'LINE 官方帐号', tgbot: 'Telegram 机器人', tgbiz: 'Telegram 私人号' };
/**
 * 回复方式：off 人工回复（只存消息，不调用模型；业务员需要时在会话页手动要推荐回复）、auto 自动回复。
 * v0.3.0 还有 suggest（客户来消息自动起草推荐回复），已取消：库里存的、PUT 收到的、导入文件里的 suggest 都按 off
 */
export const REPLY_MODES = ['off', 'auto'];
export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];
export const DELETED_ACCOUNT_NAME = '（已删除）';

export const newAccountId = () => crypto.randomBytes(6).toString('hex');
/** 会话 id：<accountId>:<chatId> */
export const conversationIdOf = (accountId, chatId) => `${accountId}:${chatId}`;

function defaultConfig(channel) {
  return {
    replyMode: 'off',
    persona: '',
    scope: 'all',
    allowlist: [],
    blocklist: [],
    // useGlobal：用全局代理（设置 → 代理）；这时 protocol、host 这些自己的代理字段留着不用，切回来不用重填
    waha:
      channel === 'waha'
        ? { proxy: { enabled: false, useGlobal: false, protocol: 'socks5', host: '', port: null, username: '', password: '' } }
        : null,
    meta:
      channel === 'meta'
        ? { phoneNumberId: '', apiVersion: DEFAULT_META_API_VERSION, verifyToken: '', accessToken: '', appSecret: '' }
        : null,
    // LINE Developers Console 里 Messaging API channel 的 Channel ID、Channel secret、长期 Channel access token
    line: channel === 'line' ? { channelId: '', channelSecret: '', accessToken: '' } : null,
    // @BotFather 给的机器人 token。私人号绑定了谁、连接的 id 这些是墨鸽收消息时记下的，存在 kv（见 wa/service.js 的 tgKv），不在这里
    telegram: isTelegram(channel) ? { botToken: '' } : null,
    notify: { email: { enabled: false, to: [] }, whatsapp: { enabled: false, number: '' } },
  };
}

/** 旧的 autoReply 开关 → 回复方式：开 → auto，关（或没有）→ off */
const replyModeOfLegacy = (autoReply) => (autoReply === true ? 'auto' : 'off');
/** 已取消的 suggest（v0.3.0 的推荐回复模式）当 off，其他值原样返回 */
const withoutSuggest = (replyMode) => (replyMode === 'suggest' ? 'off' : replyMode);

/** DB 行 → 内部对象（含密钥，只在服务端用） */
export function rowToAccount(r) {
  if (!r) return null;
  const base = defaultConfig(r.channel);
  const { autoReply, replyMode: stored, ...c } = safeJsonParse(r.config, {}) || {};
  // v0.3.0 存的 suggest 读成 off（下次保存时写 off）；更早只存了 autoReply、没有 replyMode 的，开着的算 auto，关着的算 off
  const replyMode = withoutSuggest(stored);
  const cfg = {
    ...base,
    ...c,
    replyMode: REPLY_MODES.includes(replyMode) ? replyMode : replyModeOfLegacy(autoReply),
    waha: base.waha ? { proxy: { ...base.waha.proxy, ...(c.waha?.proxy || {}) } } : null,
    meta: base.meta ? { ...base.meta, ...(c.meta || {}) } : null,
    line: base.line ? { ...base.line, ...(c.line || {}) } : null,
    telegram: base.telegram ? { ...base.telegram, ...(c.telegram || {}) } : null,
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

/** LINE 官方帐号：Channel ID、Channel secret、Channel access token 三项都填了视为 configured */
export function lineConfigured(acc) {
  const l = acc.line;
  return !!(l && l.channelId && l.channelSecret && l.accessToken);
}

/**
 * 对外视图：密钥不回传（Meta 的 token、app secret，LINE 的 channel secret、access token，Telegram 的机器人 token 只给「设没设」）。
 * viewer 是 agent 时再去掉 Meta 的 verifyToken、通知的收件人（邮箱、号码）和 Telegram 私人号的绑定链接，这些只有 admin 能看能改
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
            useGlobal: px.useGlobal,
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
    line: acc.line
      ? {
          channelId: acc.line.channelId,
          channelSecretSet: !!acc.line.channelSecret,
          accessTokenSet: !!acc.line.accessToken,
          webhookUrl: `${config.publicBaseUrl}/webhooks/line/${acc.id}`,
        }
      : null,
    telegram: acc.telegram ? { botTokenSet: !!acc.telegram.botToken } : null,
    notify: {
      email: { enabled: acc.notify.email.enabled, to: hide ? [] : [...acc.notify.email.to] },
      whatsapp: { enabled: acc.notify.whatsapp.enabled, number: hide ? '' : acc.notify.whatsapp.number },
    },
    status: withoutBindLink(status, hide) || { state: 'not_configured', me: null, error: null, lastWebhookAt: null },
  };
}

/** Telegram 私人号的绑定链接谁点了谁就成了号主，agent 看不到 */
function withoutBindLink(status, hide) {
  if (!hide || !status?.telegram?.bindLink) return status;
  return { ...status, telegram: { ...status.telegram, bindLink: null } };
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
    line: acc.line,
    telegram: acc.telegram,
    notify: acc.notify,
  });
}

/** 代理部分（含协议）的指纹：变了就要重启中继并更新 WAHA session */
export const proxyFingerprint = (acc) => JSON.stringify(acc.waha?.proxy || null);

/**
 * @param {any} px 号的代理设置（就地修改）
 * @param {any} q 要改的字段
 * @param {boolean} globalProxyReady 全局代理开着（才能选「用全局代理」）
 */
function applyProxyPatch(px, q, globalProxyReady) {
  if (!isPlainObject(q)) throw badRequest('waha.proxy 必须是对象');
  const wasGlobal = px.enabled && px.useGlobal;
  if (q.enabled !== undefined) px.enabled = boolField(q.enabled, 'waha.proxy.enabled');
  if (q.useGlobal !== undefined) px.useGlobal = boolField(q.useGlobal, 'waha.proxy.useGlobal');
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
  if (px.enabled && px.useGlobal) {
    // 只拦「改成用全局代理」：已经在用的再提交一次不报错
    if (!wasGlobal && !globalProxyReady) {
      throw badRequest('全局代理没有开启：请管理员先在「设置 → 代理」里开启，再选「用全局代理」', 'global_proxy_off');
    }
    return;
  }
  if (px.enabled && (!px.host || !px.port)) throw badRequest('启用代理时必须填写 host 和 port');
}

const forbidden = () => new HttpError(403, 'forbidden', '没有权限');

/**
 * 号的部分更新。接口层面整个 PUT 只有 admin 能调（agent 一律 403，见 routes/accounts.js）；
 * isAdmin=false 时 name、waha.proxy、meta.*、line.*、telegram.* 仍然拒绝，留作第二道防线。
 * LINE 官方帐号、Telegram 号不能开 WhatsApp 通知（通知要由这个号发给一个 WhatsApp 号码，它们发不了），只拦「开启」。
 * 机器人 token 不能和别的号重复（同一个机器人只能有一个程序收消息），这个在 routes/accounts.js 里查。
 * 回复方式：replyMode（off / auto）；suggest 按 off 处理（兼容 v0.3.0 的客户端），其他值 400。
 * 也接受旧的 autoReply（true → auto，false → off），两个都给时以 replyMode 为准。
 * @param {any} current 内部对象
 * @param {any} patch
 * @param {{isAdmin:boolean, emailReady:boolean, globalProxyReady?:boolean}} o globalProxyReady：全局代理开着
 */
export function applyAccountPatch(current, patch, { isAdmin, emailReady, globalProxyReady = false }) {
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
    const mode = withoutSuggest(patch.replyMode);
    if (!REPLY_MODES.includes(mode)) throw badRequest('replyMode 只能是 off 或 auto');
    a.replyMode = mode;
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
      applyProxyPatch(a.waha.proxy, patch.waha.proxy, globalProxyReady);
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
  if (patch.line !== undefined && patch.line !== null) {
    const l = patch.line;
    if (!isPlainObject(l)) throw badRequest('line 必须是对象');
    adminOnly();
    if (a.channel !== 'line') throw badRequest('只有 LINE 官方帐号才有这些字段');
    if (l.channelId !== undefined) {
      const v = str(l.channelId, 'line.channelId', 100).trim();
      if (v && !/^\d+$/.test(v)) throw badRequest('Channel ID 只能是数字');
      a.line.channelId = v;
    }
    if (l.channelSecret !== undefined) a.line.channelSecret = str(l.channelSecret, 'line.channelSecret', 500).trim();
    if (l.accessToken !== undefined) a.line.accessToken = str(l.accessToken, 'line.accessToken', 2000).trim();
  }
  if (patch.telegram !== undefined && patch.telegram !== null) {
    const t = patch.telegram;
    if (!isPlainObject(t)) throw badRequest('telegram 必须是对象');
    adminOnly();
    if (!a.telegram) throw badRequest('只有 Telegram 号才有这些字段');
    if (t.botToken !== undefined) {
      const v = str(t.botToken, 'telegram.botToken', 200).trim();
      if (v && !TG_TOKEN_RE.test(v)) throw badRequest('机器人 token 格式不对：应该是 @BotFather 给的「数字:一串字母」那一整段', 'bad_token');
      a.telegram.botToken = v;
    }
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
      if (w.enabled !== undefined) {
        const on = boolField(w.enabled, 'notify.whatsapp.enabled');
        if (on && !a.notify.whatsapp.enabled && !isWhatsapp(a.channel)) {
          throw badRequest(`${CHANNEL_NAMES[a.channel] || '这个号'}发不了 WhatsApp 通知，请用邮件通知`, 'whatsapp_notify_unsupported');
        }
        a.notify.whatsapp.enabled = on;
      }
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
  const l = acc.line;
  const t = acc.telegram;
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
            useGlobal: px.useGlobal,
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
    line: l ? { channelId: l.channelId, channelSecret: l.channelSecret, accessToken: l.accessToken } : null,
    telegram: t ? { botToken: t.botToken } : null,
    notify: {
      email: { enabled: acc.notify.email.enabled, to: [...acc.notify.email.to] },
      whatsapp: { enabled: acc.notify.whatsapp.enabled, number: acc.notify.whatsapp.number },
    },
  };
}

/**
 * 校验导入文件。全部合法才返回要新建的号；有一个不合法就抛 400（说明第几个号、哪个字段），一个都不建。
 * 每个号的校验和新建、更新共用（applyAccountPatch），缺的字段按新建号的默认值。
 * 回复方式：有 replyMode 用 replyMode（v0.3.0 导出的 suggest 按 off）；升级前导出的文件只有 autoReply，按 true → auto、false → off 换算；
 * 两个都没有按默认（off）。
 * 例外是邮件通知和「用全局代理」：号里开了邮件通知、但这里还没配发信方式时不报错，
 * 而是把它关掉（收件人 to 保留）；号用全局代理、但这里没开全局代理时，把这个号的代理关掉（选项保留）。
 * 都在返回项的 notices 里说明，别让一个号拖垮整批导入。
 * @param {any} doc 解析后的 JSON
 * @param {{emailReady:boolean, globalProxyReady?:boolean}} o
 * @returns {{name:string, channel:string, config:any, notices?:string[]}[]}
 */
export function parseAccountsExport(doc, { emailReady, globalProxyReady = false }) {
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
      if (!CHANNELS.includes(item.channel)) throw badRequest(`channel 只能是 ${CHANNELS.join('、')}`);
      // applyAccountPatch 在这几种情况下的提示不带字段名，先拦下来
      if (item.channel !== 'waha' && item.waha != null) throw badRequest('waha 只有扫码号才有，其他接入方式应为 null');
      if (item.channel !== 'meta' && item.meta != null) throw badRequest('meta 只有 Meta 号才有，其他接入方式应为 null');
      if (item.channel !== 'line' && item.line != null) throw badRequest('line 只有 LINE 官方帐号才有，其他接入方式应为 null');
      if (!isTelegram(item.channel) && item.telegram != null) throw badRequest('telegram 只有 Telegram 号才有，其他接入方式应为 null');
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
      const px = isPlainObject(item.waha) && isPlainObject(item.waha.proxy) ? item.waha.proxy : null;
      if (!globalProxyReady && px && px.enabled === true && px.useGlobal === true) {
        patch = { ...patch, waha: { ...patch.waha, proxy: { ...px, enabled: false } } };
        notices.push('全局代理没开，已关掉这个号的代理（「用全局代理」的选项保留）');
      }
      const { name: n, channel, ...config } = applyAccountPatch(draft, patch, { isAdmin: true, emailReady, globalProxyReady });
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
    /** @param {{name:string, channel:string, sessionName?:string, config?:any}} p */
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
     * Meta 号的 phoneNumberId、LINE 官方帐号的 Channel ID、Telegram 号的机器人（token 前面的数字 id）和已有的号、
     * 或文件里前面的号重复时跳过（空的不算重复）。
     * @param {{name:string, channel:string, config:any, notices?:string[]}[]} items 已经过 parseAccountsExport 校验；
     *   notices 是导入时自动调整过什么的说明，原样带到返回的 created 项里
     */
    importMany(items) {
      return db.transaction(() => {
        // 去重的键：meta:<phoneNumberId>、line:<channelId>、tg:<机器人 id>（两种 Telegram 号共用：同一个机器人只能给一个号用）
        const keyOf = (channel, cfg) => {
          if (channel === 'meta' && cfg.meta?.phoneNumberId) return `meta:${cfg.meta.phoneNumberId}`;
          if (channel === 'line' && cfg.line?.channelId) return `line:${cfg.line.channelId}`;
          const botId = isTelegram(channel) ? botIdOf(cfg.telegram?.botToken) : '';
          return botId ? `tg:${botId}` : '';
        };
        /** @type {Map<string, {name:string, inFile:boolean}>} */
        const seen = new Map();
        for (const a of store.list()) {
          const k = keyOf(a.channel, a);
          if (k) seen.set(k, { name: a.name, inFile: false });
        }
        const created = [];
        const skipped = [];
        for (const it of items) {
          const key = keyOf(it.channel, it.config);
          const dup = key && seen.get(key);
          if (dup) {
            const [what, unit] =
              it.channel === 'line'
                ? [`Channel ID ${it.config.line.channelId}`, '个 LINE 官方帐号']
                : it.channel === 'meta'
                  ? [`phoneNumberId ${it.config.meta.phoneNumberId}`, '个 Meta 号码']
                  : ['机器人 token', '个 Telegram 机器人'];
            skipped.push({
              name: it.name,
              reason: dup.inFile
                ? `${what} 和文件里前面的号「${dup.name}」重复，只导入了前面那个`
                : `${what} 已经被号「${dup.name}」使用，同一${unit}不重复导入`,
            });
            continue;
          }
          const acc = store.create(it);
          if (key) seen.set(key, { name: acc.name, inFile: true });
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
