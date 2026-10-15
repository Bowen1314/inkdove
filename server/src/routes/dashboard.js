import express from 'express';
import { parseDashboardQuery, parseDraftListQuery } from '../dashboard.js';

/**
 * F12 管理员数据看板（只有 admin，挂载时加了 requireAdmin，agent 403）。
 * GET /api/dashboard?range=today|7d|30d&accountId=&assigneeId=&tz= 一次返回全部数据，计算见 dashboard.js。
 * GET /api/dashboard/drafts?range&tz&accountId&assigneeId&filter&cursor&limit 推荐回复列表（改得多的和没用的），分页。
 * @param {any} ctx
 */
export function dashboardRouter(ctx) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const q = parseDashboardQuery(req.query);
    res.set('cache-control', 'no-store');
    res.json(await ctx.dashboard.build(q));
  });

  router.get('/drafts', (req, res) => {
    const q = parseDraftListQuery(req.query);
    res.set('cache-control', 'no-store');
    res.json(ctx.dashboard.listDrafts(q));
  });

  return router;
}
