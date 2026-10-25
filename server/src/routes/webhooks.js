import crypto from 'node:crypto';
import express from 'express';
import { badRequest, HttpError, safeEqual } from '../util.js';

/** 常数时间比较两个十六进制签名 */
function sigEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** @param {any} ctx */
export function webhooksRouter(ctx) {
  const router = express.Router();
  // 必须拿到原始 body 才能校验 HMAC
  const raw = express.raw({ type: () => true, limit: '5mb' });
  const parse = (buf) => {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw badRequest('请求体不是合法的 JSON', 'bad_json');
    }
  };
  const later = (fn) =>
    setImmediate(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => ctx.log.error(`[webhook] 处理出错：${err?.stack || err}`));
    });

  // WAHA：X-Webhook-Hmac = hex(HMAC-SHA512(key, 原始 body))，算法头 X-Webhook-Hmac-Algorithm: sha512
  // https://waha.devlike.pro/docs/how-to/events/
  router.post('/waha', raw, (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const got = String(req.get('x-webhook-hmac') || '').trim().toLowerCase();
    const expected = crypto.createHmac('sha512', ctx.config.wahaWebhookSecret).update(body).digest('hex');
    if (!got || !sigEqual(got, expected)) throw new HttpError(401, 'bad_signature', '签名校验失败');
    const data = parse(body);
    res.json({ ok: true });
    later(() => ctx.wa.handleWahaWebhook(data));
  });

  // Meta：每个号一个回调地址，各自用自己号的 verifyToken 和 appSecret（F7）
  const metaAccount = (req) => {
    const acc = ctx.accounts.get(String(req.params.accountId));
    if (!acc || acc.channel !== 'meta') throw new HttpError(404, 'not_found', '号码不存在');
    return acc;
  };

  // GET 校验订阅  https://developers.facebook.com/docs/graph-api/webhooks/getting-started
  router.get('/meta/:accountId', (req, res) => {
    const meta = metaAccount(req).meta;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (
      mode === 'subscribe' &&
      meta.verifyToken &&
      typeof token === 'string' &&
      safeEqual(token, meta.verifyToken) &&
      typeof challenge === 'string'
    ) {
      res.set('x-content-type-options', 'nosniff').type('text/plain').send(challenge);
      return;
    }
    throw new HttpError(403, 'forbidden', 'Webhook 校验失败');
  });

  // POST：X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(app secret, 原始 body))
  router.post('/meta/:accountId', raw, (req, res) => {
    const acc = metaAccount(req);
    const secret = acc.meta.appSecret;
    if (!secret) throw new HttpError(403, 'meta_not_configured', '该号码未配置 Meta app secret，已拒绝接收');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const got = String(req.get('x-hub-signature-256') || '').trim().toLowerCase();
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    if (!got || !sigEqual(got, expected)) throw new HttpError(401, 'bad_signature', '签名校验失败');
    const data = parse(body);
    res.json({ ok: true });
    later(() => ctx.wa.handleMetaWebhook(acc.id, data));
  });

  // LINE 官方帐号：每个号一个回调地址。X-Line-Signature = base64(HMAC-SHA256(channel secret, 原始 body))，
  // 先校验签名再解析 JSON；2 秒内要回 200，所以先回再处理。控制台的「Verify」按钮发的是签过名的 {destination, events: []}
  // https://developers.line.biz/en/reference/messaging-api/#signature-validation
  router.post('/line/:accountId', raw, (req, res) => {
    const acc = ctx.accounts.get(String(req.params.accountId));
    if (!acc || acc.channel !== 'line') throw new HttpError(404, 'not_found', '号码不存在');
    const secret = acc.line.channelSecret;
    if (!secret) throw new HttpError(403, 'line_not_configured', '该号码未配置 LINE 的 Channel secret，已拒绝接收');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const got = Buffer.from(String(req.get('x-line-signature') || '').trim(), 'base64');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      throw new HttpError(401, 'bad_signature', '签名校验失败');
    }
    const data = parse(body);
    res.json({ ok: true });
    later(() => ctx.wa.handleLineWebhook(acc.id, data));
  });

  return router;
}
