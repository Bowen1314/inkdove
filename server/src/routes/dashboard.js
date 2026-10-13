import express from 'express';
import { parseDashboardQuery } from '../dashboard.js';

/**
 * F12 管理员数据看板（只有 admin，挂载时加了 requireAdmin，agent 403）。
 * GET /api/dashboard?range=today|7d|30d&accountId=&tz= 一次返回全部数据，计算见 dashboard.js。
 * @param {any} ctx
 */
export function dashboardRouter(ctx) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const q = parseDashboardQuery(req.query);
    res.set('cache-control', 'no-store');
    res.json(await ctx.dashboard.build(q));
  });

  return router;
}
