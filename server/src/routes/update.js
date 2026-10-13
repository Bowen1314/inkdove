import express from 'express';

/**
 * 在线更新（只有 admin，挂载时加了 requireAdmin，agent 403）。逻辑见 update.js。
 * GET  /api/update        当前版本、GitHub 上的最新发布、更新助手装没装、当前的预约和最近一次预约执行的结果
 * POST /api/update/check  立即重查（60 秒内查过就直接给上次的结果）
 * POST /api/update/apply  备份数据库后让更新助手拉新镜像、重建容器（已有的预约作废）
 * POST /api/update/schedule {at}  预约在 at（ISO 时间，1 分钟之后、7 天之内）更新，只管这一次；再预约就覆盖
 * DELETE /api/update/schedule     取消预约
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

  router.post('/apply', async (req, res) => {
    res.json(await ctx.update.apply(req.user));
  });

  router.post('/schedule', async (req, res) => {
    res.json(await ctx.update.schedule(req.body?.at, req.user));
  });

  router.delete('/schedule', async (req, res) => {
    res.json(await ctx.update.cancelSchedule(req.user));
  });

  return router;
}
