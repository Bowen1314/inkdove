// 客户发来的媒体文件（图片、视频、语音、文件、贴纸）存在 <dataDir>/media/<fileKey>。fileKey 是随机的 32 位十六进制，
// 不用客户给的文件名；原始文件名只记在 messages.media 里显示用。下载时先写 media/tmp/<fileKey>.part，写完再改名，
// 边写边数字节，超过上限就中止并删掉半截文件（不把整个文件读进内存：容器只有 384MB）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TooLargeError } from './waha.js';

const KEY_RE = /^[a-f0-9]{32}$/;

/** @param {string} dataDir */
export function createMediaStore(dataDir) {
  const dir = path.join(dataDir, 'media');
  const tmpDir = path.join(dir, 'tmp');

  /** fileKey → 绝对路径；不合法的 key 返回 null（防路径穿越） */
  const pathOf = (key) => (typeof key === 'string' && KEY_RE.test(key) ? path.join(dir, key) : null);

  return {
    dir,
    pathOf,

    /** 启动时清掉上次没下完的半截文件 */
    cleanTmp() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },

    /**
     * 把下载的响应体写进文件。content-length 超过上限直接抛 TooLargeError（size 是声明的大小）；
     * 边写边数，超过上限时中止、删掉半截文件，抛 TooLargeError（size 为 null：实际多大不知道）。
     * res 是 node:http 的 IncomingMessage（media-download.js 的 httpGet 给的）。媒体下载不用 fetch：
     * npm undici 7 在对方传完就关连接时会让整个进程崩掉，原因和复现条件见 media-download.js 开头的注释。
     * @param {import('node:stream').Readable & {headers?: Record<string, string|string[]|undefined>}} res
     * @param {{maxBytes:number}} o
     * @returns {Promise<{key:string, size:number}>}
     */
    async saveResponse(res, { maxBytes }) {
      const raw = res.headers?.['content-length'];
      const declared = Number(raw);
      if (raw && Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        throw new TooLargeError(declared, maxBytes);
      }
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const key = crypto.randomBytes(16).toString('hex');
      const tmp = path.join(tmpDir, `${key}.part`);
      let size = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) {
            const err = new TooLargeError(size, maxBytes);
            err.size = null;
            return cb(err);
          }
          cb(null, chunk);
        },
      });
      try {
        // 出错时 pipeline 会销毁 res（放掉连接）
        await pipeline(res, counter, fs.createWriteStream(tmp, { flags: 'wx' }));
        await fs.promises.rename(tmp, path.join(dir, key));
      } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return { key, size };
    },

    /** 读整个文件（F4 识别用，调用方先看过大小） */
    read(key) {
      const p = pathOf(key);
      if (!p) return Promise.reject(new Error('文件 key 不合法'));
      return fs.promises.readFile(p);
    },

    /** 删一个文件（不存在不报错） */
    async remove(key) {
      const p = pathOf(key);
      if (p) await fs.promises.rm(p, { force: true }).catch(() => {});
    },
  };
}
