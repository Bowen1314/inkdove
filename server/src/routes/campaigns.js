// F11 主动外联接口。admin 能看和操作所有任务；agent 只能看和操作自己建的任务，新建时只能选分配给自己的号（F8），
// 越权返回 403，列表自动过滤。
import express from 'express';
import multer from 'multer';
import { forbidden } from '../auth.js';
import { MAX_FILE_BYTES } from '../outreach/store.js';
import { badRequest, HttpError, notFound } from '../util.js';

/** @param {any} ctx */
export function campaignsRouter(ctx) {
  const router = express.Router();
  const outreach = ctx.outreach;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20 },
    defParamCharset: 'utf8',
  });

  /** 取任务并判断权限：不存在 404；agent 看别人建的 403 */
  function loadCampaign(req) {
    const c = outreach.getRow(String(req.params.id));
    if (!c) throw notFound('外联任务不存在');
    if (req.user.role !== 'admin' && c.created_by_id !== req.user.id) throw forbidden();
    return c;
  }

  router.get('/', (req, res) => res.json(outreach.list(req.user)));

  // 新建：multipart，字段 file、name、mode、accountIds（JSON 数组）、message、metaTemplateName、metaTemplateLanguage、defaultCountry
  router.post(
    '/',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'file_too_large', '号码文件不能超过 1MB'));
          if (err.code === 'LIMIT_FILE_COUNT') return next(badRequest('一次只能上传 1 个文件', 'upload_error'));
          if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('上传字段名应为 file，且只能有 1 个文件', 'upload_error'));
          return next(badRequest(`上传失败：${err.message}`, 'upload_error'));
        }
        next(err);
      });
    },
    (req, res) => {
      res.json(outreach.create(req.user, req.file, req.body || {}));
    },
  );

  router.get('/:id', (req, res) => res.json(outreach.view(loadCampaign(req))));

  router.get('/:id/recipients', (req, res) => {
    const c = loadCampaign(req);
    const q = req.query;
    res.json(
      outreach.recipients(c.id, {
        status: q.status ? String(q.status) : '',
        page: q.page === undefined || q.page === '' ? 1 : Number(q.page),
        pageSize: q.pageSize === undefined || q.pageSize === '' ? 50 : Number(q.pageSize),
      }),
    );
  });

  for (const action of ['start', 'pause', 'resume', 'cancel']) {
    router.post(`/:id/${action}`, (req, res) => {
      const c = loadCampaign(req);
      res.json(outreach[action](c.id));
    });
  }

  router.delete('/:id', (req, res) => {
    const c = loadCampaign(req);
    outreach.remove(c.id);
    res.json({ ok: true });
  });

  return router;
}
