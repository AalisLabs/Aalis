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
  /** 真实插件目录绝对路径（= `<cwd>/packages`，与 FS 加载器一致） */
  packagesDir(): string;
  rescanPlugins(): Promise<string[]>;
  /** 彻底卸载插件（dispose + 从注册表移除）。plugins 服务缺席则 no-op。 */
  unloadPlugin(name: string): Promise<void>;
  /** 卸载后清理残留配置（删配置块 + 解除禁用标记 + 持久化）。可选：缺省则不清理。 */
  cleanupConfig?(name: string): void;
}

/**
 * 包管理核心：install/uninstall 的纯依赖实现（不碰 ctx/网关，可单测）。
 * 所有文件操作走 process 网关（子进程：npm/tar/mkdir/rm/test），目标是真实
 * `<cwd>/packages`——不经 storage 沙盒（沙盒根是 workspace，够不到 packages）。
 * ctx 组装层见 createService。
 */
export function createPackageManager(deps: PackageManagerDeps): PackageManagerService {
  const { proc, log } = deps;

  // 目录存在性：`test -d <abs>`（不存在/非目录 → exit 1 → 抛 → false）。绝对路径，cwd 无关。
  async function dirExists(absPath: string): Promise<boolean> {
    try {
      await proc.execFile('test', ['-d', absPath], { cwd: process.cwd(), timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  return {
    async install(npmPkg) {
      const packagesDir = deps.packagesDir();
      // 分离包名与可选版本：@scope/foo@1.2.3 → dirName=foo（去 scope、去版本）
      const dirName = npmPkg.replace(/^@[^/]+\//, '').replace(/@[^@]+$/, '');
      const targetDir = `${packagesDir}/${dirName}`;

      if (await dirExists(targetDir)) {
        return { ok: false, message: `目录 ${dirName} 已存在` };
      }
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
        await execProc(proc, 'pnpm', ['install', '--filter', packInfo.name], process.cwd());

        const newPlugins = await deps.rescanPlugins();
        return newPlugins.length > 0
          ? { ok: true, message: `已安装并加载: ${newPlugins.join(', ')}` }
          : { ok: true, message: `已安装到 packages/${dirName}，但未发现新插件` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`安装插件 "${npmPkg}" 失败: ${message}`);
        // 回滚：清理半成品 targetDir 与残留 tgz，避免占位导致下次"目录已存在"
        await execProc(proc, 'rm', ['-rf', targetDir], process.cwd()).catch(() => {});
        if (tgzPath) await execProc(proc, 'rm', ['-f', tgzPath], process.cwd()).catch(() => {});
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
      const packagesDir = deps.packagesDir();
      const targetDir = `${packagesDir}/${dirName}`;
      const existed = await dirExists(targetDir);
      try {
        if (existed) await execProc(proc, 'rm', ['-rf', targetDir], process.cwd()); // 删目录，不再回来
        await deps.unloadPlugin(pluginName); // 从运行时注册表彻底移除（dispose + delete），幂等
        deps.cleanupConfig?.(pluginName); // 清残留配置
        log.info(existed ? `已删除插件目录: packages/${dirName}` : `插件 ${pluginName} 目录原不存在，已从运行时移除`);
        return {
          ok: true,
          message: existed ? `插件 ${pluginName} 已卸载并删除` : `插件 ${pluginName} 已从运行时移除（目录原不存在）`,
        };
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
