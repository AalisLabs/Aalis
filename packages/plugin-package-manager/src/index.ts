import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppService, Context } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-package-manager';
export const displayName = '包管理器';
export const subsystem = 'system';

// ===== 服务接口 =====

/**
 * 包管理服务：从 npm 安装/卸载插件到 packages/ 目录
 *
 * 通过 `ctx.getService<PackageManagerService>('package-manager')` 消费。
 *
 * 这些操作涉及子进程（npm/tar/pnpm/rm），不属于 core 内核职责，
 * 因此从 App 抽出到独立插件。
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

function execProc(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rej(new Error(stderr || err.message));
        else res(stdout);
      },
    );
  });
}

function createService(ctx: Context): PackageManagerService {
  const log = ctx.logger;

  function getApp(): AppService {
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('app 服务不可用，无法执行包管理操作');
    return app;
  }

  function getPackagesDir(): string {
    return getApp().packagesDir;
  }

  return {
    async install(npmPkg) {
      const packagesDir = getPackagesDir();
      const dirName = npmPkg.replace(/^@[^/]+\//, '');
      const targetDir = resolve(packagesDir, dirName);

      if (existsSync(targetDir)) {
        return { ok: false, message: `目录 ${dirName} 已存在` };
      }
      log.info(`正在安装插件: ${npmPkg} → packages/${dirName}`);

      try {
        await execProc('npm', ['pack', npmPkg, '--pack-destination', packagesDir], packagesDir);
        const dirents = await readdir(packagesDir);
        const tgzFile = dirents.find(f => f.endsWith('.tgz') && f.includes(dirName));
        if (!tgzFile) return { ok: false, message: '下载包失败: 未找到 tgz 文件' };
        const tgzPath = resolve(packagesDir, tgzFile);
        await execProc('mkdir', ['-p', targetDir], packagesDir);
        await execProc('tar', ['xzf', tgzPath, '-C', targetDir, '--strip-components=1'], packagesDir);
        await execProc('rm', ['-f', tgzPath], packagesDir);
        await execProc('pnpm', ['install', '--filter', npmPkg], process.cwd());

        const newPlugins = await getApp().rescanPlugins();
        return newPlugins.length > 0
          ? { ok: true, message: `已安装并加载: ${newPlugins.join(', ')}` }
          : { ok: true, message: `已安装到 packages/${dirName}，但未发现新插件` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`安装插件 "${npmPkg}" 失败: ${message}`);
        return { ok: false, message };
      }
    },

    async uninstall(pluginName) {
      const packagesDir = getPackagesDir();
      // 先卸载插件实例（通过 plugins 服务）
      const pm = ctx.getService<{ disablePlugin(name: string): Promise<boolean> }>('plugins');
      if (pm) await pm.disablePlugin(pluginName);

      const dirName = pluginName.replace(/^@[^/]+\//, '');
      const targetDir = resolve(packagesDir, dirName);
      if (!existsSync(targetDir)) {
        return { ok: true, message: `插件 ${pluginName} 已卸载（目录不存在）` };
      }
      try {
        await execProc('rm', ['-rf', targetDir], packagesDir);
        log.info(`已删除插件目录: packages/${dirName}`);
        return { ok: true, message: `插件 ${pluginName} 已卸载并删除` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

export function apply(ctx: Context): void {
  ctx.provide('package-manager', createService(ctx), {
    capabilities: ['install', 'uninstall'],
    label: 'package-manager',
  });
}
