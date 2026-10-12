import crypto from 'node:crypto';

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message 中文可读信息
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg, code = 'invalid_input') => new HttpError(400, code, msg);
export const notFound = (msg = '不存在') => new HttpError(404, 'not_found', msg);

/** @param {unknown} v */
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {string} s */
export function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** 常数时间比较两个字符串 */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    }
  });

/** 规范化文本：统一换行、去 BOM、压缩多余空行 */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把 Buffer 解码为文本：先严格 UTF-8，失败则按 GB18030（兼容 GBK）尝试 */
export function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

/** 简单的并发控制 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 截断字符串（按字符） */
export function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) : str;
}
