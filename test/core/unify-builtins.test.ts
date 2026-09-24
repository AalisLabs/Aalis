declare module '@aalis/core' {
  interface PluginMeta {
    /** 测试用元数据字段：经 declaration merging 挂到插件定义上 */
    __tMeta?: { tag: string };
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  config,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';

// 内置能力（config / services / provide）、插件元数据随定义携带、插件自己的配置视图。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function makeApp() {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  return app;
}

describe('内置能力', () => {
  it('config 是插件自己的配置视图：登记时交来的那一份', async () => {
    const app = makeApp();
    let own: unknown;
    await app.plugin(
      definePlugin({
        name: 'reader',
        uses: { config },
        apply({ config }) {
          own = config;
        },
      }),
      { greeting: 'hi' },
    );
    await app.plugins.idle();
    expect(own).toEqual({ greeting: 'hi' });
  });

  it('services：描述符与名字是同一把键——查询、枚举、偏好都认两种写法', async () => {
    const kv = defineService<{ tag: string }>('__t:kv');
    const app = makeApp();
    for (const tag of ['a', 'b']) {
      await app.plugin(
        definePlugin({
          name: `kv-${tag}`,
          uses: { provide },
          apply: ({ provide }) => void provide(kv, { tag }),
        }),
      );
    }
    await app.plugins.idle();
    const host = app.bind({ services });

    expect(host.services.get(kv)?.tag).toBe('a');
    expect((host.services.get('__t:kv') as { tag: string }).tag).toBe('a');
    expect(host.services.all('__t:kv').map(view => view.contextId)).toEqual(['kv-a', 'kv-b']);
    expect(host.services.get('__t:nobody')).toBeUndefined();

    // 按名设的偏好，按描述符读得到，反之亦然
    expect(host.services.prefer('__t:kv', 'kv-b')).toBe(true);
    expect(host.services.preferred(kv)).toBe('kv-b');
    expect(host.services.get(kv)?.tag).toBe('b');
    expect(host.services.unprefer(kv)).toBe(true);
    expect(host.services.preferred('__t:kv')).toBeUndefined();
  });

  it('provide 的 onBehalfOf：条目取被代理者的身份、不触发前缀劝告，清理仍归登记它的激活', async () => {
    const face = defineService<{ dir: string }>('__t:face');
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const app = new App({ name: 'T', logLevel: 'error', logger, devMode: true });
    apps.push(app);
    await app.plugin(
      definePlugin({
        name: 'host-of-faces',
        uses: { provide },
        apply({ provide }) {
          provide(face, { dir: '/a' }, { label: 'A', onBehalfOf: '@scope/face-a' });
          provide(face, { dir: '/b' }, { entryId: 'not-prefixed' });
        },
      }),
    );
    await app.plugins.idle();
    const host = app.bind({ services });
    expect(host.services.all(face).map(view => view.contextId)).toEqual(['@scope/face-a', 'not-prefixed']);
    // 劝告只冲着没加前缀的 entryId，代为登记的那条不报
    expect(warnings.filter(line => line.includes('为前缀'))).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('@scope/face-a');

    await app.plugins.unload('host-of-faces');
    expect(host.services.all(face)).toEqual([]);
  });

  it('require() 缺席时点名是哪个服务、谁声明的', async () => {
    const missing = defineService<{ ping(): void }>('__t:missing');
    const app = makeApp();
    let thrown: unknown;
    await app.plugin(
      definePlugin({
        name: 'needs-missing',
        uses: { missing: optional(missing) },
        apply({ missing }) {
          try {
            missing.require();
          } catch (err) {
            thrown = err;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(String(thrown)).toContain('"__t:missing"');
    expect(String(thrown)).toContain('"needs-missing"');
  });

  it('元数据随定义携带，宿主从插件条目上读得到', async () => {
    const app = makeApp();
    await app.plugin(definePlugin({ name: 'meta', displayName: '带元数据', __tMeta: { tag: 'x' }, apply() {} }));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('meta')?.state).toBe('active');
    const definition = app.plugins.getPlugin('meta')?.definition;
    expect(definition?.displayName).toBe('带元数据');
    expect(definition?.__tMeta).toEqual({ tag: 'x' });
  });
});
