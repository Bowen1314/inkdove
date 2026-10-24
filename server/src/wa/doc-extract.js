// 客户发来的文件（PDF、Word、Excel、PPT、文本）提取文字：给业务员看，也放进推荐回复和转人工草稿的上下文（wa/service.js）。
// 解析在 worker 线程里跑（doc-worker.js），有内存上限和超时，同时最多 MAX_CONCURRENT 个。不调模型
import { Worker } from 'node:worker_threads';
import { detectKind } from '../sources/parse.js';

/** 超过这个大小的文件不提取 */
export const DOC_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;
/** 存下的文字最多这么多字，后面的不要 */
export const DOC_TEXT_MAX_CHARS = 20_000;
/** 一个文件解析多久还没完就杀掉 */
export const DOC_EXTRACT_TIMEOUT_MS = 30_000;
/** 一个文件放进推荐回复、转人工草稿的最多这么多字 */
export const DOC_CONTEXT_CHARS = 3000;
/** 推荐回复、转人工草稿最多带最近几个文件 */
export const DOC_CONTEXT_FILES = 2;
const MAX_CONCURRENT = 2;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };

/** 提取失败时存下、显示给业务员的原因（固定的话，不带解析库的原文） */
export const EXTRACT_ERRORS = {
  timeout: '文件太复杂，提取超时',
  memory: '文件太复杂，提取时内存不够',
  failed: '文件解析失败（可能已损坏或加了密码）',
};

export class DocExtractError extends Error {
  /** @param {'no_text'|'failed'} status @param {keyof typeof EXTRACT_ERRORS|null} reason */
  constructor(status, reason = null) {
    super(reason ? EXTRACT_ERRORS[reason] : '没有提取到文字');
    this.status = status;
    this.reason = reason;
  }
}

/** 能提取文字的文件类型（同知识库的文件解析：pdf、docx、xlsx、xls、pptx、csv、txt、md、html），不能的返回 null */
export const docKindOf = (filename, mime) => detectKind(filename || '', mime || '');

/**
 * @param {{timeoutMs?: number, workerUrl?: URL}} [o] workerUrl 只给测试换成卡死的 worker
 */
export function createDocExtractor({ timeoutMs = DOC_EXTRACT_TIMEOUT_MS, workerUrl = new URL('./doc-worker.js', import.meta.url) } = {}) {
  let running = 0;
  const queue = [];
  const workers = new Set();
  let closed = false;
  const acquire = () => {
    if (running < MAX_CONCURRENT) {
      running++;
      return Promise.resolve();
    }
    return new Promise((r) => queue.push(r));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running--;
  };

  function runOnce(buf, kind) {
    return new Promise((resolve, reject) => {
      const w = new Worker(workerUrl, { workerData: { buf, kind }, resourceLimits: WORKER_LIMITS });
      workers.add(w);
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        workers.delete(w);
        w.terminate().catch(() => {});
        fn(v);
      };
      const timer = setTimeout(() => finish(reject, new DocExtractError('failed', 'timeout')), timeoutMs);
      w.once('message', (m) => {
        if (m?.ok) finish(resolve, String(m.text ?? ''));
        else finish(reject, m?.noText ? new DocExtractError('no_text') : new DocExtractError('failed', 'failed'));
      });
      w.once('error', (err) => finish(reject, new DocExtractError('failed', err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'failed')));
      // 没回消息就退出了（被关闭时杀掉之类）
      w.once('exit', () => finish(reject, new DocExtractError('failed', 'failed')));
    });
  }

  return {
    /** 解析一个文件，返回文字；失败抛 DocExtractError */
    async extract(buf, kind) {
      if (closed) throw new DocExtractError('failed', 'failed');
      await acquire();
      try {
        if (closed) throw new DocExtractError('failed', 'failed');
        return await runOnce(buf, kind);
      } finally {
        release();
      }
    },
    /** 关闭：正在跑的 worker 杀掉，排队的直接失败 */
    async close() {
      closed = true;
      await Promise.allSettled([...workers].map((w) => w.terminate()));
    },
  };
}
