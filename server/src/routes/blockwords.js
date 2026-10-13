import express from 'express';

/**
 * 屏蔽词的命中记录（含 AI 发言检查发现的）和 AI 扩充（只有 admin，挂载时加了 requireAdmin，agent 403；记录里有原文，只给管理员看）。
 * 开关和词表本身走设置接口（PUT /api/settings 的 blockwords）。实现见 blockwords/store.js。
 * - GET  /alerts            还没处理的屏蔽词命中和 AI 发现的严重问题（弹窗轮询用）→ {total, items}，最早的在前，最多 20 条
 * - POST /hits/:id/ack      「知道了」→ 这条记录（别人已经处理过的照样返回，处理人不变）
 * - POST /hits/:id/false-positive
 *                           「误报」（只有 AI 发现的能标，屏蔽词命中 400）→ 这条记录。同时算已处理，标了不能撤销
 * - GET  /hits?status=pending|acked|false_positive&detector=word|ai&severity=severe|mild&who=<成员 id>|bot|phone|relay&from=&to=&page=&pageSize=
 *                           历史，新到旧 → {total, page, pageSize, items, senders}
 * - POST /expand            AI 扩充 {seeds, languages, existing?} → {candidates}，不存
 * @param {any} ctx
 */
export function blockwordsRouter(ctx) {
  const router = express.Router();
  const bw = ctx.blockwords;

  router.get('/alerts', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(bw.alerts());
  });
  router.post('/hits/:id/ack', (req, res) => res.json(bw.ack(String(req.params.id), req.user)));
  router.post('/hits/:id/false-positive', (req, res) => res.json(bw.falsePositive(String(req.params.id), req.user)));
  router.get('/hits', (req, res) => {
    res.set('cache-control', 'no-store');
    res.json(bw.list(req.query));
  });
  router.post('/expand', async (req, res) => res.json(await bw.expand(req.body)));

  return router;
}
