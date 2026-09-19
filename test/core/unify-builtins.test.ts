declare module '@aalis/core' {
  interface HookContextMap {
    '__t:unify-hook': { trail: string[] };
  }
  interface ContributionPointMap {
    '__t:unify-point': { id: string; label: string };
  }
  interface PluginMeta {
    /** 测试用元数据字段：经 declaration merging 挂到插件定义上 */
    __tMeta?: { tag: string };
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  config,
  contributions,
  definePlugin,
  hooks,
  hostConfig,
  type Logger,
} from '../../packages/core/src/index.js';

// 内置能力 hooks / contributions、插件元数据随定义携带、宿主配置管理面（显式声明才可见）。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function makeApp(plugins: Record<string, Record<string, unknown>> = {}) {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins }, logger });
  apps.push(app);
  return app;
}

describe('内置能力', () => {
  it('hooks：中间件随激活撤回；run 驱动整条链', async () => {
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'mw',
        uses: { hooks },
        apply({ hooks }) {
          hooks.middleware('__t:unify-hook', async (data, next) => {
            data.trail.push('mw');
            await next();
          });
        },
      }),
    );
    await app.plugins.idle();
    const host = app.bind({ hooks });
    const first = { trail: [] as string[] };
    expect(await host.hooks.run('__t:unify-hook', first)).toBe(true);
    expect(first.trail).toEqual(['mw']);
    await app.plugins.unload('mw');
    const second = { trail: [] as string[] };
    await host.hooks.run('__t:unify-hook', second);
    expect(second.trail).toEqual([]);
  });

  it('contributions：交付随激活撤回；collect 取快照', async () => {
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'giver',
        uses: { contributions },
        apply: ({ contributions }) => void contributions.contribute('__t:unify-point', { id: 'a', label: 'A' }),
      }),
    );
    await app.plugins.idle();
    const host = app.bind({ contributions });
    expect(host.contributions.collect('__t:unify-point').map(h => h.spec.label)).toEqual(['A']);
    await app.plugins.unload('giver');
    expect(host.contributions.collect('__t:unify-point')).toEqual([]);
  });

  it('config 是插件自己的配置视图；整份配置的读写走显式声明的 hostConfig', async () => {
    const app = makeApp({ reader: { greeting: 'hi' } });
    let own: unknown;
    let whole: unknown;
    await app.plugin(
      definePlugin({
        name: 'reader',
        uses: { config, hostConfig },
        apply({ config, hostConfig }) {
          own = config;
          whole = hostConfig.require().getPluginConfig('reader');
        },
      }),
      { greeting: 'hi' },
    );
    await app.plugins.idle();
    expect(own).toEqual({ greeting: 'hi' });
    expect(whole).toEqual({ greeting: 'hi' });
  });

  it('元数据随定义携带，宿主从插件条目上读得到', async () => {
    const app = makeApp();
    await app.plugin(definePlugin({ name: 'meta', displayName: '带元数据', __tMeta: { tag: 'x' }, apply() {} }));
    await app.plugins.idle();
    const module = app.plugins.getPlugin('meta')?.module;
    expect(module?.displayName).toBe('带元数据');
    expect(module?.__tMeta).toEqual({ tag: 'x' });
  });
});
