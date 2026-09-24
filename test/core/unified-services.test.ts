import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  type LifecycleCap,
  type Logger,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

declare module '@aalis/core' {
  interface AalisEvents {
    '__t:unified-services': [];
  }
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});
function makeApp() {
  const app = new App({ name: 'unified', logLevel: 'error', logger: silent });
  apps.push(app);
  return app;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 只为测试造的描述符：把资源口的身份交给 apply，供以调用者自身身份调用内置提供者 */
const me = defineService<unknown, symbol>('__t:unified-me', port => port.identity);

describe('统一服务：第一方和第三方经过相同的容器与消费者解析', () => {
  it('启动即枚举全部基础服务', () => {
    const app = makeApp();
    const host = app.bind({ services });
    expect(host.services.names().sort()).toEqual(
      [
        'events',
        'hooks',
        'contributions',
        'lifecycle',
        'logger',
        'config',
        'provide',
        'services',
        'app',
        'plugins',
      ].sort(),
    );
  });

  it('动态查询 config 和 lifecycle 得到提供者，凭调用者自身身份解析出与显式声明一致的视图', async () => {
    const app = makeApp();
    const seen = new Map<
      string,
      { config: Readonly<Record<string, unknown>>; lifecycle: LifecycleCap; viaLookup: LifecycleCap }
    >();
    for (const name of ['left', 'right']) {
      await app.plugin(
        definePlugin({
          name,
          uses: { config, lifecycle, services, me: optional(me) },
          apply({ config: ownConfig, lifecycle: ownLifecycle, services: lookup, me }) {
            const configProvider = lookup.get(config);
            if (!configProvider) throw new Error('config 提供者缺席');
            expect(lookup.get('config')).toBe(configProvider);
            expect(configProvider(me)).toBe(ownConfig);
            expect(() => configProvider(Symbol(name))).toThrow('只能由在 uses 里声明了它的激活取用');
            const lifecycleProvider = lookup.all(lifecycle)[0]?.instance;
            if (!lifecycleProvider) throw new Error('lifecycle 提供者缺席');
            const viaLookup = lifecycleProvider(me);
            expect(viaLookup.id).toBe(ownLifecycle.id);
            expect(viaLookup.closed).toBe(false);
            seen.set(name, { config: ownConfig, lifecycle: ownLifecycle, viaLookup });
          },
        }),
        { name },
      );
    }
    await app.plugins.idle();
    expect([...seen.keys()]).toEqual(['left', 'right']);
    expect(seen.get('left')?.config).toEqual({ name: 'left' });
    expect(seen.get('right')?.config).toEqual({ name: 'right' });
    expect(seen.get('left')?.lifecycle.id).toBe('left');
    expect(seen.get('right')?.lifecycle.id).toBe('right');
    expect(seen.get('left')?.lifecycle).not.toBe(seen.get('right')?.lifecycle);
    await app.plugins.unload('left');
    expect(seen.get('left')?.lifecycle.closed).toBe(true);
    expect(seen.get('left')?.viaLookup.closed).toBe(true);
    expect(seen.get('right')?.lifecycle.closed).toBe(false);
    expect(seen.get('right')?.viaLookup.closed).toBe(false);
  });

  it('follow 换提供者时等待旧清理，只挂最新提供者', async () => {
    const app = makeApp();
    const host = app.bind({ provide });
    const version = defineService<{ tag: string }>('__t:follow-version');
    const publish = (tag: string, priority: number) =>
      host.provide(version, { tag }, { priority, entryId: `root/${tag}` });
    publish('old', 0);
    const cleanupStarted = deferred();
    const release = deferred();
    const attached: string[] = [];
    const cleaned: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'follower',
        uses: { version: optional(version) },
        apply({ version }) {
          version.follow(instance => {
            attached.push(instance.tag);
            return async () => {
              if (instance.tag === 'old') {
                cleanupStarted.resolve();
                await release.promise;
              }
              cleaned.push(instance.tag);
            };
          });
        },
      }),
    );
    try {
      publish('middle', 1);
      await cleanupStarted.promise;
      publish('latest', 2);
      await app.plugins.idle();
      expect(attached).toEqual(['old']);
      expect(cleaned).toEqual([]);
      release.resolve();
      await expect.poll(() => attached).toEqual(['old', 'latest']);
      expect(cleaned).toEqual(['old']);
      await app.plugins.unload('follower');
      expect(cleaned).toEqual(['old', 'latest']);
    } finally {
      release.resolve();
    }
  });

  it('exclusive 对第一方与第三方使用同一规则，双向拒绝冲突，卸载后释放名称', async () => {
    const app = makeApp();
    const host = app.bind({ provide, services });
    const unique = defineService<{ value: number }>('__t:exclusive');
    const ordinary = defineService<{ value: number }>('__t:ordinary');
    await app.plugin(
      definePlugin({
        name: 'exclusive-provider',
        uses: { provide },
        apply({ provide }) {
          provide(unique, { value: 1 }, { exclusive: true });
        },
      }),
    );
    expect(() => host.provide(unique, { value: 2 })).toThrow(/独占/);
    const off = host.provide(ordinary, { value: 1 });
    expect(() => host.provide(ordinary, { value: 2 }, { exclusive: true })).toThrow(/独占/);
    expect(() => host.provide(events, () => ({ on: () => () => {}, emit: async () => {} }))).toThrow(/独占/);
    expect(host.services.all(unique)).toHaveLength(1);
    await app.plugins.unload('exclusive-provider');
    host.provide(unique, { value: 3 }, { exclusive: true });
    expect(host.services.get(unique)).toEqual({ value: 3 });
    off();
    host.provide(ordinary, { value: 4 }, { exclusive: true });
    expect(host.services.get(ordinary)).toEqual({ value: 4 });
  });

  it('真实 tools 的登记可执行且随消费者撤回，事件在撤回回调发射前已同栈切断', async () => {
    const app = makeApp();
    const host = app.bind({ provide, events });
    const registry = new ToolRegistry(silent);
    host.provide(tools, registry);
    // 绑定口交给消费者一个开关：调用时在消费者的清理链上挂一条撤回，撤回时向根发射测试事件
    const cleanupEmitter = defineService<object, () => void>(
      '__t:cleanup-emitter',
      port => () => void port.track(() => host.events.emit('__t:unified-services')),
    );
    host.provide(cleanupEmitter, {});
    let ownHits = 0;
    let rootHits = 0;
    host.events.on('__t:unified-services', () => {
      rootHits++;
    });
    await app.plugin(
      definePlugin({
        name: 'tool-consumer',
        uses: { tools, events, cleanupEmitter },
        apply({ tools, events, cleanupEmitter }) {
          events.on('__t:unified-services', () => {
            ownHits++;
          });
          cleanupEmitter();
          events.on('__t:unified-services', () => {
            ownHits++;
          });
          tools.register({
            definition: {
              type: 'function',
              function: { name: 'unified_echo', description: '', parameters: { type: 'object', properties: {} } },
            },
            handler: async () => 'executed',
          });
        },
      }),
    );
    expect(await registry.execute('unified_echo', {}, { sessionId: 'test' })).toEqual({ content: 'executed' });
    await host.events.emit('__t:unified-services');
    expect([ownHits, rootHits]).toEqual([2, 1]);
    await app.plugins.unload('tool-consumer');
    expect(registry.getAll()).toEqual([]);
    expect([ownHits, rootHits]).toEqual([2, 2]);
  });
});
