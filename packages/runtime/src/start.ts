import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, normalize } from 'node:path';
import { hostPaths } from '@aalis/api-host-paths';
import { pluginSource } from '@aalis/api-plugin-source';
import { App, events, type LogLevel, provide, services } from '@aalis/core';
import { installBootstrapBuffer } from './bootstrap-buffer.js';
import { createConfigStore, installHostConfig } from './config-store.js';
import { type ConfigSyncOptions, installConfigHotReload, withPluginConfigSync } from './config-sync.js';
import { type ConsoleSinkHandle, installConsoleSink } from './console-sink.js';
import { appendCrashLog, type FileLoggerHandle, setupFileLogger } from './file-logger.js';
import {
  derivePaths,
  HomeArgsError,
  initHome,
  isFullyAbsolute,
  isHomeInitialized,
  parseHostArgs,
  resolveHome,
} from './home.js';
import { acquireInstanceLock, type InstanceLock } from './instance-lock.js';
import { createNodeModulesPluginLoader } from './node-modules-loader.js';
import { createPluginDiscovery, type PluginLoader } from './plugin-discovery.js';
import {
  createFsSecretsProvider,
  createFsYamlConfigProvider,
  createProcessRespawnStrategy,
  createServiceRestartStrategy,
  READY_MESSAGE,
} from './providers.js';
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
//   startAalis({ pluginLoader: createFsPluginLoader() });
//
// 命令行开头的宿主参数（`--home`、`--profile`、`--init`、`--service`）先取走，用来定家目录与运行形态；余下的 argv 非空即子命令
// 模式——`node index.mjs <name> [args]` ≡ 聊天里的 `/<name> args`，命中即执行并退出，未命中报错退出
// （exit 2），**两种情况都不进守护进程**。宿主自己解析命令行时传 `argv: []` 或显式数组。
//
// 家目录没初始化就拒绝启动，只提示怎样初始化：绝不在找不到家目录时静默起一个空的家。
//
// 子命令进程是与守护进程零通信的一次性实例，因此不装文件日志（会把守护进程正在写的 latest.log 轮转走）、
// 不注入重启策略（`restart` 会 spawn 出 argv 仍带 restart 的 detached 子进程，无限连环——实测）。
//
// 宿主的「I/O 那一层」（日志 sink / 终端复原 / 子命令分发）全在本包，core 只产生 LogEntry。

export interface StartAalisOptions {
  /**
   * 安装集目录（package.json 与 node_modules 所在，源码形态另有 packages/），必须是绝对路径。
   * 缺省为 `<家目录>/app`（npm 形态）；源码形态的入口传仓库根，脚手架生成的入口传项目目录。
   */
  appDir?: string;
  /**
   * 宿主代码给的兜底家目录，必须是绝对路径。优先级最低：`--home`、`AALIS_HOME`、`--profile` / `AALIS_PROFILE`
   * 都没给时才用它，再没有就是 `~/.aalis`。
   */
  defaultHome?: string;
  /** 插件加载器，默认 createNodeModulesPluginLoader(安装集)；monorepo 传 createFsPluginLoader(<仓库>/packages) */
  pluginLoader?: PluginLoader;
  /**
   * 彩色控制台日志，默认 true（独立部署即有全量级别）。webui-only/嵌入式/测试夹具可传 false：
   * 此时仍把 warn/error 打到 stderr（「装了没反应」与插件解析到「另一份 @aalis/core」被拒载必须出声），
   * 不写 info/debug、不占 stdout。
   */
  consoleSink?: boolean;
  /**
   * 文件日志写到家目录的 `logs/latest.log`，默认开（WebUI 与 CLI 的日志页尾读这个文件）。
   * 启动时先把上一轮的日志改名保留（编号插在扩展名前：latest.1.log），更早的依次后移，保留 5 份。
   * 子命令模式一律不写文件日志。
   */
  fileLog?: boolean;
  /** 退出时复原终端 raw-mode/alt-screen，默认 true */
  terminalRestore?: boolean;
  /**
   * 命令行参数，默认 `process.argv.slice(2)`。开头的宿主参数先取走：`--home <目录>`、`--profile <名>`、
   * `--init`（初始化家目录后退出）、`--service`（由服务管理器拉起：实例锁被占时以 0 退出，重启交给服务管理器）。余下的非空即子命令模式：命中执行后退出，未命中报错退出（exit 2），不进守护进程。
   * 宿主自管命令行时传显式数组（`[]` 即守护进程）。
   */
  argv?: string[];
  /** 覆盖 dev/prod 判定，默认按 NODE_ENV !== 'production' */
  devMode?: boolean;
  /**
   * 插件配置同步政策（defaultConfig 回填 / schema 裁剪 / 热重载）。
   * `trimUnknownFields=false` 时保留 configSchema 之外的未知字段（默认裁剪）。
   */
  configSync?: ConfigSyncOptions;
}

/** respawn 时把实例锁的交接令牌交给新进程的环境变量 */
const HANDOFF_ENV = 'AALIS_LOCK_HANDOFF';

/**
 * 读取 @aalis/core 的实际安装版本，供 App 启动 banner 展示。
 * core 的 `exports` 开放了 `./package.json` 子路径，可 require；解析失败则返回 undefined，
 * banner 自动省略版本段（不因版本读取失败而影响启动）。
 */
function readCoreVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@aalis/core/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * 启动一个 Aalis 实例：YAML 配置 + 插件加载 + 进程级重启 + 日志/终端/子命令宿主件。
 * 返回已启动的 App（便于测试或进一步操作）。
 *
 * 生命周期不变量：① `consoleHandle.bindEvents` 必须在 `new App` 之后（之前没有事件总线）；
 * ② 子命令短路必须在 `app.start` 之前。
 */
export async function startAalis(opts: StartAalisOptions = {}): Promise<App> {
  const { consoleSink = true, fileLog = true, terminalRestore = true } = opts;

  // ── 家目录：在任何日志与文件写入之前定下来 ──
  // 命令行与环境变量里写的相对路径按启动时的 cwd 解析一次：那是用户在 shell 里的意图。
  // 启动目录可能已被删除，这时 process.cwd() 会抛错；只有遇到相对路径才需要它。
  let startCwd: string | undefined;
  try {
    startCwd = process.cwd();
  } catch {
    startCwd = undefined;
  }
  let hostArgs: ReturnType<typeof parseHostArgs>;
  let home: ReturnType<typeof resolveHome>;
  try {
    hostArgs = parseHostArgs(opts.argv ?? process.argv.slice(2));
    home = resolveHome({ args: hostArgs, env: process.env, defaultHome: opts.defaultHome, cwd: startCwd });
    if (opts.appDir !== undefined && !isFullyAbsolute(opts.appDir)) {
      throw new HomeArgsError(`appDir 必须是绝对路径：${opts.appDir}`);
    }
  } catch (err) {
    if (!(err instanceof HomeArgsError)) throw err;
    console.error(`[aalis] ${err.message}`);
    process.exit(2);
  }
  const appDirOf = (homeDir: string) => (opts.appDir ? normalize(opts.appDir) : join(homeDir, 'app'));
  const declared = derivePaths(home.home, appDirOf(home.home), home.profile);
  if (hostArgs.init) {
    try {
      initHome(declared);
    } catch (err) {
      console.error(`[aalis] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log(`[aalis] 已初始化家目录：${declared.home}`);
    process.exit(0);
  }
  if (!isHomeInitialized(declared)) {
    console.error(
      `[aalis] 家目录还没有初始化：${declared.home}\n[aalis] 在启动命令里、子命令之前加上 --init 运行一次即可初始化。`,
    );
    process.exit(1);
  }
  // 交给插件的家目录是真实路径：符号链接、大小写与末尾分隔符不同的写法指向同一个目录时，插件拿到的是同一个路径
  // （记忆库按它记归属）
  const realHome = realpathSync.native(declared.home);
  const paths = derivePaths(realHome, appDirOf(realHome), home.profile);
  // 默认加载器从安装集的 package.json 找插件：缺了它会一个插件都不加载、照样起来，只留一行「发现 0 个插件」。
  // 缺省的 <家目录>/app 留给以后的全局启动器，现在的入口都要自己传 appDir。
  if (!opts.pluginLoader && !existsSync(join(paths.app, 'package.json'))) {
    console.error(
      `[aalis] 安装集 ${paths.app} 里没有 package.json，找不到要加载的插件。\n` +
        '[aalis] 把入口文件所在的目录作为 appDir 传给 startAalis，例如 startAalis({ appDir: dirname(fileURLToPath(import.meta.url)) })。',
    );
    process.exit(1);
  }
  const subcommands = hostArgs.rest;

  // ── 实例锁：同一家目录只许一个守护进程。要在写日志之前取到，否则第二个实例一起来就把正在写的 latest.log 轮转走 ──
  // 交接令牌读到就从环境里删掉，不让插件起的子进程与侧车继承它。子命令进程不取锁（它们以后经 socket 连实例）。
  const handoffToken = process.env[HANDOFF_ENV];
  delete process.env[HANDOFF_ENV];
  let instanceLock: InstanceLock | undefined;
  if (subcommands.length === 0) {
    let acquired: ReturnType<typeof acquireInstanceLock>;
    try {
      acquired = acquireInstanceLock(paths.run, { handoffToken });
    } catch (err) {
      console.error(`[aalis] 无法在 ${paths.run} 取实例锁：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (!acquired.ok) {
      const { holder, file } = acquired;
      const occupied =
        `[aalis] 家目录 ${paths.home} 已有实例在运行：pid ${holder.pid}（锁文件 ${file}）。\n` +
        '[aalis] 确认没有实例在运行时（例如进程被强制结束、而本机查不了进程启动时间），删掉这个锁文件再启动。';
      if (hostArgs.service) {
        // 服务形态按正常退出：配合 KeepAlive={SuccessfulExit=false}，不会被服务管理器反复拉起再抢锁
        console.error(`${occupied}\n[aalis] 以服务形态启动，按正常退出处理。`);
        process.exit(0);
      }
      console.error(occupied);
      process.exit(1);
    }
    instanceLock = acquired.lock;
    const lock = acquired.lock;
    process.on('exit', () => lock.release());
  }

  // ── 最早期：任何日志之前先装 bootstrap buffer，再装 terminal / console sink ──
  const bootstrap = installBootstrapBuffer();
  if (terminalRestore) installTerminalStateRestorer();
  const subcommandMode = subcommands.length > 0;
  // console sink 在 App 之前装：此时尚无事件总线（根绑定），sink 处于「无条件写」状态以打印早期启动日志，
  // 待 App 起来再 bindEvents 接管 terminal:claimed/released。子命令模式日志走 stderr，stdout 只留命令结果。
  // consoleSink: false 仍装 stderr + minLevel warn：加载器拒载「另一份 @aalis/core」的插件记 error，不能只剩下游「commands 服务不可用」。
  const consoleHandle: ConsoleSinkHandle = consoleSink
    ? installConsoleSink(subcommandMode ? { target: 'stderr' } : {})
    : installConsoleSink({ target: 'stderr', minLevel: 'warn' });

  // 子命令进程不写文件日志：setupFileLogger 会把 latest.log 轮转走，而守护进程可能正在写它（webui 历史日志
  // 以该文件为单一数据源）。
  const fileLogTarget = fileLog && !subcommandMode ? join(paths.logs, 'latest.log') : undefined;

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

  // ── 组装 App：YAML 配置文档与密钥文件、按 loader 发现插件、用 spawn 重启 ──
  const { config, provider } = createFsYamlConfigProvider(paths.config);
  const secrets = createFsSecretsProvider(paths.secrets);
  const store = createConfigStore(config, provider, secrets);
  // core 的慢操作阈值：缺省（含 YAML 空键解出的 null）交给 core 默认；不是非负有限数的写法告警后同样交给默认
  // （启动时读取，改了要重启）
  const slowThresholdMs = store.get('slowThresholdMs') ?? undefined;
  const slowThresholdValid =
    slowThresholdMs === undefined ||
    (typeof slowThresholdMs === 'number' && Number.isFinite(slowThresholdMs) && slowThresholdMs >= 0);
  const app = new App({
    name: store.get('name'),
    logLevel: store.get('logLevel') as LogLevel,
    slowThresholdMs: slowThresholdValid ? (slowThresholdMs as number | undefined) : undefined,
    // 子命令进程没有重启能力，不注入策略：`app.restart()` 按 core 语义抛「不可用」，指令层折成失败文案。
    // 注入的话，`restart` 子命令在 app.stop 超过策略 500ms 等待时会 spawn 一个 argv 仍带 restart 的
    // detached 子进程，新进程再命中 restart……无限连环（实测 5 代，Ctrl+C 打不到）。
    restartStrategy: subcommandMode
      ? undefined
      : hostArgs.service
        ? createServiceRestartStrategy()
        : createProcessRespawnStrategy({
            appDir: paths.app,
            cwd: startCwd ?? paths.home,
            ...(instanceLock ? { env: { [HANDOFF_ENV]: instanceLock.handoffToken } } : {}),
          }),
    // 宿主层决定 dev/prod；core 不读 process.env
    devMode: opts.devMode ?? process.env.NODE_ENV !== 'production',
    // 宿主注入时钟：日志时间戳的权威时间来源在此层，core 逻辑不主动取墙上时间。
    now: () => new Date(),
    // 宿主读取 @aalis/core 的实际版本注入启动 banner——core 环境无关、不自读 package.json。
    version: readCoreVersion(),
  });

  if (!slowThresholdValid) {
    // 数字照原样显示：JSON.stringify 会把 Infinity / NaN 显示成 null
    const received = typeof slowThresholdMs === 'number' ? String(slowThresholdMs) : JSON.stringify(slowThresholdMs);
    app.logger.warn(`配置项 slowThresholdMs 应为不小于 0 的有限数字（毫秒），收到 ${received}，按默认值处理`);
  }

  // 宿主的根绑定：事件订阅、服务查询与宿主服务登记都经它，随 App 停止撤回
  const host = app.bind({ events, provide, services });
  // 宿主路径与配置文档先于任何插件接上：插件激活时就要用到，文档里的服务偏好要在全部提供者上线前生效
  host.provide(hostPaths, paths, { exclusive: true });
  installHostConfig(app, store, opts.configSync);
  // 默认值从 configSchema 派生（唯一声明来源），导入定义后、登记前深合并进文档；登记时原样交给 core
  const configLoader = withPluginConfigSync(
    opts.pluginLoader ?? createNodeModulesPluginLoader(paths.app),
    app,
    store,
    opts.configSync,
  );
  const discovery = createPluginDiscovery(app, configLoader.loader, store);
  host.provide(pluginSource, { rescan: () => discovery.rescan() }, { exclusive: true });
  // 不变量①：App 构造完成后再让 sink 监听终端归属事件——此前没有事件总线可订阅。
  consoleHandle.bindEvents(host.events);

  try {
    // 每个定义交给 Core 前已经规范化；首次 apply 与配置快照用同一份字段。
    await discovery.loadAll();
  } finally {
    // 即使后续加载失败，也保存本批已完成的规范化；不启动第二轮 bounce。
    configLoader.finishInitialLoad();
  }

  // ── 不变量②：子命令短路在 app.start 之前 ──
  // `aalis <name> [args...]` 等价于聊天里 `/<name> args...`：命中则执行返回串，未命中则报错，
  // 两种情况都干净退出、**绝不进守护进程**——打错的命令名若照常起守护，就是与运行中实例并存的
  // 第二个实例（同时连 onebot、每条消息回两遍）。与具体命令解耦——各插件自行注册命令。
  if (subcommandMode) {
    const exitCode = await tryDispatchSubcommand(host.services, subcommands);
    await app.stop();
    await new Promise<void>(r => setImmediate(r));
    process.exit(exitCode);
  }

  // ── 启动 + 优雅退出（防止重复调用）──
  await app.start();

  // 启动收敛后仍是 pending 的插件 = required 依赖没满足，而它自己**不出任何声音**。
  // 典型链条：A 缺 apiKey 激活失败（有 ERROR）→ 依赖 A 所提供服务的 B 静默挂起，
  // 用户只看到 A 的报错，会以为「只是 A 不可用」，不知道 B 也一并废了
  // （实例：embedding-openai 缺 key → memory-vector 永远不激活，向量记忆整个不工作）。
  // 没有提供者的服务若由仍在激活中（含已转入后台）的插件声明提供，报「等待 <实例> 激活完成」而非缺少：
  // 它的服务在激活完成前不对外。判据同 plugin-doctor 的 plugins.pending。
  const status = app.plugins.getStatus();
  const activating = status.filter(s => s.state === 'activating');
  for (const p of status) {
    if (p.state !== 'pending') continue;
    const missing: string[] = [];
    const waiting = new Set<string>();
    for (const svc of p.requiredServices ?? []) {
      if (host.services.inspect(svc).length > 0) continue;
      const provider = activating.find(s => s.provides?.includes(svc));
      if (provider) waiting.add(provider.instanceId);
      else missing.push(svc);
    }
    const reasons = [
      ...(missing.length > 0 ? [`缺少服务: ${missing.join('、')}`] : []),
      ...[...waiting].map(id => `等待 ${id} 激活完成`),
    ];
    if (reasons.length > 0) app.logger.warn(`插件 "${p.instanceId}" 依赖未满足，未激活（${reasons.join('；')}）`);
  }

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

  // 配置外部变更热重载（provider 不支持 watch 时为 no-op）；文件里新增的后缀实例经发现驱动登记。
  installConfigHotReload(app, store, discovery, opts.configSync);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    // app.stop() 期间和之后插件可能仍在 logger.info('已停止') 等，给微任务一个 tick 把它们
    // 入队，再等队列清空，确保 latest.log 含完整关闭日志。
    await new Promise<void>(r => setImmediate(r));
    await fileLogger?.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}
