// 操作日志接口（只有 admin，挂载时加了 requireAdmin，agent 403）。只能查，没有改和删的接口；过期的由服务端每天自动清。
// GET /api/audit-logs?actorId=&type=&from=&to=&q=&cursor=&limit=  按时间倒序，一页 limit 条（默认 50，最多 200），
//   返回 {items, nextCursor}；下一页带上 cursor=nextCursor。type 是操作类型（account）或具体操作（account.update）
// GET /api/audit-logs/types  操作类型 [{value, label}]（筛选用）
import express from 'express';
import { CATEGORIES } from '../audit/actions.js';
import { parseAuditQuery } from '../audit/store.js';

/** @param {any} ctx */
export function auditRouter(ctx) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const f = parseAuditQuery(req.query);
    res.set('cache-control', 'no-store');
    res.json(ctx.audit.list(f));
  });

  router.get('/types', (_req, res) => {
    res.json(Object.entries(CATEGORIES).map(([value, label]) => ({ value, label })));
  });

  return router;
}
