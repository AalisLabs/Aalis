import { describe, expect, it } from 'vitest';
import { App, defineService, provide, services } from '../../packages/core/src/index.js';

/**
 * 独立 App 隔离
 *
 * 核心契约：两个独立 App 的服务与配置互不影响，隔离边界就是 App 实例本身。
 */

describe('独立 App 隔离', () => {
  it('两个独立 App 各自的服务/配置互不影响', async () => {
    const app1 = new App({ config: { name: 'A', logLevel: 'error', plugins: {} } });
    const app2 = new App({ config: { name: 'B', logLevel: 'error', plugins: {} } });
    const only = defineService<{ v: number }>('only-in-1');

    app1.bind({ provide }).provide(only, { v: 1 });

    expect(app1.bind({ services }).services.get(only)).toBeDefined();
    expect(app2.bind({ services }).services.get(only)).toBeUndefined();
    expect(app1.config.get('name')).toBe('A');
    expect(app2.config.get('name')).toBe('B');

    await app1.stop();
    await app2.stop();
  });
});
