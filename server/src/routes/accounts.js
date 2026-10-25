// F7 号码接口。agent 只能看分给自己的号（GET 列表和详情，看不到 Meta 的 verifyToken 和通知收件人）；
// 其余一律只有 admin：新建、删除、改设置（整个 PUT，含回复方式、persona、范围、名单、通知、改名、IP 代理、Meta 凭证）、
// 扫码连接 / 取二维码 / 配对码 / 登出、测试代理、测试通知、配置导出导入、Telegram 私人号重新绑定、Telegram 扫码登录（开始登录、
// 二维码、两步验证密码、退出登录、从 my.telegram.org 自动取 api_id）。所有判断都在服务端。
// Telegram 号新建、改设置、导入、删除后让服务同步收消息（wa.syncTelegram）。
import express from 'express';
import multer from 'multer';
import {
  ACCOUNTS_EXPORT_FORMAT,
  ACCOUNTS_EXPORT_VERSION,
  applyAccountPatch,
  CHANNELS,
  exportAccount,
  isTelegram,
  isTgBotApi,
  parseAccountsExport,
  proxyFingerprint,
  publicAccount,
} from '../accounts.js';
import { canAccessAccount, forbidden } from '../auth.js';
import { emailConfigured, str } from '../settings.js';
import { badRequest, HttpError, isPlainObject, notFound, nowIso } from '../util.js';
import { createMyTelegram } from '../wa/mytelegram.js';
import { testProxy } from '../wa/proxy-test.js';
import { botIdOf } from '../wa/telegram.js';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * @param {any} ctx
 * @param {{requireAdmin: Function}} auth
 */
export function accountsRouter(ctx, auth) {
  const router = express.Router();
  const { accounts, wa } = ctx;
  const myTelegram = createMyTelegram({ baseUrl: ctx.config.myTelegramUrl });

  /** 先判权限再判存在：agent 探不出别人的号是否存在 */
  function load(req) {
    const id = String(req.params.id);
    if (!canAccessAccount(req.user, id)) throw forbidden();
    const acc = accounts.get(id);
    if (!acc) throw notFound('号不存在');
    return acc;
  }

  /** 同一个 Telegram 机器人只能给一个号用：两个号一起收消息会互相顶掉（Telegram 返回 409） */
  function assertBotUnused(acc) {
    const botId = isTgBotApi(acc.channel) ? botIdOf(acc.telegram.botToken) : '';
    if (!botId) return;
    const other = accounts.list().find((a) => a.id !== acc.id && isTgBotApi(a.channel) && botIdOf(a.telegram.botToken) === botId);
    if (other) throw new HttpError(409, 'telegram_bot_in_use', `这个机器人已经给号「${other.name}」用了，同一个机器人只能接一个号`);
  }

  /** viewer：看的人，agent 看不到 verifyToken 和通知收件人 */
  const view = async (acc, opts, viewer = null) => publicAccount(acc, ctx.config, await wa.getStatus(acc, opts), viewer);

  router.get('/', async (req, res) => {
    const list = accounts.list().filter((a) => canAccessAccount(req.user, a.id));
    res.json(await Promise.all(list.map((a) => view(a, { maxAgeMs: 5000, timeoutMs: 2000 }, req.user))));
  });

  router.post('/', auth.requireAdmin, async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) throw badRequest('请求体必须是对象');
    const name = str(body.name ?? '', 'name', 100).trim();
    if (!name) throw badRequest('name 不能为空');
    if (!CHANNELS.includes(body.channel)) throw badRequest(`channel 只能是 ${CHANNELS.join('、')}`);
    const acc = accounts.create({ name, channel: body.channel });
    ctx.log.info(`[accounts] ${req.user.email} 新建了号 ${acc.id}（${acc.channel}）`);
    if (isTelegram(acc.channel)) await wa.syncTelegram();
    res.json(await view(acc, { timeoutMs: 2000 }));
  });

  // 号码配置导出 / 导入（规格外新增，只有 admin）。要注册在 /:id 前面，不然 export 会被当成号 id。
  // 导出文件含密钥明文；导入是 multipart，字段 file，校验全过才建，Meta phoneNumberId 重复的跳过
  router.get('/export', auth.requireAdmin, (req, res) => {
    const list = accounts.list();
    const doc = {
      format: ACCOUNTS_EXPORT_FORMAT,
      version: ACCOUNTS_EXPORT_VERSION,
      exportedAt: nowIso(),
      accounts: list.map(exportAccount),
    };
    ctx.log.info(`[accounts] ${req.user.email} 导出了号码配置（${list.length} 个号，含密钥明文）`);
    const filename = `inkdove-accounts-${doc.exportedAt.slice(0, 10).replace(/-/g, '')}.json`;
    res.set({ 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
    res.type('json').send(JSON.stringify(doc, null, 2));
  });

  const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
    defParamCharset: 'utf8',
  });
  router.post(
    '/import',
    auth.requireAdmin,
    (req, res, next) => {
      importUpload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'file_too_large', '配置文件不能超过 2MB'));
          if (err.code === 'LIMIT_FILE_COUNT') return next(badRequest('一次只能上传 1 个文件', 'upload_error'));
          if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('上传字段名应为 file，且只能有 1 个文件', 'upload_error'));
          return next(badRequest(`上传失败：${err.message}`, 'upload_error'));
        }
        next(err);
      });
    },
    (req, res) => {
      const f = /** @type {Express.Multer.File|undefined} */ (req.file);
      if (!f) throw badRequest('没有收到文件（字段名 file）');
      let doc;
      try {
        doc = JSON.parse(f.buffer.toString('utf8').replace(/^\uFEFF/, ''));
      } catch {
        throw badRequest('文件不是有效的 JSON', 'bad_format');
      }
      const items = parseAccountsExport(doc, {
        emailReady: emailConfigured(ctx.getSettings()),
        globalProxyReady: ctx.globalProxy.enabled(),
      });
      const result = accounts.importMany(items);
      if (items.some((it) => isTelegram(it.channel))) wa.syncTelegram();
      ctx.log.info(
        `[accounts] ${req.user.email} 导入了号码配置：新建 ${result.created.length} 个，跳过 ${result.skipped.length} 个`,
      );
      res.json(result);
    },
  );

  router.get('/:id', async (req, res) => res.json(await view(load(req), undefined, req.user)));

  router.put('/:id', auth.requireAdmin, async (req, res) => {
    const cur = load(req);
    const next = applyAccountPatch(cur, req.body, {
      isAdmin: req.user.role === 'admin',
      emailReady: emailConfigured(ctx.getSettings()),
      globalProxyReady: ctx.globalProxy.enabled(),
    });
    assertBotUnused(next);
    const saved = accounts.save(next);
    if (isTelegram(saved.channel)) await wa.syncTelegram();
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
    await wa.deleteAccount(acc, req.user);
    myTelegram.cancel(acc.id);
    ctx.log.info(`[accounts] ${req.user.email} 删除了号 ${acc.id}`);
    res.json({ ok: true });
  });

  // 扫码连接、取二维码、登出、配对码只有 admin
  router.post('/:id/waha/start', auth.requireAdmin, async (req, res) => res.json(await wa.wahaStart(load(req))));
  router.get('/:id/waha/qr', auth.requireAdmin, async (req, res) => {
    const png = await wa.wahaQr(load(req));
    res.set('cache-control', 'no-store').type('image/png').send(png);
  });
  router.post('/:id/waha/logout', auth.requireAdmin, async (req, res) => res.json(await wa.wahaLogout(load(req))));
  // 手机号配对码（规格外新增）：{phoneNumber} → {code}，权限同扫码
  router.post('/:id/waha/request-code', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    if (!isPlainObject(req.body)) throw badRequest('请求体必须是对象');
    res.json(await wa.wahaRequestCode(acc, req.body.phoneNumber));
  });

  // 代理测试仍从 inkdove 直连上游代理，不经过中继（F13）；用全局代理的号测全局代理（经 mihomo）
  router.post('/:id/proxy/test', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    if (acc.channel !== 'waha') throw badRequest('这个号不是扫码接入', 'wrong_channel');
    const px = acc.waha.proxy;
    if (!px.enabled) throw new HttpError(400, 'proxy_disabled', '代理没有启用');
    res.json(px.useGlobal ? await ctx.globalProxy.test() : await testProxy(px, { url: ctx.proxyTestUrl }));
  });

  router.post('/:id/notify/test', auth.requireAdmin, async (req, res) => res.json(await wa.notifier.test(load(req))));

  // Telegram 私人号换号主：清掉绑定，生成新的绑定链接（只有 admin；绑定链接谁点了谁就是号主）
  router.post('/:id/telegram/rebind', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    wa.telegramRebind(acc);
    ctx.log.info(`[accounts] ${req.user.email} 清掉了号 ${acc.id} 绑定的 Telegram 号主`);
    res.json(await view(accounts.get(acc.id)));
  });

  // Telegram 扫码登录（只有 admin）：开始登录 → 取二维码（SVG，30 秒左右换一次）→ 开了两步验证的输密码；退出登录。
  // 二维码就是登录凭证，只从这里给，不进状态和日志；两步验证密码只拿来登录，不存
  router.post('/:id/telegram/login', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    await wa.tgUserLogin(acc);
    ctx.log.info(`[accounts] ${req.user.email} 开始给号 ${acc.id} 扫码登录 Telegram`);
    res.json(await view(accounts.get(acc.id)));
  });
  router.get('/:id/telegram/qr', auth.requireAdmin, (req, res) => {
    const svg = wa.tgUserQr(load(req));
    res.set('cache-control', 'no-store').type('image/svg+xml').send(svg);
  });
  router.post('/:id/telegram/password', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    if (!isPlainObject(req.body)) throw badRequest('请求体必须是对象');
    await wa.tgUserPassword(acc, req.body.password);
    res.json(await view(accounts.get(acc.id)));
  });
  router.post('/:id/telegram/logout', auth.requireAdmin, async (req, res) => {
    const acc = load(req);
    if (acc.channel !== 'tguser') throw badRequest('这个号不是 Telegram 扫码登录', 'wrong_channel');
    await wa.tgUserLogout(acc);
    ctx.log.info(`[accounts] ${req.user.email} 让号 ${acc.id} 退出了 Telegram 登录`);
    res.json(await view(accounts.get(acc.id)));
  });

  // 从 my.telegram.org 自动取 api_id / api_hash（只有 admin）：先让它往这个手机号的 Telegram 里发验证码，再交验证码，
  // 取到就存进这个号（已有应用就用已有的，没有就新建一个）。手机号和验证码不存、不进日志
  const loadTgUser = (req) => {
    const acc = load(req);
    if (acc.channel !== 'tguser') throw badRequest('这个号不是 Telegram 扫码登录', 'wrong_channel');
    if (!isPlainObject(req.body)) throw badRequest('请求体必须是对象');
    return acc;
  };
  router.post('/:id/telegram/api/code', auth.requireAdmin, async (req, res) => {
    const acc = loadTgUser(req);
    await myTelegram.sendCode(acc.id, req.body.phone);
    ctx.log.info(`[accounts] ${req.user.email} 为号 ${acc.id} 向 my.telegram.org 要了验证码`);
    res.json({ ok: true });
  });
  router.post('/:id/telegram/api/apply', auth.requireAdmin, async (req, res) => {
    const acc = loadTgUser(req);
    const got = await myTelegram.apply(acc.id, req.body.code);
    // 取的这几秒里号可能被删了
    const cur = accounts.get(acc.id);
    if (!cur) throw notFound('号不存在');
    const next = applyAccountPatch(
      cur,
      { telegram: { apiId: got.apiId, apiHash: got.apiHash } },
      { isAdmin: true, emailReady: emailConfigured(ctx.getSettings()), globalProxyReady: ctx.globalProxy.enabled() },
    );
    const saved = accounts.save(next);
    await wa.syncTelegram();
    ctx.log.info(
      `[accounts] ${req.user.email} 为号 ${acc.id} 从 my.telegram.org 取得了 api_id 和 api_hash（${got.created ? '新建了应用' : '用的已有应用'}）`,
    );
    res.json({ created: got.created, account: await view(saved) });
  });

  return router;
}
