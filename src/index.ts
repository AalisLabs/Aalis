import { App } from '@aalis/core';
import { setupFileLogger } from './runtime/file-logger.js';
import { installTerminalStateRestorer } from './runtime/terminal.js';

installTerminalStateRestorer();

async function main() {
  const fileLogger = await setupFileLogger();

  const app = new App({
    // 应用层声明：核心功能依赖以下服务至少各有一个提供者运行
    // （core 自身不假设这些服务存在，必须由应用入口显式声明）
    requiredServices: [],
  });

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
    await fileLogger.flush();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
