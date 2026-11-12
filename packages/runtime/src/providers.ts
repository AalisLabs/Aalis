import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AalisConfig } from '@aalis/api-host-config';
import type { HostRestart, RestartRollback } from '@aalis/api-host-restart';
import { declaresPlugin } from '@aalis/api-plugin-source';
import type { App } from '@aalis/core';
import { DefaultLogger } from '@aalis/core';
import { CORE_CONFIG_SCHEMA, defaultsFrom } from '@aalis/schema-config';
import { stringify as stringifyYaml } from 'yaml';
import { CORE_TOP_LEVEL_KEYS, type ConfigProvider, type SecretProvider } from './config-store.js';
import { assertAbsolute } from './data-dir.js';
import {
  HOST_CORE_DIR,
  importPluginDefinition,
  pluginEntry,
  warnLikelyPluginMissingKeyword,
} from './node-modules-loader.js';
import type { PluginDescriptor, PluginLoader } from './plugin-discovery.js';
import { t } from './texts.js';
import { openYamlFile } from './yaml-file.js';

// ============================================================
// FsYamlConfigProvider —— 从 YAML 文件加载+持久化配置
// ============================================================

/**
 * 把 AalisConfig 序列化为 YAML 文本，按固定顺序输出 core 字段，
 * 透传其余顶层字段（业务字段，宿主不解释）。
 */
function buildSaveYaml(config: AalisConfig): string {
  const obj: Record<string, unknown> = {
    name: config.name,
    logLevel: config.logLevel,
  };

  obj.plugins = config.plugins;

  obj.disabledPlugins = config.disabledPlugins ?? [];
  const prefs = config.servicePreferences ?? {};
  if (Object.keys(prefs).length > 0) {
    obj.servicePreferences = prefs;
  }
  const pluginPrefs = config.pluginServicePreferences ?? {};
  if (Object.keys(pluginPrefs).length > 0) obj.pluginServicePreferences = pluginPrefs;

  for (const [key, value] of Object.entries(config)) {
    if (CORE_TOP_LEVEL_KEYS.has(key)) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) obj[key] = value;
    } else if (value && typeof value === 'object') {
      if (Object.keys(value as Record<string, unknown>).length > 0) obj[key] = value;
    } else {
      obj[key] = value;
    }
  }

  return stringifyYaml(obj, { lineWidth: 0 });
}

interface FsYamlConfigProviderResult {
  /** 当前快照（交给 `createConfigStore(config, provider)` 作初始文档） */
  config: AalisConfig;
  /** Provider 实例（交给 `createConfigStore(config, provider)`） */
  provider: ConfigProvider;
}

/**
 * 创建一个基于 YAML 文件的 ConfigProvider。`absPath` 是配置文件的绝对路径（startAalis 传数据目录里的 aalis.config.yaml）。
 *
 * - 同步读取 + 解析（值原样加载，不做任何替换）；文件不存在时告警并以内存默认配置启动
 * - `save()` 原子写回；写前比对盘上内容，有尚未生效的外部修改时拒写（抛 `ConfigSaveRefusedError`，只带路径）
 * - `watch()` 监听配置文件所在目录（按文件名过滤）+ 300ms 去抖，按内容比对去重，避免自激；武装后立即核对一次
 *
 * 读写与监听的细节见 {@link openYamlFile}，与密钥文件共用。
 */
export function createFsYamlConfigProvider(absPath: string): FsYamlConfigProviderResult {
  assertAbsolute('Config file path', absPath);
  // 走 LogHub 而非 console：file logger 只订阅 LogHub，脱终端部署下 stderr 进不了 logs/latest.log
  const logger = new DefaultLogger('aalis:config');
  const file = openYamlFile<AalisConfig>(absPath, {
    label: t('configFile'),
    logger,
    serialize: buildSaveYaml,
    missing: () => {
      logger.warn(`配置文件不存在（${absPath}），使用内存默认配置启动`);
      // 名称与日志等级取 CORE_CONFIG_SCHEMA 的默认值，与配置文档补缺省同一来源
      const { name, logLevel } = defaultsFrom(CORE_CONFIG_SCHEMA);
      return { name: name as string, logLevel: logLevel as string, plugins: {} };
    },
  });
  return { config: file.initial, provider: { save: config => file.save(config), watch: file.watch } };
}

interface FsSecretsProviderResult {
  /** 当前的键值（交给 `createConfigStore` 的 `secrets.values`） */
  values: Record<string, unknown>;
  provider: SecretProvider;
}

/**
 * 创建基于数据目录 `secrets.yaml` 的密钥存储：顶层是「键 → 值」的映射。读写、拒写与监听同配置文件，
 * 另有三处不同：文件不存在时按空映射处理、不告警（第一次保存时建出）；运行中改成空文件或只剩注释时按空映射处理；
 * 原子写的临时文件一律以 0600 创建，不沿用原文件的权限位。
 */
export function createFsSecretsProvider(absPath: string): FsSecretsProviderResult {
  assertAbsolute('Secrets file path', absPath);
  const file = openYamlFile<Record<string, unknown>>(absPath, {
    label: t('secretsFile'),
    logger: new DefaultLogger('aalis:secrets'),
    serialize: values => stringifyYaml(values, { lineWidth: 0 }),
    missing: () => ({}),
    mode: 0o600,
    emptyAsMissing: true,
  });
  return { values: file.initial, provider: { save: values => file.save(values), watch: file.watch } };
}

// ============================================================
// FsPluginLoader —— 扫描目录 + dynamic import
// ============================================================

/**
 * 创建一个基于 packages 目录扫描的 PluginLoader。`rootDir` 是 packages 目录的绝对路径（源码形态的入口传 `<仓库>/packages`）。
 *
 * - `discover()`：读 dir 下每个子目录的 package.json，按 aalis-plugin 关键词收录插件，入口与 node_modules 加载器同一份解析
 * - `load()`：先经 assertSameCore 核对 core 是宿主那份，再用 `pathToFileURL(entry).href` 动态 import
 * - `reload()`：用入口文件 mtime 作为 import URL 的 query 强制 ESM 缓存失效
 */
export function createFsPluginLoader(rootDir: string): PluginLoader {
  assertAbsolute('Packages directory', rootDir);
  // 死门信号与 node_modules 加载器同一套（本仓自托管入口走的正是本加载器，
  // 只在一边出声等于对自己的部署失聪）。
  const loaderLogger = new DefaultLogger('aalis:loader');

  return {
    async discover(): Promise<PluginDescriptor[]> {
      let entries: string[];
      try {
        const dirents = await readdir(rootDir, { withFileTypes: true });
        entries = dirents.filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name);
      } catch {
        return [];
      }

      const discovered: PluginDescriptor[] = [];
      for (const entry of entries) {
        const pkgJsonPath = resolve(rootDir, entry, 'package.json');
        let pkgJson: Record<string, unknown>;
        try {
          pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        } catch {
          continue;
        }
        // 与 node_modules 加载器同一标准：纯 aalis-plugin 关键词正向门，入口按 import() 的规则解析
        if (!declaresPlugin(pkgJson)) {
          warnLikelyPluginMissingKeyword(loaderLogger, entry, pkgJson);
          continue;
        }
        const dir = resolve(rootDir, entry);
        const source = pluginEntry(loaderLogger, entry, dir, pkgJson);
        if (source) discovered.push({ name: pkgJson.name as string, source, metadata: { dir } });
      }
      return discovered;
    },

    load: desc => importPluginDefinition(desc, HOST_CORE_DIR, loaderLogger, false),
    reload: desc => importPluginDefinition(desc, HOST_CORE_DIR, loaderLogger, true),
  };
}

// ============================================================
// ProcessRespawnStrategy —— spawn 新 Node 进程然后退出当前
// ============================================================

/** 子进程 `app.start()` 成功后经 IPC 回传的握手消息。 */
export const READY_MESSAGE = 'aalis:ready';

/**
 * 重启策略：怎么换一个新实例。host-restart 服务受理请求后把控制交给它，**时序由策略决定**——何时停掉当前实例、
 * 何时拉起下一代、新实例没接管怎么办。
 */
export interface RestartStrategy {
  /**
   * @param opts.stop 优雅停掉当前 App
   * @param opts.rollback 发起方给的回滚凭据：仅当策略判定「新实例未能接管」时才使用
   */
  restart(opts: { stop: () => Promise<void>; rollback?: RestartRollback }): void | Promise<void>;
}

/**
 * host-restart 服务的实现：受理一次重启请求，下一个微任务里把控制交给策略（不在调用方的栈上），自己不停机。
 * 只受理一次：已受理过的再调记 debug 后返回（策略交出的 stop 已开始也是）；未受理过而停机已开始时抛错。
 * 策略抛错或返回被拒的 Promise 只记 error
 */
export function createHostRestart(
  app: Pick<App, 'stop' | 'stopping' | 'logger'>,
  strategy: RestartStrategy,
): HostRestart {
  let accepted = false;
  return {
    restart(opts) {
      if (accepted) {
        app.logger.debug('restart: 已受理过一次，本次忽略');
        return;
      }
      if (app.stopping) throw new Error('重启不可用：应用已开始停机');
      accepted = true;
      Promise.resolve()
        .then(() => strategy.restart({ stop: () => app.stop(), rollback: opts?.rollback }))
        .catch(err => app.logger.error('restart 失败:', err));
    },
  };
}

/** 发起方交来的 rollback 是否是可用的凭据：插件给的值在宿主这一层校验形状 */
export function isRestartRollback(v: unknown): v is RestartRollback {
  const r = v as RestartRollback | null;
  return !!r && typeof r.reason === 'string' && Array.isArray(r.restore);
}

export interface RespawnOptions {
  /** 安装集目录：开发模式（.ts 入口）在这里找本地 tsx */
  appDir: string;
  /** 新进程的 cwd：启动时的 cwd，命令行里相对的 --data 才能解析到同一处 */
  cwd: string;
  /** 额外交给新进程的环境变量（实例锁的交接令牌） */
  env?: Record<string, string>;
  /**
   * 等待子进程 IPC ready 的超时（毫秒，默认 30000）。
   *
   * **超时按成功处理**——不发 ready 的旧 runtime 必须仍能重启。真正的失败信号是
   * 「子进程在 ready 之前退出」，不是超时。
   */
  readyTimeoutMs?: number;
  /**
   * 宿主因终止信号（或输出断开）发起停机时 abort。重启途中 abort 了，操作者要的是停下：还没启动新进程的不再启动；
   * 已启动、还没报就绪的让它停下（见 `terminate`）。随后策略就此返回、不自行退出，进程由那次停机按它的退出码结束，
   * 不等新进程退出：它在后台停下，这期间还占着实例锁。带回滚凭据时记一条说明：更新留在盘上，没有新进程替它验证。
   */
  signal?: AbortSignal;
}

/**
 * 让新进程停下：它自成进程组（detached），开发模式下组里还有 tsx 包装层，整组发 SIGTERM。它已接上信号处理时走完自己的
 * 停机；三种情形是当场结束、不走停机：刚启动、还没接上信号处理；开发模式下内层没有及时回应包装层（主线程正忙），被包装层
 * 强制结束；Windows 上没有进程组信号，`child.kill()` 即强制结束。当场结束留下的实例锁，下次启动时按残留处理
 */
function terminate(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    /* 已经退出 */
  }
}

/** 组装重生用的 exec + argv。分离出来是为了单测覆盖 execArgv 保留。 */
export function buildRespawnCommand(
  appDir: string,
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): { exec: string; args: string[] } {
  const scriptFile = argv[1];
  if (scriptFile?.endsWith('.ts')) {
    // tsx 是包装脚本，node 层 flag 由它自己转交，不能放在它前面。
    const tsxBin = resolve(appDir, 'node_modules', '.bin', 'tsx');
    return { exec: existsSync(tsxBin) ? tsxBin : 'tsx', args: [...argv.slice(1)] };
  }
  // execArgv 不在 argv 里：`node --max-old-space-size=4096 dist/start.js` 的
  // `--max-old-space-size` 只出现在 execArgv。不透传的话，用户自加的 node flag
  // 会在重启后静默失效。
  const [exec, ...rest] = argv;
  return { exec: exec ?? process.execPath, args: [...execArgv, ...rest] };
}

/** 服务形态下重启以这个退出码结束：服务管理器（launchd 的 KeepAlive={SuccessfulExit=false}、systemd 的 Restart=on-failure）据此重新启动进程 */
export const SERVICE_RESTART_EXIT_CODE = 75;

/**
 * 服务形态的重启策略：停掉 App 后以 {@link SERVICE_RESTART_EXIT_CODE} 退出，由服务管理器启动新进程，
 * 新进程取锁时本进程的锁已随退出释放。不自己 spawn：detached 的新进程会脱离服务管理器的监管
 * （launchd 不再看着它，systemd 随 cgroup 把它一起杀掉）。
 * 服务形态下没有「新版启动失败就回滚」：带回滚凭据的重启（市场更新）照常退出，并记一条说明。
 *
 * `beforeExit` 在退出前等到落定（被拒时记一条、照样退出）：宿主在这里把文件日志写完，停机尾声的日志（最后几个插件的
 * 收尾、「已停止」）才进得了 latest.log。`signal` 同 {@link RespawnOptions.signal}：退出之前 abort 了就不以这个退出码抢先退出。
 */
export function createServiceRestartStrategy(
  hooks: Pick<RespawnOptions, 'signal'> & { beforeExit?: () => Promise<void> } = {},
): RestartStrategy {
  let restarting = false;
  return {
    async restart({ stop, rollback }) {
      if (restarting) {
        console.error('[aalis] A restart is already in progress; ignoring this request.');
        return;
      }
      restarting = true;
      if (isRestartRollback(rollback)) {
        console.error(
          `[aalis] Running as a service, so the service manager handles the restart; if the new version fails to start, it is not rolled back automatically (${rollback.reason}).`,
        );
      }
      try {
        await stop();
      } catch (err) {
        console.error('[aalis] Error while stopping the app; restarting anyway:', err);
      }
      try {
        await hooks.beforeExit?.();
      } catch (err) {
        console.error('[aalis] Error in the pre-exit step; restarting anyway:', err);
      }
      // 最后一个 await 之后才看：停机途中与等收尾期间收到的终止信号都算数
      if (hooks.signal?.aborted) return;
      process.exit(SERVICE_RESTART_EXIT_CODE);
    },
  };
}

/**
 * Node 进程重启策略：spawn 一个 detached 子进程接管，确认其启动成功后再退出当前进程。
 *
 * 时序：
 * 1. 等 500ms 让正在飞行的 HTTP/WS 响应有机会先返回客户端
 * 2. 调 `stop()` 优雅停掉当前 App；**抛错也继续**——否则进程会停在「插件已半拆、
 *    HTTP 已关、但还活着」的僵尸态，而脚手架不生成 supervisor，无人可救
 * 3. spawn 新进程（保留 execArgv，带 IPC 通道）
 * 4. 等 ready / 夭折 / 超时三者之一：
 *    - ready 或超时 → 放手、`exit(0)`
 *    - **ready 前夭折** → 有回滚凭据则还原工程并重生旧版；否则记 fatal 后 `exit(1)`
 *
 * 第 4 步是「更新 core 从不可逆赌博变成可接受操作」的关键：没有它，新 core 启动失败时
 * 父进程已经退了，用户只剩手改 package.json 一条路。
 *
 * **终止信号**（`signal`）打断这个时序：第 2 步停完时已经收到的，不走第 3 步；第 4 步等待期间收到的，让新进程
 * 停下、不再等它。两种情形都就此返回，见 `RespawnOptions.signal`。
 *
 * **单飞**：重启期间的第二次调用直接忽略。窗口是 500ms + stop 耗时 + 等 ready 的全程
 * （最长 30s）。经 host-restart 服务来的请求在 {@link createHostRestart} 已经只受理一次；策略也可以
 * 不经它单独使用，所以这里自己再挡：不设防会 spawn 出两个 detached 子进程——非独占端口的部署
 * （如 onebot 反向 WS）两个都能活，每条消息回两遍，而它们自成进程组，Ctrl+C 打不到。
 *
 * 对 .ts 入口（开发模式）会优先使用本地 `tsx` 二进制。
 */
export function createProcessRespawnStrategy(opts: RespawnOptions): RestartStrategy {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  let restarting = false;

  function spawnChild(withIpc: boolean): ReturnType<typeof spawn> {
    const { exec, args } = buildRespawnCommand(opts.appDir);
    return spawn(exec, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: withIpc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      detached: true,
    });
  }

  return {
    async restart({ stop, rollback }) {
      if (restarting) {
        console.error('[aalis] A restart is already in progress; ignoring this request.');
        return;
      }
      restarting = true;

      await new Promise(r => setTimeout(r, 500));
      try {
        await stop();
      } catch (err) {
        // 无法完全停止也要往下走：僵尸态比一次不完全的重启更糟。
        console.error('[aalis] Error while stopping the app; restarting anyway:', err);
      }
      const interrupted = (): void => {
        if (isRestartRollback(rollback)) {
          console.error(
            `[aalis] Restart interrupted by a termination signal; the update stays in place and is not rolled back automatically (${rollback.reason}).`,
          );
        }
      };
      if (opts.signal?.aborted) return interrupted();

      const child = spawnChild(true);
      const outcome = await new Promise<'ready' | 'timeout' | 'died' | 'interrupted'>(resolveOutcome => {
        const timer = setTimeout(() => resolveOutcome('timeout'), readyTimeoutMs);
        // 新进程还没报就绪时来了终止信号：当场让它停下（宿主的停机随后就退出本进程），不等它就绪
        const onAbort = (): void => {
          terminate(child);
          done('interrupted');
        };
        // 新进程报就绪、退出或被打断时摘掉监听（超时与就绪一样随即退出本进程，不必摘）：它已退出之后（回滚途中）再来的终止信号
        // 不该再发给它的进程组号，那个号可能已归别的进程
        const done = (o: 'ready' | 'timeout' | 'died' | 'interrupted') => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          resolveOutcome(o);
        };
        opts.signal?.addEventListener('abort', onAbort);
        child.on('message', (msg: unknown) => {
          if ((msg as { type?: unknown } | null)?.type === READY_MESSAGE) done('ready');
        });
        child.on('exit', () => done('died'));
        child.on('error', () => done('died'));
      });

      if (outcome === 'interrupted') return interrupted();
      if (outcome !== 'died') {
        try {
          child.disconnect();
        } catch {
          /* 通道可能已关，忽略 */
        }
        child.unref();
        process.exit(0);
      }

      // ── 新进程在就绪前夭折 ──
      if (!isRestartRollback(rollback)) {
        console.error(
          '[aalis] Restart failed: the new process did not start, and this restart carries no rollback information. See the log above.',
        );
        process.exit(1);
      }
      console.error(`[aalis] The new process did not start; rolling back (${rollback.reason})…`);
      // 任一还原失败就不再往下走：部分还原后跑 postRestore 会在「package.json 已回退、
      // lockfile 未回退」的混合树上安装，比不回滚更糟。此时把原始内容打进日志——
      // 它是盘外仅存的一份，用户据此可手工恢复。
      const failed: string[] = [];
      for (const f of rollback.restore) {
        try {
          // 更新前不存在的文件（deleteIfEmpty）要删掉而非写空——见 RestartRollback.restore。
          if (f.deleteIfEmpty && f.content === '') rmSync(f.path, { force: true });
          else writeFileSync(f.path, f.content);
        } catch (err) {
          failed.push(f.path);
          console.error(`[aalis] Rollback could not ${f.deleteIfEmpty ? 'delete' : 'write'} ${f.path}:`, err);
          if (!f.deleteIfEmpty) {
            console.error(
              `[aalis] The content of this file before the update follows; restore it by hand:\n${f.content}`,
            );
          }
        }
      }
      if (failed.length > 0) {
        console.error(
          `[aalis] Rollback incomplete (files not restored: ${failed.length}); skipped reinstalling so the project is not left in a mixed state.`,
        );
        process.exit(1);
      }
      if (rollback.postRestore) {
        const { cmd, args, cwd } = rollback.postRestore;
        // **必须看退出码**。这条命令把 node_modules 装回旧版，文件还原只完成了一半的工作。
        // 它失败的途径是现实的：回滚窗口内 registry 不可达、私有源 token 过期、旧版被
        // unpublish、npm cache 为空（pnpm 装的工程正是这种）、原生模块 postinstall 异常退出。
        // 不看退出码就宣告「已回滚」的话，留下的是比原状态更糟的错位树——package.json 声明
        // 旧版、node_modules 实装新版、锁已被删；而 caret 范围仍满足新版，后续 `npm install`
        // 也不会自愈。然后拿旧版进程去加载新版代码，进 crash loop，用户却被告知回滚成功。
        const code = await new Promise<number | null>(r => {
          const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
          p.on('exit', c => r(c));
          p.on('error', err => {
            console.error('[aalis] The rollback command could not run:', err);
            r(-1);
          });
        });
        if (code !== 0) {
          console.error(
            `[aalis] Rollback incomplete: reinstalling dependencies failed (${cmd} exited with code ${code}).\n` +
              '[aalis] The files were restored, but node_modules still holds the updated versions: the project declares the old versions while the new ones are installed.\n' +
              `[aalis] Once online, run by hand: ${[cmd, ...args].join(' ')} (cwd: ${cwd})\n` +
              '[aalis] The old version was not started again: it would load the new code and likely keep crashing.',
          );
          process.exit(1);
        }
      }
      const revived = spawnChild(false);
      revived.unref();
      console.error('[aalis] Rolled back and started the old version again.');
      process.exit(1);
    },
  };
}
