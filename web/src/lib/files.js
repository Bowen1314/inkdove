import { File as FileIcon, FileImage, FileSpreadsheet, FileText, Presentation } from 'lucide-react';
import { api } from '../api/client.js';

// 产品资料库（F15）前端共用的小工具：格式、图标、上传前检查、错误提示、按 id 查文件的缓存。

/** 单个文件上限，和后端 MAX_SENDABLE_BYTES 一致 */
export const MAX_SENDABLE_BYTES = 50 * 1024 * 1024;
/** 后端 multer 限制一次最多 20 个文件，超过的分批传 */
export const UPLOAD_BATCH = 20;
const EXTS = ['pdf', 'xlsx', 'xls', 'csv', 'docx', 'pptx', 'txt', 'jpg', 'jpeg', 'png', 'webp'];
export const SENDABLE_ACCEPT = EXTS.map((e) => `.${e}`).join(',');
export const SENDABLE_FORMATS_TEXT = '支持 PDF、Excel、CSV、Word、PPT、TXT、JPG、PNG、WebP，单个不超过 50MB';

const MIME_LABEL = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-excel': 'XLS',
  'text/csv': 'CSV',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'text/plain': 'TXT',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
};

export const extOf = (name) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

/** 上传前检查格式：先看扩展名，没有扩展名时看浏览器给的 mime（和后端 detectSendable 一样） */
export function isSendableFile(f) {
  const ext = extOf(f?.name);
  if (ext) return EXTS.includes(ext);
  return !!MIME_LABEL[String(f?.type || '').split(';')[0].trim().toLowerCase()];
}

/** 格式：PDF、XLSX、JPG…（f 可以是 SendableFile 或消息里的 attachment） */
export function fileTypeLabel(f) {
  const ext = extOf(f?.filename);
  if (ext) return ext === 'jpeg' ? 'JPG' : ext.toUpperCase();
  return MIME_LABEL[f?.mime] || '文件';
}

export const isImageMime = (mime) => /^image\//.test(String(mime || ''));

/** 文件类型图标（表格、会话里的文件卡片、选择弹窗共用） */
export function fileIcon(f) {
  const mime = String(f?.mime || '');
  const ext = extOf(f?.filename);
  if (isImageMime(mime) || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return FileImage;
  if (/spreadsheet|ms-excel|csv/.test(mime) || ['xlsx', 'xls', 'csv'].includes(ext)) return FileSpreadsheet;
  if (/presentation/.test(mime) || ext === 'pptx') return Presentation;
  if (/pdf|word|text\//.test(mime) || ['pdf', 'docx', 'txt'].includes(ext)) return FileText;
  return FileIcon;
}

/**
 * 接口错误码 → 中文提示。后端的 error 字段本来就是中文，这里只在它缺失时兜底
 * （比如反向代理直接回了 413，没有 JSON）。
 */
const ERROR_TEXT = {
  unsupported_file_type: `文件格式不支持。${SENDABLE_FORMATS_TEXT}`,
  file_too_large: '单个文件不能超过 50MB',
  http_413: '单个文件不能超过 50MB',
  upload_error: '上传失败，请重试',
  llm_not_configured: '还没有配置模型，请先到设置页填写',
  image_disabled: '图片要先在设置里开启图片识别才能自动生成描述',
  file_disabled: '这个文件已停用，启用后才能发送',
  account_deleted: '这个会话所属的号已删除，不能再发送',
};

export function fileErrorText(err) {
  if (!err) return '操作失败，请重试';
  const fromServer = err.data && typeof err.data.error === 'string' ? err.data.error : '';
  return fromServer || ERROR_TEXT[err.code] || err.message || '操作失败，请重试';
}

// 没有"按 id 批量取"的接口：草稿里的文件要显示名字时，拉一次全量列表并短暂缓存（同 entryCache）
let cache = null;
let cachedAt = 0;
let inflight = null;
const TTL = 30 * 1000;

export function clearFileCache() {
  cache = null;
  cachedAt = 0;
}

/** → Map<id, SendableFile> */
export async function getFileMap({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = api
    .listFiles({}, { silent: true })
    .then((list) => {
      cache = new Map((list || []).map((f) => [f.id, f]));
      cachedAt = Date.now();
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
