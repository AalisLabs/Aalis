import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type AppOptions,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  pluginsService,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { Resources } from '../../packages/core/src/infrastructure/resources.js';
import { ActivationHost } from '../../packages/core/src/orchestration/activation-host.js';
import { PluginManager } from '../../packages/core/src/orchestration/plugin.js';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

// ════════════════════════════════════════════════════════════
// watch：「可能变了，请重读」的订阅。选择层的 caps.xxx.watch 看一个服务的提供者与选择，plugins.watch 看插件状态，
// 两处同一套规则：
//   - 登记时不调；每次变化在下一个微任务里调一次，期间的多次变化合并成一次；
//   - 已退订的、订阅方已开始关闭的不调；抛错与拒绝只记在订阅方名下；
//   - 关闭后登记拒收；订阅随这次激活撤回。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const microtask = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** 一个已静置的 App（构造时登记宿主服务发起过一次重算，在飞期间的注册只排队）与它的 warn 记录 */
async function world(options: Partial<AppOptions> = {}) {
  const warns: string[] = [];
  const scoped = (scope: string): Logger => ({
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(`[${scope}] ${args.map(String).join(' ')}`),
    error() {},
    child: name => scoped(`${scope}:${name}`),
  });
  const app = new App({ logger: scoped('aalis'), ...options });
  apps.push(app);
  await app.plugins.idle();
  return { app, warns };
}

const model = defineService<{ tag: string }>('watch-test:model');
const other = defineService<{ tag: string }>('watch-test:other');

/** 提供 model 的插件；apply 可异步（等 gate） */
const provider = (name: string, gate?: Promise<void>) =>
  definePlugin({
    name,
    provides: [model],
    uses: { provide },
    async apply({ provide }) {
      provide.use(model, { tag: name });
      if (gate) await gate;
    },
  });

describe('选择层的 watch', () => {
  it('提供者上线、下线、偏好切换都通知；登记时不调，回调里读到变化后的名单', async () => {
    const { app } = await world();
    const seen: string[][] = [];
    await app.plugin(
      definePlugin({
        name: 'watcher',
        uses: { model: optional(model) },
        apply: ({ model }) => void model.watch(() => void seen.push(model.list().map(entry => entry.id))),
      }),
    );
    await tick();
    expect(seen, '登记时不调').toEqual([]);

    await app.plugin(provider('p1'));
    await tick();
    expect(seen).toEqual([['p1']]);

    await app.plugin(provider('p2'));
    await tick();
    expect(seen.at(-1)).toEqual(['p1', 'p2']);

    const before = seen.length;
    app.bind({ services }).services.use.prefer(model, 'p2');
    await tick();
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)).toEqual(['p2', 'p1']);

    await app.plugins.unload('p2');
    await tick();
    expect(seen.at(-1)).toEqual(['p1']);
  });

  it('不在变更方的调用栈上调，同一拍的多次变化合并成一次', async () => {
    const { app } = await world();
    let calls = 0;
    const host = app.bind({ provide, model: optional(model) });
    host.model.watch(() => void calls++);
    const off1 = host.provide.use(model, { tag: 'a' }, { entryId: 'a' });
    const off2 = host.provide.use(model, { tag: 'b' }, { entryId: 'b' });
    off1();
    expect(calls, '变更方的调用栈上不调').toBe(0);
    await microtask();
    expect(calls).toBe(1);
    off2();
    await microtask();
    expect(calls).toBe(2);
  });

  it('只通知这个服务的变化', async () => {
    const { app } = await world();
    let calls = 0;
    const host = app.bind({ provide, model: optional(model) });
    host.model.watch(() => void calls++);
    host.provide.use(other, { tag: 'x' });
    await microtask();
    expect(calls).toBe(0);
  });

  it('退订之后不调，排上之后才退订的也不调', async () => {
    const { app } = await world();
    const log: string[] = [];
    const host = app.bind({ provide, model: optional(model) });
    const offEarly = host.model.watch(() => void log.push('早退订'));
    const offQueued = host.model.watch(() => void log.push('排上后退订'));
    host.model.watch(() => void log.push('留着'));
    offEarly();
    host.provide.use(model, { tag: 'a' });
    offQueued();
    await microtask();
    expect(log).toEqual(['留着']);
    offQueued();
  });

  it('同一个函数登记两次各算一条', async () => {
    const { app } = await world();
    let calls = 0;
    const fn = () => void calls++;
    const host = app.bind({ provide, model: optional(model) });
    host.model.watch(fn);
    host.model.watch(fn)();
    host.provide.use(model, { tag: 'a' });
    await microtask();
    expect(calls).toBe(1);
  });

  it('订阅方开始关闭之后不调：收尾期间的变化、关完之后的变化都不通知', async () => {
    const { app } = await world();
    let calls = 0;
    const host = app.bind({ provide });
    await app.plugin(
      definePlugin({
        name: 'watcher',
        uses: { lifecycle, model: optional(model) },
        apply(caps) {
          caps.model.watch(() => void calls++);
          // 收尾期间名单变了：此刻本激活已开始关闭
          caps.lifecycle.use.onDrain(async () => {
            host.provide.use(model, { tag: 'during-drain' }, { entryId: 'd' });
            await tick();
          });
        },
      }),
    );
    await app.plugins.disable('watcher');
    host.provide.use(model, { tag: 'after-close' }, { entryId: 'e' });
    await tick();
    expect(calls).toBe(0);
  });

  it('回调抛错或拒绝：只记在订阅方名下，别的订阅者照常收到', async () => {
    const { app, warns } = await world();
    let good = 0;
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'bad',
          uses: { model: optional(model) },
          apply({ model }) {
            model.watch(() => {
              throw new Error('同步抛');
            });
            model.watch(async () => {
              throw new Error('异步拒');
            });
          },
        }),
      },
      {
        definition: definePlugin({
          name: 'good',
          uses: { model: optional(model) },
          apply: ({ model }) => void model.watch(() => void good++),
        }),
      },
    ]);
    app.bind({ provide }).provide.use(model, { tag: 'a' });
    await tick();
    expect(good).toBe(1);
    expect(warns).toEqual([
      '[aalis:bad] Resources "bad": watch-test:model 的 watch 回调抛错，已忽略: Error: 同步抛',
      '[aalis:bad] Resources "bad": watch-test:model 的 watch 回调抛错，已忽略: Error: 异步拒',
    ]);
  });

  it('激活已开始关闭之后登记：拒收并告警', async () => {
    const { app, warns } = await world();
    let calls = 0;
    let selection!: { watch(fn: () => void): () => void };
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { model: optional(model) },
        apply: ({ model }) => {
          selection = model;
        },
      }),
    );
    await app.plugins.disable('p');
    // 拒收时交回的退订是空操作
    selection.watch(() => void calls++)();
    app.bind({ provide }).provide.use(model, { tag: 'a' });
    await tick();
    expect(calls).toBe(0);
    expect(warns).toEqual(['[aalis:p] 激活 "p" 已关闭，忽略 watch-test:model 的 watch']);
  });

  it('提供者转入后台时不算上线，激活完成后上线才通知到新名单', async () => {
    const { app } = await world({ slowThresholdMs: 20 });
    const seen: string[][] = [];
    const host = app.bind({ model: optional(model) });
    host.model.watch(() => void seen.push(host.model.list().map(entry => entry.id)));
    let release!: () => void;
    void app.plugin(provider('slow', new Promise<void>(resolve => (release = resolve))));
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    expect(app.plugins.getStatus()[0]).toMatchObject({ state: 'activating', slow: true });
    expect(seen.at(-1), '转入后台后名单里没有它').toEqual([]);
    release();
    await tick();
    expect(seen.at(-1)).toEqual(['slow']);
  });
});

describe('plugins.watch', () => {
  it('每轮重算收敛后通知：注册、停用、启用、重启、卸载、激活失败；登记时不调，回调里读到收敛后的状态', async () => {
    const { app } = await world();
    const seen: string[] = [];
    app.plugins.watch(
      () =>
        void seen.push(
          app.plugins
            .getStatus()
            .map(p => `${p.instanceId}=${p.state}`)
            .join(','),
        ),
    );
    await tick();
    expect(seen, '登记时不调').toEqual([]);

    await app.plugin(definePlugin({ name: 'a', apply() {} }));
    await tick();
    expect(seen.splice(0)).toEqual(['a=active']);

    await app.plugins.disable('a');
    await tick();
    expect(seen.splice(0)).toEqual(['a=disabled']);

    await app.plugins.enable('a');
    await tick();
    expect(seen.splice(0)).toEqual(['a=active']);

    await app.plugins.bounce('a');
    await tick();
    expect(seen.splice(0)).toEqual(['a=active']);

    await app.plugin(
      definePlugin({
        name: 'broken',
        apply() {
          throw new Error('apply 失败');
        },
      }),
    );
    await tick();
    expect(seen.splice(0)).toEqual(['a=active,broken=error']);

    await app.plugins.unload('a');
    await tick();
    expect(seen.splice(0)).toEqual(['broken=error']);
  });

  it('只登记禁用条目：不重算，名单多了一行照样通知', async () => {
    const { app } = await world();
    const seen: string[] = [];
    app.plugins.watch(
      () =>
        void seen.push(
          app.plugins
            .getStatus()
            .map(p => `${p.instanceId}=${p.state}`)
            .join(','),
        ),
    );
    expect(await app.plugin(definePlugin({ name: 'off', apply() {} }), {}, undefined, { disabled: true })).toBe(true);
    await tick();
    expect(seen).toEqual(['off=disabled']);
    // 登记被拒（重名）：名单没变，不通知
    expect(await app.plugin(definePlugin({ name: 'off', apply() {} }), {}, undefined, { disabled: true })).toBe(false);
    await tick();
    expect(seen).toEqual(['off=disabled']);
  });

  it('插件经 uses 声明的 plugins 服务登记：回调里等 idle() 不互等，订阅方开始关闭后不调', async () => {
    const { app } = await world();
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'observer',
        uses: { plugins: pluginsService },
        apply: ({ plugins }) =>
          void plugins.use.watch(async () => {
            await plugins.use.idle();
            log.push(
              plugins.use
                .getStatus()
                .map(p => p.instanceId)
                .join(','),
            );
          }),
      }),
    );
    await tick();
    // 自己激活的那一轮收敛时订阅已在：通知到
    expect(log.splice(0)).toEqual(['observer']);

    await app.plugin(definePlugin({ name: 'x', apply() {} }));
    await tick();
    expect(log.splice(0)).toEqual(['observer,x']);

    await app.plugins.disable('observer');
    await app.plugins.unload('x');
    await tick();
    expect(log).toEqual([]);
  });

  it('停机那一轮不通知', async () => {
    const { app } = await world();
    let calls = 0;
    await app.plugin(definePlugin({ name: 'a', apply() {} }));
    app.plugins.watch(() => void calls++);
    await app.stop();
    await tick();
    expect(calls).toBe(0);
  });

  it('停机打断在飞的重算：那一轮也不通知', async () => {
    const { app } = await world({ slowThresholdMs: 0 });
    const seen: string[] = [];
    let stopping = false;
    app.plugins.watch(() => void seen.push(stopping ? '停机之后' : '停机之前'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    void app.plugin(definePlugin({ name: 'slow', apply: () => gate }));
    await tick();
    stopping = true;
    const stopped = app.stop();
    release();
    await stopped;
    await tick();
    expect(seen).not.toContain('停机之后');
  });

  it('退订之后不调', async () => {
    const { app } = await world();
    let calls = 0;
    const off = app.plugins.watch(() => void calls++);
    off();
    await app.plugin(definePlugin({ name: 'a', apply() {} }));
    await tick();
    expect(calls).toBe(0);
    off();
  });

  it('回调抛错：宿主经 app.plugins 登记的记在根名下，插件登记的记在插件名下', async () => {
    const { app, warns } = await world();
    app.plugins.watch(() => {
      throw new Error('宿主的回调');
    });
    await app.plugin(
      definePlugin({
        name: 'observer',
        uses: { plugins: pluginsService },
        apply: ({ plugins }) =>
          void plugins.use.watch(() => {
            throw new Error('插件的回调');
          }),
      }),
    );
    await tick();
    expect(warns).toEqual([
      '[aalis] Resources "root": plugins 的 watch 回调抛错，已忽略: Error: 宿主的回调',
      '[aalis:observer] Resources "observer": plugins 的 watch 回调抛错，已忽略: Error: 插件的回调',
    ]);
  });

  it('激活已开始关闭之后登记：拒收并告警', async () => {
    const { app, warns } = await world();
    let calls = 0;
    let handle!: { watch(fn: () => void): () => void };
    await app.plugin(
      definePlugin({
        name: 'observer',
        uses: { plugins: pluginsService },
        apply: ({ plugins }) => {
          handle = plugins.use;
        },
      }),
    );
    await app.plugins.disable('observer');
    handle.watch(() => void calls++);
    await app.plugin(definePlugin({ name: 'x', apply() {} }));
    await tick();
    expect(calls).toBe(0);
    expect(warns).toEqual(['[aalis:observer] 激活 "observer" 已关闭，忽略 plugins 的 watch']);
  });
});

describe('订阅的摘除', () => {
  const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
  /** 记下挂上与摘下的变更来源 */
  function source() {
    const hooked = new Set<() => void>();
    const hook = (poke: () => void) => {
      hooked.add(poke);
      return () => hooked.delete(poke);
    };
    return { hooked, hook };
  }

  it('退订把订阅从来源上摘掉，重复退订无害', () => {
    const resources = new Resources('r', quiet);
    const { hooked, hook } = source();
    const off = resources.watch('x', hook, () => {});
    expect(hooked.size).toBe(1);
    off();
    expect(hooked.size).toBe(0);
    off();
    expect(hooked.size).toBe(0);
  });

  it('没退订的订阅在关闭的撤回段摘掉', async () => {
    const resources = new Resources('r', quiet);
    const { hooked, hook } = source();
    resources.watch('x', hook, () => {});
    await resources.disposeAsync();
    expect(hooked.size).toBe(0);
  });

  it('plugins.watch 交出的来源：摘掉之后重算收敛不再通知它', async () => {
    const manager = new PluginManager(new ActivationHost(new ServiceContainer(), quiet), quiet, 1000, 1000);
    let pokes = 0;
    let unhook = (): unknown => undefined;
    // 订阅方的替身：只接下来源，自己挂一个计数的通知
    const subscriber = {
      resources: {
        watch: (_what: string, hook: (poke: () => void) => () => unknown) => {
          unhook = hook(() => void pokes++);
          return () => undefined;
        },
      },
    };
    manager.watch(() => undefined, subscriber as never);
    await manager.register(definePlugin({ name: 'watch-unhook-a', apply() {} }));
    expect(pokes).toBe(1);
    unhook();
    await manager.register(definePlugin({ name: 'watch-unhook-b', apply() {} }));
    expect(pokes).toBe(1);
  });
});
