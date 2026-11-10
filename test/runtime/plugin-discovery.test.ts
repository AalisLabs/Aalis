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
import { withPluginConfigSync } from '../../packages/runtime/src/config-sync.js';
import {
  createPluginDiscovery,
  type PluginDescriptor,
  type PluginLoader,
} from '../../packages/runtime/src/plugin-discovery.js';

// 宿主层的插件发现：冷启动整批交给 core（返回即收敛），热扫描不等静置、只报真正登记的、
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
      apply: ({ store }) => void seen.push(store.use.id),
    });
    const fallback = definePlugin({
      name: 'pd-fallback',
      uses: { provide },
      provides: [store],
      apply: ({ provide }) => {
        provide.use(store, { id: 'fallback' }, { priority: -100 });
      },
    });
    const preferred = definePlugin({
      name: 'pd-preferred',
      uses: { provide },
      provides: [store],
      apply: ({ provide }) => {
        provide.use(store, { id: 'preferred' }, { priority: 10 });
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

  it('找不到插件的单实例配置段逐段告警一次；已发现（含导入失败、定义校验不过）、已登记与多实例键不报', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message: string) => void warns.push(message),
      error() {},
      child: () => logger,
    };
    const { app, discovery } = world(
      {
        plugins: {
          present: {},
          'present:work': {},
          broken: {},
          'bad-def': { apiKey: 'sk-PLACEHOLDER' },
          'pre-registered': {},
          'gone-plugin': { apiKey: 'sk-PLACEHOLDER' },
          'gone-plugin:x': {},
        },
      },
      logger,
    );
    await app.plugin(definePlugin({ name: 'pre-registered', apply() {} }));
    const loader: PluginLoader = {
      async discover() {
        return [
          { name: 'present', source: 'stub' },
          { name: 'broken', source: 'stub' },
          // 装着但定义坏了（如包里自带一份 core）：它的配置段不是孤儿，不能引导去删
          { name: 'bad-def', source: 'stub' },
        ];
      },
      async load(desc) {
        if (desc.name === 'broken') throw new Error('import failed');
        if (desc.name === 'bad-def') return { name: 'bad-def', uses: { x: {} }, apply() {} } as never;
        return definePlugin({ name: desc.name, reusable: true, apply() {} });
      },
    };
    await discovery(loader).loadAll();
    const orphan = warns.filter(w => w.startsWith('配置段'));
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toContain('"gone-plugin"');
    expect(orphan[0]).toContain('可能含密钥');
    expect(orphan[0]).not.toContain('sk-PLACEHOLDER');
    // 多实例键归实例登记报：合法实例不报，孤儿实例只报一次
    expect(warns.some(w => w.includes('present:work'))).toBe(false);
    expect(warns.filter(w => w.includes('gone-plugin:x'))).toHaveLength(1);
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
        apply: ({ provide }) => void provide.use(store, { id }, { priority }),
      });
    const consumer = definePlugin({
      name: 'pd-rescan-consumer',
      uses: { store },
      apply: ({ store }) => void seen.push(store.use.id),
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
});

describe('热重载登记配置里的后缀实例', () => {
  it('模块取注册表里已登记的定义，配置与禁用标记取自文档；已注册的跳过，模块未登记的告警跳过', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message: string) => void warns.push(message),
      error() {},
      child: () => logger,
    };
    const { app, store, discovery } = world({}, logger);
    // 模块不经加载器、直接登记：加载器什么也发现不到，定义只能从注册表取
    await app.plugin(definePlugin({ name: 'rs-hot', reusable: true, apply() {} }));
    const d = discovery(memoryLoader([]));
    store.setPluginConfig('rs-hot:a', { k: 1 });
    store.setPluginConfig('rs-hot:off', { k: 2 });
    store.setPluginEnabled('rs-hot:off', false);
    store.setPluginConfig('rs-gone:x', {});

    await d.registerConfiguredInstances();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rs-hot:a')?.state).toBe('active');
    expect(app.plugins.getPlugin('rs-hot:a')?.config).toEqual({ k: 1 });
    expect(app.plugins.getPlugin('rs-hot:off')?.state).toBe('disabled');
    expect(warns.filter(w => w.includes('"rs-gone:x"'))).toHaveLength(1);

    await d.registerConfiguredInstances();
    expect(warns.filter(w => w.includes('已注册'))).toEqual([]);
  });

  it('主实例已卸载、后缀实例还在册：新出现的后缀段取在册实例的定义照常登记，不报模块未找到', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message: string) => void warns.push(message),
      error() {},
      child: () => logger,
    };
    const { app, store, discovery } = world({}, logger);
    await app.plugin(definePlugin({ name: 'rs-main', reusable: true, apply() {} }));
    const d = discovery(memoryLoader([]));
    store.setPluginConfig('rs-main:a', {});
    await d.registerConfiguredInstances();
    await app.plugins.idle();
    await app.plugins.unload('rs-main');

    store.setPluginConfig('rs-main:b', {});
    await d.registerConfiguredInstances();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rs-main:b')?.state).toBe('active');
    expect(warns).toEqual([]);
  });

  it('同模块在册实例的定义不一致（主实例换过代码）：取主实例的', async () => {
    const { app, store, discovery } = world();
    const v1 = definePlugin({ name: 'rs-ver', reusable: true, apply() {} });
    const v2 = definePlugin({ name: 'rs-ver', reusable: true, apply() {} });
    await app.plugin(v1);
    const d = discovery(memoryLoader([]));
    store.setPluginConfig('rs-ver:a', {});
    await d.registerConfiguredInstances();
    await app.plugins.idle();
    // 换代码走 unload + register：rs-ver:a 仍是旧定义；rs-ver:c 以旧定义登记在主实例之后，
    // 注册表里主实例前后都有旧定义，按先到或后到取都会拿到 v1
    await app.plugins.unload('rs-ver');
    await app.plugins.register(v2);
    await app.plugins.register(v1, {}, 'rs-ver:c');

    store.setPluginConfig('rs-ver:b', {});
    await d.registerConfiguredInstances();
    expect(app.plugins.getPlugin('rs-ver:b')?.definition).toBe(v2);
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
          seen[name] = config.use;
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

describe('插件名即包名', () => {
  function recording() {
    const warnings: string[] = [];
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')),
      child: () => logger,
    };
    return { logger, warnings, errors };
  }
  /** 依次发现的条目：[描述符名（包名）, 来源, 它的入口导出的定义]；记下每个来源被导入的次数 */
  function entries(list: Array<[string, string, PluginDefinition]>) {
    const imports = new Map<string, number>();
    const loader: PluginLoader = {
      async discover() {
        return list.map(([name, source]) => ({ name, source }));
      },
      async load(desc) {
        imports.set(desc.source, (imports.get(desc.source) ?? 0) + 1);
        return list.find(([, source]) => source === desc.source)?.[2] ?? null;
      },
    };
    return { loader, imports };
  }

  it('定义名与描述符名（包名）不同：报错点名两样、拒载，不同步它的配置', async () => {
    const { logger, errors } = recording();
    const { app, store } = world({ plugins: { 'zz-other': { keep: 1 } } }, logger);
    const definition = definePlugin({
      name: 'zz-other',
      configSchema: { x: { type: 'number', label: 'X', default: 1 } },
      apply() {},
    });
    const { loader } = entries([['@zz/pkg', 'mem', definition]]);
    await createPluginDiscovery(app, loader, store, withPluginConfigSync(app, store)).loadAll();
    expect(app.plugins.getPlugin('zz-other')).toBeUndefined();
    expect(store.getPluginConfig('zz-other')).toEqual({ keep: 1 });
    expect(errors).toEqual(['插件包 "@zz/pkg" 的定义 name 是 "zz-other"，必须与包名相同，已拒绝加载']);
  });

  it('冷启动同一个名字发现了两份：只导入前一份，主实例与后缀实例都用它，配置段只按它的 schema 同步；告警点名两处来源', async () => {
    const { logger, warnings } = recording();
    const { app, store } = world({ plugins: { 'zz-same': { apiKey: 'k' }, 'zz-same:2': {} } }, logger);
    const ran: string[] = [];
    const copy = (from: string, configSchema: PluginDefinition['configSchema']) =>
      definePlugin({ name: 'zz-same', reusable: true, configSchema, apply: () => void ran.push(from) });
    const { loader, imports } = entries([
      ['zz-same', '/a', copy('a', { apiKey: { type: 'string', label: 'K' } })],
      ['zz-same', '/b', copy('b', { token: { type: 'string', label: 'T', default: 'from-b' } })],
    ]);
    await createPluginDiscovery(app, loader, store, withPluginConfigSync(app, store)).loadAll();
    expect(app.plugins.getPlugin('zz-same:2')?.state).toBe('active');
    expect(ran).toEqual(['a', 'a']);
    expect(imports.get('/b')).toBeUndefined();
    expect(store.getPluginConfig('zz-same')).toEqual({ apiKey: 'k' });
    expect(warnings.filter(line => line.includes('zz-same'))).toEqual([
      '插件 "zz-same" 发现了两份（/a 与 /b），只加载前一份',
    ]);
  });

  it('同一个名字的两份里前面的没导入成（导入失败、定义名与包名不同）：照常导入后面那份，不告警两份', async () => {
    const { logger, warnings } = recording();
    const w = world({}, logger);
    const good = definePlugin({ name: 'zz-dup', apply() {} });
    const { loader } = entries([
      ['zz-dup', '/broken', definePlugin({ name: 'zz-dup', apply() {} })],
      ['zz-dup', '/renamed', definePlugin({ name: 'zz-renamed', apply() {} })],
      ['zz-dup', '/good', good],
    ]);
    const load = loader.load;
    loader.load = async desc => {
      if (desc.source === '/broken') throw new Error('入口坏了');
      return load(desc);
    };
    await w.discovery(loader).loadAll();
    expect(w.app.plugins.getPlugin('zz-dup')?.definition).toBe(good);
    expect(warnings.filter(line => line.includes('两份'))).toEqual([]);
  });

  it('热扫描：名字已由宿主直接登记，不导入同名包、告警；后缀实例用已登记的定义，loaded 为 false', async () => {
    const { logger, warnings } = recording();
    const w = world({ plugins: { 'zz-host:2': {} } }, logger);
    const ran: string[] = [];
    const copy = (from: string) => definePlugin({ name: 'zz-host', reusable: true, apply: () => void ran.push(from) });
    await w.app.plugin(copy('host'));
    const { loader, imports } = entries([['zz-host', 'mem', copy('pkg')]]);
    const discovery = w.discovery(loader);
    expect(await discovery.rescan()).toEqual([]);
    await w.app.plugins.idle();
    expect(imports.size).toBe(0);
    expect(w.app.plugins.getPlugin('zz-host:2')?.state).toBe('active');
    expect(ran).toEqual(['host', 'host']);
    expect(discovery.loaded('zz-host')).toBe(false);
    expect(warnings).toEqual(['插件 "zz-host" 已由宿主直接登记，跳过发现到的同名包']);
  });

  it('热扫描：已从这个包登记的不再导入，不告警，后缀实例用已登记的定义', async () => {
    const { logger, warnings } = recording();
    const w = world({}, logger);
    let version = 0;
    const ran: number[] = [];
    const discovery = w.discovery({
      async discover() {
        return [{ name: 'zz-loaded', source: 'mem' }];
      },
      async load() {
        const v = ++version;
        return definePlugin({ name: 'zz-loaded', reusable: true, apply: () => void ran.push(v) });
      },
    });
    await discovery.loadAll();
    w.store.setPluginConfig('zz-loaded:2', {});
    expect(await discovery.rescan()).toEqual([]);
    await w.app.plugins.idle();
    expect(version, '热扫描没有再导入').toBe(1);
    expect(w.app.plugins.getPlugin('zz-loaded:2')?.state).toBe('active');
    expect(ran).toEqual([1, 1]);
    expect(discovery.loaded('zz-loaded')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('两次热扫描并发：后一次导入完时前一次已登记，不交给 core，不告警', async () => {
    const { logger, warnings } = recording();
    const w = world({}, logger);
    let release!: () => void;
    const late = new Promise<void>(r => {
      release = r;
    });
    let imports = 0;
    const discovery = w.discovery({
      async discover() {
        return [{ name: 'zz-twice', source: 'mem' }];
      },
      async load() {
        if (++imports === 2) await late;
        return definePlugin({ name: 'zz-twice', apply() {} });
      },
    });
    const first = discovery.rescan();
    const second = discovery.rescan();
    expect(await first).toEqual(['zz-twice']);
    release();
    expect(await second).toEqual([]);
    expect(imports).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('热扫描：从这个包登记的主实例卸载后（后缀实例还在册），照旧重新导入登记', async () => {
    const w = world({ plugins: { 'zz-unloaded:2': {} } });
    const { loader } = entries([
      ['zz-unloaded', 'mem', definePlugin({ name: 'zz-unloaded', reusable: true, apply() {} })],
    ]);
    const discovery = w.discovery(loader);
    await discovery.loadAll();
    await w.app.plugins.unload('zz-unloaded');
    expect(w.app.plugins.getPlugin('zz-unloaded:2')?.state).toBe('active');
    expect(discovery.loaded('zz-unloaded')).toBe(false);
    expect(await discovery.rescan()).toEqual(['zz-unloaded']);
    expect(discovery.loaded('zz-unloaded')).toBe(true);
  });
});
