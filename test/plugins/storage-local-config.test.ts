import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostPaths } from '../../packages/api-host-paths/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { derivePaths } from '../../packages/runtime/src/data-dir.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// 无效 roots 在 createRoot/mkdir 之前拒绝；空数组只检查解析结果，避免在工作区创建默认目录。
const apps: App[] = [];
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aalis-storage-cfg-'));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  rmSync(home, { recursive: true, force: true });
});

async function start(roots: unknown) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  provideHostPaths(app, home);
  await app.plugin(storageLocal, { roots });
  await app.plugins.idle();
  return app.plugins.getStatus().find(p => p.instanceId === storageLocal.name);
}

describe('plugin-storage-local roots 配置', () => {
  it.each([
    [{ name: 'custom', path: false }],
    [{ name: 'custom', path: '/tmp/x', readable: 'false' }],
    [[null]],
  ])('显式坏条目拒绝整个数组，不回落默认根：%j', async roots => {
    const state = await start(roots);
    expect(state?.state).toBe('error');
    expect(state?.error).toContain('roots');
  });

  it('显式空数组保留空值，供插件按原规则使用内置根', () => {
    expect(parseConfig(storageLocal.configSchema!, { roots: [] }).roots).toEqual([]);
  });

  it('语义无效的根只记错误类别，不把配置路径写入日志', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: message => void warnings.push(String(message)),
      error() {},
      child: () => logger,
    };
    const app = new App({ name: 'T', logger });
    apps.push(app);
    provideHostPaths(app, home);
    await app.plugin(storageLocal, { roots: [{ name: 'bad/name', path: '/private/canary', readable: true }] });
    await app.plugins.idle();
    // 用户根一个都不剩时照常激活（插件自己的数据在内置根里），只告警缺了文件工具的工作根
    expect(app.plugins.getPlugin(storageLocal.name)?.state).toBe('active');
    expect(warnings.some(w => w.includes('没有可用的用户根'))).toBe(true);
    expect(warnings.some(w => w.includes('非法根名'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('/private/canary');
    expect(warnings.join('\n')).not.toContain('bad/name');
  });

  describe('workspace 根：没写 path 时指向宿主给的默认工作区目录，写了以用户的为准', () => {
    /** 默认工作区放在数据目录里别的名字下：存储插件只认 host-paths 给的位置，不自己拼 <数据目录>/workspace */
    async function startElsewhere(config: Record<string, unknown>) {
      const app = new App({ name: 'T', logLevel: 'error' });
      apps.push(app);
      const real = realpathSync(home);
      const workspace = join(real, 'zz-workspace');
      app.bind({ provide }).provide.use(hostPaths, { ...derivePaths(real, real), workspace }, { exclusive: true });
      await app.plugin(storageLocal, config);
      await app.plugins.idle();
      return { local: app.bind({ storage }).storage.use, workspace, real };
    }

    it('roots 没配：缺省的 workspace 根就是默认工作区目录', async () => {
      const { local, workspace } = await startElsewhere({});
      expect(await local.resolveLocalPath?.('workspace:/')).toBe(workspace);
    });

    it('roots 里的条目没写 path：指向默认工作区目录', async () => {
      const { local, workspace } = await startElsewhere({
        roots: [{ name: 'workspace', readable: true, writable: true }],
      });
      expect(await local.resolveLocalPath?.('workspace:/')).toBe(workspace);
    });

    it('roots 里给 workspace 根写了 path：以用户的为准', async () => {
      const { local, real } = await startElsewhere({
        roots: [{ name: 'workspace', path: 'zz-mine', readable: true, writable: true }],
      });
      expect(await local.resolveLocalPath?.('workspace:/')).toBe(join(real, 'zz-mine'));
    });
  });
});
