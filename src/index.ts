import { App, onLogEntry } from '@aalis/core';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOG_FILE = 'data/latest.log';

async function setupFileLogger(): Promise<void> {
  // 每次启动覆盖 latest.log；订阅 onLogEntry 异步追加，core 不感知文件 sink。
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await writeFile(LOG_FILE, '');
  let queue = Promise.resolve();
  onLogEntry((entry) => {
    const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
    const line = `${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
    queue = queue.then(() => appendFile(LOG_FILE, line)).catch(() => {});
  });
}

async function main() {
  await setupFileLogger();

  const app = new App();

  // 自动扫描 packages/ 并加载所有插件
  await app.autoLoadPlugins();

  // 启动
  await app.start();

  // 优雅退出（防止重复调用）
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
