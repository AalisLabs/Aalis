import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger, PluginDescriptor, PluginLoader, PluginModule } from '@aalis/core';
import { DefaultLogger } from '@aalis/core';

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
 * ESM 命名空间可能把插件挂在 default 上（`export default {...}`）——此前该形态
 * 会被加载判据静默拒收（作者最自然的写法=永不加载的死门）。解包后统一交判据。
 */
export function unwrapPluginModule(ns: unknown): PluginModule {
  const mod = ns as PluginModule & { default?: PluginModule };
  // default 必须是**对象**才解包：函数/类天然继承 Function.prototype.apply，
  // 只查 .apply 会把 `export default function/class` 误当插件解包——core 随后
  // 调用的是 Function.prototype.apply，插件体以 ctx=undefined 空跑并被标记
  // 已激活（比修前的静默不装更坏）。对象判据下这两种形态落回命名空间，
  // 由 warnShape 发正确的「缺少具名导出」告警。
  return typeof mod?.apply !== 'function' &&
    typeof mod?.default === 'object' &&
    mod.default !== null &&
    typeof mod.default.apply === 'function'
    ? mod.default
    : mod;
}

/** 加载后形状告警：违例此前完全静默（仅 core 一行 debug），是「装了没反应」死门族。两加载器共用。 */
export function warnShape(logger: Logger, pkgName: string, mod: PluginModule): void {
  if (!mod?.name || typeof mod?.apply !== 'function') {
    logger.warn(
      `插件 "${pkgName}" 缺少具名导出 name/apply，将被跳过——入口须具名导出这两者，` +
        `或 default 导出一个 { name, apply } 对象（default 为函数/类不属插件契约，不会被解包）`,
    );
  } else if (mod.name !== pkgName) {
    logger.warn(
      `插件包 "${pkgName}" 的 module.name 为 "${mod.name}"——配置键/热扫描/卸载均以 module.name 为准，二者应一致`,
    );
  }
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
 *
 * - `discover()`：读 projectDir/package.json 的 dependencies + optionalDependencies，
 *   用 require.resolve 定位每个依赖的 package.json，按标记过滤出可加载插件。
 * - `load()`：用 `pathToFileURL(entry).href` 动态 import（entry = require.resolve(包名)）。
 * - `reload()`：用入口文件 mtime 作 import URL query 强制 ESM 缓存失效。
 */
export function createNodeModulesPluginLoader(projectDir: string = process.cwd()): PluginLoader {
  const root = resolve(projectDir);
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

    async load(desc): Promise<PluginModule | null> {
      const mod = unwrapPluginModule(await import(pathToFileURL(desc.source).href));
      warnShape(logger, desc.name, mod);
      return mod;
    },

    async reload(desc): Promise<PluginModule | null> {
      let cacheKey = '';
      try {
        cacheKey = `?t=${(await stat(desc.source)).mtimeMs}`;
      } catch {
        /* stat 失败时用空 key，让 import 自己报错 */
      }
      const mod = unwrapPluginModule(await import(pathToFileURL(desc.source).href + cacheKey));
      warnShape(logger, desc.name, mod);
      return mod;
    },
  };
}
