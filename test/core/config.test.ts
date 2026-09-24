import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, App, ConfigManager, config, definePlugin } from '../../packages/core/src/index.js';
import { type TempConfigHandle, tempConfig } from '../fixtures/app.js';

/** JSON / YAML 把 `__proto__` 解成自有键，对象字面量做不到。 */
function poisonedSnapshot(): AalisConfig {
  return JSON.parse('{"name":"T","logLevel":"error","plugins":{},"__proto__":{"pollutedA6v":"yes"}}') as AalisConfig;
}

function expectUnpoisoned(snap: object): void {
  expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
  expect(Object.hasOwn(snap, '__proto__')).toBe(false);
  expect((snap as { pollutedA6v?: unknown }).pollutedA6v).toBeUndefined();
  expect(({} as { pollutedA6v?: unknown }).pollutedA6v).toBeUndefined();
}

describe('ConfigManager (内存快照模式)', () => {
  it('未传入字段时使用默认值', () => {
    const cfg = new ConfigManager({ name: 'Aalis', logLevel: 'info', plugins: {} });
    expect(cfg.get('name')).toBe('Aalis');
    expect(cfg.get('logLevel')).toBe('info');
    expect(cfg.get('plugins')).toEqual({});
  });

  it('setPluginConfig / removePluginConfig', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    cfg.setPluginConfig('a', { x: 1 });
    expect(cfg.getPluginConfig('a').x).toBe(1);
    cfg.removePluginConfig('a');
    expect(cfg.getPluginConfig('a')).toEqual({});
  });

  it('isPluginDisabled / setPluginEnabled toggle', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    expect(cfg.isPluginDisabled('p')).toBe(false);
    cfg.setPluginEnabled('p', false);
    expect(cfg.isPluginDisabled('p')).toBe(true);
    cfg.setPluginEnabled('p', true);
    expect(cfg.isPluginDisabled('p')).toBe(false);
  });

  it('servicePreferences 增删', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    cfg.setServicePreference('llm', 'plugin-llm-openai');
    expect(cfg.getServicePreferences().llm).toBe('plugin-llm-openai');
    cfg.removeServicePreference('llm');
    expect(cfg.getServicePreferences().llm).toBeUndefined();
  });

  /** provider 经 watch 推送新快照的接线 */
  function watched(initial: AalisConfig) {
    let push!: (next: AalisConfig) => void;
    const cfg = new ConfigManager(initial, {
      provider: {
        watch(onChange) {
          push = onChange;
          return () => {};
        },
      },
    });
    cfg.watch(() => {});
    return { cfg, push: (next: AalisConfig) => push(next) };
  }

  it('provider 推送新快照即替换当前状态', () => {
    const { cfg, push } = watched({ name: 'One', logLevel: 'info', plugins: {} });
    expect(cfg.get('name')).toBe('One');
    push({ name: 'Two', logLevel: 'info', plugins: {} });
    expect(cfg.get('name')).toBe('Two');
  });

  it('推送的 JSON 带 __proto__ 不得改快照原型', () => {
    const { cfg, push } = watched({ name: 'T', logLevel: 'error', plugins: {} });
    push(poisonedSnapshot());
    expectUnpoisoned(cfg.getAll());
    expect(cfg.get('pollutedA6v' as never)).toBeUndefined();
  });

  it('构造期外来 JSON 的 __proto__ 不得改快照原型', () => {
    const cfg = new ConfigManager(poisonedSnapshot());
    expectUnpoisoned(cfg.getAll());
  });

  it('constructor / prototype 与 __proto__ 同一闸，不写入快照', () => {
    const input = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{},"constructor":{"prototype":{"polluted":"yes"}},"prototype":{"x":1}}',
    ) as AalisConfig;
    const snap = new ConfigManager(input).getAll();
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(Object.hasOwn(snap, 'constructor')).toBe(false);
    expect(Object.hasOwn(snap, 'prototype')).toBe(false);
    expect(snap.constructor).toBe(Object);
  });

  it('未注入 provider 时 save() 是 no-op', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    // 不抛错即可——纯内存模式 save 没有持久化目标
    expect(() => cfg.save()).not.toThrow();
  });
});

describe('FsYamlConfigProvider (集成)', () => {
  let cfg: TempConfigHandle;
  afterEach(() => cfg?.cleanup());

  // 环境变量插值（`${VAR}`）与 save() 的占位符保护已随 `.env` 机制一并删除：
  // 那一层承载的东西与 aalis.config.yaml 完全重合，唯一区别是「哪个文件进 git」，
  // 而脚手架现在把 config 本身 gitignore 掉了（密钥直接写在里面），于是它纯属多余。
  // 顺带记一笔：被删的第二条用例（save() 保留 ${VAR} 占位符）在插值实现删掉之后**仍然
  // 通过**——因为没有插值，写回的本来就是原字符串。它一直是条假绿。

  it('从 YAML 加载配置树', () => {
    cfg = tempConfig('name: MyApp\nlogLevel: debug\nplugins:\n  myplug:\n    apikey: literal-secret\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider });
    expect(mgr.get('name')).toBe('MyApp');
    expect(mgr.getPluginConfig('myplug').apikey, '值原样加载，不做任何替换').toBe('literal-secret');
  });

  it('save() 原样写回字符串值（密钥直接住在 config 里，不得被改写）', () => {
    cfg = tempConfig('name: X\nlogLevel: info\nplugins:\n  myplug:\n    token: sk-literal\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider });
    mgr.set('name', 'Y');
    mgr.save();
    const written = readFileSync(cfg.path, 'utf-8');
    expect(written).toMatch(/name: Y/);
    expect(written).toContain('sk-literal');
  });

  it('YAML 解析出的 __proto__ 自有键经 ConfigManager 不得改原型', () => {
    cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n__proto__:\n  pollutedA6v: yes\n');
    expect(
      Object.getOwnPropertyNames(cfg.config).includes('__proto__'),
      '本用例前提：YAML 把 __proto__ 解成自有键，与 JSON.parse 同类',
    ).toBe(true);
    const mgr = new ConfigManager(cfg.config);
    expectUnpoisoned(mgr.getAll());
    expect(mgr.get('pollutedA6v' as never)).toBeUndefined();
  });
});

// 注：配置同步政策（schema 派生默认值回填 / schema 裁剪）的测试在
// test/runtime/config-sync.test.ts——政策属宿主层,core 只持有配置快照机制。

describe('注册期配置合并（app.plugin：defaults ← 配置文件 ← 代码传入，逐层深合并）', () => {
  const nestedPlugin = (seen: { config?: Record<string, unknown> }) =>
    definePlugin({
      name: 'np',
      uses: { config },
      apply({ config }) {
        seen.config = config;
      },
    });

  const defaults = () => ({
    server: { host: '127.0.0.1', port: 8080 },
    hosts: ['a'],
    flag: true,
    stamp: new Date('2020-01-01'),
  });

  it('配置文件只写嵌套组里的一个键时，同组其它默认值仍在首次 apply 就到位', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { np: { server: { port: 9000 } } } },
      pluginDefaults: () => defaults(),
    });
    await app.plugin(nestedPlugin(seen));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config?.server).toEqual({ host: '127.0.0.1', port: 9000 });
    await app.stop();
  });

  it('代码传入的嵌套值压过配置文件，未提及的键不丢', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { np: { server: { port: 9000, host: 'file' } } } },
      pluginDefaults: () => defaults(),
    });
    await app.plugin(nestedPlugin(seen), { server: { host: 'code' } });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config?.server).toEqual({ host: 'code', port: 9000 });
    await app.stop();
  });

  it('数组与非纯对象是原子值：整体覆盖，不逐元素合并', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const stamp = new Date('2021-01-01');
    const app = new App({
      config: {
        name: 'T',
        logLevel: 'error',
        plugins: { np: { hosts: ['b', 'c'], stamp } },
      },
      pluginDefaults: () => defaults(),
    });
    await app.plugin(nestedPlugin(seen));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config?.hosts).toEqual(['b', 'c']);
    // Date 不是纯对象：整体覆盖且原型保持，不被递归成 {} 形状的普通对象；原子值按引用透传
    expect(seen.config?.stamp).toBe(stamp);
    expect(seen.config?.stamp).toBeInstanceOf(Date);
    await app.stop();
  });

  it('__proto__ 键不进原型链（配置层不承载原型语义）', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      pluginDefaults: () => defaults(),
    });
    // 对象字面量里的 __proto__ 是原型语法糖，只有 JSON.parse（配置文件）这类路径产出自有键
    await app.plugin(nestedPlugin(seen), JSON.parse('{"__proto__":{"polluted":"yes"}}'));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(Object.getPrototypeOf(seen.config as object)).toBe(Object.prototype);
    expect((seen.config as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await app.stop();
  });

  it('合并不改写入参：配置文件里的活对象与宿主的默认值常量都不被写脏', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const sharedDefaults = defaults();
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { np: { server: { port: 9000 } } } },
      pluginDefaults: () => sharedDefaults,
    });
    await app.plugin(nestedPlugin(seen), { server: { host: 'code' } });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config?.server).toEqual({ host: 'code', port: 9000 });
    expect(sharedDefaults.server).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(app.config.getPluginConfig('np')).toEqual({ server: { port: 9000 } });
    await app.stop();
  });

  it('插件改数组不得写穿 ConfigManager 的文件快照', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { np: { hosts: ['file'] } } },
      pluginDefaults: () => ({ hosts: ['default'] }),
    });
    await app.plugin(nestedPlugin(seen));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    (seen.config as { hosts: string[] }).hosts.push('mutated-by-plugin');
    expect(app.config.getPluginConfig('np').hosts, '数组合并应交出新数组，不能把文件快照当活引用').toEqual(['file']);
    expect(seen.config?.hosts).toEqual(['file', 'mutated-by-plugin']);
    await app.stop();
  });

  it('未覆盖的嵌套纯对象与宿主 defaults 不共享引用', async () => {
    const sharedDefaults = { server: { host: '127.0.0.1', port: 8080 }, flag: true };
    const seen: { config?: Record<string, unknown> } = {};
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { np: { flag: false } } },
      pluginDefaults: () => sharedDefaults,
    });
    await app.plugin(nestedPlugin(seen));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    (seen.config as { server: { host: string } }).server.host = 'mutated';
    expect(sharedDefaults.server.host, 'defaults 可能是宿主复用的常量').toBe('127.0.0.1');
    await app.stop();
  });

  it('数组元素若为纯对象也拷贝：就地改 jobs[i] 不得写进配置快照', async () => {
    const jobs = [{ name: 'once', enabled: true, cron: '@every 30s' }];
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { sched: { jobs } } },
    });
    await app.plugin(
      definePlugin({
        name: 'sched',
        uses: { config },
        apply({ config: pluginConfig }) {
          const list = (pluginConfig as { jobs: Array<{ enabled: boolean; cron?: string; interval?: number }> }).jobs;
          const job = list[0];
          job.enabled = false;
          job.interval = 30;
          job.cron = undefined;
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('sched')?.state).toBe('active');
    const stored = app.config.getPluginConfig('sched').jobs as Array<{ enabled: boolean; cron?: string }>;
    expect(stored[0].enabled, '静态任务就地改 enabled 不应隔空写进配置快照').toBe(true);
    expect(stored[0].cron).toBe('@every 30s');
    await app.stop();
  });

  it('constructor / prototype 键不进插件配置（与 __proto__ 同一闸）', async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.plugin(nestedPlugin(seen), JSON.parse('{"constructor":{"polluted":1},"prototype":{"x":1},"ok":true}'));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('np')?.state).toBe('active');
    expect(seen.config?.ok).toBe(true);
    expect(Object.hasOwn(seen.config as object, 'constructor')).toBe(false);
    expect(Object.hasOwn(seen.config as object, 'prototype')).toBe(false);
    await app.stop();
  });
});

describe('bounce / updateConfig 入参拷贝', () => {
  it('await updateConfig 之后改 payload，ConfigManager 与 entry.config 不得跟着变', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
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
    expect(app.config.getPluginConfig('p')).toEqual({ v: 2, nested: { k: 1 } });
    expect(app.plugins.getPlugin('p')?.config).toEqual({ v: 2, nested: { k: 1 } });
    await app.stop();
  });

  it('bounce 入参里未铺开的嵌套也要拷：改旧 current.extra 不得写穿新快照', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
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
    expect((app.config.getPluginConfig('mcp') as { extra: { token: string } }).extra.token).toBe('secret');
    await app.stop();
  });

  it('bounce 后经内置 config 就地改嵌套，ConfigManager 快照不变', async () => {
    let seen: { nested?: { k: number } } | undefined;
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
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
    await app.plugins.updateConfig('p', { nested: { k: 1 } });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    (seen as { nested: { k: number } }).nested.k = 7;
    expect(app.config.getPluginConfig('p')).toEqual({ nested: { k: 1 } });
    await app.stop();
  });
});

describe('ConfigManager.watch', () => {
  const base = { name: 'T', logLevel: 'error', plugins: {} };

  it('返回退订闭包；退订后 provider 侧也停表，可再次订阅', () => {
    let stopped = 0;
    let push!: (next: typeof base) => void;
    const cm = new ConfigManager(base, {
      provider: {
        watch: onChange => {
          push = onChange;
          return () => {
            stopped++;
          };
        },
      },
    });
    const seen: number[] = [];
    const off = cm.watch(() => seen.push(1));
    push({ ...base, name: 'T2' });
    expect(seen).toHaveLength(1);
    expect(cm.get('name')).toBe('T2');
    off();
    expect(stopped).toBe(1);
    expect(() => cm.watch(() => {})).not.toThrow();
  });

  it('provider.watch 推送的快照走同一闸，JSON __proto__ 不得改原型', () => {
    let push!: (next: AalisConfig) => void;
    const cm = new ConfigManager(base, {
      provider: {
        watch: onChange => {
          push = onChange;
          return () => {};
        },
      },
    });
    cm.watch(() => {});
    push(poisonedSnapshot());
    expectUnpoisoned(cm.getAll());
    expect(cm.get('pollutedA6v' as never)).toBeUndefined();
  });

  it('单订阅者：已有订阅时再 watch 抛错，不静默顶替', () => {
    const cm = new ConfigManager(base);
    cm.watch(() => {});
    expect(() => cm.watch(() => {})).toThrow(/只支持一个订阅者/);
  });
});
