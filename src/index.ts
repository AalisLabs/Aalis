import { App, getLogBuffer, onLogEntry, type LogEntry } from '@aalis/core';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOG_FILE = 'data/latest.log';

function formatEntry(entry: LogEntry): string {
  const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
  return `${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
}

async function setupFileLogger(): Promise<void> {
  // 文件 sink 完全在 core 外实现：
  //   1) 启动时清空 latest.log；
  //   2) 先把 core 的环形缓冲（已发生的日志）一次性写入，避免漏掉本函数被调用前的条目；
  //   3) 再订阅 onLogEntry 持续追加新日志。
  await mkdir(dirname(LOG_FILE), { recursive: true });
  const initial = getLogBuffer().map(formatEntry).join('');
  await writeFile(LOG_FILE, initial);
  let queue = Promise.resolve();
  onLogEntry((entry) => {
    queue = queue.then(() => appendFile(LOG_FILE, formatEntry(entry))).catch(() => {});
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
