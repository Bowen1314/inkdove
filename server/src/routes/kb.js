import express from 'express';
import { badRequest, HttpError, isPlainObject, notFound } from '../util.js';
import { ENTRY_STATUSES, ENTRY_TYPES, GAP_STATUSES, normalizeTags } from '../kb/store.js';
import { decideReply } from '../reply/engine.js';
import { llmConfigured } from '../settings.js';

/** GET /entries/by-ids 一次最多取几条 */
export const MAX_BY_IDS = 50;

/** 校验条目写入字段；partial=true 时只校验传入的字段 */
function validateEntryInput(body, partial) {
  if (!isPlainObject(body)) throw badRequest('请求体必须是对象');
  const out = {};
  if (body.type !== undefined || !partial) {
    if (!ENTRY_TYPES.includes(body.type)) throw badRequest('type 只能是 faq、product、policy、fact');
    out.type = body.type;
  }
  for (const f of ['title', 'content']) {
    if (body[f] !== undefined || !partial) {
      if (typeof body[f] !== 'string' || !body[f].trim()) throw badRequest(`${f} 不能为空`);
      out[f] = body[f].trim().slice(0, f === 'title' ? 200 : 20000);
    }
  }
  if (body.tags !== undefined) out.tags = normalizeTags(body.tags);
  if (body.status !== undefined) {
    if (!ENTRY_STATUSES.includes(body.status)) throw badRequest('status 只能是 active 或 disabled');
    out.status = body.status;
  }
  return out;
}

/**
 * 知识库：浏览条目和画像、统计、测试对话两种角色都能用；增删改和缺口只有 admin（F8）。
 * @param {any} ctx
 * @param {{requireAdmin: Function}} auth
 */
export function kbRouter(ctx, auth) {
  const { kb } = ctx;
  const router = express.Router();
  const admin = auth.requireAdmin;

  router.get('/profile', (_req, res) => res.json(kb.getProfile()));
  router.put('/profile', admin, (req, res) => res.json(kb.updateProfile(req.body)));

  router.get('/entries', (req, res) => {
    const { q, type, status } = req.query;
    if (type && !ENTRY_TYPES.includes(String(type))) throw badRequest('type 不正确');
    if (status && !ENTRY_STATUSES.includes(String(status))) throw badRequest('status 不正确');
    res.json(kb.listEntries({ q: q ? String(q) : '', type: type ? String(type) : '', status: status ? String(status) : '' }));
  });

  // 按 id 取几条条目（会话里显示引用的条目用，不用为了几个标题把整个知识库拉下来），权限同 GET /entries。
  // ids 逗号分隔（也认重复的 ids=），去重后最多 MAX_BY_IDS 个；顺序和 ids 一样，不存在的跳过，停用的照样返回（看 status）
  router.get('/entries/by-ids', (req, res) => {
    const raw = req.query.ids;
    const parts = (Array.isArray(raw) ? raw : [raw ?? '']).flatMap((v) => (typeof v === 'string' ? v.split(',') : []));
    const ids = [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_BY_IDS) throw badRequest(`ids 最多 ${MAX_BY_IDS} 个`, 'too_many_ids');
    res.json(ids.length ? kb.entriesByIds(ids, { status: null }) : []);
  });

  // F2b：origin 可选 manual（默认）或 conversation；conversation 时可带 sourceRefs（会话名 + 人工回复摘录）
  router.post('/entries', admin, (req, res) => {
    const input = validateEntryInput(req.body, false);
    const origin = req.body.origin ?? 'manual';
    if (origin !== 'manual' && origin !== 'conversation') throw badRequest('origin 只能是 manual 或 conversation');
    let sourceRefs = [];
    if (origin === 'conversation' && req.body.sourceRefs !== undefined) {
      if (!Array.isArray(req.body.sourceRefs)) throw badRequest('sourceRefs 必须是数组');
      sourceRefs = req.body.sourceRefs.filter(isPlainObject).slice(0, 5).map((r) => ({
        sourceId: typeof r.sourceId === 'string' && r.sourceId ? r.sourceId.slice(0, 100) : null,
        sourceName: typeof r.sourceName === 'string' ? r.sourceName.slice(0, 200) : '',
        quote: typeof r.quote === 'string' ? r.quote.slice(0, 200) : '',
      }));
    }
    res.json(kb.insertEntry({ ...input, origin, sourceRefs }));
  });

  router.put('/entries/:id', admin, (req, res) => {
    const input = validateEntryInput(req.body, true);
    const e = kb.updateEntry(req.params.id, input);
    if (!e) throw notFound('条目不存在');
    res.json(e);
  });

  router.delete('/entries/:id', admin, (req, res) => {
    if (!kb.deleteEntry(req.params.id)) throw notFound('条目不存在');
    res.json({ ok: true });
  });

  router.get('/stats', (_req, res) => res.json(kb.stats()));

  // 向量检索（可选，kb/vectors.js）：进度和状态、全部清掉重算、出错停下后马上再试。只有 admin（和设置页一样）
  router.get('/vectors', admin, (_req, res) => res.json(ctx.vectors.status()));
  router.post('/vectors/rebuild', admin, (_req, res) => {
    if (!ctx.getSettings().embedding?.enabled) throw badRequest('向量检索没有开启', 'embedding_disabled');
    ctx.vectors.rebuild();
    res.json(ctx.vectors.status());
  });
  router.post('/vectors/retry', admin, (_req, res) => {
    if (!ctx.getSettings().embedding?.enabled) throw badRequest('向量检索没有开启', 'embedding_disabled');
    ctx.vectors.retry();
    res.json(ctx.vectors.status());
  });

  router.get('/gaps', admin, (req, res) => {
    const status = req.query.status ? String(req.query.status) : '';
    if (status && !GAP_STATUSES.includes(status)) throw badRequest('status 不正确');
    res.json(kb.listGaps(status));
  });

  router.post('/gaps/:id/answer', admin, (req, res) => {
    const gap = kb.getGap(req.params.id);
    if (!gap) throw notFound('缺口不存在');
    const answer = req.body?.answer;
    if (typeof answer !== 'string' || !answer.trim()) throw badRequest('答案不能为空');
    if (gap.status !== 'open') throw new HttpError(409, 'gap_closed', '这个缺口已经处理过了');
    const entry = kb.insertEntry({
      type: 'faq',
      title: gap.question.slice(0, 200),
      content: answer.trim().slice(0, 20000),
      tags: [],
      sourceRefs: [],
      origin: 'gap',
    });
    res.json({ gap: kb.setGapStatus(gap.id, 'answered'), entry });
  });

  router.post('/gaps/:id/dismiss', admin, (req, res) => {
    const gap = kb.getGap(req.params.id);
    if (!gap) throw notFound('缺口不存在');
    res.json(kb.setGapStatus(gap.id, 'dismissed'));
  });

  router.post('/ask', async (req, res) => {
    const { message, history } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) throw badRequest('message 不能为空');
    if (history !== undefined && !Array.isArray(history)) throw badRequest('history 必须是数组');
    const hist = (history || [])
      .filter((h) => isPlainObject(h) && (h.role === 'customer' || h.role === 'bot') && typeof h.text === 'string')
      .map((h) => ({ role: h.role, text: h.text }));
    if (!llmConfigured(ctx.getSettings(), ctx.config)) {
      throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
    }
    // 与真实回复走同一个引擎（第 4 层的会话计数除外）
    const r = await decideReply(ctx, { message: message.trim(), history: hist });
    res.json({
      decision: r.decision,
      code: r.code,
      reply: r.reply,
      usedEntryIds: r.usedEntryIds,
      sendFileIds: r.sendFileIds,
      reason: r.reason,
      latencyMs: r.latencyMs,
    });
  });

  return router;
}
