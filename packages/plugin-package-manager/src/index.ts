import type { AppService, Context } from '@aalis/core';
import { createProcessGateway, type ExecResult, type ProcessService } from '@aalis/plugin-process-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-package-manager';
export const displayName = '包管理器';
export const subsystem = 'system';
export const provides = ['package-manager'];
export const inject = {
  required: ['process'],
};

// ===== 服务接口 =====

/**
 * 包管理服务：从 npm 安装/卸载插件到 packages/ 目录
 *
 * 通过 `ctx.getService<PackageManagerService>('package-manager')` 消费。
 *
 * 这些操作涉及子进程（npm/tar/pnpm/rm），不属于 core 内核职责，
 * 因此从 App 抽出到独立插件；底层子进程统一走 plugin-process-api。
 */
export interface PackageManagerService {
  /** 从 npm 安装插件到 packages/ 并触发 rescanPlugins */
  install(npmPkg: string): Promise<{ ok: boolean; message: string }>;
  /** 停用并删除 packages/ 下对应目录 */
  uninstall(pluginName: string): Promise<{ ok: boolean; message: string }>;
}

// ===== 实现 =====

/**
 * 解析 `npm pack --json` 的输出 → 产物 {filename, name}。
 * npm pack --json 输出形如 `[{"filename":"scope-foo-1.2.3.tgz","name":"@scope/foo",...}]`。
 * 部分 npm 版本会在 JSON 前混入 notice，故定位首个 `[` 起截取。纯函数，便于单测。
 */
export function parsePackInfo(jsonOut: string): { filename: string; name: string } | undefined {
  try {
    const start = jsonOut.indexOf('[');
    if (start < 0) return undefined;
    const arr = JSON.parse(jsonOut.slice(start)) as Array<{ filename?: string; name?: string }>;
    const first = arr?.[0];
    if (!first?.filename || !first?.name) return undefined;
    return { filename: first.filename, name: first.name };
  } catch {
    return undefined;
  }
}

/** 短命令（mkdir/tar/rm/test/npm pack）的超时。 */
const QUICK_TIMEOUT_MS = 120_000;
/**
 * 安装类命令的超时。`npm install` 要装全依赖树 + 原生编译（better-sqlite3、puppeteer
 * 都在脚手架默认依赖里），快机快网下已达 95 秒量级，而超时行为是 SIGKILL——留足余量，
 * 否则会在半装状态下被杀。
 */
const INSTALL_TIMEOUT_MS = 600_000;

async function execProc(
  proc: ProcessService,
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number = QUICK_TIMEOUT_MS,
): Promise<string> {
  try {
    const result: ExecResult = await proc.execFile(cmd, args, { cwd, timeout });
    return result.stdout;
  } catch (err) {
    const withResult = err as { result?: ExecResult } & Error;
    const stderr = withResult.result?.stderr ?? '';
    throw new Error(stderr || withResult.message);
  }
}

/**
 * 部署形态。两者的安装语义完全不同，装错地方 = 装了不加载。
 *
 * - `workspace`：本仓库式自托管。包落 `packages/<dir>`，由 `createFsPluginLoader` 扫描；
 *   根依赖用 `workspace:` 协议。
 * - `standalone`：`create-aalis` 产出的脚手架（**第一等公民**）。包落 `node_modules/`，
 *   由 `createNodeModulesPluginLoader` **只读根 `dependencies`** 发现；不写
 *   `pnpm-workspace.yaml`、不建 `packages/`。
 */
export type ProjectLayout = 'workspace' | 'standalone';

/**
 * 判别形态：`pnpm-workspace.yaml` 是工作区的权威标志——脚手架产出物只有
 * package.json / index.mjs / aalis.config.yaml / .env.example / .gitignore / README.md
 * 六个文件，不含它。
 */
export function layoutFromWorkspaceFile(hasWorkspaceFile: boolean): ProjectLayout {
  return hasWorkspaceFile ? 'workspace' : 'standalone';
}

/**
 * 根依赖里是否含 `workspace:` 协议。
 *
 * 这是 standalone 分支跑 `npm install` 前的**硬护栏**：npm 遇到该协议会
 * `EUNSUPPORTEDPROTOCOL` 硬失败；但若哪天根依赖恰好没有该协议，`npm install` 会在
 * pnpm 仓库根写出 `package-lock.json` 与扁平 `node_modules`，把整个工作区搅坏。
 * 故不能指望 npm 兜底，必须自己先判。纯函数，便于单测。
 */
export function hasWorkspaceProtocol(pkgJson: Record<string, unknown> | undefined): boolean {
  if (!pkgJson) return false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkgJson[field];
    if (!block || typeof block !== 'object') continue;
    for (const v of Object.values(block as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith('workspace:')) return true;
    }
  }
  return false;
}

/**
 * 包是否声明自己是可加载插件（与两个加载器同一判据：纯 `aalis-plugin` 关键词正向门）。
 *
 * 用途是把「装完没发现新插件」分成两种情形：目标本就不是插件（如 `aalis-interface`
 * 前端包）→ 正常；目标声明了自己是插件却没被发现 → **静默假成功**，必须报失败。
 * 纯函数，便于单测。
 */
export function declaresPlugin(pkgJson: Record<string, unknown> | undefined): boolean {
  const kw = pkgJson?.keywords;
  return Array.isArray(kw) && kw.includes('aalis-plugin');
}

function createService(ctx: Context, config: Record<string, unknown>): PackageManagerService {
  const log = ctx.logger;
  const proc = createProcessGateway(ctx);

  function getApp(): AppService {
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('app 服务不可用，无法执行包管理操作');
    return app;
  }

  /**
   * 真实插件目录的绝对路径。
   *
   * 必须与 core 的 createFsPluginLoader 一致——后者扫描 `<cwd>/packages`。
   * 关键：**不能**走 storage 的 `workspace:` 根（那是 agent 沙盒 `<cwd>/workspace`，
   * 与插件目录 `<cwd>/packages` 不是同一处），否则装到/找错地方（历史 bug：
   * 卸载报"目录不存在"）。可用插件配置 `packagesDir` 覆盖（相对 cwd 或绝对路径）。
   */
  function packagesDir(): string {
    const override = (config as { packagesDir?: unknown }).packagesDir;
    const base = process.cwd();
    if (typeof override === 'string' && override.length > 0) {
      return override.startsWith('/') ? override : `${base}/${override.replace(/^\.?\/+/, '')}`;
    }
    return `${base}/packages`;
  }

  return createPackageManager({
    proc,
    log,
    packagesDir,
    // 项目根 = cwd：与 createNodeModulesPluginLoader(projectDir = process.cwd()) 的默认
    // 以及 packagesDir() 的基准同源，三者必须指同一处，否则「写的 package.json」与
    // 「加载器读的 package.json」会是两份。
    projectRoot: () => process.cwd(),
    // 经 process 网关的 readExternalFile 读，而非 node:fs：目标（项目根 package.json、
    // node_modules/<pkg>/package.json）在 storage 沙盒之外，而 readExternalFile 正是
    // 文档给这一场景指定的「OS 直通读外部路径」通道——本插件也不在 biome 的 node:* 例外清单里。
    readJson: async absPath => {
      try {
        const bytes = await proc.readExternalFile(absPath);
        return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    },
    rescanPlugins: () => getApp().rescanPlugins(),
    // 彻底卸载：dispose 上下文并从注册表移除（plugins 服务缺席则 no-op）。
    // 区别于 disablePlugin（仅置禁用态，仍滞留在插件列表里）。
    unloadPlugin: async name => {
      const pm = ctx.getService<{ unload(n: string): Promise<void> }>('plugins');
      if (pm) await pm.unload(name);
    },
    // 卸载后清残留配置：删 plugins.<name> 配置块 + 从 disabledPlugins 移除
    // （否则重装会被"上次禁用"标记带成已禁用状态），并持久化。
    cleanupConfig: name => {
      ctx.config.removePluginConfig(name);
      ctx.config.setPluginEnabled(name, true);
      ctx.config.save();
    },
  });
}

/** install/uninstall 的显式依赖（从 ctx/网关解耦，便于集成测试） */
export interface PackageManagerDeps {
  proc: ProcessService;
  log: { info(msg: string): void; error(msg: string): void };
  /** 真实插件目录绝对路径（= `<cwd>/packages`，与 FS 加载器一致）。仅 workspace 形态用到。 */
  packagesDir(): string;
  /** 项目根绝对路径（= `<cwd>`）：形态探测、根 package.json 读取、npm 的 cwd。 */
  projectRoot(): string;
  /** 读 JSON 文件；不存在或解析失败返回 undefined。注入以便单测。 */
  readJson(absPath: string): Promise<Record<string, unknown> | undefined>;
  rescanPlugins(): Promise<string[]>;
  /** 彻底卸载插件（dispose + 从注册表移除）。plugins 服务缺席则 no-op。 */
  unloadPlugin(name: string): Promise<void>;
  /** 卸载后清理残留配置（删配置块 + 解除禁用标记 + 持久化）。可选：缺省则不清理。 */
  cleanupConfig?(name: string): void;
}

/** `@scope/foo@1.2.3` → `@scope/foo`（剥掉版本后缀，保留 scope）。 */
export function stripVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * 包管理核心：install/uninstall 的纯依赖实现（不碰 ctx/网关，可单测）。
 * 所有文件操作走 process 网关（子进程：npm/tar/mkdir/rm/test），目标是真实
 * `<cwd>/packages`——不经 storage 沙盒（沙盒根是 workspace，够不到 packages）。
 * ctx 组装层见 createService。
 */
export function createPackageManager(deps: PackageManagerDeps): PackageManagerService {
  const { proc, log } = deps;

  /** 路径存在性：`test -d|-f <abs>`（不存在 → exit 1 → 抛 → false）。绝对路径，cwd 无关。 */
  async function pathExists(absPath: string, kind: 'd' | 'f'): Promise<boolean> {
    try {
      await proc.execFile('test', [`-${kind}`, absPath], { cwd: process.cwd(), timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async function detectLayout(): Promise<ProjectLayout> {
    return layoutFromWorkspaceFile(await pathExists(`${deps.projectRoot()}/pnpm-workspace.yaml`, 'f'));
  }

  /**
   * 装完的统一判定：rescan 出新插件即成功；没出新插件时按目标是否**声明自己是插件**分流。
   * 「声明了插件却没被发现」正是那条静默假成功——必须报失败，否则用户看到 ok 却什么也没装上。
   */
  async function settleInstall(
    npmPkg: string,
    installedPkgJsonPath: string,
    where: string,
  ): Promise<{ ok: boolean; message: string }> {
    const newPlugins = await deps.rescanPlugins();
    if (newPlugins.length > 0) return { ok: true, message: `已安装并加载: ${newPlugins.join(', ')}` };
    const meta = await deps.readJson(installedPkgJsonPath);
    if (declaresPlugin(meta)) {
      return { ok: false, message: `已装到 ${where}，但它声明为插件却未被加载——请检查其 keywords 与入口导出` };
    }
    return { ok: true, message: `已安装 ${stripVersion(npmPkg)}（非插件包，不进入插件列表）` };
  }

  /** standalone：写根 `dependencies`——这是 node_modules 加载器**唯一**的发现来源。 */
  async function installStandalone(npmPkg: string): Promise<{ ok: boolean; message: string }> {
    const root = deps.projectRoot();
    const rootPkg = await deps.readJson(`${root}/package.json`);
    if (hasWorkspaceProtocol(rootPkg)) {
      return {
        ok: false,
        message: '根依赖含 workspace: 协议，拒绝在此运行 npm install（会写出 package-lock.json 并搅坏 pnpm 工作区）',
      };
    }
    log.info(`正在安装: ${npmPkg} → 根依赖 + node_modules`);
    await execProc(proc, 'npm', ['install', npmPkg, '--no-audit', '--no-fund'], root, INSTALL_TIMEOUT_MS);
    const bare = stripVersion(npmPkg);
    return settleInstall(npmPkg, `${root}/node_modules/${bare}/package.json`, 'node_modules');
  }

  /** workspace：解包到 `packages/<dir>` 再 `pnpm install --filter` 链接（本仓库自托管形态）。 */
  async function installWorkspace(npmPkg: string): Promise<{ ok: boolean; message: string }> {
    const packagesDir = deps.packagesDir();
    // 分离包名与可选版本：@scope/foo@1.2.3 → dirName=foo（去 scope、去版本）
    const dirName = npmPkg.replace(/^@[^/]+\//, '').replace(/@[^@]+$/, '');
    const targetDir = `${packagesDir}/${dirName}`;

    if (await pathExists(targetDir, 'd')) return { ok: false, message: `目录 ${dirName} 已存在` };
    log.info(`正在安装插件: ${npmPkg} → packages/${dirName}`);

    let tgzPath: string | undefined;
    try {
      await execProc(proc, 'mkdir', ['-p', packagesDir], process.cwd()); // 确保 packages/ 存在
      // npm pack --json 精确返回产物 {filename, name}，避免 includes 误匹配
      // （装 foo 时命中 foo-bar-*.tgz）；name 是精确包名，供 pnpm --filter 用。
      const packOut = await execProc(
        proc,
        'npm',
        ['pack', npmPkg, '--pack-destination', packagesDir, '--json'],
        process.cwd(),
      );
      const packInfo = parsePackInfo(packOut);
      if (!packInfo) return { ok: false, message: '下载包失败: 未能解析 npm pack 产物' };
      tgzPath = `${packagesDir}/${packInfo.filename}`;
      await execProc(proc, 'mkdir', ['-p', targetDir], process.cwd());
      await execProc(proc, 'tar', ['xzf', tgzPath, '-C', targetDir, '--strip-components=1'], process.cwd());
      await execProc(proc, 'rm', ['-f', tgzPath], process.cwd()); // 清理 tgz
      tgzPath = undefined; // 已删，回滚时不再尝试
      // --filter 用精确包名（npm pack 回报的 name，无版本后缀）链接新 workspace 包
      await execProc(proc, 'pnpm', ['install', '--filter', packInfo.name], process.cwd(), INSTALL_TIMEOUT_MS);

      return await settleInstall(npmPkg, `${targetDir}/package.json`, `packages/${dirName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`安装插件 "${npmPkg}" 失败: ${message}`);
      // 回滚：清理半成品 targetDir 与残留 tgz，避免占位导致下次"目录已存在"
      await execProc(proc, 'rm', ['-rf', targetDir], process.cwd()).catch(() => {});
      if (tgzPath) await execProc(proc, 'rm', ['-f', tgzPath], process.cwd()).catch(() => {});
      return { ok: false, message };
    }
  }

  return {
    async install(npmPkg) {
      const layout = await detectLayout();
      if (layout === 'workspace') return installWorkspace(npmPkg);
      try {
        return await installStandalone(npmPkg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`安装 "${npmPkg}" 失败: ${message}`);
        return { ok: false, message };
      }
    },

    async uninstall(pluginName) {
      const dirName = pluginName.replace(/^@[^/]+\//, '');
      // 安全闸：dirName 必须是合法 npm 包段名——杜绝路径穿越（如 `../../x`）导致
      // `rm -rf packages/../../x` 删到 packages 外的任意目录。
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(dirName)) {
        return { ok: false, message: `非法插件名（疑似路径穿越）: ${pluginName}` };
      }
      const layout = await detectLayout();
      try {
        let detail: string;
        if (layout === 'workspace') {
          const targetDir = `${deps.packagesDir()}/${dirName}`;
          const existed = await pathExists(targetDir, 'd');
          if (existed) await execProc(proc, 'rm', ['-rf', targetDir], process.cwd()); // 删目录，不再回来
          detail = existed ? `已删除 packages/${dirName}` : '目录原不存在，已从运行时移除';
        } else {
          // standalone：必须从根 dependencies 摘掉。只 dispose 运行时实例是不够的——
          // 依赖声明还在，下次启动加载器照样把它发现并装载回来。
          await execProc(
            proc,
            'npm',
            ['uninstall', pluginName, '--no-audit', '--no-fund'],
            deps.projectRoot(),
            INSTALL_TIMEOUT_MS,
          );
          detail = '已从根依赖与 node_modules 移除';
        }
        await deps.unloadPlugin(pluginName); // 从运行时注册表彻底移除（dispose + delete），幂等
        deps.cleanupConfig?.(pluginName); // 清残留配置
        log.info(`${pluginName}: ${detail}`);
        return { ok: true, message: `插件 ${pluginName} 已卸载（${detail}）` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  ctx.provide('package-manager', createService(ctx, config), {
    label: 'package-manager',
  });
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'package-manager': PackageManagerService;
  }
}
