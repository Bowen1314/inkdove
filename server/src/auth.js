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

/** 个人话术最长多少字符 */
export const MAX_STYLE_PROMPT = 2000;

/**
 * 「我的资料」的字段：接口字段名 → users 的列和最长字符数。multiline 的可以换行，其余的把连续空白（含换行）合成一个空格。
 * 起草推荐回复和转人工草稿时作为【业务员信息】用（见 reply/prompts.js 的 agentProfileText）。
 */
export const PROFILE_FIELDS = {
  displayName: { column: 'display_name', max: 60, label: '对客户的称呼' },
  jobTitle: { column: 'job_title', max: 60, label: '职位' },
  contactPhone: { column: 'contact_phone', max: 40, label: '联系电话' },
  contactEmail: { column: 'contact_email', max: 120, label: '联系邮箱' },
  bio: { column: 'bio', max: 1000, label: '补充介绍', multiline: true },
};

/** users 行 → 「我的资料」{displayName, jobTitle, contactPhone, contactEmail, bio}，没填的是空串 */
export function profileOfRow(r) {
  return Object.fromEntries(Object.entries(PROFILE_FIELDS).map(([k, f]) => [k, r[f.column] ?? '']));
}

/** 自己看自己（GET /api/auth/me 等）：比 rowToUser 多个人话术 stylePrompt 和「我的资料」profile，成员列表、登录返回里不带 */
export function selfUser(r) {
  return { ...rowToUser(r), stylePrompt: r.style_prompt ?? '', profile: profileOfRow(r) };
}

export const forbidden = () => new HttpError(403, 'forbidden', '无权限');

/** 这个用户能不能操作这个号：admin 能看所有号，agent 只能看分配给自己的 */
export function canAccessAccount(user, accountId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.accountIds) && user.accountIds.includes(accountId);
}

/**
 * 会话级权限的唯一判断（会话详情、消息、发送、发文件、翻译、机器人开关、kb-draft、分配记录，以及客户线索都走它）：
 * admin 能看、能操作所有会话；agent 只能是分给自己的、而且有这个号的权限，未分配的看不到。
 * 列表（会话、线索）按 conversationScope 的同一套条件在 SQL 里过滤。
 * @param {{accountId:string|null, assignee?:{id:string}|null}|null} conv Conversation 对象
 */
export function canAccessConversation(user, conv) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!conv?.assignee && conv.assignee.id === user.id && canAccessAccount(user, conv.accountId);
}

/**
 * 列表的可见范围，和 canAccessConversation 一致：admin 两项都是 null（不限）；agent 是 {assigneeId: 自己, accountIds: 自己的号}。
 * @returns {{assigneeId: string|null, accountIds: string[]|null}}
 */
export function conversationScope(user) {
  if (user?.role === 'admin') return { assigneeId: null, accountIds: null };
  return { assigneeId: user?.id ?? '', accountIds: Array.isArray(user?.accountIds) ? user.accountIds : [] };
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
    if (pw.length > 200) throw badRequest('密码超出长度限制', 'weak_password');
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
        throw new HttpError(429, 'rate_limited', '尝试次数过多，请 1 分钟后重试');
      }
      const row = email ? getUserByEmail(email) : null;
      const ok = typeof password === 'string' && password.length <= 200 && (await verifyPassword(password, row?.password_hash));
      if (!ok) {
        addFailure(ip);
        if (email) addFailure(emailKey);
        throw new HttpError(401, 'bad_credentials', '邮箱或密码错误');
      }
      if (row.disabled) throw new HttpError(403, 'account_disabled', '该帐号已停用，请联系管理员');
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

    /** GET /api/auth/me：当前用户，带个人话术和「我的资料」（user.profile） */
    me(req, res) {
      res.json({ user: selfUser(getUserRow(req.user.id)) });
    },

    /**
     * PUT /api/auth/me/profile {displayName?, jobTitle?, contactPhone?, contactEmail?, bio?}：改自己的「我的资料」，所有角色都能改，
     * 只能改自己的。只改给了的字段（至少给一个）；都是字符串，去掉首尾空白后按 PROFILE_FIELDS 的长度校验，邮箱填了要像邮箱，
     * 空串是清空。返回更新后的 user（同 GET /api/auth/me）。
     */
    setProfile(req, res) {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('请求体必须是 JSON 对象');
      const keys = Object.keys(PROFILE_FIELDS).filter((k) => b[k] !== undefined);
      if (!keys.length) throw badRequest(`至少需提供一个字段：${Object.keys(PROFILE_FIELDS).join('、')}`);
      const sets = [];
      const values = [];
      for (const k of keys) {
        const f = PROFILE_FIELDS[k];
        if (typeof b[k] !== 'string') throw badRequest(`${k} 必须是字符串`);
        const v = f.multiline ? b[k].trim() : b[k].replace(/\s+/g, ' ').trim();
        if (v.length > f.max) throw badRequest(`${f.label}最多 ${f.max} 个字符`);
        if (k === 'contactEmail' && v && !EMAIL_RE.test(v)) throw badRequest('联系邮箱格式错误');
        sets.push(`${f.column} = ?`);
        values.push(v);
      }
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.user.id);
      res.json({ user: selfUser(getUserRow(req.user.id)) });
    },

    /** PUT /api/auth/me/style-prompt {stylePrompt}：改自己的个人话术（推荐回复用），返回更新后的 user */
    setStylePrompt(req, res) {
      const v = req.body?.stylePrompt;
      if (typeof v !== 'string') throw badRequest('stylePrompt 必须是字符串');
      if (v.length > MAX_STYLE_PROMPT) throw badRequest(`stylePrompt 最多 ${MAX_STYLE_PROMPT} 个字符`);
      db.prepare('UPDATE users SET style_prompt = ? WHERE id = ?').run(v, req.user.id);
      res.json({ user: selfUser(getUserRow(req.user.id)) });
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
        throw new HttpError(400, 'wrong_password', '当前密码错误');
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
      if (!EMAIL_RE.test(e) || e.length > 200) throw badRequest('邮箱格式错误');
      return e;
    },
  };
}
