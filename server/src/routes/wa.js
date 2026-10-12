// 会话接口。agent 只能看和操作分配给自己的号下的会话（F8），越权返回 403。
import express from 'express';
import { canAccessAccount, forbidden } from '../auth.js';
import { notFound } from '../util.js';

/** @param {any} ctx */
export function waRouter(ctx) {
  const router = express.Router();
  const wa = ctx.wa;

  function loadConv(req) {
    const c = wa.getConversation(String(req.params.id));
    if (!c) throw notFound('会话不存在');
    if (!canAccessAccount(req.user, c.accountId)) throw forbidden();
    return c;
  }

  router.get('/conversations', (req, res) => {
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    if (accountId && !canAccessAccount(req.user, accountId)) throw forbidden();
    const accountIds = req.user.role === 'admin' ? null : req.user.accountIds;
    res.json(wa.listConversations({ accountIds, accountId }));
  });
  router.get('/conversations/:id', (req, res) => res.json(loadConv(req)));
  router.get('/conversations/:id/messages', (req, res) => res.json(wa.listMessages(loadConv(req).id)));
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
  // F2b：人工回复改写成知识条目（不落库），只有 admin
  router.post('/conversations/:id/messages/:messageId/kb-draft', async (req, res) => {
    if (req.user.role !== 'admin') throw forbidden();
    const c = loadConv(req);
    res.json(await wa.kbDraftFromMessage(c.id, String(req.params.messageId)));
  });

  return router;
}
