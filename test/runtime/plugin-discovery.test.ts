import { afterEach, describe, expect, it } from 'vitest';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  config,
  definePlugin,
  defineService,
  type Logger,
  type PluginDefinition,
  provide,
} from '../../packages/core/src/index.js';
import { createConfigStore } from '../../packages/runtime/src/config-store.js';
import {
  createPluginDiscovery,
  type PluginDescriptor,
  type PluginLoader,
} from '../../packages/runtime/src/plugin-discovery.js';

// 宿主层的插件发现：冷启动整批交给 core（返回即收敛），热扫描不等静置、只报真正落账的、
// 与冷启动同样收齐配置里的 name:suffix 实例；登记时各实例的配置与禁用标记取自配置文档。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world(doc: Partial<AalisConfig> = {}, logger?: Logger) {
  const store = createConfigStore(doc);
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  return { app, store, discovery: (loader: PluginLoader) => createPluginDiscovery(app, loader, store) };
}
function memoryLoader(definitions: PluginDefinition[], names = definitions.map(d => d.name)): PluginLoader {
  return {
    async discover(): Promise<PluginDescriptor[]> {
      return names.map(name => ({ name, source: 'mem' }));
    },
    async load(desc) {
      return definitions.find(d => d.name === desc.name) ?? null;
    },
  };
}
function gated(name: string) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(r => {
    enter = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  const definition = definePlugin({
    name,
    async apply() {
      enter();
      await gate;
    },
  });
  return { definition, entered, release };
}

describe('冷启动：先全部登记、再统一激活', () => {
  it('后备提供者先被发现：required 依赖方只激活一次，且看到的是首选提供者', async () => {
    const store = defineService<{ id: string }>('pd-store');
    const seen: string[] = [];
    const consumer = definePlugin({
      name: 'pd-consumer',
      uses: { store },
      apply: ({ store }) => void seen.push(store.require().id),
    });
    const fallback = definePlugin({
      name: 'pd-fallback',
      uses: { provide },
      provides: [store],
      apply: ({ provide }) => {
        provide(store, { id: 'fallback' }, { priority: -100 });
      },
    });
    const preferred = definePlugin({
      name: 'pd-preferred',
      uses: { provide },
      provides: [store],
      apply: ({ provide }) => {
        provide(store, { id: 'preferred' }, { priority: 10 });
      },
    });
    const { discovery } = world();
    // 发现序刻意把后备与消费者排在首选之前（逐个注册即激活时，消费者会从后备加载）
    await discovery(memoryLoader([fallback, consumer, preferred])).loadAll();
    expect(seen).toEqual(['preferred']);
  });

  it('返回时全部发现的插件已收敛，即使登记撞上在飞 run 排队', async () => {
    const { app, discovery } = world();
    const g = gated('occupier');
    const occupying = app.plugin(g.definition);
    await g.entered;
    const booted = definePlugin({ name: 'booted', apply() {} });
    const loading = discovery(memoryLoader([booted])).loadAll();
    const stateAtResolve = loading.then(() => app.plugins.getPlugin('booted')?.state);
    await new Promise(r => setTimeout(r, 10));
    g.release();
    expect(await stateAtResolve).toBe('active');
    await occupying;
  });

  it('配置里的 name:suffix 实例一并登记', async () => {
    const def = definePlugin({ name: 'rs-scan', reusable: true, apply() {} });
    const { app, discovery } = world({ plugins: { 'rs-scan:work': { k: 1 } } });
    await discovery(memoryLoader([def])).loadAll();
    expect(app.plugins.getPlugin('rs-scan')?.state).toBe('active');
    expect(app.plugins.getPlugin('rs-scan:work')?.state).toBe('active');
  });
});

describe('热扫描', () => {
  it('在飞 run 占着单飞时仍立即 resolve（新插件此刻 pending，事后自愈）', async () => {
    const w = world();
    const { app } = w;
    const g = gated('occupier');
    const occupying = app.plugin(g.definition);
    await g.entered;
    const discovery = w.discovery(memoryLoader([definePlugin({ name: 'scanned', apply() {} })]));
    const timer = setTimeout(() => g.release(), 200);
    expect(await discovery.rescan()).toEqual(['scanned']);
    expect(app.plugins.getPlugin('scanned')?.state).toBe('pending');
    clearTimeout(timer);
    g.release();
    await occupying;
    await app.plugins.idle();
    expect(app.plugins.getPlugin('scanned')?.state).toBe('active');
  });

  it('同样收齐配置里的后缀实例，含已注册模块新增的后缀', async () => {
    const def = definePlugin({ name: 'rs-scan', reusable: true, apply() {} });
    const w = world({ plugins: { 'rs-scan:work': { k: 1 } } });
    const { app, store } = w;
    const discovery = w.discovery(memoryLoader([def]));
    await discovery.rescan();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rs-scan:work')?.state).toBe('active');
    store.setPluginConfig('rs-scan:late', {});
    await discovery.rescan();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rs-scan:late')?.state).toBe('active');
  });

  it('描述符名与模块自报名不同、而自报名已注册时，不计入热加载名单', async () => {
    const { app, discovery } = world();
    const real = definePlugin({ name: 'real', apply() {} });
    await app.plugin(real);
    const loader: PluginLoader = {
      async discover() {
        return [
          { name: 'alias-of-real', source: 'stub' },
          { name: 'fresh', source: 'stub' },
        ];
      },
      async load(desc) {
        return desc.name === 'alias-of-real' ? real : definePlugin({ name: desc.name, apply() {} });
      },
    };
    expect(await discovery(loader).rescan()).toEqual(['fresh']);
  });

  it('插件在 apply 里触发热扫描不自锁', async () => {
    const w = world();
    const { app } = w;
    const discovery = w.discovery(memoryLoader([definePlugin({ name: 'late', apply() {} })]));
    let scanned: string[] | undefined;
    await app.plugin(
      definePlugin({
        name: 'scanner',
        async apply() {
          scanned = await discovery.rescan();
        },
      }),
    );
    await app.plugins.idle();
    expect(scanned).toEqual(['late']);
    expect(app.plugins.getPlugin('late')?.state).toBe('active');
  });

  it('热扫描同样整批登记：后备提供者先被发现时，依赖方看到的是首选提供者', async () => {
    const store = defineService<{ id: string }>('pd-rescan-store');
    const seen: string[] = [];
    const provider = (name: string, id: string, priority: number) =>
      definePlugin({
        name,
        uses: { provide },
        provides: [store],
        apply: ({ provide }) => void provide(store, { id }, { priority }),
      });
    const consumer = definePlugin({
      name: 'pd-rescan-consumer',
      uses: { store },
      apply: ({ store }) => void seen.push(store.require().id),
    });
    const { app, discovery } = world();
    await discovery(
      memoryLoader([
        provider('pd-rescan-fallback', 'fallback', -100),
        consumer,
        provider('pd-rescan-preferred', 'preferred', 10),
      ]),
    ).rescan();
    await app.plugins.idle();
    expect(seen).toEqual(['preferred']);
  });

  it('加载器提供 reload 时热扫描走 reload，冷启动走 load', async () => {
    const calls: string[] = [];
    const defs = new Map<string, PluginDefinition>();
    const loader: PluginLoader = {
      async discover() {
        return [...defs.keys()].map(name => ({ name, source: 'mem' }));
      },
      async load(desc) {
        calls.push(`load:${desc.name}`);
        return defs.get(desc.name) ?? null;
      },
      async reload(desc) {
        calls.push(`reload:${desc.name}`);
        return defs.get(desc.name) ?? null;
      },
    };
    const { discovery } = world();
    const d = discovery(loader);
    defs.set('cold', definePlugin({ name: 'cold', apply() {} }));
    await d.loadAll();
    defs.set('hot', definePlugin({ name: 'hot', apply() {} }));
    await d.rescan();
    expect(calls).toEqual(['load:cold', 'reload:hot']);
  });

  it('返回的是登记进注册表的主实例名（定义名），不是描述符名', async () => {
    const { app, discovery } = world();
    const loader: PluginLoader = {
      async discover() {
        return [{ name: '@scope/pkg-name', source: 'stub' }];
      },
      async load() {
        return definePlugin({ name: 'def-name', apply() {} });
      },
    };
    const names = await discovery(loader).rescan();
    expect(names).toEqual(['def-name']);
    expect(app.plugins.getPlugin(names[0])).toBeDefined();
  });
});

describe('按配置文档登记', () => {
  it('冷启动与热扫描都按实例 id 从文档取配置与禁用标记，配置原样交给 core', async () => {
    const seen: Record<string, unknown> = {};
    const probe = (name: string) =>
      definePlugin({
        name,
        uses: { config },
        apply: ({ config }) => {
          seen[name] = config;
        },
      });
    const { app, store, discovery } = world({
      plugins: { a: { k: 1 }, b: { k: 2 }, c: { k: 3 } },
      disabledPlugins: ['b'],
    });
    await discovery(memoryLoader([probe('a'), probe('b')])).loadAll();
    expect(seen).toEqual({ a: { k: 1 } });
    expect(app.plugins.getPlugin('b')?.state).toBe('disabled');
    expect(app.plugins.getPlugin('b')?.config).toEqual({ k: 2 });

    store.setPluginEnabled('c', false);
    expect(await discovery(memoryLoader([probe('a'), probe('b'), probe('c')])).rescan()).toEqual(['c']);
    expect(app.plugins.getPlugin('c')?.state).toBe('disabled');
    expect(app.plugins.getPlugin('c')?.config).toEqual({ k: 3 });
  });

  it('实例 id 撞上危险键、文档拒取时只记该条，其余照常登记', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (message: string) => void errors.push(message),
      child: () => logger,
    };
    const { app, discovery } = world({}, logger);
    // 手写定义绕过 definePlugin 的定义期校验；自定义加载器可能交来这种东西
    const unsafe = { name: 'constructor', apply() {} } as PluginDefinition;
    const loader: PluginLoader = {
      async discover() {
        return [
          { name: 'constructor', source: 'stub' },
          { name: 'fine', source: 'stub' },
        ];
      },
      async load(desc) {
        return desc.name === 'constructor' ? unsafe : definePlugin({ name: 'fine', apply() {} });
      },
    };
    await discovery(loader).loadAll();
    expect(errors).toContain('加载插件 "constructor" 失败:');
    expect(app.plugins.getPlugin('fine')?.state).toBe('active');
  });
});
