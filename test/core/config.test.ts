import { afterEach, describe, expect, it } from 'vitest';
import { App, config, definePlugin, type PluginDefinition } from '../../packages/core/src/index.js';

// core 只持各实例的运行配置：登记与 bounce 时把入参拷进 entry，危险键不进实例配置。
// 配置文档（默认值合并、危险键闸、落盘、外部变更）在 runtime，
// 见 test/runtime/config-store.test.ts 与 test/runtime/config-sync.test.ts。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function makeApp(): App {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  return app;
}

describe('登记入参：原样生效、拷贝、危险键不进实例配置', () => {
  const nestedPlugin = (seen: { config?: Record<string, unknown> }) =>
    definePlugin({
      name: 'np',
      uses: { config },
      apply({ config }) {
        seen.config = config;
      },
    });

  it('传入的配置原样生效：core 不补默认值，也不读配置文档', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = makeApp();
    await app.plugin(nestedPlugin(seen), { server: { port: 9000 } });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config).toEqual({ server: { port: 9000 } });
  });

  it('插件就地改嵌套对象、数组与数组里的纯对象，都不写穿调用方传入的对象', async () => {
    const payload = { server: { host: 'h', port: 9000 }, hosts: ['file'], jobs: [{ name: 'once', enabled: true }] };
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'mut',
        uses: { config },
        apply({ config: pluginConfig }) {
          const c = pluginConfig as typeof payload;
          c.server.port = 1;
          c.hosts.push('mutated-by-plugin');
          c.jobs[0].enabled = false;
        },
      }),
      payload,
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('mut')?.state).toBe('active');
    expect(payload).toEqual({
      server: { host: 'h', port: 9000 },
      hosts: ['file'],
      jobs: [{ name: 'once', enabled: true }],
    });
  });

  it('Date 等非纯对象是原子值：按引用透传，原型保持', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const stamp = new Date('2021-01-01');
    const app = makeApp();
    await app.plugin(nestedPlugin(seen), { stamp });
    await app.plugins.idle();
    expect(seen.config?.stamp).toBe(stamp);
    expect(seen.config?.stamp).toBeInstanceOf(Date);
  });

  it('__proto__ 键不进原型链（配置层不承载原型语义）', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = makeApp();
    // 对象字面量里的 __proto__ 是原型语法糖，只有 JSON.parse（配置文件）这类路径产出自有键
    await app.plugin(nestedPlugin(seen), JSON.parse('{"__proto__":{"polluted":"yes"}}'));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(Object.getPrototypeOf(seen.config as object)).toBe(Object.prototype);
    expect((seen.config as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('constructor / prototype 键不进插件配置（与 __proto__ 同一闸）', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = makeApp();
    await app.plugin(nestedPlugin(seen), JSON.parse('{"constructor":{"polluted":1},"prototype":{"x":1},"ok":true}'));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config?.ok).toBe(true);
    expect(Object.hasOwn(seen.config as object, 'constructor')).toBe(false);
    expect(Object.hasOwn(seen.config as object, 'prototype')).toBe(false);
  });

  it('definePlugin 以 __proto__ 为 name 时定义期即抛，文案含危险键', () => {
    expect(() => definePlugin({ name: '__proto__', apply() {} })).toThrow(/危险键/);
  });

  it('手写定义对象直接 register(__proto__) 返回 false，不入注册表', async () => {
    const app = makeApp();
    const handwritten = { name: '__proto__', apply() {} } as PluginDefinition;
    expect(await app.plugins.register(handwritten)).toBe(false);
    expect(app.plugins.getPlugin('__proto__')).toBeUndefined();
    expect(app.plugins.getStatus()).toEqual([]);
  });
});

describe('bounce / updateConfig 入参拷贝', () => {
  it('await updateConfig 之后改 payload，entry.config 不得跟着变', async () => {
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { config },
        apply() {},
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    const payload = { v: 2, nested: { k: 1 } };
    await app.plugins.updateConfig('p', payload);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    payload.v = 4;
    payload.nested.k = 99;
    expect(app.plugins.getPlugin('p')?.config).toEqual({ v: 2, nested: { k: 1 } });
    await app.stop();
  });

  it('bounce 入参里未铺开的嵌套也要拷：改旧 current.extra 不得写穿新快照', async () => {
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'mcp',
        uses: { config },
        apply() {},
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('mcp')?.state).toBe('active');
    await app.plugins.updateConfig('mcp', {
      extra: { token: 'secret' },
      servers: [{ id: 'a', enabled: true }],
    });
    await app.plugins.idle();
    const current = app.plugins.getPlugin('mcp')?.config as {
      extra: { token: string };
      servers: Array<Record<string, unknown>>;
    };
    const servers = [...current.servers];
    servers[0] = { ...servers[0], enabled: false };
    const payload = { ...current, servers };
    await app.plugins.updateConfig('mcp', payload);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('mcp')?.state).toBe('active');
    current.extra.token = 'leaked';
    expect((app.plugins.getPlugin('mcp')?.config as { extra: { token: string } }).extra.token).toBe('secret');
    await app.stop();
  });

  it('bounce 后经内置 config 就地改嵌套，调用方传入的对象不变', async () => {
    let seen: { nested?: { k: number } } | undefined;
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { config },
        apply({ config: pluginConfig }) {
          seen = pluginConfig as { nested?: { k: number } };
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    const payload = { nested: { k: 1 } };
    await app.plugins.updateConfig('p', payload);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    (seen as { nested: { k: number } }).nested.k = 7;
    expect(payload).toEqual({ nested: { k: 1 } });
    await app.stop();
  });
});
