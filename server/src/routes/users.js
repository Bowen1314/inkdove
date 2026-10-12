// F8 成员管理（仅 admin）。邀请和重置链接由管理员自己复制发给对方，系统不发邮件。
import express from 'express';
import { normalizeEmail, ROLES, rowToUser } from '../auth.js';
import { badRequest, HttpError, isPlainObject, newId, notFound, nowIso } from '../util.js';

/**
 * @param {any} ctx
 * @param {ReturnType<typeof import('../auth.js').createAuth>} auth
 */
export function usersRouter(ctx, auth) {
  const { db, accounts } = ctx;
  const router = express.Router();
  router.use(auth.requireAdmin);

  function checkAccountIds(v) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest('accountIds 必须是字符串数组');
    const ids = [...new Set(v)];
    const unknown = ids.filter((id) => !accounts.get(id));
    if (unknown.length) throw badRequest(`号不存在：${unknown.join('、')}`, 'unknown_account');
    return ids;
  }
  const checkName = (v) => {
    if (typeof v !== 'string' || v.length > 100) throw badRequest('name 必须是 100 字以内的字符串');
    return v.trim();
  };
  const checkRole = (v) => {
    if (!ROLES.includes(v)) throw badRequest('role 只能是 admin 或 agent');
    return v;
  };
  function load(id) {
    const row = auth.getUserRow(id);
    if (!row) throw notFound('成员不存在');
    return row;
  }

  router.get('/', (_req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY created_at, rowid').all().map(rowToUser));
  });

  router.post('/', (req, res) => {
    const b = req.body;
    if (!isPlainObject(b)) throw badRequest('请求体必须是对象');
    const email = auth.validateEmail(b.email);
    if (auth.getUserByEmail(email)) throw new HttpError(409, 'email_taken', '这个邮箱已经是成员了');
    const name = b.name === undefined ? '' : checkName(b.name);
    const role = checkRole(b.role ?? 'agent');
    const accountIds = b.accountIds === undefined ? [] : checkAccountIds(b.accountIds);
    const id = newId();
    db.prepare(
      `INSERT INTO users(id, email, name, role, account_ids, disabled, password_hash, created_at)
       VALUES(?, ?, ?, ?, ?, 0, NULL, ?)`,
    ).run(id, normalizeEmail(email), name, role, JSON.stringify(accountIds), nowIso());
    const inviteUrl = auth.createLink(id, 'invite');
    ctx.log.info(`[users] ${req.user.email} 邀请了 ${email}（${role}）`);
    res.json({ user: rowToUser(auth.getUserRow(id)), inviteUrl });
  });

  router.put('/:id', (req, res) => {
    const row = load(req.params.id);
    const b = req.body;
    if (!isPlainObject(b)) throw badRequest('请求体必须是对象');
    const next = { name: row.name, role: row.role, accountIds: JSON.parse(row.account_ids || '[]'), disabled: !!row.disabled };
    if (b.name !== undefined) next.name = checkName(b.name);
    if (b.role !== undefined) next.role = checkRole(b.role);
    if (b.accountIds !== undefined) next.accountIds = checkAccountIds(b.accountIds);
    if (b.disabled !== undefined) {
      if (typeof b.disabled !== 'boolean') throw badRequest('disabled 必须是布尔值');
      next.disabled = b.disabled;
    }
    // 降级或停用最后一个启用中的 admin → 400 last_admin
    if ((row.role === 'admin' && next.role !== 'admin') || (!row.disabled && next.disabled)) auth.assertNotLastAdmin(row);
    db.prepare('UPDATE users SET name = ?, role = ?, account_ids = ?, disabled = ? WHERE id = ?').run(
      next.name,
      next.role,
      JSON.stringify(next.accountIds),
      next.disabled ? 1 : 0,
      row.id,
    );
    // 停用后这个人的所有会话立即失效
    if (next.disabled) auth.dropSessions(row.id);
    res.json(rowToUser(auth.getUserRow(row.id)));
  });

  router.delete('/:id', (req, res) => {
    const row = load(req.params.id);
    auth.assertNotLastAdmin(row);
    db.transaction(() => {
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(row.id);
      db.prepare('DELETE FROM invites WHERE user_id = ?').run(row.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    })();
    ctx.log.info(`[users] ${req.user.email} 删除了成员 ${row.email}`);
    res.json({ ok: true });
  });

  router.post('/:id/reset-link', (req, res) => {
    const row = load(req.params.id);
    if (row.disabled) throw badRequest('这个成员已停用，先启用再生成链接', 'user_disabled');
    // 还没激活的成员，重新生成的是邀请链接
    const resetUrl = auth.createLink(row.id, row.password_hash ? 'reset' : 'invite');
    res.json({ resetUrl });
  });

  return router;
}
