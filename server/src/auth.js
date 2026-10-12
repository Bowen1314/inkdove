// F8 多人账号：用户、密码、服务端会话、邀请和重置链接、权限判断。
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest, HttpError, newId, nowIso, safeEqual, safeJsonParse } from './util.js';

export const COOKIE_NAME = 'inkdove_session';
export const ROLES = ['admin', 'agent'];
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const FAIL_WINDOW_MS = 60 * 1000;
const FAIL_LIMIT = 5;
export const MIN_NEW_PASSWORD = 10;

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** 加盐哈希：scrypt$N$r$p$salt$hash（hex） */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 常数时间校验；stored 为空时也算一次哈希，避免按耗时区分"邮箱不存在" */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await scryptAsync(String(password), 'dummy-salt-value', SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const [, N, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const got = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** @param {string|undefined} header */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const sign = (secret, token) => crypto.createHmac('sha256', secret).update(token).digest('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function rowToUser(r) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    accountIds: safeJsonParse(r.account_ids, []),
    disabled: !!r.disabled,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at ?? null,
    pending: !r.password_hash,
  };
}

export const forbidden = () => new HttpError(403, 'forbidden', '没有权限');

/** 这个用户能不能操作这个号：admin 能看所有号，agent 只能看分配给自己的 */
export function canAccessAccount(user, accountId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.accountIds) && user.accountIds.includes(accountId);
}

/**
 * @param {{db: import('better-sqlite3').Database, config: import('./config.js').Config, log: any}} ctx
 */
export function createAuth(ctx) {
  const { db, config } = ctx;
  /** @type {Map<string, number[]>} key -> 失败时间戳（ip:… 和 email:… 两类） */
  const failures = new Map();

  const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });

  function recentFailures(key) {
    const now = Date.now();
    const list = (failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  }
  function addFailure(key) {
    const list = recentFailures(key);
    list.push(Date.now());
    failures.set(key, list);
  }

  const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const getUserByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));

  /** 首次启动、库里没有用户时，用 INKDOVE_ADMIN_EMAIL / INKDOVE_ADMIN_PASSWORD 建第一个 admin */
  function bootstrapAdmin() {
    const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    if (n > 0) return null;
    const id = newId();
    db.prepare(
      `INSERT INTO users(id, email, name, role, account_ids, disabled, password_hash, created_at)
       VALUES(?, ?, ?, 'admin', '[]', 0, ?, ?)`,
    ).run(id, config.adminEmail, '管理员', hashPasswordSync(config.adminPassword), nowIso());
    ctx.log.info(`[auth] 已创建第一个管理员 ${config.adminEmail}`);
    return id;
  }

  function tokenFromReq(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const token = raw.slice(0, dot);
    if (!safeEqual(raw.slice(dot + 1), sign(config.sessionSecret, token))) return null;
    return token;
  }

  /** 当前请求的用户（未登录、会话过期、账号停用或被删都返回 null） */
  function userFromReq(req) {
    const token = tokenFromReq(req);
    if (!token) return null;
    const s = db.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?').get(token);
    if (!s || !s.user_id) return null;
    if (Date.parse(s.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
      return null;
    }
    const row = getUserRow(s.user_id);
    if (!row || row.disabled || !row.password_hash) return null;
    return { user: rowToUser(row), token };
  }

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare('INSERT INTO auth_sessions(token, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run(
      token,
      userId,
      new Date(now).toISOString(),
      new Date(now + MAX_AGE_MS).toISOString(),
    );
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(new Date(now).toISOString());
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
    res.cookie(COOKIE_NAME, `${token}.${sign(config.sessionSecret, token)}`, { ...cookieOptions(), maxAge: MAX_AGE_MS });
    return token;
  }

  /** 删除某人的会话（停用、删除、改密码、重置密码时用）；exceptToken 保留当前这次登录 */
  function dropSessions(userId, exceptToken = null) {
    if (exceptToken) db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token <> ?').run(userId, exceptToken);
    else db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  }

  /** 生成一次性的邀请或重置链接；同一个人之前没用掉的链接作废 */
  function createLink(userId, kind) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO invites(token_hash, user_id, kind, created_at, expires_at) VALUES(?, ?, ?, ?, ?)').run(
      sha256(token),
      userId,
      kind,
      new Date(now).toISOString(),
      new Date(now + INVITE_TTL_MS).toISOString(),
    );
    return `${config.publicBaseUrl}/invite/${token}`;
  }

  function findInvite(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const inv = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
    if (!inv || inv.used_at || Date.parse(inv.expires_at) <= Date.now()) return null;
    const user = getUserRow(inv.user_id);
    if (!user) return null;
    return { inv, user };
  }

  /** 启用中的 admin（已设置密码、未停用）数量 */
  const activeAdmins = () =>
    db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL").get().n;
  /** 不允许删除、停用或降级最后一个启用中的 admin */
  function assertNotLastAdmin(row) {
    const isActiveAdmin = row.role === 'admin' && !row.disabled && !!row.password_hash;
    if (isActiveAdmin && activeAdmins() <= 1) throw new HttpError(400, 'last_admin', '不能删除、停用或降级最后一个管理员');
  }

  const checkNewPassword = (pw) => {
    if (typeof pw !== 'string' || pw.length < MIN_NEW_PASSWORD) {
      throw badRequest(`新密码至少 ${MIN_NEW_PASSWORD} 个字符`, 'weak_password');
    }
    if (pw.length > 200) throw badRequest('密码太长', 'weak_password');
  };

  return {
    bootstrapAdmin,
    userFromReq,
    dropSessions,
    createLink,
    assertNotLastAdmin,
    getUserRow,
    getUserByEmail,

    /** POST /api/auth/login {email, password} */
    async login(req, res) {
      const ip = `ip:${req.ip || 'unknown'}`;
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      const emailKey = `email:${email}`;
      if (recentFailures(ip).length >= FAIL_LIMIT || (email && recentFailures(emailKey).length >= FAIL_LIMIT)) {
        throw new HttpError(429, 'rate_limited', '尝试次数过多，请一分钟后再试');
      }
      const row = email ? getUserByEmail(email) : null;
      const ok = typeof password === 'string' && password.length <= 200 && (await verifyPassword(password, row?.password_hash));
      if (!ok) {
        addFailure(ip);
        if (email) addFailure(emailKey);
        throw new HttpError(401, 'bad_credentials', '邮箱或密码错误');
      }
      if (row.disabled) throw new HttpError(403, 'account_disabled', '这个账号已被停用，请联系管理员');
      failures.delete(ip);
      failures.delete(emailKey);
      startSession(res, row.id);
      res.json({ user: rowToUser(getUserRow(row.id)) });
    },

    /** POST /api/auth/logout */
    logout(req, res) {
      const token = tokenFromReq(req);
      if (token) db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
      res.clearCookie(COOKIE_NAME, cookieOptions());
      res.json({ ok: true });
    },

    /** 中间件：要求登录，把 req.user 填好 */
    requireAuth(req, _res, next) {
      const s = userFromReq(req);
      if (!s) throw new HttpError(401, 'unauthorized', '未登录');
      req.user = s.user;
      req.sessionToken = s.token;
      next();
    },

    /** 中间件：仅 admin */
    requireAdmin(req, _res, next) {
      if (req.user?.role !== 'admin') throw forbidden();
      next();
    },

    /** POST /api/auth/password {currentPassword, newPassword}：改完后这个人的其他会话全部失效 */
    async changePassword(req, res) {
      const { currentPassword, newPassword } = req.body || {};
      const row = getUserRow(req.user.id);
      if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, row.password_hash))) {
        throw new HttpError(400, 'wrong_password', '当前密码不对');
      }
      checkNewPassword(newPassword);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), row.id);
      dropSessions(row.id, req.sessionToken);
      res.json({ ok: true });
    },

    /** GET /api/invites/:token */
    getInvite(req, res) {
      const found = findInvite(req.params.token);
      if (!found || found.user.disabled) throw new HttpError(404, 'not_found', '链接已失效，请联系管理员重新发送');
      res.json({ email: found.user.email, name: found.user.name, role: found.user.role, kind: found.inv.kind });
    },

    /** POST /api/invites/:token/accept {name?, password}：设置密码并直接登录 */
    async acceptInvite(req, res) {
      const found = findInvite(req.params.token);
      if (!found || found.user.disabled) throw new HttpError(404, 'not_found', '链接已失效，请联系管理员重新发送');
      const { name, password } = req.body || {};
      checkNewPassword(password);
      if (name !== undefined && (typeof name !== 'string' || name.length > 100)) throw badRequest('name 必须是 100 字以内的字符串');
      const hash = await hashPassword(password);
      // 一次性：用 used_at IS NULL 做条件，并发提交时只有一个能成功
      const used = db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(nowIso(), found.inv.token_hash);
      if (used.changes === 0) throw new HttpError(404, 'not_found', '链接已失效，请联系管理员重新发送');
      const newName = typeof name === 'string' && name.trim() ? name.trim() : found.user.name;
      db.prepare('UPDATE users SET password_hash = ?, name = ? WHERE id = ?').run(hash, newName, found.user.id);
      db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(found.user.id);
      dropSessions(found.user.id);
      startSession(res, found.user.id);
      res.json({ user: rowToUser(getUserRow(found.user.id)) });
    },

    validateEmail(email) {
      const e = normalizeEmail(email);
      if (!EMAIL_RE.test(e) || e.length > 200) throw badRequest('邮箱格式不对');
      return e;
    },
  };
}
