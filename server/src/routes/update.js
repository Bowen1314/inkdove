import express from 'express';

/**
 * 在线更新（只有 admin，挂载时加了 requireAdmin，agent 403）。逻辑见 update.js。
 * GET  /api/update        当前版本、GitHub 上的最新发布、更新助手装没装
 * POST /api/update/check  立即重查（60 秒内查过就直接给上次的结果）
 * POST /api/update/apply  备份数据库后让更新助手拉新镜像、重建容器
 * @param {any} ctx
 */
export function updateRouter(ctx) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(await ctx.update.status());
  });

  router.post('/check', async (_req, res) => {
    res.json(await ctx.update.checkNow());
  });

  router.post('/apply', async (_req, res) => {
    res.json(await ctx.update.apply());
  });

  return router;
}
