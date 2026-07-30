import { spawn } from 'node:child_process';
import { existsSync, type FSWatcher, watch as fsWatch, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AalisConfig,
  ConfigProvider,
  PluginDescriptor,
  PluginLoader,
  PluginModule,
  RestartStrategy,
} from '@aalis/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isLoadablePlugin } from './node-modules-loader.js';

// ============================================================
// FsYamlConfigProvider —— 从 YAML 文件加载+持久化配置
// ============================================================

const DEFAULT_CONFIG_FILE = 'aalis.config.yaml';

/**
 * 把 `${ENV_VAR}` 替换为环境变量值（兼容老配置）。
 */
function interpolateEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)}/g, (_, varName: string) => {
    return process.env[varName.trim()] ?? '';
  });
}

/**
 * 在【解析后】的配置树上对字符串标量做 ${ENV} 替换（值级插值）。
 * 不在 YAML 文本层插值——含 :/换行/{} 的 env 值也只成为该字段的字符串值，
 * 注入不了 YAML 键、崩不了解析。含占位的纯数字/布尔结果安全恢复类型
 * （保持 `port: ${PORT}` 仍解析为数字，与旧文本插值行为一致）。
 */
function interpolateEnvVarsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('${')) return value;
    const s = interpolateEnvVars(value);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s === 'true' || s === 'false') return s === 'true';
    return s;
  }
  if (Array.isArray(value)) return value.map(interpolateEnvVarsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateEnvVarsDeep(v);
    return out;
  }
  return value;
}

const CORE_TOP_LEVEL_KEYS = new Set<string>(['name', 'logLevel', 'plugins', 'disabledPlugins', 'servicePreferences']);

/**
 * 恢复 ${ENV} 占位符：对比当前值与原始 raw 值，若相等则保留 raw。
 */
function restoreEnvVars(current: Record<string, unknown>, raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const rawVal = raw[key];
    if (typeof rawVal === 'string' && /\$\{[^}]+}/.test(rawVal)) {
      const expanded = interpolateEnvVars(rawVal);
      if (expanded === value) {
        result[key] = rawVal;
        continue;
      }
    }
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      rawVal &&
      typeof rawVal === 'object' &&
      !Array.isArray(rawVal)
    ) {
      result[key] = restoreEnvVars(value as Record<string, unknown>, rawVal as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 把 AalisConfig 序列化为 YAML 文本，按固定顺序输出 core 字段，
 * 透传其余顶层字段（业务字段，宿主不解释）。
 */
function buildSaveYaml(config: AalisConfig, rawYaml: string | null): string {
  const obj: Record<string, unknown> = {
    name: config.name,
    logLevel: config.logLevel,
  };

  if (rawYaml) {
    const rawParsed = parseYaml(rawYaml) as Record<string, unknown> | null;
    const rawPlugins = (rawParsed?.plugins ?? {}) as Record<string, Record<string, unknown>>;
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const [name, conf] of Object.entries(config.plugins)) {
      plugins[name] = restoreEnvVars(conf, rawPlugins[name] ?? {});
    }
    obj.plugins = plugins;
  } else {
    obj.plugins = config.plugins;
  }

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
  /** 当前快照（用于 `new App({ config })`） */
  config: AalisConfig;
  /** Provider 实例（用于 `new App({ configProvider })`） */
  provider: ConfigProvider;
  /** 配置文件所在目录（用于 `new App({ dataDir })`） */
  dataDir: string;
}

/**
 * 创建一个基于 YAML 文件的 ConfigProvider。
 *
 * - 同步读取 + 解析 + 环境变量插值
 * - `save()` 同步写回，并保护 `${ENV}` 占位符
 * - `watch()` 用 `fs.watch` + 300ms debounce，并通过 lastWrittenYaml 去重避免自激
 *
 * 调用时一次性返回 config 快照、provider 和 dataDir 三件套，方便 src/index.ts 组装。
 */
export function createFsYamlConfigProvider(configPath?: string): FsYamlConfigProviderResult {
  const absPath = configPath ? resolve(configPath) : resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  const dataDir = dirname(absPath);

  let rawYaml: string | null = null;
  let lastWrittenYaml: string | null = null;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function loadFromDisk(): AalisConfig {
    if (existsSync(absPath)) {
      rawYaml = readFileSync(absPath, 'utf-8');
      // 先 parse、再只在解析后的字符串值上插值 ${ENV}——env 值注入不了 YAML 结构、崩不了解析。
      const parsed = interpolateEnvVarsDeep(parseYaml(rawYaml) ?? {}) as Record<string, unknown>;
      return parsed as AalisConfig;
    }
    rawYaml = null;
    return { name: 'Aalis', logLevel: 'info', plugins: {} };
  }

  const initialConfig = loadFromDisk();

  const provider: ConfigProvider = {
    save(config) {
      const yaml = buildSaveYaml(config, rawYaml);
      lastWrittenYaml = yaml;
      writeFileSync(absPath, yaml, 'utf-8');
      rawYaml = yaml;
    },

    watch(onChange) {
      if (watcher) return () => {};
      if (!existsSync(absPath)) return () => {};
      try {
        watcher = fsWatch(absPath, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            try {
              const current = readFileSync(absPath, 'utf-8');
              if (lastWrittenYaml !== null && current === lastWrittenYaml) return;
              lastWrittenYaml = null;
              rawYaml = current;
              const parsed = interpolateEnvVarsDeep(parseYaml(current) ?? {}) as Record<string, unknown>;
              onChange(parsed as AalisConfig);
            } catch {
              /* 文件可能被部分写入，忽略 */
            }
          }, 300);
        });
      } catch {
        /* 平台不支持 watch */
      }

      return () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        watcher?.close();
        watcher = null;
      };
    },
  };

  return { config: initialConfig, provider, dataDir };
}

// ============================================================
// FsPluginLoader —— 扫描目录 + dynamic import
// ============================================================

/**
 * 创建一个基于 packages 目录扫描的 PluginLoader。
 *
 * - `discover()`：读 dir 下每个子目录的 package.json，按 aalis-plugin 关键词收录可加载插件
 * - `load()`：用 `pathToFileURL(entry).href` 动态 import
 * - `reload()`：用入口文件 mtime 作为 import URL 的 query 强制 ESM 缓存失效
 */
export function createFsPluginLoader(packagesDir?: string): PluginLoader {
  const rootDir = packagesDir ?? resolve(process.cwd(), 'packages');

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
        if (!isLoadablePlugin(pkgJson)) continue;
        const main = (pkgJson.main as string) || 'dist/index.js';
        discovered.push({
          name: pkgJson.name as string,
          source: resolve(rootDir, entry, main),
          metadata: { dir: resolve(rootDir, entry) },
        });
      }
      return discovered;
    },

    async load(desc): Promise<PluginModule | null> {
      const mod = (await import(pathToFileURL(desc.source).href)) as PluginModule;
      return mod;
    },

    async reload(desc): Promise<PluginModule | null> {
      let cacheKey = '';
      try {
        cacheKey = `?t=${(await stat(desc.source)).mtimeMs}`;
      } catch {
        /* stat 失败时用空 key，让 import 自己报错 */
      }
      const mod = (await import(pathToFileURL(desc.source).href + cacheKey)) as PluginModule;
      return mod;
    },
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
  /**
   * 等待子进程 IPC ready 的超时（毫秒，默认 30000）。
   *
   * **超时按成功处理**——不发 ready 的旧 runtime 必须仍能重启。真正的失败信号是
   * 「子进程在 ready 之前退出」，不是超时。
   */
  readyTimeoutMs?: number;
}

/**
 * 从 execArgv 里解析出 `--env-file` / `--env-file-if-exists` 指向的文件路径。
 * 两种写法都要认：`--env-file=x` 与 `--env-file x`。纯函数，便于单测。
 */
export function parseEnvFileArgs(execArgv: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i];
    const inline = /^--env-file(?:-if-exists)?=(.+)$/.exec(a);
    if (inline) files.push(inline[1]);
    else if (/^--env-file(?:-if-exists)?$/.test(a) && execArgv[i + 1]) files.push(execArgv[++i]);
  }
  return files;
}

/** 极简 dotenv 解析：`KEY=VALUE`，容忍 `export ` 前缀、行内注释外的引号包裹。纯函数。 */
export function parseDotenvKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out.set(m[1], m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2'));
  }
  return out;
}

/**
 * 算出「本进程环境里，哪些键的值确实来自 env 文件」。
 *
 * 为什么需要：Node 的 `--env-file` **不覆盖环境里已存在的键**（已实测）。而重生子进程
 * 会继承父进程解析后的 `process.env`，于是那些键在子进程里已经"存在"，`--env-file`
 * 便不再写入——「改完 .env 再重启」永远读到旧值，仅保留 execArgv 是不够的。
 *
 * 判据取「当前值 == 文件里的值」而非「文件里有这个键」：若用户在 shell 里显式覆盖了
 * 某个键（Node 让 shell 赢），两者不等 → 不算文件所有 → 重生时保留 shell 值，
 * 优先级语义不被这项修复改变。
 */
export function envKeysOwnedByFile(
  execArgv: readonly string[],
  env: NodeJS.ProcessEnv,
  readText: (p: string) => string | undefined,
): Set<string> {
  const owned = new Set<string>();
  for (const file of parseEnvFileArgs(execArgv)) {
    const text = readText(file);
    if (text === undefined) continue;
    for (const [k, v] of parseDotenvKeys(text)) {
      if (env[k] === v) owned.add(k);
    }
  }
  return owned;
}

/** 组装重生用的 exec + argv。分离出来是为了单测覆盖 execArgv 保留。 */
export function buildRespawnCommand(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
  cwd: string = process.cwd(),
): { exec: string; args: string[] } {
  const scriptFile = argv[1];
  if (scriptFile?.endsWith('.ts')) {
    // tsx 是包装脚本，node 层 flag 由它自己转交，不能塞在它前面。
    const tsxBin = resolve(cwd, 'node_modules', '.bin', 'tsx');
    return { exec: existsSync(tsxBin) ? tsxBin : 'tsx', args: [...argv.slice(1)] };
  }
  // execArgv 不在 argv 里：`node --env-file-if-exists=.env dist/start.js` 的
  // `--env-file-if-exists` 只出现在 execArgv。不透传的话，脚手架启动脚本的 .env 加载与
  // 用户自加的 --max-old-space-size 会在重启后静默失效。
  const [exec, ...rest] = argv;
  return { exec: exec ?? process.execPath, args: [...execArgv, ...rest] };
}

/**
 * Node 进程重启策略：spawn 一个 detached 子进程接管，确认其起得来后再退出当前进程。
 *
 * 时序：
 * 1. 等 500ms 让正在飞行的 HTTP/WS 响应有机会先返回客户端
 * 2. 调 `stop()` 优雅停掉当前 App；**抛错也继续**——否则进程会停在「插件已半拆、
 *    HTTP 已关、但还活着」的僵尸态，而脚手架不生成 supervisor，无人可救
 * 3. spawn 新进程（保留 execArgv、剔除 env 文件所有的键，带 IPC 通道）
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
export function createProcessRespawnStrategy(opts: RespawnOptions = {}): RestartStrategy {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  let restarting = false;

  // 启动时（而非重启时）快照：此刻 process.env 还是本进程启动时解析出来的那一份，
  // 能准确判定哪些键的值来自 env 文件。重启时文件可能已被用户改过，那时再比就错了。
  const envFileOwnedKeys = envKeysOwnedByFile(process.execArgv, process.env, p => {
    try {
      return readFileSync(resolve(process.cwd(), p), 'utf-8');
    } catch {
      return undefined;
    }
  });

  /** 子进程环境：剔掉 env 文件所有的键，让新进程的 `--env-file` 能重新写入最新值。 */
  function childEnv(): NodeJS.ProcessEnv {
    if (envFileOwnedKeys.size === 0) return process.env;
    const env = { ...process.env };
    for (const k of envFileOwnedKeys) delete env[k];
    return env;
  }

  function spawnChild(withIpc: boolean): ReturnType<typeof spawn> {
    const { exec, args } = buildRespawnCommand();
    return spawn(exec, args, {
      cwd: process.cwd(),
      stdio: withIpc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      detached: true,
      env: childEnv(),
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
        await new Promise<void>(r => {
          const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
          p.on('exit', () => r());
          p.on('error', err => {
            console.error('[aalis] 回滚命令执行失败:', err);
            r();
          });
        });
      }
      const revived = spawnChild(false);
      revived.unref();
      console.error('[aalis] 已回滚并重新启动旧版本。');
      process.exit(1);
    },
  };
}
