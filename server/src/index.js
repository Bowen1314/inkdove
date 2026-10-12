import { createApp } from './app.js';
import { loadConfig } from './config.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[inkdove] 启动失败：${err.message}`);
  process.exit(1);
}

const { app, close } = createApp(config);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[inkdove] 已启动，端口 ${config.port}${config.llmMock ? '（LLM mock 模式）' : ''}，数据目录 ${config.dataDir}`);
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[inkdove] 收到 ${signal}，正在退出`);
  const done = () => close().finally(() => process.exit(0));
  server.close(done);
  setTimeout(done, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
