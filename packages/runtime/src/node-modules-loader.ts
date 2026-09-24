import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger, PluginDefinition, PluginDescriptor, PluginLoader } from '@aalis/core';
import { DefaultLogger, pluginDefinitionOf } from '@aalis/core';

// ============================================================
// NodeModulesPluginLoader —— 从 node_modules 解析并加载插件
// ============================================================
//
// 独立部署（纯 npm 装 Aalis）用的加载器：不扫描 packages/ 目录，而是读项目
// package.json 的 dependencies，逐个用 node 模块解析（require.resolve）定位已装的
// @aalis 插件并 dynamic import。与 monorepo 的 createFsPluginLoader 是「两种部署
// 模型的两个加载器」，非重复：前者扫目录，后者走 node 解析。
//
// 插件识别（纯正向关键词门）：
//   - 唯一标准：package.json 的 keywords 含 'aalis-plugin'。
// 每类包各带自己的类型关键词（插件 aalis-plugin / 契约 aalis-api / 前端 aalis-interface / 工具库 aalis-util /
// 核心 aalis-core / 工具链 aalis-runtime，后几类均不带 aalis-plugin），所以 @aalis/core、各 *-api、webui-client、
// @aalis/runtime、各 util-* 与 express/yaml 等普通依赖都因不带 aalis-plugin 而自然不被加载——无需 marker 特判或名前缀/service 回退。

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 判定一个已装依赖是否为可加载的 Aalis 插件。纯函数，便于单测。
 * 唯一标准：keywords 含 'aalis-plugin'（真插件均带；契约/前端/核心/工具库带各自类型词，自然排除）。
 */
export function isLoadablePlugin(meta: Record<string, unknown>): boolean {
  const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
  return keywords.includes('aalis-plugin');
}

/**
 * 从已导入模块取出定义，并按加载器政策出声：形状不对必须 warn；定义 name 与包名不一致也必须点名。
 * 判定本身在 `@aalis/core` 的 `pluginDefinitionOf`；两加载器共用本包装，告警文案只有这一份。
 */
export function loadPluginDefinition(ns: unknown, pkgName: string, logger: Logger): PluginDefinition | null {
  const def = pluginDefinitionOf(ns);
  if (!def) {
    logger.warn(
      `插件 "${pkgName}" 的入口没有默认导出插件定义，将被跳过——入口须 \`export default definePlugin({ … })\``,
    );
    return null;
  }
  if (def.name !== pkgName) {
    logger.warn(`插件包 "${pkgName}" 的定义 name 为 "${def.name}"——配置键/热扫描/卸载均以定义的 name 为准，二者应一致`);
  }
  return def;
}

/**
 * 按 Node 的 node_modules 逐级上溯规则，找出从 `start` 目录解析到的 `@aalis/core` 包目录（realpath）。
 * 只看目录布局、不走 exports，结果不受入口条件影响；找不到返回 undefined。
 */
function coreDirFrom(start: string): string | undefined {
  for (let dir = realpathSync(start); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '@aalis', 'core');
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * 宿主那份 @aalis/core：runtime 用它创建 App，从本文件所在目录按同一规则算一次。
 * 算不到（如被打包内联、import.meta.url 不是文件 URL）为 undefined，检测随之跳过，不误报。
 */
export const HOST_CORE_DIR: string | undefined = (() => {
  try {
    return coreDirFrom(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return undefined;
  }
})();

/**
 * 插件解析到的 @aalis/core 不是宿主那份时拒绝加载该插件（抛错），须在 import 插件之前调用。
 *
 * 依赖树允许同名包存在多份，两份 core 同处一个进程会让进程级身份分裂（默认日志中枢、
 * instanceof 等）且不报任何错。最常见的来路是本地插件目录被装成符号链接：插件目录自带的
 * devDependencies 里那份 core 成了它运行时解析到的那份。错误由 App 逐插件接住记 error，
 * 其余插件照常加载。两加载器共用。
 *
 * @param hostCoreDir 宿主那份 core 的包目录（realpath）；undefined 时跳过
 * @param pluginDir 插件包目录，即两加载器 discover 写进描述符的 `metadata.dir`；缺失时跳过
 */
export function assertSameCore(hostCoreDir: string | undefined, pluginDir: unknown, pluginName: string): void {
  if (!hostCoreDir || typeof pluginDir !== 'string') return;
  const theirs = coreDirFrom(pluginDir);
  if (!theirs || theirs === hostCoreDir) return;
  const version = (dir: string) => String(readJson(join(dir, 'package.json'))?.version ?? '版本未知');
  throw new Error(
    `插件 "${pluginName}" 解析到另一份 @aalis/core（${version(theirs)}：${theirs}），` +
      `宿主用的是 ${version(hostCoreDir)}：${hostCoreDir}。@aalis/core 只能装一份：` +
      '插件应把 @aalis/core 写进 peerDependencies 而非 dependencies；本地目录安装改用 npm install --install-links 或 pnpm add file:；' +
      '排查用 npm query "#@aalis/core" / pnpm why @aalis/core',
  );
}

/**
 * 疑似插件缺关键词是「装了没反应」死门族之首：peer 依赖 core 却不带任何
 * aalis-* 类型词（契约/前端/工具库各有其词，带了即非误漏）。两加载器共用。
 */
export function warnLikelyPluginMissingKeyword(logger: Logger, name: string, meta: Record<string, unknown>): void {
  const peers = { ...(meta.peerDependencies as object), ...(meta.dependencies as object) };
  const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
  if ('@aalis/core' in peers && !keywords.some(k => k.startsWith('aalis-'))) {
    logger.warn(`依赖 "${name}" 疑似 Aalis 插件但 keywords 缺 "aalis-plugin"，不会被加载——若确为插件请补关键词`);
  }
}

/**
 * 创建一个从项目 node_modules 解析插件的 PluginLoader。
 *
 * @param projectDir 项目根目录（含 package.json 与 node_modules），默认 process.cwd()
 * @param opts.hostCoreDir 宿主那份 @aalis/core 的包目录，默认 {@link HOST_CORE_DIR}；插件解析到的 core 与它不同即拒绝加载
 *
 * - `discover()`：读 projectDir/package.json 的 dependencies + optionalDependencies，
 *   用 require.resolve 定位每个依赖的 package.json，按标记过滤出可加载插件。
 * - `load()`：先经 {@link assertSameCore} 核对 core 是宿主那份，再用 `pathToFileURL(entry).href` 动态 import（entry = require.resolve(包名)）。
 * - `reload()`：用入口文件 mtime 作 import URL query 强制 ESM 缓存失效。
 */
export function createNodeModulesPluginLoader(
  projectDir: string = process.cwd(),
  opts: { hostCoreDir?: string } = {},
): PluginLoader {
  const root = resolve(projectDir);
  const hostCoreDir = opts.hostCoreDir === undefined ? HOST_CORE_DIR : realpathSync(opts.hostCoreDir);
  // 以项目 package.json 为基准创建 require，确保从项目 node_modules 解析
  const req = createRequire(pathToFileURL(resolve(root, 'package.json')));
  const logger = new DefaultLogger('aalis:loader');

  return {
    async discover(): Promise<PluginDescriptor[]> {
      const rootPkg = readJson(resolve(root, 'package.json'));
      if (!rootPkg) return [];
      const deps = {
        ...((rootPkg.dependencies as Record<string, string>) ?? {}),
        ...((rootPkg.optionalDependencies as Record<string, string>) ?? {}),
      };

      const discovered: PluginDescriptor[] = [];
      for (const dep of Object.keys(deps)) {
        let metaPath: string;
        try {
          metaPath = req.resolve(`${dep}/package.json`);
        } catch (err) {
          // 未安装保持安静；但 exports 映射屏蔽 package.json 的包（装了却读不到
          // 元数据）是链上最早的静默死点——无法判定是否插件，必须出声。
          if ((err as NodeJS.ErrnoException).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
            logger.warn(`依赖 "${dep}" 的 exports 映射未导出 "./package.json"，无法读取元数据判定是否插件，跳过`);
          }
          continue;
        }
        const meta = readJson(metaPath);
        if (!meta) continue;
        if (!isLoadablePlugin(meta)) {
          warnLikelyPluginMissingKeyword(logger, dep, meta);
          continue;
        }
        let entry: string;
        try {
          entry = req.resolve(dep);
        } catch {
          logger.warn(`插件 "${dep}" 入口无法解析（缺 main/exports 或产物未打进 files），跳过`);
          continue;
        }
        discovered.push({
          name: (meta.name as string) ?? dep,
          source: entry,
          metadata: { dir: dirname(metaPath) },
        });
      }
      return discovered;
    },

    async load(desc): Promise<PluginDefinition | null> {
      assertSameCore(hostCoreDir, desc.metadata?.dir, desc.name);
      return loadPluginDefinition(await import(pathToFileURL(desc.source).href), desc.name, logger);
    },

    async reload(desc): Promise<PluginDefinition | null> {
      assertSameCore(hostCoreDir, desc.metadata?.dir, desc.name);
      let cacheKey = '';
      try {
        cacheKey = `?t=${(await stat(desc.source)).mtimeMs}`;
      } catch {
        /* stat 失败时用空 key，让 import 自己报错 */
      }
      return loadPluginDefinition(await import(pathToFileURL(desc.source).href + cacheKey), desc.name, logger);
    },
  };
}
