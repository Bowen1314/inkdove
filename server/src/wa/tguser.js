// Telegram 扫码登录（tguser）：墨鸽用 MTProto 直接登录用户自己的 Telegram 帐号（和 Telegram 桌面版一样是一个「设备」），
// 代收代发这个帐号的私聊。用的是 mtcute（MIT，https://mtcute.dev），api_id / api_hash 是用户自己在 my.telegram.org 申请的。
//
// - 登录只用扫码（auth.exportLoginToken，二维码里是 tg://login?token=…，30 秒左右换一次）：手机 Telegram 里
//   「设置 → 设备 → 连接桌面设备」扫。开了两步验证的，扫完再输一次密码（只拿来登录，不存）。
//   二维码地址就是登录凭证：只经管理员的二维码接口给出去，不进状态、日志、kv。
// - 登录态（auth key、见过的用户的 access hash、收消息的 pts）存在 <数据目录>/telegram/<号 id>.session（SQLite），
//   和扫码号的 WhatsApp 登录态一样不单独加密；退出登录、删号时先断开再删文件。
// - 收消息：只收和真人的私聊（不收群、频道、机器人、Saved Messages、Telegram 官方通知 777000、已注销的帐号、服务消息）。
//   第一次登录不拉以前的消息；重启后补上停机期间的（catchUp，Telegram 留得有限，太久的就跳过了）。
//   墨鸽自己发出去的不会再推回来（mtcute 默认不把自己调用产生的更新再分发一遍），手机等其他设备发的推回来，按 fromMe 存。
// - 用户帐号的消息 id 在所有私聊里是同一个序列，删除通知（updateDeleteMessages）只给 id、不给聊天，按号 + 消息 id 找。
// - 运行中被手机上「结束会话」踢掉时，mtcute 不报错只是停了收消息：每 5 分钟查一次自己（getMe），查到登录失效就报出来。
// - 全局代理开着时（proxy/route.js），连 Telegram 的 TCP 经 mihomo 的混合端口（127.0.0.1，本机免密，SOCKS5），不退回直连。
// - mtcute 的日志里会展开消息内容和用户 id，这里只记警告以上、只留开头的类别和错误码，不带内容。
//
// 适配层（createMtcuteClient）把 mtcute 的对象换成和 Bot API 一样形状的普通对象（toPlainMessage），服务层只认这个形状，
// 测试里换成假的客户端（createApp 的 tgUserClientFactory）。
import { readLimited, TooLargeError } from './waha.js';
import { viaProxy } from '../proxy/route.js';

/** Telegram 官方通知（登录码、安全提醒）的帐号 */
export const TG_SERVICE_USER_ID = '777000';
/** 二维码一直没人扫，多久以后停下（要登录时再点一次） */
export const TGU_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 多久查一次登录是不是还有效 */
export const TGU_HEALTH_MS = 5 * 60 * 1000;
/** 私聊删除没有时限：撤回的 revocableUntil 给一个很远的时间 */
export const TGU_NO_LIMIT_MS = 100 * 365 * 24 * 3600 * 1000;

/** 登录失效（被手机上结束会话、帐号注销、被封） */
const AUTH_LOST = new Set(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'AUTH_KEY_DUPLICATED']);

/** code：Telegram 的错误名（FLOOD_WAIT_X 这类），连不上时为空 */
export class TgUserError extends Error {
  constructor(message, { code = '', authLost = false } = {}) {
    super(message);
    this.code = code;
    this.authLost = authLost;
  }
}

/** mtcute 的 RpcError：{code: 数字, text: 'FLOOD_WAIT_5' 这样的名字} */
const rpcText = (err) => (err && typeof err.text === 'string' && Number.isInteger(err.code) ? err.text : '');
export const isAuthLost = (err) => err instanceof TgUserError ? err.authLost : AUTH_LOST.has(rpcText(err));

/** Telegram 的错误 → 中文原因（常见的几种），其余带上错误名 */
export function explainTgUser(err) {
  if (err instanceof TgUserError) return err;
  const t = rpcText(err);
  if (!t) return new TgUserError(`无法连接 Telegram：${String(err?.message || err).slice(0, 200)}`);
  const wait = /^(?:FLOOD|SLOWMODE)_WAIT_(\d+)$/.exec(t);
  let msg;
  if (AUTH_LOST.has(t)) msg = 'Telegram 登录状态已失效（设备已在手机上移除，或帐号已注销、封禁），请重新扫码登录';
  else if (t === 'API_ID_INVALID' || t === 'API_ID_PUBLISHED_FLOOD') msg = 'api_id 或 api_hash 错误，请在 my.telegram.org 的 API development tools 中核对';
  else if (wait) msg = `操作过于频繁，请 ${wait[1]} 秒后重试`;
  else if (t === 'PEER_ID_INVALID' || t === 'USER_ID_INVALID') msg = '客户不存在（尚未收到该客户的消息）';
  else if (t === 'INPUT_USER_DEACTIVATED') msg = '客户的 Telegram 帐号已注销';
  else if (t === 'YOU_BLOCKED_USER') msg = '已将该客户拉黑，无法发送';
  else if (t === 'USER_IS_BLOCKED') msg = '已被客户拉黑，无法发送';
  else if (t === 'PRIVACY_PREMIUM_REQUIRED' || t === 'PRIVACY_RESTRICTED') msg = '客户的隐私设置禁止接收消息';
  else if (t === 'MESSAGE_TOO_LONG') msg = '消息过长，请分条发送';
  else if (t === 'MEDIA_CAPTION_TOO_LONG') msg = '文件说明文字过长';
  else if (t === 'MESSAGE_DELETE_FORBIDDEN' || t === 'MESSAGE_ID_INVALID') msg = '无法删除该消息（已删除或 Telegram 不允许删除）';
  else if (t === 'PASSWORD_HASH_INVALID') msg = '两步验证密码错误';
  else if (t === 'AUTH_TOKEN_EXPIRED' || t === 'AUTH_TOKEN_INVALID') msg = '二维码已过期，请重新扫码';
  else msg = `Telegram 返回 ${t}`;
  return new TgUserError(msg, { code: t, authLost: AUTH_LOST.has(t) });
}

/**
 * mtcute 的日志一行 → 只留类别和错误码的一行（不带消息内容、用户 id）：
 * fmt 里 %j %e 这些已经展开了（可能是整条消息），只取第一个冒号、百分号之前的那段，再从里面找 Telegram 的错误名
 */
export function sanitizeMtLog(tag, fmt) {
  const s = String(fmt || '').replace(/^(?:\[[^\]]*\]\s*)+/, '');
  const head = s.split(/[:%\n{[("'=]/)[0].replace(/\d{5,}/g, '#').trim().slice(0, 120);
  const code = /\b\d{3} ([A-Z][A-Z0-9_]{2,})\b/.exec(s)?.[1] || /\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/.exec(s)?.[1] || '';
  return `${String(tag || '').slice(0, 40)}：${head || '（无说明）'}${code ? `（${code}）` : ''}`;
}

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');
/** Photo、Document 的 fileId 拿不到时（极少见）会抛错 */
function fileIdOf(m) {
  try {
    return m.fileId || null;
  } catch {
    return null;
  }
}

/**
 * mtcute 的 Message → 和 Bot API 一样形状的普通对象（service.js 的 parseTelegramMessage 认这个形状），外加：
 * out（自己发的）、service（服务消息）、scheduled（定时消息）、chat.type（私聊是 private，其余 other）、
 * chat.is_bot / is_self / is_deleted。只读 Message 上公开的 getter，不碰 raw
 * @param {any} msg
 */
export function toPlainMessage(msg) {
  const chat = msg.chat || {};
  const isUser = chat.type === 'user';
  const out = {
    message_id: msg.id,
    date: msg.date instanceof Date ? Math.floor(msg.date.getTime() / 1000) : null,
    out: !!msg.isOutgoing,
    service: !!msg.isService,
    scheduled: !!msg.isScheduled,
    chat: {
      type: isUser ? 'private' : 'other',
      id: chat.id != null ? String(chat.id) : null,
      first_name: isUser ? str(chat.firstName) : '',
      last_name: isUser ? str(chat.lastName) : '',
      username: isUser ? str(chat.username) : '',
      is_bot: !!chat.isBot,
      is_self: !!chat.isSelf,
      is_deleted: !!chat.isDeleted,
    },
    text: msg.isService ? '' : str(msg.text),
    reply_to_message: msg.replyToMessage?.id != null ? { message_id: msg.replyToMessage.id } : undefined,
  };
  const m = msg.isService ? null : msg.media;
  const file = (extra = {}) => ({ file_id: fileIdOf(m), file_size: num(m.fileSize), mime_type: str(m.mimeType) || undefined, ...extra });
  switch (m?.type) {
    case 'photo':
      out.photo = [{ file_id: fileIdOf(m), file_size: num(m.fileSize) }];
      break;
    case 'voice':
      out.voice = file({ duration: num(m.duration) });
      break;
    case 'video':
      if (m.isRound) out.video_note = file({ duration: num(m.duration) });
      else if (m.isAnimation || m.isLegacyGif) out.animation = file();
      else out.video = file({ duration: num(m.duration) });
      break;
    case 'audio':
      out.audio = file({ duration: num(m.duration), file_name: str(m.fileName) || undefined });
      break;
    case 'document':
      out.document = file({ file_name: str(m.fileName) || undefined });
      break;
    case 'sticker':
      out.sticker = {};
      break;
    case 'venue':
      out.venue = { title: str(m.title), address: str(m.address), location: { latitude: m.location?.latitude, longitude: m.location?.longitude } };
      break;
    case 'location':
    case 'live_location':
      out.location = { latitude: m.latitude, longitude: m.longitude };
      break;
    case 'contact':
      out.contact = { first_name: str(m.firstName), last_name: str(m.lastName), phone_number: str(m.phoneNumber) };
      break;
    case 'poll':
      out.poll = { question: str(m.question) };
      break;
    default:
      // 网页预览（web_page）是带链接的文字消息；骰子、游戏、账单、故事这些只有标签
      break;
  }
  return out;
}

/**
 * 这条消息墨鸽收不收：返回不收的原因，收的返回 null
 * @param {ReturnType<typeof toPlainMessage>} p
 */
export function tgUserSkip(p) {
  if (!p || p.chat?.type !== 'private' || p.chat.id == null) return 'ignored_non_private';
  if (p.service) return 'ignored_service';
  if (p.scheduled) return 'ignored_scheduled';
  if (p.chat.is_self) return 'ignored_self';
  if (p.chat.is_bot) return 'ignored_bot';
  if (p.chat.is_deleted) return 'ignored_deleted';
  if (String(p.chat.id) === TG_SERVICE_USER_ID) return 'ignored_service';
  return null;
}

/** mtcute 的用户 → {id, name, username} */
const meOf = (u) => ({
  id: String(u.id),
  name: [u.firstName, u.lastName].map((s) => str(s).trim()).filter(Boolean).join(' ') || (u.username ? `@${u.username}` : ''),
  username: str(u.username),
});

/**
 * 真正的客户端（mtcute）。只有用到扫码登录的号时才加载 mtcute（import 放在里面），测试和别的接入方式不加载。
 * @param {{
 *   apiId: number, apiHash: string, storagePath: string, catchUp: boolean, proxyPort: number,
 *   log: {warn: Function, error: Function}, logTag: string,
 *   onMessage: (p: any) => void, onEdit: (p: any) => void, onDelete: (ids: number[]) => void, onAuthLost: (err: TgUserError) => void,
 * }} o
 */
export async function createMtcuteClient(o) {
  const { TelegramClient, NodePlatform, TcpTransport, SocksProxyTcpTransport, InputMedia } = await import('@mtcute/node');
  const { LogManager } = await import('@mtcute/node/utils.js');

  // mtcute 的 SQLite 存储默认会挂 SIGINT / SIGTERM / beforeExit 钩子自己收尾，和墨鸽的退出流程打架：换成不挂钩子的，
  // 关闭时由 close() 断开（会把存储写完）
  class QuietPlatform extends NodePlatform {
    beforeExit() {
      return () => {};
    }
  }
  const platform = new QuietPlatform();
  const logger = new LogManager('client', platform);
  logger.level = LogManager.WARN;
  logger.handler = (_color, level, tag, fmt) => {
    const line = `[tguser] ${o.logTag} mtcute ${sanitizeMtLog(tag, fmt)}`;
    if (level <= LogManager.ERROR) o.log.error(line);
    else o.log.warn(line);
  };

  const direct = new TcpTransport();
  // 每次连接时看全局代理：开着就经 mihomo（本机免密），关着直连。连着的连接不动，下次重连时生效（改了全局代理由服务层重启客户端）
  const transport = {
    connect(dc, signal) {
      if (!viaProxy(dc.ipAddress)) return direct.connect(dc, signal);
      return new SocksProxyTcpTransport({ host: '127.0.0.1', port: o.proxyPort, version: 5 }).connect(dc, signal);
    },
    packetCodec: () => direct.packetCodec(),
  };

  const client = new TelegramClient({
    apiId: o.apiId,
    apiHash: o.apiHash,
    storage: o.storagePath,
    storageOptions: { cleanup: false },
    platform,
    logger,
    transport,
    updates: { catchUp: o.catchUp },
    // 帐号的「设置 → 设备」里显示成 Inkdove，好认、好结束
    initConnectionOptions: { deviceModel: 'Inkdove', systemVersion: process.platform, appVersion: 'Inkdove' },
  });

  let lost = false;
  /** 调一个方法，Telegram 的错误换成中文；登录失效的报给服务层（只报一次） */
  async function call(fn) {
    try {
      return await fn();
    } catch (err) {
      const e = explainTgUser(err);
      if (e.authLost && !lost) {
        lost = true;
        o.onAuthLost(e);
      }
      throw e;
    }
  }
  const fail = (err) => o.log.error(`[tguser] ${o.logTag} 处理收到的消息出错：${err?.stack || err}`);
  /** 服务层的处理函数可能是异步的：出错只记日志 */
  const safe = (fn) => (arg) => {
    try {
      const r = fn(arg);
      if (r && typeof r.catch === 'function') r.catch(fail);
    } catch (err) {
      fail(err);
    }
  };
  client.onNewMessage.add(safe((msg) => o.onMessage(toPlainMessage(msg))));
  client.onEditMessage.add(safe((msg) => o.onEdit(toPlainMessage(msg))));
  client.onDeleteMessage.add(safe((u) => (u.channelId ? undefined : o.onDelete([...u.messageIds]))));
  client.onError.add((err) => {
    const e = explainTgUser(err);
    if (e.authLost && !lost) {
      lost = true;
      o.onAuthLost(e);
      return;
    }
    o.log.warn(`[tguser] ${o.logTag} 收消息出错：${e.code || 'network'}`);
  });

  let health = null;
  function startHealth() {
    clearInterval(health);
    health = setInterval(() => {
      call(() => client.getMe()).catch(() => {});
    }, TGU_HEALTH_MS);
    health.unref?.();
  }

  const peer = (chatId) => Number(chatId);

  return {
    /** 用存着的登录态登录：返回自己；没登录过或登录态失效了返回 null（失效的顺便从 Telegram 退出、清掉） */
    async restore() {
      try {
        const me = await client.getMe();
        await client.notifyLoggedIn(me.raw);
        startHealth();
        return meOf(me);
      } catch (err) {
        const t = rpcText(err);
        if (t === 'AUTH_KEY_UNREGISTERED') return null;
        if (AUTH_LOST.has(t)) {
          await client.logOut().catch(() => {});
          return null;
        }
        // 扫完码、还没输两步验证密码时重启了：接着要密码
        if (t === 'SESSION_PASSWORD_NEEDED') return { needPassword: true };
        throw explainTgUser(err);
      }
    },
    /**
     * 扫码登录，登录成功返回自己。password 是要密码时调的函数（返回 Promise，用户在页面上输了才 resolve）；
     * 密码不对时调 onPasswordInvalid，再调一次 password
     */
    async loginQr({ onQr, onScanned, password, onPasswordInvalid, signal }) {
      try {
        const me = await client.signInQr({
          onUrlUpdated: (url, expires) => onQr(url, expires.getTime()),
          onQrScanned: onScanned,
          password,
          invalidPasswordCallback: onPasswordInvalid,
          abortSignal: signal,
        });
        lost = false;
        startHealth();
        return meOf(me);
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        throw explainTgUser(err);
      }
    },
    /** 扫完码、重启后接着输两步验证密码 */
    async checkPassword({ password, onPasswordInvalid, signal }) {
      for (;;) {
        const pw = await password();
        try {
          const me = await client.checkPassword({ password: pw, abortSignal: signal });
          startHealth();
          return meOf(me);
        } catch (err) {
          if (rpcText(err) === 'PASSWORD_HASH_INVALID') {
            await onPasswordInvalid();
            continue;
          }
          throw explainTgUser(err);
        }
      }
    },
    async sendText(chatId, text) {
      const msg = await call(() => client.sendText(peer(chatId), text));
      return String(msg.id);
    },
    /** @param {{buffer: Buffer, filename: string, mime: string}} file */
    async sendFile(chatId, file, { asPhoto = false, caption = '' } = {}) {
      const media = asPhoto
        ? InputMedia.photo(file.buffer, { fileName: file.filename, fileSize: file.buffer.length })
        : InputMedia.document(file.buffer, { fileName: file.filename, fileMime: file.mime || 'application/octet-stream', fileSize: file.buffer.length });
      const msg = await call(() => client.sendMedia(peer(chatId), media, caption ? { caption } : {}));
      return String(msg.id);
    },
    deleteMessages: (chatId, ids) => call(() => client.deleteMessagesById(peer(chatId), ids.map(Number), { revoke: true })),
    readHistory: (chatId, maxId) => call(() => client.readHistory(peer(chatId), { maxId: Number(maxId) })),
    sendTyping: (chatId) => call(() => client.sendTyping(peer(chatId), 'typing')),
    /**
     * 打开一个文件（Bot API 格式的 file_id）。已知大小超过 maxBytes 时不下，抛 TooLargeError
     * @returns {import('node:stream').Readable}
     */
    openFile(fileId, { fileSize = null, maxBytes, signal } = {}) {
      if (Number.isFinite(fileSize) && maxBytes && fileSize > maxBytes) throw new TooLargeError(fileSize, maxBytes);
      return client.downloadAsNodeStream(fileId, { fileSize: fileSize ?? undefined, abortSignal: signal });
    },
    async download(fileId, { fileSize = null, maxBytes } = {}) {
      const stream = this.openFile(fileId, { fileSize, maxBytes });
      try {
        return await readLimited(stream, maxBytes);
      } catch (err) {
        stream.destroy();
        if (err instanceof TooLargeError) throw new TgUserError(err.message);
        throw explainTgUser(err);
      }
    },
    /** 从 Telegram 退出（这个设备从帐号的设备列表里消失） */
    async logOut() {
      clearInterval(health);
      try {
        await client.logOut();
      } catch (err) {
        throw explainTgUser(err);
      }
    },
    async close() {
      clearInterval(health);
      await client.destroy();
    },
  };
}
