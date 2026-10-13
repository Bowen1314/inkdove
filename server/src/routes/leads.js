// F6 客户线索接口。admin 能看所有线索；agent 只能看、改、重新提取、导出自己负责的会话的线索（按客户分配，
// 和会话用同一个判断 canAccessConversation），越权返回 403，列表和导出自动过滤。删除只有 admin。
import express from 'express';
import { canAccessAccount, canAccessConversation, conversationScope, forbidden } from '../auth.js';
import { leadsToCsv } from '../leads/store.js';
import { notFound } from '../util.js';

/** @param {any} ctx */
export function leadsRouter(ctx) {
  const router = express.Router();
  const leads = ctx.leads;

  function loadLead(req) {
    const l = leads.get(String(req.params.id));
    if (!l) throw notFound('线索不存在');
    if (!canAccessConversation(req.user, ctx.wa.getConversation(l.conversationId))) throw forbidden();
    return l;
  }

  /** 列表和导出共用的筛选：agent 指定了别人的号 403，没指定时只看自己负责的会话的线索 */
  function filtersOf(req) {
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    if (accountId && !canAccessAccount(req.user, accountId)) throw forbidden();
    return {
      ...conversationScope(req.user),
      accountId,
      stage: req.query.stage ? String(req.query.stage) : '',
      q: req.query.q ? String(req.query.q) : '',
    };
  }

  router.get('/', (req, res) => res.json(leads.list(filtersOf(req))));

  // 要注册在 /:id 前面，不然 export.csv 会被当成线索 id
  router.get('/export.csv', (req, res) => {
    const list = leads.list(filtersOf(req));
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    ctx.log.info(`[leads] ${req.user.email} 导出了 ${list.length} 条客户线索`);
    res.set({ 'content-disposition': `attachment; filename="inkdove-leads-${day}.csv"`, 'cache-control': 'no-store' });
    res.type('text/csv; charset=utf-8').send(leadsToCsv(list));
  });

  router.get('/:id', (req, res) => res.json(loadLead(req)));

  router.put('/:id', (req, res) => {
    const l = loadLead(req);
    res.json(leads.update(l.id, req.body));
  });

  router.delete('/:id', (req, res) => {
    if (req.user.role !== 'admin') throw forbidden();
    const l = loadLead(req);
    if (!leads.remove(l.id)) throw notFound('线索不存在');
    res.json({ ok: true });
  });

  router.post('/:id/refresh', async (req, res) => {
    const l = loadLead(req);
    res.json(await leads.refresh(l.id));
  });

  return router;
}
