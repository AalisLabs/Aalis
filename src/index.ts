import { App } from '@aalis/core';
import { type ConsoleSinkHandle, installConsoleSink } from './runtime/console-sink.js';
import { appendCrashLog, type FileLoggerHandle, setupFileLogger } from './runtime/file-logger.js';
import { installTerminalStateRestorer } from './runtime/terminal.js';

installTerminalStateRestorer();
const consoleSink: ConsoleSinkHandle = installConsoleSink();

let fileLogger: FileLoggerHandle | undefined;
let handlingFatal = false;

async function exitWithFatalLog(label: string, err: unknown): Promise<never> {
  if (handlingFatal) process.exit(1);
  handlingFatal = true;

  console.error(`${label}:`, err);
  try {
    await fileLogger?.flush();
    await appendCrashLog(label, err);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

process.on('uncaughtException', err => {
  void exitWithFatalLog('未捕获异常', err);
});

process.on('unhandledRejection', reason => {
  void exitWithFatalLog('未处理 Promise 拒绝', reason);
});

async function main() {
  const activeFileLogger = await setupFileLogger();
  fileLogger = activeFileLogger;

  const app = new App({
    // 应用层声明：核心功能依赖以下服务至少各有一个提供者运行
    // （core 自身不假设这些服务存在，必须由应用入口显式声明）
    requiredServices: [],
  });

  // 把运行时 console sink 暴露为服务，供 CLI 等终端 UI 在接管 stdout 时暂停日志写入
  app.ctx.provide('console-sink', consoleSink, { capabilities: ['pause-resume'] });

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
    await activeFileLogger.flush();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => void exitWithFatalLog('启动失败', err));
