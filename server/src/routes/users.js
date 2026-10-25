// F8 成员管理（仅 admin）。邀请和重置链接由管理员自己复制发给对方，系统不发邮件。
// 按客户分配：每个成员带 assignedCount；删成员、agent 失去号的权限时他负责的会话变成未分配；转交把他的会话全部给另一个人。
// 停用、删成员时清掉用了他「我的资料」的草稿（转人工草稿和他点的推荐回复，不管在谁的会话上）。
import express from 'express';
import { normalizeEmail, ROLES, rowToUser } from '../auth.js';
import { badRequest, HttpError, isPlainObject, newId, notFound, nowIso } from '../util.js';
import { assignedCounts, clearMemberDrafts, releaseAll, releaseLostAccess, transferAll } from '../wa/assign.js';

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
    if (unknown.length) throw badRequest(`号码不存在：${unknown.join('、')}`, 'unknown_account');
    return ids;
  }
  const checkName = (v) => {
    if (typeof v !== 'string' || v.length > 100) throw badRequest('name 必须是 100 字以内的字符串');
    return v.trim();
  };
  const checkRole = (v) => {
    if (!ROLES.includes(v)) throw badRequest('role 须为 admin 或 agent');
    return v;
  };
  function load(id) {
    const row = auth.getUserRow(id);
    if (!row) throw notFound('成员不存在');
    return row;
  }
  /** 成员 + assignedCount（当前负责的会话数） */
  const view = (row, counts = assignedCounts(db)) => ({ ...rowToUser(row), assignedCount: counts.get(row.id) || 0 });

  router.get('/', (_req, res) => {
    const counts = assignedCounts(db);
    res.json(db.prepare('SELECT * FROM users ORDER BY created_at, rowid').all().map((r) => view(r, counts)));
  });

  router.post('/', (req, res) => {
    const b = req.body;
    if (!isPlainObject(b)) throw badRequest('请求体必须是对象');
    const email = auth.validateEmail(b.email);
    if (auth.getUserByEmail(email)) throw new HttpError(409, 'email_taken', '该邮箱已是成员');
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
    res.json({ user: view(auth.getUserRow(id)), inviteUrl });
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
    const disabling = !row.disabled && next.disabled;
    if ((row.role === 'admin' && next.role !== 'admin') || disabling) auth.assertNotLastAdmin(row);
    let cleared = 0;
    db.transaction(() => {
      db.prepare('UPDATE users SET name = ?, role = ?, account_ids = ?, disabled = ? WHERE id = ?').run(
        next.name,
        next.role,
        JSON.stringify(next.accountIds),
        next.disabled ? 1 : 0,
        row.id,
      );
      // agent 的 accountIds 去掉了某个号（或者 admin 降级成 agent）：他在没有权限的号上负责的会话变成未分配。
      // 停用不动负责关系，等管理员转交
      releaseLostAccess(db, row.id, req.user);
      // 停用：用了他资料的草稿作废（里面是他的名字和电话，他已经不在了）。重新启用不恢复
      if (disabling) cleared = clearMemberDrafts(db, row.id);
    })();
    if (disabling) ctx.log.info(`[users] ${req.user.email} 停用了成员 ${row.email}${cleared ? `，清掉 ${cleared} 份用了他资料的草稿` : ''}`);
    // 停用后这个人的所有会话立即失效
    if (next.disabled) auth.dropSessions(row.id);
    res.json(view(auth.getUserRow(row.id)));
  });

  router.delete('/:id', (req, res) => {
    const row = load(req.params.id);
    auth.assertNotLastAdmin(row);
    let released = 0;
    let cleared = 0;
    db.transaction(() => {
      // 用了他资料的草稿作废（他在别人会话上点的推荐也算）。先清再收回，清掉的份数才数得全（收回时也会清他负责的会话上的）
      cleared = clearMemberDrafts(db, row.id);
      // 他负责的会话变成未分配（要在删用户行之前）
      released = releaseAll(db, row.id, req.user);
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(row.id);
      db.prepare('DELETE FROM invites WHERE user_id = ?').run(row.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    })();
    ctx.log.info(
      `[users] ${req.user.email} 删除了成员 ${row.email}${released ? `，${released} 个会话变成未分配` : ''}${cleared ? `，清掉 ${cleared} 份用了他资料的草稿` : ''}`,
    );
    res.json({ ok: true });
  });

  // 转交客户：{toUserId} → 把这个成员负责的会话全部转给 toUserId，返回 {moved, skipped}。
  // skipped 是目标 agent 没有对应号权限、保持原样的会话数；目标不存在、已停用、就是他自己 → 400 assignee_invalid
  router.post('/:id/transfer', (req, res) => {
    const row = load(req.params.id);
    const r = transferAll(db, row.id, req.body?.toUserId, req.user);
    ctx.log.info(`[users] ${req.user.email} 把 ${row.email} 负责的 ${r.moved} 个会话转交出去，${r.skipped} 个没有号权限没转`);
    res.json(r);
  });

  router.post('/:id/reset-link', (req, res) => {
    const row = load(req.params.id);
    if (row.disabled) throw badRequest('该成员已停用，请先启用再生成链接', 'user_disabled');
    // 还没激活的成员，重新生成的是邀请链接
    const resetUrl = auth.createLink(row.id, row.password_hash ? 'reset' : 'invite');
    res.json({ resetUrl });
  });

  return router;
}
