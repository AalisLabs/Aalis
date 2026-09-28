import { expect, it, vi } from 'vitest';
import { packageManager } from '../../packages/api-package-manager/src/index.js';
import { App, defineService, provide, services } from '../../packages/core/src/index.js';
import plugin from '../../packages/plugin-package-manager/src/index.js';

it('包管理目录配置无效时拒绝激活，不回落到工作目录操作包', async () => {
  const app = new App({ name: 'config-test', logLevel: 'error' });
  const caps = app.bind({ provide, services });
  const execFile = vi.fn();
  const readExternalFile = vi.fn();
  caps.provide(defineService<object>('process'), { execFile, readExternalFile });
  try {
    await app.plugin(plugin, { projectRoot: { private: 'placeholder' } });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('error');
    expect(caps.services.get(packageManager)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(readExternalFile).not.toHaveBeenCalled();
  } finally {
    await app.stop();
  }
});
