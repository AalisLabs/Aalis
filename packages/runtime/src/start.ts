import { createRequire } from 'node:module';
import { App, type PluginLoader } from '@aalis/core';
import { installBootstrapBuffer } from './bootstrap-buffer.js';
import { type ConfigSyncOptions, installConfigHotReload, syncPluginDefaults } from './config-sync.js';
import { type ConsoleSinkHandle, installConsoleSink } from './console-sink.js';
import { appendCrashLog, DEFAULT_LOG_FILE, type FileLoggerHandle, setupFileLogger } from './file-logger.js';
import { createNodeModulesPluginLoader } from './node-modules-loader.js';
import { createFsYamlConfigProvider, createProcessRespawnStrategy, READY_MESSAGE } from './providers.js';
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
  /**
   * 插件配置同步政策（defaultConfig 回填 / schema 裁剪 / 热重载）。
   * `trimUnknownFields=false` 时保留 configSchema 之外的未知字段（默认裁剪）。
   */
  configSync?: ConfigSyncOptions;
}

/**
 * 启动一个 Aalis 实例：YAML 配置 + 插件加载 + 进程级重启 + 日志/终端/子命令宿主件。
 * 返回已启动的 App（便于测试或进一步操作）。
 *
 * 生命周期不变量：① `consoleHandle.bindEvents` 必须在 `new App` 之后（之前无 ctx）；
 * ② 子命令短路必须在 `app.start` 之前。
 */
/**
 * 读取 @aalis/core 的实际安装版本，供 App 启动 banner 展示。
 * core 无 `exports` 限制，package.json 子路径可 require；解析失败则返回 undefined，
 * banner 自动省略版本段（不因版本读取失败而影响启动）。
 */
function readCoreVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@aalis/core/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

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
    // 宿主注入时钟：日志时间戳的权威时间来源在此层，core 逻辑不主动取墙上时间。
    now: () => new Date(),
    // 宿主读取 @aalis/core 的实际版本注入启动 banner——core 环境无关、不自读 package.json。
    version: readCoreVersion(),
  });

  // 不变量①：App 构造完成后再让 sink 监听终端归属事件——此前没有 ctx 可订阅。
  consoleHandle?.bindEvents(app.ctx);

  await app.autoLoadPlugins();

  // 配置同步政策：defaultConfig 回填 + 按 schema 裁剪未知字段，有变化则落盘。
  const synced = syncPluginDefaults(app, opts.configSync);
  for (const id of synced) app.logger.debug(`同步插件配置: ${id}`);
  if (synced.length > 0) app.logger.info('已将插件配置同步到配置文件');

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

  // 向重启我们的父进程回报「起来了」。父进程据此决定放手退出，还是判定本次
  // 更新失败并回滚（见 providers.ts 的 createProcessRespawnStrategy）。
  //
  // 两道防护缺一不可，都为了「本进程绝不能因为报喜而死」：
  // 1. `process.connected` —— 父进程等 ready 超时后会 disconnect + exit，此时通道已关，
  //    但 `process.send` 仍是 function（`?.` 只挡「从来没有 IPC」的非重启启动），
  //    照发会得到 ERR_IPC_CHANNEL_CLOSED；
  // 2. callback —— 通道在判断与发送之间关闭（TOCTOU）时，错误改走 callback。没有它，
  //    Node 会在 nextTick 往 process 上 emit 无监听者的 'error'，直接升级成
  //    uncaughtException 被 start.ts 顶部的 handler 捕获并 exit(1)——**同步 try/catch
  //    接不住**（错误是异步抛的）。症状会是「一重启就没、手动起就好」。
  if (process.connected) process.send?.({ type: READY_MESSAGE }, undefined, undefined, () => {});
  // 握手完成后解除 IPC 对事件循环的持有——否则父进程退出前本进程无法自然结束。
  process.channel?.unref();

  // 配置外部变更热重载（provider 不支持 watch 时为 no-op）。
  installConfigHotReload(app, opts.configSync);
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
