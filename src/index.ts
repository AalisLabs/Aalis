import { App } from '@aalis/core';
import { type ConsoleSinkHandle, installConsoleSink } from './runtime/console-sink.js';
import { appendCrashLog, type FileLoggerHandle, setupFileLogger } from './runtime/file-logger.js';
import { createFsPluginLoader, createFsYamlConfigProvider, createProcessRespawnStrategy } from './runtime/providers.js';
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

  // 宿主层组装：从 YAML 加载配置、扫描 packages/ 加载插件、用 spawn 重启
  const { config, provider: configProvider, dataDir } = createFsYamlConfigProvider();

  const app = new App({
    config,
    configProvider,
    dataDir,
    pluginLoader: createFsPluginLoader(),
    restartStrategy: createProcessRespawnStrategy(),
    // 宿主层决定 dev/prod；core 不读 process.env
    devMode: process.env.NODE_ENV !== 'production',
    // 应用层声明：核心功能依赖以下服务至少各有一个提供者运行
    // （core 自身不假设这些服务存在，必须由应用入口显式声明）
    requiredServices: [],
  });

  // App 构造完成后再让 sink 监听终端归属事件——
  // 此前没有 ctx 可订阅，sink 一直处于"写 stdout"默认状态以打印早期启动日志。
  consoleSink.bindEvents(app.ctx);

  // 自动扫描 packages/ 并加载所有插件
  await app.autoLoadPlugins();

  // ── 子命令分发 ─────────────────────────────────────────
  // `aalis doctor` 走诊断流程：不 start gateway/adapters，直接调用
  // doctor 服务跑检查、打印报告，然后干净退出。
  const subcommand = process.argv[2];
  if (subcommand === 'doctor') {
    const doctor = app.ctx.getService<{ runChecks: () => Promise<unknown> }>('doctor');
    if (!doctor) {
      console.error('未找到 doctor 服务，请确认 @aalis/plugin-doctor 已启用。');
      await app.stop();
      await activeFileLogger.flush();
      process.exit(2);
    }
    const report = (await doctor.runChecks()) as {
      summary: { ok: number; warn: number; error: number };
      checks: Array<{ level: string; category: string; id: string; message: string; detail?: string }>;
    };
    for (const c of report.checks) {
      const tag = c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗';
      console.log(`[${tag}] ${c.category}/${c.id} — ${c.message}`);
      if (c.detail) console.log(`    ${c.detail}`);
    }
    console.log(`\n汇总: ok=${report.summary.ok} warn=${report.summary.warn} error=${report.summary.error}`);
    await app.stop();
    await new Promise<void>(r => setImmediate(r));
    await activeFileLogger.flush();
    process.exit(report.summary.error > 0 ? 1 : 0);
  }

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
