import express from 'express';
import { notFound } from '../util.js';

/**
 * F5 红线体检（只有 admin，挂载时加了 requireAdmin）。
 * @param {any} ctx
 */
export function redteamRouter(ctx) {
  const router = express.Router();

  // 已有体检在跑时 409 job_running，响应体带上那次的 runId（前端直接切过去看）
  router.post('/run', (_req, res) => {
    const runningId = ctx.redteam.runningId();
    if (runningId) return res.status(409).json({ error: '已有红线体检在运行', code: 'job_running', runId: runningId });
    const run = ctx.redteam.start();
    res.json({ runId: run.id });
  });

  router.get('/runs', (_req, res) => res.json(ctx.redteam.list()));

  router.get('/runs/:id', (req, res) => {
    const run = ctx.redteam.get(req.params.id);
    if (!run) throw notFound('体检记录不存在');
    res.json(run);
  });

  router.post('/runs/:id/cancel', (req, res) => {
    ctx.redteam.cancel(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
