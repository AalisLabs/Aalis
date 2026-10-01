import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AalisConfig } from '@aalis/api-host-config';
import type { RestartStrategy } from '@aalis/core';
import { DefaultLogger } from '@aalis/core';
import { CORE_CONFIG_SCHEMA, defaultsFrom } from '@aalis/schema-config';
import { stringify as stringifyYaml } from 'yaml';
import type { ConfigProvider, SecretProvider } from './config-store.js';
import { assertAbsolute } from './home.js';
import {
  HOST_CORE_DIR,
  importPluginDefinition,
  isLoadablePlugin,
  warnLikelyPluginMissingKeyword,
} from './node-modules-loader.js';
import type { PluginDescriptor, PluginLoader } from './plugin-discovery.js';
import { disarmTerminalStateRestorer } from './terminal.js';
import { openYamlFile } from './yaml-file.js';

// ============================================================
// FsYamlConfigProvider —— 从 YAML 文件加载+持久化配置
// ============================================================

const CORE_TOP_LEVEL_KEYS = new Set<string>(['name', 'logLevel', 'plugins', 'disabledPlugins', 'servicePreferences']);

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
 * 创建一个基于 YAML 文件的 ConfigProvider。`absPath` 是配置文件的绝对路径（startAalis 传家目录里的 aalis.config.yaml）。
 *
 * - 同步读取 + 解析（值原样加载，不做任何替换）；文件不存在时告警并以内存默认配置启动
 * - `save()` 原子写回；写前比对盘上内容，有尚未生效的外部修改时拒写（抛 `ConfigSaveRefusedError`，只带路径）
 * - `watch()` 监听配置文件所在目录（按文件名过滤）+ 300ms 去抖，按内容比对去重，避免自激；武装后立即对账一次
 *
 * 读写与监听的细节见 {@link openYamlFile}，与密钥文件共用。
 */
export function createFsYamlConfigProvider(absPath: string): FsYamlConfigProviderResult {
  assertAbsolute('配置文件路径', absPath);
  // 走 LogHub 而非 console：file logger 只订阅 LogHub，脱终端部署下 stderr 进不了 logs/latest.log
  const logger = new DefaultLogger('aalis:config');
  const file = openYamlFile<AalisConfig>(absPath, {
    label: '配置文件',
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
 * 创建基于家目录 `secrets.yaml` 的密钥存储：顶层是「键 → 值」的映射。读写、拒写与监听同配置文件，
 * 另有三处不同：文件不存在时按空映射处理、不告警（第一次保存时建出）；运行中改成空文件或只剩注释时按空映射处理；
 * 原子写的临时文件一律以 0600 创建，不沿用原文件的权限位。
 */
export function createFsSecretsProvider(absPath: string): FsSecretsProviderResult {
  assertAbsolute('密钥文件路径', absPath);
  const file = openYamlFile<Record<string, unknown>>(absPath, {
    label: '密钥文件',
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
 * - `discover()`：读 dir 下每个子目录的 package.json，按 aalis-plugin 关键词收录可加载插件
 * - `load()`：先经 assertSameCore 核对 core 是宿主那份，再用 `pathToFileURL(entry).href` 动态 import
 * - `reload()`：用入口文件 mtime 作为 import URL 的 query 强制 ESM 缓存失效
 */
export function createFsPluginLoader(rootDir: string): PluginLoader {
  assertAbsolute('packages 目录', rootDir);
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
        // 与 node_modules 加载器同一标准：纯 aalis-plugin 关键词正向门（单一真相，防两处漂移）。
        // 非插件（核心/契约/前端/工具链/工具库）各带自己的类型关键词、不带 aalis-plugin，自然不被收录。
        if (!isLoadablePlugin(pkgJson)) {
          warnLikelyPluginMissingKeyword(loaderLogger, entry, pkgJson);
          continue;
        }
        const main = (pkgJson.main as string) || 'dist/index.js';
        discovered.push({
          name: pkgJson.name as string,
          source: resolve(rootDir, entry, main),
          metadata: { dir: resolve(rootDir, entry) },
        });
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
 * 重启回滚凭据——「更新后新实例起不来」时把工程恢复到更新前的手段。
 *
 * 由发起方（市场的 core/runtime 更新）在改写 `package.json` **之前**构造，经
 * `app.restart({ rollback })` 交给策略，**全程只在父进程内存里**：触发条件（新进程
 * ready 前退出）与执行者都是父进程，不跨 spawn 边界，因此不需要落盘。
 */
export interface RestartRollback {
  /** 人类可读的来由，仅用于日志（如 `marketplace-update:@aalis/core`）。 */
  reason: string;
  /**
   * 需要还原的文件：绝对路径 → 更新前的原始内容。
   *
   * `deleteIfEmpty` 表示该文件**更新前并不存在**（如原本无 lockfile 的工程被
   * `npm install` 新建了一个），回滚时应删除而非写空——留着它会让后续的重装判定
   * 新版仍然满足，从而什么都不做，把回滚变成一句谎话。
   */
  restore: Array<{ path: string; content: string; deleteIfEmpty?: boolean }>;
  /**
   * 还原文件后需要跑的命令——`package.json` 回退了，`node_modules` 还停在新版，
   * 必须再跑一次安装才能真正回到旧状态。省略则只还原文件。
   */
  postRestore?: { cmd: string; args: string[]; cwd: string };
}

/** 判定不透明的 rollback 透传值是否是可用的凭据（core 不解释形状，由本层校验）。 */
export function isRestartRollback(v: unknown): v is RestartRollback {
  const r = v as RestartRollback | null;
  return !!r && typeof r.reason === 'string' && Array.isArray(r.restore);
}

export interface RespawnOptions {
  /** 安装集目录：开发模式（.ts 入口）在这里找本地 tsx */
  appDir: string;
  /** 新进程的 cwd：启动时的 cwd，命令行里相对的 --home 才能解析到同一处 */
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
}

/** 组装重生用的 exec + argv。分离出来是为了单测覆盖 execArgv 保留。 */
export function buildRespawnCommand(
  appDir: string,
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): { exec: string; args: string[] } {
  const scriptFile = argv[1];
  if (scriptFile?.endsWith('.ts')) {
    // tsx 是包装脚本，node 层 flag 由它自己转交，不能塞在它前面。
    const tsxBin = resolve(appDir, 'node_modules', '.bin', 'tsx');
    return { exec: existsSync(tsxBin) ? tsxBin : 'tsx', args: [...argv.slice(1)] };
  }
  // execArgv 不在 argv 里：`node --max-old-space-size=4096 dist/start.js` 的
  // `--max-old-space-size` 只出现在 execArgv。不透传的话，用户自加的 node flag
  // 会在重启后静默失效。
  const [exec, ...rest] = argv;
  return { exec: exec ?? process.execPath, args: [...execArgv, ...rest] };
}

/** 服务形态下重启以这个退出码结束：服务管理器（launchd 的 KeepAlive={SuccessfulExit=false}、systemd 的 Restart=on-failure）据此重新拉起 */
export const SERVICE_RESTART_EXIT_CODE = 75;

/**
 * 服务形态的重启策略：停掉 App 后以 {@link SERVICE_RESTART_EXIT_CODE} 退出，由服务管理器拉起新进程，
 * 新进程取锁时本进程的锁已随退出释放。不自己 spawn：detached 的新进程会脱离服务管理器的监管
 * （launchd 不再看着它，systemd 随 cgroup 把它一起杀掉）。
 * 服务形态下没有「新版起不来就回滚」：带回滚凭据的重启（市场更新）照常退出，并记一条说明。
 */
export function createServiceRestartStrategy(): RestartStrategy {
  let restarting = false;
  return {
    async restart({ stop, rollback }) {
      if (restarting) {
        console.error('[aalis] 已有重启在进行中，忽略本次请求。');
        return;
      }
      restarting = true;
      if (isRestartRollback(rollback)) {
        console.error(`[aalis] 以服务形态运行，重启交给服务管理器；新版本起不来时不会自动回滚（${rollback.reason}）。`);
      }
      try {
        await stop();
      } catch (err) {
        console.error('[aalis] 停止应用时出错，仍继续重启:', err);
      }
      process.exit(SERVICE_RESTART_EXIT_CODE);
    },
  };
}

/**
 * Node 进程重启策略：spawn 一个 detached 子进程接管，确认其起得来后再退出当前进程。
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
 * 第 4 步是「更新 core 从不可逆赌博变成可接受操作」的关键：没有它，新 core 起不来时
 * 父进程已经退了，用户只剩手改 package.json 一条路。
 *
 * **单飞**：重启期间的第二次调用直接忽略。窗口是 500ms + stop 耗时 + 等 ready 的全程
 * （最长 30s），期间 HTTP/指令入口仍可能再次触发；不设防会 spawn 出两个 detached
 * 子进程——非独占端口的部署（如 onebot 反向 WS）两个都能活，每条消息回两遍，而它们
 * 自成进程组，Ctrl+C 打不到。
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
        console.error('[aalis] 已有重启在进行中，忽略本次请求。');
        return;
      }
      restarting = true;

      await new Promise(r => setTimeout(r, 500));
      try {
        await stop();
      } catch (err) {
        // 停不干净也要往下走：僵尸态比一次不完全的重启更糟。
        console.error('[aalis] 停止应用时出错，仍继续重启:', err);
      }

      const child = spawnChild(true);
      const outcome = await new Promise<'ready' | 'timeout' | 'died'>(resolveOutcome => {
        const timer = setTimeout(() => resolveOutcome('timeout'), readyTimeoutMs);
        const done = (o: 'ready' | 'timeout' | 'died') => {
          clearTimeout(timer);
          resolveOutcome(o);
        };
        child.on('message', (msg: unknown) => {
          if ((msg as { type?: unknown } | null)?.type === READY_MESSAGE) done('ready');
        });
        child.on('exit', () => done('died'));
        child.on('error', () => done('died'));
      });

      if (outcome !== 'died') {
        // 终端已归子进程所有（它的 ready 发生在 TUI 进备用屏之后），父进程退出时不得再写它，
        // 否则复原序列会把新实例的 TUI 踢出备用屏。见 disarmTerminalStateRestorer 的注释。
        disarmTerminalStateRestorer();
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
        console.error('[aalis] 重启失败：新进程未能启动，且本次重启未带回滚凭据。请检查上方日志。');
        process.exit(1);
      }
      console.error(`[aalis] 新进程未能启动，正在回滚（${rollback.reason}）…`);
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
          console.error(`[aalis] 回滚${f.deleteIfEmpty ? '删除' : '写入'}失败 ${f.path}:`, err);
          if (!f.deleteIfEmpty) console.error(`[aalis] 该文件的更新前内容如下，请手工恢复：\n${f.content}`);
        }
      }
      if (failed.length > 0) {
        console.error(`[aalis] 回滚未完成（${failed.length} 个文件写入失败），已跳过重装以免留下混合状态。`);
        process.exit(1);
      }
      if (rollback.postRestore) {
        const { cmd, args, cwd } = rollback.postRestore;
        // **必须看退出码**。这条命令把 node_modules 装回旧版，文件还原只完成了一半的工作。
        // 它失败的途径是现实的：回滚窗口内 registry 不可达、私有源 token 过期、旧版被
        // unpublish、npm cache 为空（pnpm 装的工程正是这种）、原生模块 postinstall 挂掉。
        // 不看退出码就宣告「已回滚」的话，留下的是比原状态更糟的错位树——package.json 声明
        // 旧版、node_modules 实装新版、锁已被删；而 caret 范围仍满足新版，后续 `npm install`
        // 也不会自愈。然后拿旧版进程去加载新版代码，进 crash loop，用户却被告知回滚成功。
        const code = await new Promise<number | null>(r => {
          const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
          p.on('exit', c => r(c));
          p.on('error', err => {
            console.error('[aalis] 回滚命令执行失败:', err);
            r(-1);
          });
        });
        if (code !== 0) {
          console.error(
            `[aalis] 回滚未完成：依赖重装失败（${cmd} 退出码 ${code}）。\n` +
              `[aalis] 配置文件已还原，但 node_modules 仍是更新后的版本 —— 工程处于「声明旧版、实装新版」的错位状态。\n` +
              `[aalis] 请联网后手工执行：${[cmd, ...args].join(' ')}（cwd: ${cwd}）\n` +
              '[aalis] 未重新拉起旧版进程：它会加载到新版代码，很可能反复崩溃。',
          );
          process.exit(1);
        }
      }
      const revived = spawnChild(false);
      revived.unref();
      console.error('[aalis] 已回滚并重新启动旧版本。');
      process.exit(1);
    },
  };
}
