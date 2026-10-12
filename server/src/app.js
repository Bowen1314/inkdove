import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAccountStore, migrateLegacy } from './accounts.js';
import { canAccessAccount, createAuth } from './auth.js';
import { openDb } from './db.js';
import { createMailer } from './email.js';
import { createMockAi } from './ai/mock.js';
import { createRealAi } from './ai/real.js';
import { createDistillRunner } from './distill/runner.js';
import { verifyFileToken } from './files/signed.js';
import { createFileStore } from './files/store.js';
import { createKbStore } from './kb/store.js';
import { createLeadStore, LEADS_SCAN_INTERVAL_MS } from './leads/store.js';
import { createRecords, withLlmCallLog } from './records.js';
import { accountsRouter } from './routes/accounts.js';
import { distillRouter } from './routes/distill.js';
import { filesRouter, sendStoredFile } from './routes/files.js';
import { kbRouter } from './routes/kb.js';
import { leadsRouter } from './routes/leads.js';
import { sendBrandLogo, settingsRouter } from './routes/settings.js';
import { sourcesRouter } from './routes/sources.js';
import { usersRouter } from './routes/users.js';
import { waRouter } from './routes/wa.js';
import { webhooksRouter } from './routes/webhooks.js';
import { llmConfigured, loadSettings, publicBranding, saveSettings } from './settings.js';
import { HttpError } from './util.js';
import { PROXY_TEST_URL } from './wa/proxy-test.js';
import { createRelayManager } from './wa/relay.js';
import { createWaService } from './wa/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const DEFAULT_WEB_DIST = path.resolve(here, '..', '..', 'web', 'dist');

/**
 * 创建应用。所有状态都挂在 ctx 上，便于测试里起多个实例。
 * @param {import('./config.js').Config} config
 * @param {{
 *   log?: {info: Function, warn: Function, error: Function},
 *   mockDelayMs?: number,
 *   aiOverrides?: Record<string, Function>,
 *   realAiOptions?: object,
 *   createMailTransport?: Function,
 *   resendRetryDelayMs?: number,
 *   notifyRetryDelayMs?: number,
 *   humanize?: {preMs?: Function, typingMs?: Function, betweenMs?: Function, fileGapMs?: Function},
 *   onDecision?: (row:any) => void,
 *   onDeclined?: (p:{accountId:string, conversationId:string, ts:string}) => void,
 *   wahaInlineMaxBytes?: number,
 *   wahaPairWaitMs?: number,
 *   wahaPollMs?: number,
 *   historyImportDelayMs?: number,
 *   leadsScanIntervalMs?: number,
 *   relayBindHost?: string,
 *   canary?: string,
 *   proxyTestUrl?: string,
 *   webDist?: string,
 * }} [options]
 */
export function createApp(config, options = {}) {
  const log = options.log || console;
  const db = openDb(config.dataDir);
  const accounts = createAccountStore(db, config);
  // 第一期的单通道设置 → 号「默认号」（只在还没有任何号时跑一次）
  migrateLegacy(db, accounts, log, config);
  let settings = loadSettings(db, config);

  const ctx = {
    config,
    db,
    log,
    // 金丝雀串：每次进程启动随机生成，埋进 system prompt，用来发现提示词泄露
    canary: options.canary || `INKDOVE-${crypto.randomBytes(6).toString('hex')}`,
    proxyTestUrl: options.proxyTestUrl || PROXY_TEST_URL,
    getSettings: () => settings,
    setSettings(next) {
      saveSettings(db, next);
      settings = next;
    },
    updateSettings(fn) {
      const next = structuredClone(settings);
      fn(next);
      ctx.setSettings(next);
      return next;
    },
    kb: createKbStore(db),
    accounts,
    // F12：处理记录、模型调用、转人工记录
    records: createRecords(db, log),
    mailer: null,
    // F13：中继只在 compose 内网监听（容器里绑 0.0.0.0，不映射到宿主机端口）
    relays: createRelayManager({ bindHost: options.relayBindHost || '0.0.0.0', log }),
    ai: null,
    distill: null,
    wa: null,
    files: null,
    leads: null,
  };
  ctx.mailer = createMailer({
    getSettings: ctx.getSettings,
    resendUrl: config.resendApiUrl,
    createMailTransport: options.createMailTransport,
    resendRetryDelayMs: options.resendRetryDelayMs,
  });
  const baseAi = config.llmMock ? createMockAi({ delayMs: options.mockDelayMs }) : createRealAi(ctx.getSettings, options.realAiOptions);
  // F12：每次模型调用写一行 llm_calls。包在测试钩子外面，钩子替换的方法也照样记
  ctx.ai = withLlmCallLog({ ...baseAi, ...(options.aiOverrides || {}) }, { mock: config.llmMock, record: (row) => ctx.records.llmCall(row) });
  ctx.distill = createDistillRunner(ctx);
  ctx.files = createFileStore(ctx);
  ctx.files.resumePending();
  ctx.wa = createWaService(ctx, {
    humanize: options.humanize,
    notifyRetryDelayMs: options.notifyRetryDelayMs,
    onDecision: options.onDecision,
    onDeclined: options.onDeclined,
    wahaInlineMaxBytes: options.wahaInlineMaxBytes,
    wahaPairWaitMs: options.wahaPairWaitMs,
    wahaPollMs: options.wahaPollMs,
    historyImportDelayMs: options.historyImportDelayMs,
  });
  // F6：每 2 分钟扫一遍会话提取客户线索。leadsScanIntervalMs 为 0 时不启动定时器（测试里手动调 ctx.leads.scan()）
  ctx.leads = createLeadStore(ctx);
  ctx.leads.start(options.leadsScanIntervalMs ?? LEADS_SCAN_INTERVAL_MS);
  const auth = createAuth(ctx);
  auth.bootstrapAdmin();
  const ready = ctx.wa.init().catch((err) => log.error(`[relay] 拉起代理中继出错：${err?.stack || err}`));

  const app = express();
  app.disable('x-powered-by');
  // 部署在 nginx 后面时从 X-Forwarded-For 取客户端 IP（只信任本机和内网的代理）
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.use('/webhooks', webhooksRouter(ctx));

  // F15：给 WAHA 拉大文件用的内部下载地址，不要求登录，靠 token（HMAC 签名、10 分钟、只对这一个文件）。token 不写日志
  app.get('/internal/files/:id', (req, res) => {
    const id = String(req.params.id);
    if (!verifyFileToken(config.sessionSecret, id, req.query.token)) {
      throw new HttpError(403, 'bad_token', '下载链接无效或已过期');
    }
    const f = ctx.files.get(id);
    if (!f) throw new HttpError(404, 'not_found', '文件不存在');
    sendStoredFile(res, ctx, f);
  });

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  // health 不要求登录；登录了才带上有权限看的号
  api.get('/health', async (req, res) => {
    const who = auth.userFromReq(req);
    let list = [];
    if (who) {
      const accs = accounts.list().filter((a) => canAccessAccount(who.user, a.id));
      list = await Promise.all(
        accs.map(async (a) => {
          let state = 'failed';
          try {
            state = (await ctx.wa.getStatus(a, { maxAgeMs: 5000, timeoutMs: 2000 })).state;
          } catch {
            /* 记为 failed */
          }
          return { id: a.id, name: a.name, channel: a.channel, state };
        }),
      );
    }
    res.json({
      ok: true,
      version: VERSION,
      mock: config.llmMock,
      llmConfigured: llmConfigured(ctx.getSettings(), config),
      accounts: list,
    });
  });

  // 不需要登录的：登录、邀请和重置链接
  api.post('/auth/login', auth.login);
  api.get('/invites/:token', auth.getInvite);
  api.post('/invites/:token/accept', auth.acceptInvite);
  // 品牌（网站名称和 Logo）：登录页也要显示，所以不要求登录。只带名称和 Logo，别的设置一点都不带出去
  api.get('/branding', (_req, res) => res.json(publicBranding(ctx.getSettings())));
  api.get('/branding/logo', (_req, res, next) => sendBrandLogo(res, next, ctx));

  api.use(auth.requireAuth);
  api.post('/auth/logout', auth.logout);
  api.get('/auth/me', (req, res) => res.json({ user: req.user }));
  api.post('/auth/password', auth.changePassword);
  api.use('/users', usersRouter(ctx, auth));
  api.use('/accounts', accountsRouter(ctx, auth));
  api.use('/settings', auth.requireAdmin, settingsRouter(ctx));
  api.use('/sources', auth.requireAdmin, sourcesRouter(ctx));
  api.use('/distill', auth.requireAdmin, distillRouter(ctx));
  api.use('/kb', kbRouter(ctx, auth));
  api.use('/files', filesRouter(ctx, auth));
  api.use('/wa', waRouter(ctx));
  api.use('/leads', leadsRouter(ctx));
  api.use(() => {
    throw new HttpError(404, 'not_found', '接口不存在');
  });
  app.use('/api', api);

  // 生产环境托管 web/dist，SPA 回退到 index.html
  const webDist = options.webDist || DEFAULT_WEB_DIST;
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (
        (req.method !== 'GET' && req.method !== 'HEAD') ||
        req.path.startsWith('/api/') ||
        req.path.startsWith('/webhooks/') ||
        req.path.startsWith('/internal/')
      ) {
        return next();
      }
      res.set('cache-control', 'no-cache').sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(() => {
    throw new HttpError(404, 'not_found', '页面不存在');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法的 JSON', code: 'bad_json' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: '请求体太大', code: 'payload_too_large' });
    log.error(`[inkdove] 未处理的错误：${err?.stack || err}`);
    res.status(500).json({ error: '服务器内部错误', code: 'internal' });
  });

  return {
    app,
    ctx,
    auth,
    /** 代理中继都拉起来之后 resolve（测试用） */
    ready,
    async close() {
      ctx.leads.stop();
      ctx.files.close();
      await ctx.wa.close();
      ctx.distill.abortAll();
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
    },
  };
}
