// 在单独的线程里解析客户发来的文件（doc-extract.js 起的）：解析库处理的是不可信的文件，放在 worker 里，有内存上限，超时就整个杀掉，
// 卡死或吃光内存都不影响主线程。只回 {ok, text} 或 {ok:false, noText, error}
import { parentPort, workerData } from 'node:worker_threads';
import { parseBuffer } from '../sources/parse.js';

try {
  const text = await parseBuffer(Buffer.from(workerData.buf), workerData.kind);
  parentPort.postMessage({ ok: true, text });
} catch (err) {
  const error = String(err?.message || err);
  parentPort.postMessage({ ok: false, noText: /没有提取到文字/.test(error), error });
}
