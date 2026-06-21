import { spawn } from 'node:child_process';
import { existsSync, type FSWatcher, watch as fsWatch, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Node 进程重启策略：spawn 一个 detached 子进程沿用当前 argv，然后 `process.exit(0)`。
 *
 * 时序：
 * 1. 等 500ms 让正在飞行的 HTTP/WS 响应有机会先返回客户端
 * 2. 调 `stop()` 优雅停掉当前 App（关闭网关、断开适配器等）
 * 3. spawn 新进程 + `process.exit(0)`
 *
 * 对 .ts 入口（开发模式）会优先使用本地 `tsx` 二进制。
 */
export function createProcessRespawnStrategy(): RestartStrategy {
  return {
    async restart({ stop }) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await stop();
      const scriptFile = process.argv[1];
      let exec: string;
      let args: string[];
      if (scriptFile?.endsWith('.ts')) {
        const tsxBin = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
        exec = existsSync(tsxBin) ? tsxBin : 'tsx';
        args = process.argv.slice(1);
      } else {
        [exec, ...args] = process.argv;
      }
      const child = spawn(exec, args, {
        cwd: process.cwd(),
        stdio: 'inherit',
        detached: true,
        env: process.env,
      });
      child.unref();
      process.exit(0);
    },
  };
}
