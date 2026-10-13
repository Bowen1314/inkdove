// 按客户分配会话：改负责人、批量分配、转交、分配记录，以及成员和号变动时把会话收回成未分配（表和列见 db.js）。
// 谁能看哪个会话由 auth.js 的 canAccessConversation 判断；这里只管写。每次改负责人都在事务里同时写一行分配记录。
import { canAccessAccount, rowToUser } from '../auth.js';
import { HttpError, newId, notFound, nowIso } from '../util.js';

export const ASSIGN_REASONS = ['manual', 'bulk', 'transfer', 'migration', 'campaign', 'access_removed', 'user_deleted'];
/** 分配记录里的成员已经被删了时显示的名字 */
export const DELETED_MEMBER_NAME = '已删除成员';
/** 批量分配一次最多几个会话 */
export const MAX_BULK_ASSIGN = 500;

const assigneeInvalid = () => new HttpError(400, 'assignee_invalid', '负责人不存在或已停用');
const noAccountAccess = () => new HttpError(400, 'assignee_no_account_access', '这个成员没有这个会话所属号的权限，先在成员页给他分配这个号');

/**
 * 分配目标：null 表示取消分配（返回 null）；成员不存在或已停用 → 400 assignee_invalid。
 * @returns {ReturnType<typeof rowToUser>|null}
 */
export function assigneeTarget(db, userId) {
  if (userId === null) return null;
  const row = typeof userId === 'string' && userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
  if (!row || row.disabled) throw assigneeInvalid();
  return rowToUser(row);
}

/** 目标能不能负责这个号上的会话：admin 都能，agent 要有这个号的权限；取消分配总是可以 */
const canTake = (target, accountId) => !target || canAccessAccount(target, accountId);

const convRow = (db, id) => db.prepare('SELECT id, account_id, assignee_id FROM conversations WHERE id = ?').get(id);

/**
 * 改一个会话的负责人并写一行分配记录（事务和校验由调用方负责）。和原负责人相同时什么也不做，返回 false。
 * assigned_at 记这次改的时间，取消分配时清空。
 * 会话的草稿用了某个人的「我的资料」（draft.agentUserId）、新负责人不是他时，清掉这份草稿：里面是别人的名字和电话。
 * 转人工草稿记的是当时的负责人；推荐回复记的是点按钮的那个人（可能不是负责人，比如管理员替业务员点的），
 * 负责人不变时不动，换成别人时一样清掉，改派给的正好是他时保留。没用资料的草稿都不动。
 * @param {{id:string, assignee_id:string|null}} row 会话行
 * @param {string|null} toUserId
 * @param {{byUserId?: string|null, reason: string, at?: string}} o
 */
function writeAssignee(db, row, toUserId, { byUserId = null, reason, at = nowIso() }) {
  const from = row.assignee_id ?? null;
  if (from === (toUserId ?? null)) return false;
  db.prepare('UPDATE conversations SET assignee_id = ?, assigned_at = ? WHERE id = ?').run(toUserId, toUserId ? at : null, row.id);
  db.prepare(
    `UPDATE conversations SET draft = NULL
      WHERE id = ? AND json_valid(draft) AND json_extract(draft, '$.agentUserId') IS NOT NULL AND json_extract(draft, '$.agentUserId') IS NOT ?`,
  ).run(row.id, toUserId ?? null);
  db.prepare(
    `INSERT INTO conversation_assignments(id, conversation_id, from_user_id, to_user_id, by_user_id, reason, at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), row.id, from, toUserId, byUserId, reason, at);
  return true;
}

/**
 * PUT /api/wa/conversations/:id/assignee（reason=manual）。userId 为 null 是取消分配，分给 admin（包括自己）也可以。
 * 会话不存在 404；目标无效 400 assignee_invalid；目标是 agent 但没有这个号的权限 400 assignee_no_account_access。
 * 和原负责人相同时不写记录。
 * @returns {boolean} 有没有改
 */
export function assignConversation(db, convId, userId, by) {
  const target = assigneeTarget(db, userId);
  return db.transaction(() => {
    const row = convRow(db, convId);
    if (!row) throw notFound('会话不存在');
    if ((row.assignee_id ?? null) === (target?.id ?? null)) return false;
    if (!canTake(target, row.account_id)) throw noAccountAccess();
    return writeAssignee(db, row, target?.id ?? null, { byUserId: by?.id ?? null, reason: 'manual' });
  })();
}

/**
 * POST /api/wa/conversations/assign（reason=bulk）。目标无效时整体 400 assignee_invalid；
 * 逐个跳过的记 {id, code}，code 是 not_found、unchanged、assignee_no_account_access。重复的 id 只算一次。
 * @param {string[]} ids
 * @returns {{updated:number, skipped:{id:string, code:string}[]}}
 */
export function assignMany(db, ids, userId, by) {
  const target = assigneeTarget(db, userId);
  return db.transaction(() => {
    const at = nowIso();
    let updated = 0;
    const skipped = [];
    for (const id of new Set(ids)) {
      const row = convRow(db, id);
      if (!row) skipped.push({ id, code: 'not_found' });
      else if ((row.assignee_id ?? null) === (target?.id ?? null)) skipped.push({ id, code: 'unchanged' });
      else if (!canTake(target, row.account_id)) skipped.push({ id, code: 'assignee_no_account_access' });
      else if (writeAssignee(db, row, target?.id ?? null, { byUserId: by?.id ?? null, reason: 'bulk', at })) updated++;
    }
    return { updated, skipped };
  })();
}

/**
 * POST /api/users/:id/transfer（reason=transfer）：把 fromUserId 负责的会话全部转给 toUserId。
 * 目标不存在、已停用、就是他自己 → 400 assignee_invalid。目标是 agent 时，他没有权限的号上的会话不动，计入 skipped。
 * @returns {{moved:number, skipped:number}}
 */
export function transferAll(db, fromUserId, toUserId, by) {
  if (typeof toUserId !== 'string' || toUserId === fromUserId) throw assigneeInvalid();
  const target = assigneeTarget(db, toUserId);
  return db.transaction(() => {
    const at = nowIso();
    let moved = 0;
    let skipped = 0;
    for (const row of db.prepare('SELECT id, account_id, assignee_id FROM conversations WHERE assignee_id = ?').all(fromUserId)) {
      if (!canTake(target, row.account_id)) skipped++;
      else if (writeAssignee(db, row, target.id, { byUserId: by?.id ?? null, reason: 'transfer', at })) moved++;
    }
    return { moved, skipped };
  })();
}

/**
 * 成员被停用或删除：清掉所有用了他「我的资料」的草稿（draft.agentUserId 是他），不管会话是不是他负责的——
 * 他点的推荐回复可能在别人的会话上。重新启用不恢复。在改用户行的同一个事务里调。
 * @returns {number} 清了几份
 */
export function clearMemberDrafts(db, userId) {
  return db
    .prepare("UPDATE conversations SET draft = NULL WHERE json_valid(draft) AND json_extract(draft, '$.agentUserId') = ?")
    .run(userId).changes;
}

/**
 * 成员被删：他负责的会话全部变成未分配（reason=user_deleted）。要在删用户行之前调（同一个事务里）。
 * @returns {number} 收回了几个
 */
export function releaseAll(db, userId, by) {
  const at = nowIso();
  let n = 0;
  for (const row of db.prepare('SELECT id, account_id, assignee_id FROM conversations WHERE assignee_id = ?').all(userId)) {
    if (writeAssignee(db, row, null, { byUserId: by?.id ?? null, reason: 'user_deleted', at })) n++;
  }
  return n;
}

/**
 * agent 失去了号的权限（accountIds 改掉了某个号、admin 降级成 agent、号被删）：他在没有权限的号上负责的会话变成未分配
 * （reason=access_removed）。按成员当前存的 role 和 accountIds 判断，所以要在改完用户行之后调；admin 不受影响。
 * @returns {number} 收回了几个
 */
export function releaseLostAccess(db, userId, by) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) return 0;
  const user = rowToUser(row);
  if (user.role === 'admin') return 0;
  const at = nowIso();
  let n = 0;
  for (const c of db.prepare('SELECT id, account_id, assignee_id FROM conversations WHERE assignee_id = ?').all(userId)) {
    if (canAccessAccount(user, c.account_id)) continue;
    if (writeAssignee(db, c, null, { byUserId: by?.id ?? null, reason: 'access_removed', at })) n++;
  }
  return n;
}

/**
 * F11：外联开场消息所在的会话还没有负责人时，发起人现在是启用中的 agent、有这个号的权限 → 分给他（reason=campaign，系统做的）。
 * 发起人是 admin、已停用、已删除或没有这个号的权限 → 保持未分配。已经有负责人的不动。在 sendCampaignMessage 的事务里调。
 */
export function assignCampaignConversation(db, convId, creatorId) {
  if (!creatorId) return false;
  const row = convRow(db, convId);
  if (!row || row.assignee_id) return false;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(creatorId);
  if (!u || u.disabled || u.role !== 'agent' || !canAccessAccount(rowToUser(u), row.account_id)) return false;
  return writeAssignee(db, row, u.id, { reason: 'campaign' });
}

/**
 * GET /api/wa/conversations/:id/assignments：新到旧。成员名字取现在的名字（没填名字的用邮箱），已经被删的显示「已删除成员」。
 * @returns {{id:string, from:{id:string,name:string}|null, to:{id:string,name:string}|null, by:{id:string,name:string}|null, reason:string, at:string}[]}
 */
export function assignmentHistory(db, convId) {
  const person = (id, name, email) => (id ? { id, name: email == null ? DELETED_MEMBER_NAME : name || email } : null);
  return db
    .prepare(
      `SELECT h.*, f.name AS from_name, f.email AS from_email, t.name AS to_name, t.email AS to_email, b.name AS by_name, b.email AS by_email
         FROM conversation_assignments h
         LEFT JOIN users f ON f.id = h.from_user_id
         LEFT JOIN users t ON t.id = h.to_user_id
         LEFT JOIN users b ON b.id = h.by_user_id
        WHERE h.conversation_id = ?
        ORDER BY h.at DESC, h.rowid DESC`,
    )
    .all(convId)
    .map((r) => ({
      id: r.id,
      from: person(r.from_user_id, r.from_name, r.from_email),
      to: person(r.to_user_id, r.to_name, r.to_email),
      by: person(r.by_user_id, r.by_name, r.by_email),
      reason: r.reason,
      at: r.at,
    }));
}

/** 每个成员当前负责的会话数（GET /api/users 的 assignedCount） */
export function assignedCounts(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT assignee_id, COUNT(*) n FROM conversations WHERE assignee_id IS NOT NULL GROUP BY assignee_id').all()) {
    m.set(r.assignee_id, r.n);
  }
  return m;
}
