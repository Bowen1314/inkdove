// F7 号码接口。新建、删除、改名、IP 代理、Meta 凭证只有 admin 能做；其余（扫码连接和登出、自动回复、persona、
// 回复范围、名单、通知）分到这个号的 agent 也能做。所有判断都在服务端。
import express from 'express';
import { applyAccountPatch, CHANNELS, proxyFingerprint, publicAccount } from '../accounts.js';
import { canAccessAccount, forbidden } from '../auth.js';
import { emailConfigured, str } from '../settings.js';
import { badRequest, HttpError, isPlainObject, notFound } from '../util.js';
import { testProxy } from '../wa/proxy-test.js';

/**
 * @param {any} ctx
 * @param {{requireAdmin: Function}} auth
 */
export function accountsRouter(ctx, auth) {
  const router = express.Router();
  const { accounts, wa } = ctx;

  /** 先判权限再判存在：agent 探不出别人的号是否存在 */
  function load(req) {
    const id = String(req.params.id);
    if (!canAccessAccount(req.user, id)) throw forbidden();
    const acc = accounts.get(id);
    if (!acc) throw notFound('号不存在');
    return acc;
  }

  const view = async (acc, opts) => publicAccount(acc, ctx.config, await wa.getStatus(acc, opts));

  router.get('/', async (req, res) => {
    const list = accounts.list().filter((a) => canAccessAccount(req.user, a.id));
    res.json(await Promise.all(list.map((a) => view(a, { maxAgeMs: 5000, timeoutMs: 2000 }))));
  });

  router.post('/', auth.requireAdmin, async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) throw badRequest('请求体必须是对象');
    const name = str(body.name ?? '', 'name', 100).trim();
    if (!name) throw badRequest('name 不能为空');
    if (!CHANNELS.includes(body.channel)) throw badRequest('channel 只能是 waha 或 meta');
    const acc = accounts.create({ name, channel: body.channel });
    ctx.log.info(`[accounts] ${req.user.email} 新建了号 ${acc.id}（${acc.channel}）`);
    res.json(await view(acc, { timeoutMs: 2000 }));
  });

  router.get('/:id', async (req, res) => res.json(await view(load(req))));

  router.put('/:id', async (req, res) => {
    const cur = load(req);
    const next = applyAccountPatch(cur, req.body, {
      isAdmin: req.user.role === 'admin',
      emailReady: emailConfigured(ctx.getSettings()),
    });
    const saved = accounts.save(next);
    if (saved.channel === 'waha' && proxyFingerprint(cur) !== proxyFingerprint(saved)) {
      // 4.5 / F13：代理一改，中继重启，已有的 WAHA session 用新配置更新（WAHA 自动重启 session，登录态保留）
      try {
        const r = await wa.applyWahaConfig(saved);
        ctx.log.info(`[waha] 号 ${saved.id} 的代理设置已变更：${r}`);
      } catch (err) {
        ctx.log.warn(`[waha] 号 ${saved.id} 的代理设置未能同步到 WAHA：${err?.message || err}`);
      }
    }
    res.json(await view(accounts.get(saved.id)));
  });

  router.delete('/:id', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    await wa.deleteAccount(acc);
    ctx.log.info(`[accounts] ${req.user.email} 删除了号 ${acc.id}`);
    res.json({ ok: true });
  });

  router.post('/:id/waha/start', async (req, res) => res.json(await wa.wahaStart(load(req))));
  router.get('/:id/waha/qr', async (req, res) => {
    const png = await wa.wahaQr(load(req));
    res.set('cache-control', 'no-store').type('image/png').send(png);
  });
  router.post('/:id/waha/logout', async (req, res) => res.json(await wa.wahaLogout(load(req))));

  // 代理测试仍从 inkdove 直连上游代理，不经过中继（F13）
  router.post('/:id/proxy/test', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    if (acc.channel !== 'waha') throw badRequest('这个号不是扫码接入', 'wrong_channel');
    const px = acc.waha.proxy;
    if (!px.enabled) throw new HttpError(400, 'proxy_disabled', '代理没有启用');
    res.json(await testProxy(px, { url: ctx.proxyTestUrl }));
  });

  router.post('/:id/notify/test', async (req, res) => res.json(await wa.notifier.test(load(req))));

  return router;
}
