// 全局设置（仅 admin）：LLM、全局回复、语音图片、线索开关、发信方式（F10）、品牌（网站名称和 Logo）、模型单价（F12）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { listModels, MOCK_MODELS, normalizeModels, redactKey } from '../ai/models.js';
import {
  applySettingsPatch,
  checkLlmBaseUrl,
  checkLlmFormat,
  emailConfigured,
  llmConfigured,
  logoMeta,
  publicSettings,
  str,
} from '../settings.js';
import { badRequest, HttpError, isPlainObject, notFound } from '../util.js';

const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TYPE_MESSAGE = '只支持 PNG、JPG、WebP 或 SVG 图片';

/** logo 文件所在目录 */
export const brandingDir = (config) => path.join(config.dataDir, 'branding');

/**
 * 按文件内容判断 logo 类型，不信扩展名和 mimetype → {mime, ext} 或 null。
 * SVG：严格 UTF-8，去掉 BOM、XML 声明、注释和空白后以 <svg 开头。
 * @param {Buffer} buf
 */
export function sniffLogo(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  let s = text.replace(/^﻿/, '');
  for (;;) {
    const next = s
      .replace(/^\s+/, '')
      .replace(/^<\?xml[\s\S]*?\?>/, '')
      .replace(/^<!--[\s\S]*?-->/, '');
    if (next === s) break;
    s = next;
  }
  return /^<svg[\s>/]/.test(s) ? { mime: 'image/svg+xml', ext: 'svg' } : null;
}

/**
 * 公开接口 GET /api/branding/logo：按存储的 mime 发文件。
 * 带 nosniff，以及禁止脚本的 CSP（有人直接打开 SVG 时也不会执行里面的脚本）；地址里的 v 用来换版本，缓存一天。
 */
export function sendBrandLogo(res, next, ctx) {
  const meta = logoMeta(ctx.getSettings());
  if (!meta) throw notFound('还没有设置 Logo');
  const p = path.join(brandingDir(ctx.config), meta.filename);
  if (!fs.existsSync(p)) throw notFound('Logo 文件不存在');
  res.type(meta.mime);
  res.set({
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'public, max-age=86400',
  });
  res.sendFile(p, { dotfiles: 'allow' }, (err) => {
    if (err) next(err.code === 'ENOENT' ? notFound('Logo 文件不存在') : err);
  });
}

/** 获取模型列表时取字段：没传、null 或空串返回 undefined（用已保存的值） */
function optionalStr(v, field, max) {
  if (v === undefined || v === null) return undefined;
  const s = str(v, field, max).trim();
  return s || undefined;
}

/** @param {any} ctx */
export function settingsRouter(ctx) {
  const router = express.Router();
  const dir = brandingDir(ctx.config);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
    defParamCharset: 'utf8',
  });

  const view = () => publicSettings(ctx.getSettings(), ctx.config);

  /** 换上新的 logo 元数据（null 为移除），删掉旧文件 */
  const replaceLogo = (meta) => {
    let old = null;
    ctx.updateSettings((s) => {
      old = s.branding.logo;
      s.branding.logo = meta;
    });
    if (old?.filename && old.filename !== meta?.filename) {
      try {
        fs.rmSync(path.join(dir, path.basename(old.filename)), { force: true });
      } catch (err) {
        ctx.log.warn(`[branding] 删除旧 Logo 失败：${err?.message || err}`);
      }
    }
  };

  router.get('/', (_req, res) => res.json(view()));

  router.put('/', (req, res) => {
    const next = applySettingsPatch(ctx.getSettings(), req.body);
    ctx.setSettings(next);
    res.json(view());
  });

  router.post('/llm/test', async (_req, res) => {
    const s = ctx.getSettings();
    if (!llmConfigured(s, ctx.config)) {
      res.json({ ok: false, error: '还没有填写 baseUrl 和回复模型' });
      return;
    }
    const started = Date.now();
    try {
      const r = await ctx.ai.test();
      res.json({ ok: true, model: r.model, latencyMs: Date.now() - started });
    } catch (err) {
      res.json({ ok: false, error: String(err?.message || err) });
    }
  });

  // 用设置页表单里当前（可能还没保存）的值拉模型列表；没传或空着的字段用已保存的值，密钥通常不传。
  // 参数不合法回 400；其余成功失败都回 200
  router.post('/llm/models', async (req, res) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const saved = ctx.getSettings().llm;
    const formatIn = optionalStr(b.format, 'llm.format', 50);
    const baseUrlIn = optionalStr(b.baseUrl, 'llm.baseUrl', 500);
    const apiKeyIn = optionalStr(b.apiKey, 'llm.apiKey', 1000);
    const format = checkLlmFormat(formatIn ?? saved.format);
    const baseUrl = baseUrlIn !== undefined ? checkLlmBaseUrl(baseUrlIn) : saved.baseUrl;
    const apiKey = apiKeyIn ?? saved.apiKey ?? '';

    if (ctx.config.llmMock) {
      res.json({ ok: true, models: normalizeModels(MOCK_MODELS) });
      return;
    }
    if (!baseUrl) {
      res.json({ ok: false, error: '还没有填写接口地址' });
      return;
    }
    try {
      res.json({ ok: true, models: await listModels({ format, baseUrl, apiKey }) });
    } catch (err) {
      // listModels 已经抹过密钥，这里再兜一次底
      res.json({ ok: false, error: redactKey(err?.message || err, apiKey) });
    }
  });

  // 上传 Logo：multipart，字段 file，最多 512 KB，按内容判断类型。立即生效，返回完整设置
  router.post(
    '/branding/logo',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'file_too_large', '图片不能超过 512 KB'));
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
      const kind = sniffLogo(f.buffer);
      if (!kind) throw badRequest(LOGO_TYPE_MESSAGE, 'unsupported_image');

      const prev = logoMeta(ctx.getSettings());
      const meta = {
        filename: `logo-${crypto.randomUUID()}.${kind.ext}`,
        mime: kind.mime,
        // 保证比上一个大，地址里的 v 一定会变
        updatedAt: Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1),
      };
      // 先写临时文件再改名，读的人不会看到写了一半的文件
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, meta.filename);
      const tmp = path.join(dir, `.${meta.filename}.part`);
      try {
        fs.writeFileSync(tmp, f.buffer);
        fs.renameSync(tmp, dest);
        replaceLogo(meta);
      } catch (err) {
        fs.rm(tmp, { force: true }, () => {});
        fs.rm(dest, { force: true }, () => {});
        throw err;
      }
      res.json(view());
    },
  );

  // 移除 Logo：删文件、清元数据。本来就没有也返回 200
  router.delete('/branding/logo', (_req, res) => {
    replaceLogo(null);
    res.json(view());
  });

  // F10：发一封测试邮件。成功失败都返回 200
  router.post('/email/test', async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(to) || to.length > 200) {
      res.json({ ok: false, error: '收件地址格式不对' });
      return;
    }
    if (!emailConfigured(ctx.getSettings())) {
      res.json({ ok: false, error: '还没有配置发信方式' });
      return;
    }
    try {
      await ctx.mailer.sendEmail({
        to: [to],
        subject: '墨鸽 测试邮件',
        text: `这是一封测试邮件。收到说明发信方式配置正确，转人工通知会用同样的方式发出。\n后台：${ctx.config.publicBaseUrl}`,
      });
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: String(err?.message || err) });
    }
  });

  return router;
}
