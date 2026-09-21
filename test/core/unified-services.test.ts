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
  serviceFactory,
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
  const app = new App({ config: { name: 'unified', logLevel: 'error', plugins: {} }, logger: silent });
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

describe('统一服务：第一方和第三方经过相同的容器与消费者解析', () => {
  it('启动即枚举全部基础服务；枚举名字和底层投影不会执行工厂', () => {
    const app = makeApp();
    const host = app.bind({ provide, services });
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
        'host-config',
      ].sort(),
    );
    let created = 0;
    const lazy = defineService<{ value: number }>('__t:lazy-factory');
    host.provide(
      lazy,
      serviceFactory(() => ({ value: ++created })),
    );

    expect(host.services.names()).toContain(lazy.name);
    expect(app.services.getServiceNames()).toContain(lazy.name);
    expect(app.services.getAll(lazy.name)).toHaveLength(1);
    expect(created).toBe(0);
    expect(host.services.get(lazy)).toEqual({ value: 1 });
    expect(host.services.all(lazy)[0]?.instance).toBe(host.services.get(lazy));
    expect(created).toBe(1);
  });

  it('动态查询 config 和 lifecycle 解析调用者自身，与显式声明取得同一对象', async () => {
    const app = makeApp();
    const seen = new Map<string, { config: Readonly<Record<string, unknown>>; lifecycle: LifecycleCap }>();
    for (const name of ['left', 'right']) {
      await app.plugin(
        definePlugin({
          name,
          uses: { config, lifecycle, services },
          apply({ config: ownConfig, lifecycle: ownLifecycle, services: lookup }) {
            expect(lookup.get(config)).toBe(ownConfig);
            expect(lookup.get('config')).toBe(ownConfig);
            expect(lookup.all(lifecycle)[0]?.instance).toBe(ownLifecycle);
            seen.set(name, { config: ownConfig, lifecycle: ownLifecycle });
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
    expect(seen.get('right')?.lifecycle.closed).toBe(false);
  });

  it('第三方工厂按激活缓存，同名描述符、别名和动态查询复用实例，资源随消费者撤回', async () => {
    const app = makeApp();
    interface Personal {
      id: string;
      identity: symbol;
    }
    const personal = defineService<Personal>('__t:personal');
    const secondContract = defineService<Personal>(personal.name);
    const created: Personal[] = [];
    const released: symbol[] = [];
    app.bind({ provide }).provide(
      personal,
      serviceFactory(scope => {
        const instance = { id: scope.id, identity: scope.identity };
        created.push(instance);
        scope.track(() => void released.push(scope.identity));
        return instance;
      }),
    );
    for (const name of ['first', 'second']) {
      await app.plugin(
        definePlugin({
          name,
          uses: { one: personal, two: secondContract, services },
          apply({ one, two, services: lookup }) {
            expect(one.require()).toBe(two.require());
            expect(one.all()[0]?.instance).toBe(one.require());
            expect(lookup.get(secondContract)).toBe(one.require());
            expect(one.require().id).toBe(name);
          },
        }),
      );
    }
    await app.plugins.idle();
    expect(created.map(instance => instance.id)).toEqual(['first', 'second']);
    expect(created[0]?.identity).not.toBe(created[1]?.identity);
    await app.plugins.unload('first');
    expect(released).toEqual([created[0]?.identity]);
    await app.plugins.unload('second');
    expect(released).toEqual(created.map(instance => instance.identity));
  });

  it('同一个 factory 对象重复发布，每次登记独立建实例；撤回后重新发布不会复用旧缓存', () => {
    const app = makeApp();
    const host = app.bind({ provide, services });
    const counter = defineService<{ serial: number }>('__t:counter');
    let serial = 0;
    const factory = serviceFactory(() => ({ serial: ++serial }));
    const offFirst = host.provide(counter, factory, { entryId: 'root/first' });
    host.provide(counter, factory, { entryId: 'root/second' });
    const initial = host.services.all(counter);
    expect(initial.map(entry => entry.instance.serial)).toEqual([1, 2]);
    expect(initial[0]?.instance).not.toBe(initial[1]?.instance);
    offFirst();
    host.provide(counter, factory, { entryId: 'root/first' });
    const next = host.services.all(counter);
    expect(next.map(entry => entry.instance.serial)).toEqual([2, 3]);
    expect(next[0]?.instance).toBe(initial[1]?.instance);
  });

  it('follow 换工厂时等待旧清理，只挂最新提供者，并保留消费者身份', async () => {
    const app = makeApp();
    const host = app.bind({ provide });
    const version = defineService<{ tag: string; consumer: string }>('__t:factory-version');
    const publish = (tag: string, priority: number) =>
      host.provide(
        version,
        serviceFactory(scope => ({ tag, consumer: scope.id })),
        { priority, entryId: `root/${tag}` },
      );
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
            attached.push(`${instance.tag}:${instance.consumer}`);
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
      expect(attached).toEqual(['old:follower']);
      expect(cleaned).toEqual([]);
      release.resolve();
      await expect.poll(() => attached).toEqual(['old:follower', 'latest:follower']);
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
    expect(() => host.provide(events, { on: () => () => {}, emit: async () => {} })).toThrow(/独占/);
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
    const cleanupEmitter = defineService<object>('__t:cleanup-emitter');
    host.provide(
      cleanupEmitter,
      serviceFactory(scope => {
        scope.track(() => host.events.emit('__t:unified-services'));
        return {};
      }),
    );
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
          cleanupEmitter.require();
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

  it('工厂抛错使消费者激活失败，工厂已交出的清理仍会执行', async () => {
    const app = makeApp();
    const broken = defineService<object>('__t:broken-factory');
    const released: string[] = [];
    app.bind({ provide }).provide(
      broken,
      serviceFactory(scope => {
        scope.track(() => void released.push(scope.id));
        throw new Error('factory failed');
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'broken-consumer',
        uses: { broken },
        apply({ broken }) {
          broken.require();
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('broken-consumer')?.state).toBe('error');
    expect(released).toEqual(['broken-consumer']);
  });
});
