// F15 产品资料库接口。浏览、下载两种角色都能用；上传、修改、删除、重新生成描述只有 admin。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { normalizeTags } from '../kb/store.js';
import { llmConfigured } from '../settings.js';
import { badRequest, HttpError, isPlainObject, notFound } from '../util.js';
import { detectSendable, isImageMime, MAX_SENDABLE_BYTES, SUPPORTED_FILE_HINT } from '../files/store.js';

const STATUSES = ['active', 'disabled'];

/** 下载：Content-Type 用文件自己的 mime，文件名按 RFC 6266 / 5987 带 UTF-8 */
export function sendStoredFile(res, ctx, file) {
  const p = ctx.files.filePath(file.id);
  if (!fs.existsSync(p)) throw notFound('文件内容不存在');
  res.attachment(file.filename);
  res.type(file.mime);
  res.set('cache-control', 'private, no-store');
  res.sendFile(p, { dotfiles: 'allow' });
}

/**
 * @param {any} ctx
 * @param {{requireAdmin: Function}} auth
 */
export function filesRouter(ctx, auth) {
  const router = express.Router();
  const admin = auth.requireAdmin;
  const tmpDir = path.join(ctx.config.dataDir, 'files', 'tmp');
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdir(tmpDir, { recursive: true }, (err) => cb(err, tmpDir));
      },
      filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: MAX_SENDABLE_BYTES, files: 20 },
    defParamCharset: 'utf8',
  });

  const load = (id) => {
    const f = ctx.files.get(String(id));
    if (!f) throw notFound('文件不存在');
    return f;
  };

  router.get('/', (req, res) => {
    const status = req.query.status ? String(req.query.status) : '';
    if (status && !STATUSES.includes(status)) throw badRequest('status 须为 active 或 disabled');
    res.json(ctx.files.list({ q: req.query.q ? String(req.query.q) : '', status }));
  });

  router.post(
    '/',
    admin,
    (req, res, next) => {
      upload.array('files')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'file_too_large', '单个文件不能超过 50MB'));
          if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('上传字段名须为 files', 'upload_error'));
          if (err.code === 'LIMIT_FILE_COUNT') return next(badRequest('每次最多上传 20 个文件', 'upload_error'));
          return next(badRequest(`上传失败：${err.message}`, 'upload_error'));
        }
        next(err);
      });
    },
    async (req, res) => {
      const files = /** @type {Express.Multer.File[]} */ (req.files || []);
      const cleanup = () => {
        for (const f of files) fs.rm(f.path, { force: true }, () => {});
      };
      if (!files.length) throw badRequest('未收到文件（字段名 files）');
      const raw = String(req.body?.addToKb ?? 'true').trim().toLowerCase();
      if (!['true', 'false', '1', '0', 'on', 'off', ''].includes(raw)) {
        cleanup();
        throw badRequest('addToKb 须为 true 或 false');
      }
      const addToKb = !['false', '0', 'off'].includes(raw);
      const detected = files.map((f) => detectSendable(f.originalname, f.mimetype));
      const badIdx = detected.findIndex((d) => !d);
      if (badIdx >= 0) {
        cleanup();
        throw badRequest(`不支持的文件类型：${path.basename(files[badIdx].originalname || '')}（${SUPPORTED_FILE_HINT}）`, 'unsupported_file_type');
      }
      const out = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          out.push(
            await ctx.files.add(
              { tmpPath: f.path, originalname: f.originalname, size: f.size, kind: detected[i].kind, mime: detected[i].mime },
              { addToKb },
            ),
          );
        }
      } finally {
        cleanup();
      }
      res.json(out);
    },
  );

  router.get('/:id', (req, res) => res.json(load(req.params.id)));

  router.put('/:id', admin, (req, res) => {
    load(req.params.id);
    const b = req.body;
    if (!isPlainObject(b)) throw badRequest('请求体必须是对象');
    const patch = {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim()) throw badRequest('name 不能为空');
      patch.name = b.name.trim().slice(0, 200);
    }
    if (b.description !== undefined) {
      if (typeof b.description !== 'string') throw badRequest('description 必须是字符串');
      patch.description = b.description.trim().slice(0, 2000);
    }
    if (b.tags !== undefined) patch.tags = normalizeTags(b.tags);
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw badRequest('status 须为 active 或 disabled');
      patch.status = b.status;
    }
    res.json(ctx.files.update(req.params.id, patch));
  });

  router.delete('/:id', admin, (req, res) => {
    if (!ctx.files.remove(String(req.params.id))) throw notFound('文件不存在');
    res.json({ ok: true });
  });

  router.get('/:id/download', (req, res) => sendStoredFile(res, ctx, load(req.params.id)));

  router.post('/:id/describe', admin, (req, res) => {
    const f = load(req.params.id);
    const s = ctx.getSettings();
    if (!llmConfigured(s, ctx.config)) throw badRequest('未配置模型，请前往设置页配置', 'llm_not_configured');
    if (isImageMime(f.mime) && !s.media.image) throw badRequest('需先在设置中开启图片识别，才可自动生成图片描述', 'image_disabled');
    res.json(ctx.files.redescribe(f.id));
  });

  return router;
}
