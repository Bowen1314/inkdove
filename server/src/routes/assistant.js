import express from 'express';

/**
 * 首页的 AI 助手（所有登录的人都能用；对话只有本人看得到）。逻辑见 assistant/store.js。
 * - GET    /chats                              → {chats:[{id, title, createdAt, updatedAt}], usage:{used, limit}}
 * - POST   /ask {question, chatId?, tz?, now?}  → {chat, message}（message.status 为 running，之后轮询下面的接口）
 * - GET    /chats/:id                          → {chat, messages:[Message]}
 * - GET    /chats/:id/messages/:messageId      → Message
 * - POST   /chats/:id/retry {tz?, now?}        → Message（重答最后一个没答成的问题）
 * - DELETE /chats/:id                          → {ok:true}
 * Message：{id, chatId, question, answer, status: running|done|failed, steps:[{label, status}], refs, error, errorCode, createdAt, finishedAt}；
 * refs 是回答里 [[c1]] 这类标记对应的对象：{key, kind: conversation|entry|file, id, available, name?, accountName?, entry?, file?}。
 * @param {any} ctx
 */
export function assistantRouter(ctx) {
  const router = express.Router();
  const a = ctx.assistant;
  router.get('/chats', (req, res) => res.json(a.list(req.user)));
  router.post('/ask', (req, res) => res.json(a.ask(req.user, req.body || {})));
  router.get('/chats/:id', (req, res) => res.json(a.get(req.user, String(req.params.id))));
  router.get('/chats/:id/messages/:messageId', (req, res) => res.json(a.getMessage(req.user, String(req.params.id), String(req.params.messageId))));
  router.post('/chats/:id/retry', (req, res) => res.json(a.retry(req.user, String(req.params.id), req.body || {})));
  router.delete('/chats/:id', (req, res) => {
    a.remove(req.user, String(req.params.id));
    res.json({ ok: true });
  });
  return router;
}
