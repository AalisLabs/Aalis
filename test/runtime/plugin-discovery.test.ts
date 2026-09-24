import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import {
  createPluginDiscovery,
  type PluginDescriptor,
  type PluginLoader,
} from '../../packages/runtime/src/plugin-discovery.js';

// 宿主层的插件发现：冷启动整批交给 core（返回即收敛），热扫描不等静置、只报真正落账的、
// 与冷启动同样收齐配置里的 name:suffix 实例。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world(plugins: Record<string, Record<string, unknown>> = {}): App {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins } });
  apps.push(app);
  return app;
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
    const app = world();
    // 发现序刻意把后备与消费者排在首选之前（逐个注册即激活时，消费者会从后备加载）
    await createPluginDiscovery(app, memoryLoader([fallback, consumer, preferred])).loadAll();
    expect(seen).toEqual(['preferred']);
  });

  it('返回时全部发现的插件已收敛，即使登记撞上在飞 run 排队', async () => {
    const app = world();
    const g = gated('occupier');
    const occupying = app.plugin(g.definition);
    await g.entered;
    const booted = definePlugin({ name: 'booted', apply() {} });
    const loading = createPluginDiscovery(app, memoryLoader([booted])).loadAll();
    const stateAtResolve = loading.then(() => app.plugins.getPlugin('booted')?.state);
    await new Promise(r => setTimeout(r, 10));
    g.release();
    expect(await stateAtResolve).toBe('active');
    await occupying;
  });

  it('配置里的 name:suffix 实例一并登记', async () => {
    const def = definePlugin({ name: 'rs-scan', reusable: true, apply() {} });
    const app = world({ 'rs-scan:work': { k: 1 } });
    await createPluginDiscovery(app, memoryLoader([def])).loadAll();
    expect(app.plugins.getPlugin('rs-scan')?.state).toBe('active');
    expect(app.plugins.getPlugin('rs-scan:work')?.state).toBe('active');
  });
});

describe('热扫描', () => {
  it('在飞 run 占着单飞时仍立即 resolve（新插件此刻 pending，事后自愈）', async () => {
    const app = world();
    const g = gated('occupier');
    const occupying = app.plugin(g.definition);
    await g.entered;
    const discovery = createPluginDiscovery(app, memoryLoader([definePlugin({ name: 'scanned', apply() {} })]));
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
    const app = world({ 'rs-scan:work': { k: 1 } });
    const discovery = createPluginDiscovery(app, memoryLoader([def]));
    await discovery.rescan();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rs-scan:work')?.state).toBe('active');
    app.config.setPluginConfig('rs-scan:late', {});
    await discovery.rescan();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rs-scan:late')?.state).toBe('active');
  });

  it('描述符名与模块自报名不同、而自报名已注册时，不计入热加载名单', async () => {
    const app = world();
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
    expect(await createPluginDiscovery(app, loader).rescan()).toEqual(['fresh']);
  });

  it('插件在 apply 里触发热扫描不自锁', async () => {
    const app = world();
    const discovery = createPluginDiscovery(app, memoryLoader([definePlugin({ name: 'late', apply() {} })]));
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
});
