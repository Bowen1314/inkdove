// F15：给 WAHA 拉大文件用的内部签名下载地址 http://<inkdove 主机名>:<端口>/internal/files/<id>?token=<过期秒>.<签名>
// 签名是 HMAC-SHA256(INKDOVE_SESSION_SECRET, "inkdove-file:<id>:<过期秒>")，只对这一个文件、在过期前有效（默认 10 分钟）。
import crypto from 'node:crypto';

export const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

const mac = (secret, fileId, exp) =>
  crypto.createHmac('sha256', String(secret)).update(`inkdove-file:${fileId}:${exp}`).digest('base64url');

/** 生成 token：`<过期时间（Unix 秒）>.<签名>` */
export function signFileToken(secret, fileId, { now = Date.now(), ttlMs = SIGNED_URL_TTL_MS } = {}) {
  const exp = Math.floor((now + ttlMs) / 1000);
  return `${exp}.${mac(secret, fileId, exp)}`;
}

/** 校验 token：格式、过期时间、签名都对才返回 true */
export function verifyFileToken(secret, fileId, token, { now = Date.now() } = {}) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp * 1000 < now) return false;
  const want = Buffer.from(mac(secret, fileId, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** WAHA 在 compose 内网里能访问到的签名地址；主机名用 INKDOVE_PROXY_RELAY_HOST（默认 inkdove），端口用 INKDOVE_PORT */
export function internalFileUrl(config, fileId, opts) {
  const token = signFileToken(config.sessionSecret, fileId, opts);
  return `http://${config.proxyRelayHost}:${config.port}/internal/files/${encodeURIComponent(fileId)}?token=${token}`;
}
