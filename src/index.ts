import { App, getLogBuffer, onLogEntry, type LogEntry } from '@aalis/core';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOG_FILE = 'data/latest.log';

function formatEntry(entry: LogEntry): string {
  const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
  return `${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
}

/** 文件日志写入队列 —— 由 setupFileLogger 维护，shutdown 前需 await 以保证最后几条日志落盘 */
let fileLoggerQueue: Promise<void> = Promise.resolve();

async function setupFileLogger(): Promise<void> {
  // 文件 sink 完全在 core 外实现：
  //   1) 启动时清空 latest.log；
  //   2) 先把 core 的环形缓冲（已发生的日志）一次性写入，避免漏掉本函数被调用前的条目；
  //   3) 再订阅 onLogEntry 持续追加新日志。
  await mkdir(dirname(LOG_FILE), { recursive: true });
  const initial = getLogBuffer().map(formatEntry).join('');
  await writeFile(LOG_FILE, initial);
  onLogEntry((entry) => {
    fileLoggerQueue = fileLoggerQueue.then(() => appendFile(LOG_FILE, formatEntry(entry))).catch(() => {});
  });
}

/** 等待所有挂起的文件日志写入落盘 */
async function flushFileLogger(): Promise<void> {
  await fileLoggerQueue.catch(() => {});
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
    // app.stop() 期间和之后插件可能仍在 logger.info('已停止') 等，
    // 给微任务一个 tick 把它们入队，再等队列清空，确保 latest.log 含完整关闭日志
    await new Promise<void>(r => setImmediate(r));
    await flushFileLogger();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
