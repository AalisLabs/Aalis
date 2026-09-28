import { afterEach, describe, expect, it } from 'vitest';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

// 无效 roots 在 createRoot/mkdir 之前拒绝；空数组只检查解析结果，避免在工作区创建默认目录。
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function start(roots: unknown) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await app.plugin(storageLocal, { roots });
  await app.plugins.idle();
  return app.plugins.getStatus().find(p => p.instanceId === storageLocal.name);
}

describe('plugin-storage-local roots 配置', () => {
  it.each([
    [{ name: 'custom', path: false }],
    [{ name: 'custom', path: '/tmp/x', readable: 'false' }],
    [[null]],
  ])('显式坏条目拒绝整个数组，不回落默认五根：%j', async roots => {
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
    await app.plugin(storageLocal, { roots: [{ name: 'bad/name', path: '/private/canary', readable: true }] });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(storageLocal.name)?.state).toBe('error');
    expect(warnings.some(w => w.includes('非法根名'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('/private/canary');
    expect(warnings.join('\n')).not.toContain('bad/name');
  });
});
