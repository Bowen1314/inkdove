// 会话接口。按客户分配：admin 能看和操作所有会话；agent 只能看和操作分给自己、而且有这个号权限的会话（未分配的看不到），
// 越权返回 403。会话级接口都经过 loadConv（auth.js 的 canAccessConversation）；列表按 conversationScope 的同一套条件过滤。
// 改负责人、批量分配只有 admin。
import express from 'express';
import { canAccessAccount, canAccessConversation, conversationScope, forbidden } from '../auth.js';
import { badRequest, notFound } from '../util.js';
import { assignConversation, assignmentHistory, assignMany, MAX_BULK_ASSIGN } from '../wa/assign.js';
import { translateForConversation } from '../wa/translate.js';

/** @param {any} ctx */
export function waRouter(ctx) {
  const router = express.Router();
  const wa = ctx.wa;

  function loadConv(req) {
    const c = wa.getConversation(String(req.params.id));
    if (!c) throw notFound('会话不存在');
    if (!canAccessConversation(req.user, c)) throw forbidden();
    return c;
  }
  const requireAdmin = (req) => {
    if (req.user.role !== 'admin') throw forbidden();
  };
  /** body.userId：字符串（成员 id）或 null（取消分配） */
  function userIdOf(body) {
    const v = body?.userId;
    if (v !== null && (typeof v !== 'string' || !v)) throw badRequest('userId 必须是成员 id 或 null');
    return v;
  }

  /**
   * ?accountId=&assignee=。assignee：空（全部能看的）、me、none（未分配，仅 admin）、成员 id（仅 admin）。
   * agent 传 none 或别人的 id → 403；accountId 指定没权限的号也 403
   */
  router.get('/conversations', (req, res) => {
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    if (accountId && !canAccessAccount(req.user, accountId)) throw forbidden();
    const scope = conversationScope(req.user);
    const q = req.query.assignee ? String(req.query.assignee) : '';
    let assignee = scope.assigneeId;
    if (q === 'me') assignee = req.user.id;
    else if (q && scope.assigneeId === null) assignee = q;
    else if (q && q !== scope.assigneeId) throw forbidden();
    res.json(wa.listConversations({ accountIds: scope.accountIds, accountId, assignee }));
  });
  // 批量分配（只有 admin）：{conversationIds, userId} → {updated, skipped:[{id, code}]}。要注册在 /conversations/:id 前面
  router.post('/conversations/assign', (req, res) => {
    requireAdmin(req);
    const ids = req.body?.conversationIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || !x)) throw badRequest('conversationIds 必须是会话 id 的数组');
    if (ids.length > MAX_BULK_ASSIGN) throw badRequest(`一次最多分配 ${MAX_BULK_ASSIGN} 个会话`);
    const r = assignMany(ctx.db, ids, userIdOf(req.body), req.user);
    ctx.log.info(`[wa] ${req.user.email} 批量分配了 ${r.updated} 个会话，跳过 ${r.skipped.length} 个`);
    res.json(r);
  });
  router.get('/conversations/:id', (req, res) => res.json(loadConv(req)));
  router.get('/conversations/:id/messages', (req, res) => res.json(wa.listMessages(loadConv(req).id)));
  // 改负责人（只有 admin）：{userId: 成员 id | null} → 完整的 Conversation
  router.put('/conversations/:id/assignee', (req, res) => {
    requireAdmin(req);
    const c = loadConv(req);
    assignConversation(ctx.db, c.id, userIdOf(req.body), req.user);
    res.json(wa.getConversation(c.id));
  });
  // 分配记录，新到旧；能看这个会话的都能看
  router.get('/conversations/:id/assignments', (req, res) => res.json(assignmentHistory(ctx.db, loadConv(req).id)));
  router.post('/conversations/:id/send', async (req, res) => {
    const c = loadConv(req);
    res.json(await wa.operatorSend(c.id, req.body?.text, req.user));
  });
  router.post('/conversations/:id/bot', (req, res) => {
    const c = loadConv(req);
    res.json(wa.setBotPaused(c.id, req.body?.paused));
  });
  // F15：人工发文件，权限同手动回复
  router.post('/conversations/:id/send-file', async (req, res) => {
    const c = loadConv(req);
    res.json(await wa.operatorSendFile(c.id, req.body, req.user));
  });
  // 输入框一键翻译成客户的语言，权限同手动回复；不改会话状态，不计入会话每日模型次数
  router.post('/conversations/:id/translate', async (req, res) => {
    const c = loadConv(req);
    res.json(await translateForConversation(ctx, c, req.body?.text));
  });
  // 推荐回复：手动要一条（「推荐回复」「换一条」，推荐回复只能这样要），权限同手动回复；号是人工回复还是自动回复都可以。同步返回 {draft}
  router.post('/conversations/:id/suggest', async (req, res) => {
    const c = loadConv(req);
    res.json(await wa.suggestReply(c.id, req.user));
  });
  // F2b：人工回复改写成知识条目（不落库），只有 admin
  router.post('/conversations/:id/messages/:messageId/kb-draft', async (req, res) => {
    if (req.user.role !== 'admin') throw forbidden();
    const c = loadConv(req);
    res.json(await wa.kbDraftFromMessage(c.id, String(req.params.messageId)));
  });

  return router;
}
