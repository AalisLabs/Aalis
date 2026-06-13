import type { AppService, Context } from '@aalis/core';
import { createProcessGateway, type ExecResult, type ProcessService } from '@aalis/plugin-process-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-package-manager';
export const displayName = '包管理器';
export const subsystem = 'system';
export const provides = ['package-manager'];
export const inject = {
  required: ['process', 'storage'],
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

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    'package-manager': 'install' | 'uninstall';
  }
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

async function execProc(proc: ProcessService, cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const result: ExecResult = await proc.execFile(cmd, args, { cwd, timeout: 120_000 });
    return result.stdout;
  } catch (err) {
    const withResult = err as { result?: ExecResult } & Error;
    const stderr = withResult.result?.stderr ?? '';
    throw new Error(stderr || withResult.message);
  }
}

function createService(ctx: Context, config: Record<string, unknown>): PackageManagerService {
  const log = ctx.logger;
  const proc = createProcessGateway(ctx);
  const storage: StorageService = createStorageGateway(ctx);

  function getApp(): AppService {
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('app 服务不可用，无法执行包管理操作');
    return app;
  }

  /**
   * 解析 packages/ 的 storage URI 与本地绝对路径。
   *
   * 与 core 的 createFsPluginLoader 默认一致：`workspace:/packages`。
   * 可通过插件配置 `packagesDir` 字段覆盖（必须是 storage URI 或 workspace 下的相对路径）。
   */
  function packagesUri(): string {
    const override = (config as { packagesDir?: unknown }).packagesDir;
    if (typeof override === 'string' && override.length > 0) {
      if (override.includes(':/')) return override;
      return `workspace:/${override.replace(/^\.?\/+/, '')}`;
    }
    return 'workspace:/packages';
  }

  async function packagesLocal(): Promise<string> {
    const uri = packagesUri();
    if (!storage.resolveLocalPath) {
      throw new Error('storage 服务未实现 resolveLocalPath，无法执行包管理操作');
    }
    return storage.resolveLocalPath(uri, 'write');
  }

  return createPackageManager({
    proc,
    storage,
    log,
    packagesUri,
    packagesLocal,
    rescanPlugins: () => getApp().rescanPlugins(),
    // plugins 服务可能未启用：缺席即跳过实例停用（仅删目录）
    disablePlugin: async name => {
      const pm = ctx.getService<{ disablePlugin(n: string): Promise<boolean> }>('plugins');
      if (pm) await pm.disablePlugin(name);
    },
  });
}

/** install/uninstall 的显式依赖（从 ctx/网关解耦，便于集成测试） */
export interface PackageManagerDeps {
  proc: ProcessService;
  storage: Pick<StorageService, 'stat' | 'delete'>;
  log: { info(msg: string): void; error(msg: string): void };
  packagesUri(): string;
  packagesLocal(): Promise<string>;
  rescanPlugins(): Promise<string[]>;
  disablePlugin(name: string): Promise<void>;
}

/**
 * 包管理核心：install/uninstall 的纯依赖实现（不碰 ctx/网关，可单测）。
 * ctx 组装层见 createService。
 */
export function createPackageManager(deps: PackageManagerDeps): PackageManagerService {
  const { proc, storage, log } = deps;

  async function dirExists(uri: string): Promise<boolean> {
    try {
      await storage.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async install(npmPkg) {
      const packagesDir = await deps.packagesLocal();
      // 分离包名与可选版本：@scope/foo@1.2.3 → dirName=foo（去 scope、去版本）
      const dirName = npmPkg.replace(/^@[^/]+\//, '').replace(/@[^@]+$/, '');
      const targetUri = `${deps.packagesUri()}/${dirName}`;
      const targetDir = `${packagesDir}/${dirName}`;

      if (await dirExists(targetUri)) {
        return { ok: false, message: `目录 ${dirName} 已存在` };
      }
      log.info(`正在安装插件: ${npmPkg} → packages/${dirName}`);

      let tgzName: string | undefined;
      try {
        // npm pack --json 精确返回产物 {filename, name}，避免 includes 误匹配
        // （装 foo 时命中 foo-bar-*.tgz）；name 是精确包名，供 pnpm --filter 用。
        const packOut = await execProc(
          proc,
          'npm',
          ['pack', npmPkg, '--pack-destination', packagesDir, '--json'],
          packagesDir,
        );
        const packInfo = parsePackInfo(packOut);
        if (!packInfo) return { ok: false, message: '下载包失败: 未能解析 npm pack 产物' };
        tgzName = packInfo.filename;
        const tgzPath = `${packagesDir}/${tgzName}`;
        await execProc(proc, 'mkdir', ['-p', targetDir], packagesDir);
        await execProc(proc, 'tar', ['xzf', tgzPath, '-C', targetDir, '--strip-components=1'], packagesDir);
        await storage.delete(`${deps.packagesUri()}/${tgzName}`).catch(() => {}); // 清理 tgz
        tgzName = undefined; // 已删，回滚时不再尝试
        // --filter 用精确包名（npm pack 回报的 name，无版本后缀）链接新 workspace 包
        await execProc(proc, 'pnpm', ['install', '--filter', packInfo.name], process.cwd());

        const newPlugins = await deps.rescanPlugins();
        return newPlugins.length > 0
          ? { ok: true, message: `已安装并加载: ${newPlugins.join(', ')}` }
          : { ok: true, message: `已安装到 packages/${dirName}，但未发现新插件` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`安装插件 "${npmPkg}" 失败: ${message}`);
        // 回滚：清理半成品 targetDir 与残留 tgz，避免占位导致下次"目录已存在"
        await storage.delete(targetUri).catch(() => {});
        if (tgzName) await storage.delete(`${deps.packagesUri()}/${tgzName}`).catch(() => {});
        return { ok: false, message };
      }
    },

    async uninstall(pluginName) {
      await deps.disablePlugin(pluginName); // 先停用实例（plugins 服务缺席则 no-op）
      const dirName = pluginName.replace(/^@[^/]+\//, '');
      const targetUri = `${deps.packagesUri()}/${dirName}`;
      if (!(await dirExists(targetUri))) {
        return { ok: true, message: `插件 ${pluginName} 已卸载（目录不存在）` };
      }
      try {
        await storage.delete(targetUri);
        log.info(`已删除插件目录: packages/${dirName}`);
        return { ok: true, message: `插件 ${pluginName} 已卸载并删除` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  ctx.provide('package-manager', createService(ctx, config), {
    capabilities: ['install', 'uninstall'],
    label: 'package-manager',
  });
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'package-manager': PackageManagerService;
  }
}
