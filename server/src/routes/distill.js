import express from 'express';
import { badRequest, notFound } from '../util.js';

/** @param {any} ctx */
export function distillRouter(ctx) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const { sourceIds, mode } = req.body || {};
    if (sourceIds !== undefined && sourceIds !== null && (!Array.isArray(sourceIds) || sourceIds.some((x) => typeof x !== 'string'))) {
      throw badRequest('sourceIds 必须是字符串数组');
    }
    const job = ctx.distill.start({ sourceIds, mode: mode ?? 'incremental' });
    res.json({ jobId: job.id });
  });

  router.get('/jobs', (_req, res) => res.json(ctx.distill.list()));

  router.get('/jobs/:id', (req, res) => {
    const job = ctx.distill.get(req.params.id);
    if (!job) throw notFound('任务不存在');
    res.json(job);
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    ctx.distill.cancel(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
