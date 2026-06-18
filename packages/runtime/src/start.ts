import { App, type PluginLoader } from '@aalis/core';
import { installBootstrapBuffer } from './bootstrap-buffer.js';
import { type ConsoleSinkHandle, installConsoleSink } from './console-sink.js';
import { appendCrashLog, DEFAULT_LOG_FILE, type FileLoggerHandle, setupFileLogger } from './file-logger.js';
import { createNodeModulesPluginLoader } from './node-modules-loader.js';
import { createFsYamlConfigProvider, createProcessRespawnStrategy } from './providers.js';
import { tryDispatchSubcommand } from './subcommand.js';
import { installTerminalStateRestorer } from './terminal.js';

// ============================================================
// startAalis —— Node 宿主一行启动（独立部署与 monorepo 自托管共用）
// ============================================================
//
// 独立部署（scaffold 生成的 index.mjs）：
//   import { startAalis } from '@aalis/runtime';
//   startAalis();   // 从 node_modules 加载插件 + 默认开控制台/文件日志
//
// monorepo 自托管（src/index.ts）传 monorepo 风味配置：
//   startAalis({ pluginLoader: createFsPluginLoader(), subcommands: true });
//
// 宿主的「I/O 那一层」（日志 sink / 终端复原 / 子命令分发）全在本包，core 只产生 LogEntry。

export interface StartAalisOptions {
  /** aalis.config.yaml 路径，默认 cwd 下的 aalis.config.yaml */
  configPath?: string;
  /** 项目根目录（含 package.json + node_modules），默认 process.cwd() */
  projectDir?: string;
  /** 插件加载器，默认 createNodeModulesPluginLoader(projectDir)；monorepo 传 createFsPluginLoader() 扫 packages/ */
  pluginLoader?: PluginLoader;
  /** 彩色 stdout 日志，默认 true（独立部署即有日志）；webui-only/嵌入式可传 false */
  consoleSink?: boolean;
  /** 文件日志：true→data/latest.log，string→自定义路径，false→关。默认 true（webui/cli 尾读此文件）。 */
  fileLog?: boolean | string;
  /** 退出时复原终端 raw-mode/alt-screen，默认 true */
  terminalRestore?: boolean;
  /** `aalis <name> [args]` 子命令分发：命中即执行并干净退出、不进守护。默认 false（monorepo 传 true）。 */
  subcommands?: boolean | string[];
  /** 覆盖 dev/prod 判定，默认按 NODE_ENV !== 'production' */
  devMode?: boolean;
}

/**
 * 启动一个 Aalis 实例：YAML 配置 + 插件加载 + 进程级重启 + 日志/终端/子命令宿主件。
 * 返回已启动的 App（便于测试或进一步操作）。
 *
 * 生命周期不变量：① `consoleHandle.bindEvents` 必须在 `new App` 之后（之前无 ctx）；
 * ② 子命令短路必须在 `app.start` 之前。
 */
export async function startAalis(opts: StartAalisOptions = {}): Promise<App> {
  const { consoleSink = true, fileLog = true, terminalRestore = true, subcommands = false } = opts;

  // ── 最早期：任何日志之前先装 bootstrap buffer，再装 terminal / console sink ──
  const bootstrap = installBootstrapBuffer();
  if (terminalRestore) installTerminalStateRestorer();
  // console sink 在 App 之前装：此时无 ctx，sink 处于「无条件写 stdout」状态以打印早期启动日志，
  // 待 App 起来再 bindEvents 接管 terminal:claimed/released。
  const consoleHandle: ConsoleSinkHandle | undefined = consoleSink ? installConsoleSink() : undefined;

  const fileLogTarget = fileLog === false ? undefined : typeof fileLog === 'string' ? fileLog : DEFAULT_LOG_FILE;

  // ── fatal handler（覆盖整个 async 启动过程）──
  let fileLogger: FileLoggerHandle | undefined;
  let handlingFatal = false;
  const exitWithFatalLog = async (label: string, err: unknown): Promise<never> => {
    if (handlingFatal) process.exit(1);
    handlingFatal = true;
    console.error(`${label}:`, err);
    try {
      await fileLogger?.flush();
      if (fileLogTarget) await appendCrashLog(label, err, fileLogTarget);
    } catch {
      /* ignore */
    }
    process.exit(1);
  };
  process.on('uncaughtException', err => void exitWithFatalLog('未捕获异常', err));
  process.on('unhandledRejection', reason => void exitWithFatalLog('未处理 Promise 拒绝', reason));

  // ── file logger（async）+ 释放 bootstrap buffer ──
  if (fileLogTarget) fileLogger = await setupFileLogger(fileLogTarget);
  // sink 全部装好；bootstrap buffer 完成使命，解除订阅并释放内存。
  bootstrap.dispose();

  // ── 组装 App：从 YAML 加载配置、按 loader 加载插件、用 spawn 重启 ──
  const { config, provider, dataDir } = createFsYamlConfigProvider(opts.configPath);
  const app = new App({
    config,
    configProvider: provider,
    dataDir,
    pluginLoader: opts.pluginLoader ?? createNodeModulesPluginLoader(opts.projectDir),
    restartStrategy: createProcessRespawnStrategy(),
    // 宿主层决定 dev/prod；core 不读 process.env
    devMode: opts.devMode ?? process.env.NODE_ENV !== 'production',
  });

  // 不变量①：App 构造完成后再让 sink 监听终端归属事件——此前没有 ctx 可订阅。
  consoleHandle?.bindEvents(app.ctx);

  await app.autoLoadPlugins();

  // ── 不变量②：子命令短路在 app.start 之前 ──
  // `aalis <name> [args...]` 等价于聊天里 `/<name> args...`：命中则执行返回串并干净退出，
  // 不命中则按正常守护进程模式继续启动。与具体命令解耦——各插件自行注册命令。
  if (subcommands) {
    const argv = Array.isArray(subcommands) ? subcommands : process.argv.slice(2);
    if (argv.length > 0) {
      const exitCode = await tryDispatchSubcommand(app, argv);
      if (exitCode !== null) {
        await app.stop();
        await new Promise<void>(r => setImmediate(r));
        await fileLogger?.flush();
        process.exit(exitCode);
      }
    }
  }

  // ── 启动 + 优雅退出（防止重复调用）──
  await app.start();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    // app.stop() 期间和之后插件可能仍在 logger.info('已停止') 等，给微任务一个 tick 把它们
    // 入队，再等队列清空，确保 latest.log 含完整关闭日志。
    await new Promise<void>(r => setImmediate(r));
    await fileLogger?.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}
