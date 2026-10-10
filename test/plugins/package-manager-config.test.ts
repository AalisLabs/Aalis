import { expect, it, vi } from 'vitest';
import { packageManager } from '../../packages/api-package-manager/src/index.js';
import { App, defineService, provide, services } from '../../packages/core/src/index.js';
import plugin from '../../packages/plugin-package-manager/src/index.js';

// 包管理往宿主的安装集里装包，安装集只来自 host-paths：宿主不提供时不激活，不回落到工作目录操作包
it('宿主不提供 host-paths 时不激活，不回落到工作目录操作包', async () => {
  const app = new App({ name: 'config-test', logLevel: 'error' });
  const caps = app.bind({ provide, services });
  const execFile = vi.fn();
  const readExternalFile = vi.fn();
  caps.provide.use(defineService<object>('process'), { execFile, readExternalFile });
  try {
    await app.plugin(plugin);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('pending');
    expect(caps.services.use.get(packageManager)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(readExternalFile).not.toHaveBeenCalled();
  } finally {
    await app.stop();
  }
});
