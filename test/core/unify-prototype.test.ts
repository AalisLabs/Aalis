import { afterEach, describe, expect, it } from 'vitest';
import { type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { assemble } from '../../packages/core/src/context/binding.js';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  logger,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { rootActivation } from '../../packages/core/src/orchestration/app.js';
import type { PluginRecord } from '../../packages/core/src/orchestration/plugin-activation.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

// ════════════════════════════════════════════════════════════
// 统一服务架构纵向原型：插件不接收 Context，声明描述符、拿按激活绑定的接口。
// 这里的「未知第三方能力」zz-hub 完全定义在测试里（模拟独立发布的契约包 + 提供者），
// core 对它一无所知；tools 是真实注册型能力，process 是真实调用型服务。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ----- 未知第三方能力：契约（描述符 + 类型）-----

interface HubItem {
  name: string;
  /** 这条登记的退订行为：同步 / 慢异步 / 异步拒绝 / 同步抛错 */
  off?: 'sync' | 'slow' | 'reject' | 'throw';
  /** 登记时抛错（模拟业务校验失败） */
  failOnRegister?: boolean;
}
interface HubService {
  register(item: HubItem, owner: string): () => unknown;
  list(): string[];
  settled: string[];
}
interface BoundHub {
  register(item: HubItem): () => void;
}
const makeHubDescriptor = () =>
  defineService<HubService, BoundHub>('zz-hub', port => {
    const book = port.registrar<HubItem>({
      key: item => item.name,
      register: (hub, item) => hub.register(item, port.id),
    });
    return { register: item => book.add(item) };
  });
const hub = makeHubDescriptor();

// ----- 未知第三方能力：提供者实现（枢纽）。无 unregisterByPlugin，撤回只靠逐条句柄 -----

function makeHub(tag = 'hub'): HubService {
  const items = new Map<string, { item: HubItem; owner: string }>();
  const settled: string[] = [];
  return {
    settled,
    register(item, owner) {
      if (item.failOnRegister) throw new Error(`${tag}: 拒绝登记 ${item.name}`);
      const entry = { item, owner };
      items.set(item.name, entry);
      const remove = () => {
        if (items.get(item.name) === entry) items.delete(item.name);
      };
      return () => {
        if (item.off === 'throw') {
          remove();
          throw new Error(`off ${item.name} 同步抛错`);
        }
        if (item.off === 'slow') {
          return sleep(30).then(() => {
            remove();
            settled.push(item.name);
          });
        }
        if (item.off === 'reject') {
          remove();
          return Promise.reject(new Error(`off ${item.name} 拒绝`));
        }
        remove();
        return undefined;
      };
    },
    list: () => [...items.keys()].sort(),
  };
}

// ----- 测试世界 -----

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: unknown, ...rest: unknown[]) => warnings.push([message, ...rest].map(String).join(' ')),
    error: () => {},
    child: () => logger,
  };
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return { app, warnings, host: app.bind({ provide, services }) };
}

/** 提供 zz-hub 的插件（第三方提供者，走同一套定义入口） */
const hubProvider = (instance: HubService, name = 'hub-provider') =>
  definePlugin({
    name,
    uses: { provide },
    provides: [hub],
    apply({ provide }) {
      provide(hub, instance);
    },
  });

const state = (app: App, id: string) => app.plugins.getStatus().find(s => s.instanceId === id)?.state;

describe('目标接口：声明描述符，拿按激活绑定的接口', () => {
  it('第一方 events 与未知第三方 zz-hub 同一种接入；卸载后两者都撤净', async () => {
    const { app } = world();
    const instance = makeHub();
    let ready = 0;
    await app.plugin(hubProvider(instance));
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { hub, events, logger, lifecycle, config },
        apply({ hub, events, logger, lifecycle, config }) {
          hub.register({ name: 'echo' });
          events.on('app:ready', () => {
            ready++;
          });
          logger.info(`config=${JSON.stringify(config)}`);
          lifecycle.onDispose(() => {});
        },
      }),
    );
    await app.plugins.idle();
    expect(state(app, 'consumer')).toBe('active');
    expect(instance.list()).toEqual(['echo']);
    await app.bind({ events }).events.emit('app:ready');
    expect(ready).toBe(1);

    await app.plugins.unload('consumer');
    expect(instance.list(), '注册型登记随激活撤回，不靠按名字清扫').toEqual([]);
    await app.bind({ events }).events.emit('app:ready');
    expect(ready, '事件监听同样撤回').toBe(1);
  });

  it('真实注册型能力 tools 与真实调用型服务 process 走同一声明', async () => {
    const { app, host } = world();
    const registry = new ToolRegistry(app.bind({ logger }).logger);
    host.provide(tools, registry);
    const fakeProcess = { execFile: async () => ({ stdout: 'v1', stderr: '', code: 0 }) } as unknown as ProcessService;
    host.provide(processService, fakeProcess);
    let out = '';
    await app.plugin(
      definePlugin({
        name: 'runner',
        uses: { tools, process: processService },
        apply({ tools, process }) {
          tools.registerGroup({ name: 'g', label: 'g' });
          tools.register({
            definition: {
              type: 'function',
              function: { name: 'run', description: '', parameters: { type: 'object', properties: {} } },
            },
            groups: ['g'],
            handler: async () => {
              out = (await process.require().execFile('echo', [])).stdout;
              return out;
            },
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(registry.getAll().map(t => t.name)).toEqual(['run']);
    await registry.execute('run', {}, { sessionId: 's', platform: 't' });
    expect(out).toBe('v1');
    await app.plugins.unload('runner');
    expect(registry.getAll()).toEqual([]);
    expect(registry.getGroups()).toEqual([]);
  });
});

describe('资源身份：同名不同激活互不清扫', () => {
  it('两个同 id 的激活各登记一条，拆左不清右', async () => {
    const { app, host } = world();
    const instance = makeHub();
    host.provide(hub, instance);
    const left = rootActivation(app).fork('dup');
    const right = rootActivation(app).fork('dup');
    assemble(left, { hub }).hub.register({ name: 'from-left' });
    assemble(right, { hub }).hub.register({ name: 'from-right' });
    expect(instance.list()).toEqual(['from-left', 'from-right']);
    await left.disposeAsync();
    expect(instance.list(), '撤回按这次激活的句柄，不按 id 字符串').toEqual(['from-right']);
    await right.disposeAsync();
    expect(instance.list()).toEqual([]);
  });

  it('契约包装了两份（两个同名描述符对象）指向同一服务，各自的登记独立撤回', async () => {
    const { app } = world();
    const instance = makeHub();
    await app.plugin(hubProvider(instance));
    const copyA = makeHubDescriptor();
    const copyB = makeHubDescriptor();
    await app.plugin(
      definePlugin({ name: 'a', uses: { hub: copyA }, apply: ({ hub }) => void hub.register({ name: 'a' }) }),
    );
    await app.plugin(
      definePlugin({ name: 'b', uses: { hub: copyB }, apply: ({ hub }) => void hub.register({ name: 'b' }) }),
    );
    await app.plugins.idle();
    expect(instance.list()).toEqual(['a', 'b']);
    await app.plugins.unload('a');
    expect(instance.list()).toEqual(['b']);
  });
});

describe('子模块：重新绑定与父子关闭', () => {
  it('子模块的登记归子激活；单独关子只撤子的；关父级联关子', async () => {
    const { app } = world();
    const instance = makeHub();
    await app.plugin(hubProvider(instance));
    const child = definePlugin({
      name: 'child',
      uses: { hub },
      apply: ({ hub }) => void hub.register({ name: 'child-item' }),
    });
    let handles: Array<{ disposeAsync(): Promise<void> }> = [];
    await app.plugin(
      definePlugin({
        name: 'parent',
        uses: { hub, lifecycle },
        async apply({ hub, lifecycle }) {
          hub.register({ name: 'parent-item' });
          handles = [await lifecycle.module(child)];
        },
      }),
    );
    await app.plugins.idle();
    expect(instance.list()).toEqual(['child-item', 'parent-item']);
    await handles[0]!.disposeAsync();
    expect(instance.list(), '关子不动父的登记').toEqual(['parent-item']);

    // 再挂一个子，然后关父：级联。公开条目没有激活记录，挂载口是父激活的 lifecycle.module
    const parentCtx = (app.plugins.getPlugin('parent') as PluginRecord).context!;
    await assemble(parentCtx, { lifecycle }).lifecycle.module(child);
    expect(instance.list()).toEqual(['child-item', 'parent-item']);
    await app.plugins.unload('parent');
    expect(instance.list()).toEqual([]);
  });
});

describe('动态依赖：提供者更换、偏好、required 丢失与恢复', () => {
  it('注册型：换提供者整体重挂到新实例，旧实例撤净；任一微任务只见 0 条或全部', async () => {
    const { app, host } = world();
    const first = makeHub('first');
    const offFirst = host.provide(hub, first);
    await app.plugin(
      definePlugin({
        name: 'many',
        uses: { hub },
        apply({ hub }) {
          for (let i = 0; i < 20; i++) hub.register({ name: `t${i}` });
        },
      }),
    );
    await app.plugins.idle();
    expect(first.list()).toHaveLength(20);
    const second = makeHub('second');
    offFirst();
    host.provide(hub, second);
    const seen = new Set<number>();
    for (let hop = 0; hop < 30; hop++) {
      seen.add(second.list().length);
      await Promise.resolve();
    }
    expect(
      [...seen].every(n => n === 0 || n === 20),
      `观察到部分重挂：${[...seen]}`,
    ).toBe(true);
    expect(first.list()).toEqual([]);
    expect(second.list()).toHaveLength(20);
  });

  it('调用型：ServiceRef 每次读当前胜者——优先级更高者上线、偏好切换都即时跟随', async () => {
    const { app, host } = world();
    const kv = defineService<{ tag: string }>('zz-kv');
    host.provide(kv, { tag: 'low' }, { priority: 1, entryId: 'root/low' });
    const seen: string[] = [];
    let read!: () => void;
    await app.plugin(
      definePlugin({
        name: 'reader',
        uses: { kv },
        apply({ kv }) {
          read = () => seen.push(kv.require().tag);
        },
      }),
    );
    await app.plugins.idle();
    read();
    host.provide(kv, { tag: 'high' }, { priority: 9, entryId: 'root/high' });
    read();
    host.services.prefer(kv, 'root/low');
    read();
    host.services.unprefer(kv);
    read();
    expect(seen).toEqual(['low', 'high', 'low', 'high']);
    expect(state(app, 'reader'), '提供者换人不重启消费者').toBe('active');
  });

  it('required 丢失 → 消费者转 pending 且登记撤回；恢复 → 自动重新激活并重新登记', async () => {
    const { app } = world();
    const instance = makeHub();
    await app.plugin(hubProvider(instance));
    let applied = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { hub },
        apply({ hub }) {
          applied++;
          hub.register({ name: 'item' });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.disable('hub-provider');
    await app.plugins.idle();
    expect(state(app, 'consumer')).toBe('pending');
    expect(instance.list()).toEqual([]);
    await app.plugins.enable('hub-provider');
    await app.plugins.idle();
    expect(state(app, 'consumer')).toBe('active');
    expect(applied).toBe(2);
    expect(instance.list()).toEqual(['item']);
  });

  it('optional：提供者缺席时照常激活，登记排队到提供者上线', async () => {
    const { app, host } = world();
    await app.plugin(
      definePlugin({
        name: 'early',
        uses: { hub: optional(hub) },
        apply: ({ hub }) => void hub.register({ name: 'queued' }),
      }),
    );
    await app.plugins.idle();
    expect(state(app, 'early')).toBe('active');
    const instance = makeHub();
    host.provide(hub, instance);
    await sleep(0); // 重挂随 service:registered 的广播到达，不与 provide 同栈
    expect(instance.list()).toEqual(['queued']);
  });
});

describe('失败回滚', () => {
  it('部分装配失败：先装配的绑定已挂上的跟随与句柄全部回滚，插件进 error，apply 不执行', async () => {
    const { app, host } = world();
    const instance = makeHub();
    host.provide(hub, instance);
    const events: string[] = [];
    const eager = defineService<HubService, null>('zz-hub', port => {
      port.follow(provider => {
        const off = provider.register({ name: 'eager' }, port.id);
        events.push('attached');
        return () => {
          events.push('withdrawn');
          return off();
        };
      });
      port.track(() => events.push('tracked-off'));
      return null;
    });
    const broken = defineService<unknown, never>('zz-broken', () => {
      throw new Error('bind 失败');
    });
    host.provide(broken, {});
    let applied = false;
    await app.plugin(
      definePlugin({
        name: 'half',
        uses: { eager, broken },
        apply() {
          applied = true;
        },
      }),
    );
    await app.plugins.idle();
    expect(state(app, 'half')).toBe('error');
    expect(applied).toBe(false);
    expect(events.sort()).toEqual(['attached', 'tracked-off', 'withdrawn']);
    expect(instance.list()).toEqual([]);
  });

  it('重挂中途某条 register 抛错：其余照挂、该条留待重试，批次的撤回没有丢', async () => {
    const { app, host, warnings } = world();
    const first = makeHub('first');
    host.provide(hub, first);
    const flaky: HubItem = { name: 'flaky' };
    await app.plugin(
      definePlugin({
        name: 'batch',
        uses: { hub },
        apply({ hub }) {
          hub.register({ name: 'a' });
          hub.register(flaky);
          hub.register({ name: 'b' });
        },
      }),
    );
    await app.plugins.idle();
    // 胜者换人但服务名从不落空（required 落空会走「转 pending → 重新激活」，是另一条路径）
    flaky.failOnRegister = true;
    const second = makeHub('second');
    host.provide(hub, second, { priority: 9, entryId: 'root/second' });
    await sleep(0);
    expect(first.list(), '旧提供者上的整批已撤').toEqual([]);
    expect(second.list()).toEqual(['a', 'b']);
    expect(warnings.some(w => w.includes('"flaky" 失败（保留待重试）'))).toBe(true);
    // 再换一次：second 上已挂的两条必须被撤回（那次抛错没有让批次的 cleanup 丢失），flaky 被重试
    flaky.failOnRegister = false;
    const third = makeHub('third');
    host.provide(hub, third, { priority: 99, entryId: 'root/third' });
    await sleep(0);
    expect(second.list()).toEqual([]);
    expect(third.list()).toEqual(['a', 'b', 'flaky']);
    expect(state(app, 'batch'), '换人不重启消费者').toBe('active');
  });

  it('登记时提供者在场且 register 抛错：原样抛给调用方，账上不留半条', async () => {
    const { app, host } = world();
    const instance = makeHub();
    host.provide(hub, instance);
    const ctx = rootActivation(app).fork('p');
    const bound = assemble(ctx, { hub }).hub;
    expect(() => bound.register({ name: 'bad', failOnRegister: true })).toThrow('拒绝登记');
    const second = makeHub('second');
    host.provide(hub, second, { priority: 9, entryId: 'root/second' });
    await sleep(0);
    expect(second.list(), '失败的登记不在账上，不会被重挂').toEqual([]);
  });
});

describe('关闭契约', () => {
  it('批量撤回：同步抛错、异步拒绝各自隔离，慢撤回被 disposeAsync 等到；无未处理拒绝', async () => {
    const { app, warnings } = world();
    const instance = makeHub();
    await app.plugin(hubProvider(instance));
    await app.plugin(
      definePlugin({
        name: 'mixed',
        uses: { hub },
        apply({ hub }) {
          hub.register({ name: 'throws', off: 'throw' });
          hub.register({ name: 'rejects', off: 'reject' });
          hub.register({ name: 'slow', off: 'slow' });
          hub.register({ name: 'plain' });
        },
      }),
    );
    await app.plugins.idle();
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => escaped.push(err);
    process.on('unhandledRejection', onEscape);
    try {
      await app.plugins.unload('mixed');
      expect(instance.settled, '返回时慢撤回已落地').toEqual(['slow']);
      expect(instance.list()).toEqual([]);
      await sleep(10);
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped).toEqual([]);
    expect(warnings.some(w => w.includes('撤回抛错'))).toBe(true);
    expect(warnings.some(w => w.includes('拒绝'))).toBe(true);
  });

  it('手动退订与同键替换启动的异步撤回，由随后的关闭等到', async () => {
    const { app, host } = world();
    const instance = makeHub();
    host.provide(hub, instance);
    const ctx = rootActivation(app).fork('p');
    const bound = assemble(ctx, { hub }).hub;
    const off = bound.register({ name: 'manual', off: 'slow' });
    bound.register({ name: 'replaced', off: 'slow' });
    bound.register({ name: 'replaced' }); // 同键替换：旧登记的慢撤回在飞
    off();
    expect(instance.settled).toEqual([]);
    await ctx.disposeAsync();
    expect(instance.settled.sort()).toEqual(['manual', 'replaced']);
    expect(instance.list()).toEqual([]);
  });

  it('关闭中迟到的登记（apply 跨 await）：被拒并记 warn，不进枢纽；迟到的 onDispose 仍被执行', async () => {
    const { app, warnings } = world();
    const instance = makeHub();
    await app.plugin(hubProvider(instance));
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let lateCleanup = false;
    const registering = app.plugin(
      definePlugin({
        name: 'late',
        uses: { hub, lifecycle },
        async apply({ hub, lifecycle }) {
          hub.register({ name: 'early' });
          await gate;
          hub.register({ name: 'late' });
          lifecycle.onDispose(() => {
            lateCleanup = true;
          });
        },
      }),
    );
    await sleep(5);
    expect(instance.list()).toEqual(['early']);
    const unloading = app.plugins.unload('late');
    await sleep(5);
    release();
    await registering;
    await unloading;
    expect(instance.list()).toEqual([]);
    expect(warnings.some(w => w.includes('已关闭，忽略 zz-hub 登记 "late"'))).toBe(true);
    expect(lateCleanup, '迟到的资源清理不泄漏').toBe(true);
  });

  it('旧退订对已被替换的登记无动作；重复关闭幂等', async () => {
    const { app, host } = world();
    const instance = makeHub();
    host.provide(hub, instance);
    const ctx = rootActivation(app).fork('p');
    const bound = assemble(ctx, { hub }).hub;
    const oldOff = bound.register({ name: 'x' });
    bound.register({ name: 'x' });
    oldOff();
    expect(instance.list()).toEqual(['x']);
    await Promise.all([ctx.disposeAsync(), ctx.disposeAsync()]);
    ctx.dispose();
    expect(instance.list()).toEqual([]);
  });
});

describe('宿主：最小内存宿主', () => {
  it('启动、注册第三方能力、跑插件、停止；根绑定的登记随 stop 撤回', async () => {
    const { app, host } = world();
    const instance = makeHub();
    host.provide(hub, instance);
    const rootHub = app.bind({ hub }).hub;
    rootHub.register({ name: 'from-host' });
    await app.plugin(
      definePlugin({ name: 'p', uses: { hub }, apply: ({ hub }) => void hub.register({ name: 'from-plugin' }) }),
    );
    await app.start();
    expect(instance.list()).toEqual(['from-host', 'from-plugin']);
    await app.stop();
    expect(instance.list()).toEqual([]);
  });
});
