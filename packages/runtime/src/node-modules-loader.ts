import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginDescriptor, PluginLoader, PluginModule } from '@aalis/core';

// ============================================================
// NodeModulesPluginLoader —— 从 node_modules 解析并加载插件
// ============================================================
//
// 独立部署（纯 npm 装 Aalis）用的加载器：不扫描 packages/ 目录，而是读项目
// package.json 的 dependencies，逐个用 node 模块解析（require.resolve）定位已装的
// @aalis 插件并 dynamic import。与 monorepo 的 createFsPluginLoader 是「两种部署
// 模型的两个加载器」，非重复：前者扫目录，后者走 node 解析。
//
// 插件识别（正信号 + 排除标记）：
//   - 排除：package.json 的 aalis.{core,types,client,tooling} 标记（核心/契约/前端/工具链）
//   - 收录：keywords 含 'aalis-plugin'（市场约定）∪ 名称匹配 @aalis/plugin-* ∪ 有 aalis.service/subsystem
// 这样 @aalis/core、各 *-api（types）、webui-client（client）、@aalis/runtime（tooling）
// 与 express/yaml 等普通依赖都不会被误当插件加载。

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 判定一个已装依赖是否为可加载的 Aalis 插件。纯函数，便于单测。
 * 排除核心/契约/前端/工具链标记；收录有 aalis-plugin 关键词或 @aalis/plugin-* 名或 service/subsystem。
 */
export function isLoadablePlugin(name: string, meta: Record<string, unknown>): boolean {
  const aalis = (meta.aalis ?? {}) as Record<string, unknown>;
  if (aalis.core || aalis.types || aalis.client || aalis.tooling) return false;
  const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
  return (
    keywords.includes('aalis-plugin') ||
    /^@aalis\/plugin-/.test(name) ||
    aalis.service !== undefined ||
    aalis.subsystem !== undefined
  );
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
        } catch {
          continue; // 未安装或无法解析，跳过
        }
        const meta = readJson(metaPath);
        if (!meta || !isLoadablePlugin(dep, meta)) continue;
        let entry: string;
        try {
          entry = req.resolve(dep);
        } catch {
          continue; // 解析不到入口（如缺 main/exports），跳过
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
      return (await import(pathToFileURL(desc.source).href)) as PluginModule;
    },

    async reload(desc): Promise<PluginModule | null> {
      let cacheKey = '';
      try {
        cacheKey = `?t=${(await stat(desc.source)).mtimeMs}`;
      } catch {
        /* stat 失败时用空 key，让 import 自己报错 */
      }
      return (await import(pathToFileURL(desc.source).href + cacheKey)) as PluginModule;
    },
  };
}
