import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';

// 关停顺序覆盖管理动作：unload / disable / bounce 提供者时，正在用它的 required 依赖方先收尾再关，
// 提供者之后；判据是依赖方此刻解析到的胜者属于要走的激活，所以空档里不切到后备。
// 提供者清理之前，挂在它上面、尚未进关闭计划的跟随者就地交接，落定后提供者才关；交接不经事件投递。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
/** 收集 warn / error 的宿主：断言某条告警不出现 */
function capturing(disposeTimeoutMs?: number) {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    child: () => logger,
  };
  const app = new App({
    name: 't',
    logLevel: 'error',
    devMode: false,
    logger,
    disposeTimeoutMs,
  });
  apps.push(app);
  return { app, warnings };
}

function world(disposeTimeoutMs?: number) {
  const app = new App({ name: 't', logLevel: 'error', devMode: false, disposeTimeoutMs });
  apps.push(app);
  return app;
}

const M = defineService<{ gen: string }>('t:handover:mem');

function memPlugin(log: string[], name: string, priority = 0) {
  return definePlugin({
    name,
    provides: [M],
    uses: { provide, lifecycle },
    apply({ provide, lifecycle }) {
      provide.use(M, { gen: name }, { priority });
      lifecycle.use.onDrain(() => void log.push(`${name} drain`));
      lifecycle.use.onDispose(() => void log.push(`${name} dispose`));
    },
  });
}

describe('管理动作下依赖方先收尾、提供者后关', () => {
  async function scenario(action: 'bounce' | 'unload' | 'disable', target: string, twoProviders = false) {
    const app = world();
    const log: string[] = [];
    await app.plugin(memPlugin(log, 'mem', 10));
    if (twoProviders) await app.plugin(memPlugin(log, 'mem2'));
    let applies = 0;
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { m: M, lifecycle },
        apply({ m, lifecycle }) {
          applies++;
          seen.push(m.use.gen);
          lifecycle.use.onDrain(() => void log.push(`consumer drain sees ${m.present ? m.use.gen : 'NONE'}`));
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins[action](target);
    await app.plugins.idle();
    return { log, applies, seen, state: app.plugins.getPlugin('consumer')?.state };
  }

  for (const action of ['bounce', 'unload', 'disable'] as const) {
    it(`${action}(提供者)：依赖方先收尾且还能用到它`, async () => {
      const { log, applies, state } = await scenario(action, 'mem');
      expect(log.slice(0, 3)).toEqual(['consumer drain sees mem', 'mem drain', 'mem dispose']);
      if (action === 'bounce') {
        expect(state).toBe('active');
        expect(applies).toBe(2);
      } else {
        expect(state).toBe('pending');
      }
    });
  }

  it('bounce 首选提供者：有后备时依赖方也随首选走，空档里不切到后备，重启后回到首选', async () => {
    const { log, applies, seen, state } = await scenario('bounce', 'mem', true);
    expect(log.slice(0, 2)).toEqual(['consumer drain sees mem', 'mem drain']);
    expect(state).toBe('active');
    expect(applies).toBe(2);
    expect(seen).toEqual(['mem', 'mem']);
  });

  it('bounce 首选提供者：后备先注册、首选有晚解析的 required 依赖时，依赖方重启后仍挂回首选', async () => {
    const app = world();
    const log: string[] = [];
    const seen: string[] = [];
    const STORE = defineService<object>('t:handover:store');
    await app.plugin(memPlugin(log, 'mem2'));
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { m: M },
        apply({ m }) {
          seen.push(m.use.gen);
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'store',
        provides: [STORE],
        uses: { provide },
        apply({ provide }) {
          provide.use(STORE, {});
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'mem',
        provides: [M],
        uses: { provide, store: STORE },
        apply({ provide }) {
          provide.use(M, { gen: 'mem' }, { priority: 10 });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.bounce('mem');
    await app.plugins.idle();
    // 第一段是逐个注册即激活的启动行为；重启时依赖方排在该服务的全部提供者之后
    expect(seen).toEqual(['mem2', 'mem']);
  });

  it('其余提供者传递依赖依赖方时不加排序边：不制造伪环，全部激活', async () => {
    const { app, warnings } = capturing();
    const N = defineService<object>('t:handover:n');
    await app.plugin(memPlugin([], 'mem'));
    await app.plugin(
      definePlugin({
        name: 'consumer',
        provides: [N],
        uses: { m: M, provide },
        apply({ provide }) {
          provide.use(N, {});
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'mem2',
        provides: [M],
        uses: { provide, n: N },
        apply({ provide }) {
          provide.use(M, { gen: 'mem2' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`)).toEqual([
      'mem:active',
      'consumer:active',
      'mem2:active',
    ]);
    expect(warnings.filter(w => w.includes('依赖环'))).toEqual([]);
  });

  it('要走的不是依赖方正在用的提供者：依赖方不动', async () => {
    const { log, applies, state } = await scenario('unload', 'mem2', true);
    expect(log).toEqual(['mem2 drain', 'mem2 dispose']);
    expect(state).toBe('active');
    expect(applies).toBe(1);
  });

  it('多级 required 下游同批先收尾：每一级收尾时自己的依赖仍在；bounce 时整条链各重启一次', async () => {
    const names = ['storage', 'memory', 'session-manager', 'agent'] as const;
    const svc = Object.fromEntries(names.map(n => [n, defineService<{ name: string }>(`t:handover:${n}`)])) as Record<
      (typeof names)[number],
      ReturnType<typeof defineService<{ name: string }>>
    >;
    // 链头 storage 依赖根提供的服务：根不会离开，只为让四个定义同形
    const ROOT = defineService<{ name: string }>('t:handover:root');
    const applies: Record<string, number> = {};
    const drains: string[] = [];
    const mk = (name: (typeof names)[number], dep: typeof ROOT) =>
      definePlugin({
        name,
        provides: [svc[name]],
        uses: { provide, lifecycle, dep },
        apply({ provide, lifecycle, dep }) {
          applies[name]++;
          provide.use(svc[name], { name });
          lifecycle.use.onDrain(() => void drains.push(`${name} sees ${dep.present ? dep.use.name : 'NONE'}`));
        },
      });
    const run = async (action: 'unload' | 'bounce') => {
      const app = world();
      app.bind({ provide }).provide.use(ROOT, { name: 'root' });
      for (const n of names) applies[n] = 0;
      drains.length = 0;
      for (const d of [
        mk('agent', svc['session-manager']),
        mk('memory', svc.storage),
        mk('session-manager', svc.memory),
        mk('storage', ROOT),
      ])
        await app.plugin(d);
      await app.plugins.idle();
      for (const n of names) applies[n] = 0;
      await app.plugins[action]('storage');
      await app.plugins.idle();
      return app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`);
    };
    const expectedDrains = [
      'agent sees session-manager',
      'session-manager sees memory',
      'memory sees storage',
      'storage sees root',
    ];

    const states = await run('unload');
    expect(drains).toEqual(expectedDrains);
    expect(states.sort()).toEqual(['agent:pending', 'memory:pending', 'session-manager:pending']);

    await run('bounce');
    expect(drains).toEqual(expectedDrains);
    expect(applies).toEqual({ storage: 1, memory: 1, 'session-manager': 1, agent: 1 });
  });
});

describe('两份管理关闭计划重叠', () => {
  it('后一份计划等前一份里还没关完、依赖它服务的消费者关完，提供者才收尾（前一份关完它的总时长超过宽限也等）', async () => {
    // 每项都在宽限 50ms 之内，前一份计划关完 b 却要约 80ms
    const app = world(50);
    const S = defineService<object>('t:overlap:s');
    const T = defineService<object>('t:overlap:t');
    const seen: string[] = [];
    let entered!: () => void;
    const cDraining = new Promise<void>(resolve => {
      entered = resolve;
    });
    await app.plugin(
      definePlugin({ name: 'a', provides: [S], uses: { provide }, apply: ({ provide }) => void provide.use(S, {}) }),
    );
    await app.plugin(
      definePlugin({
        name: 'b',
        provides: [T],
        uses: { s: S, provide, lifecycle },
        apply({ s, provide, lifecycle }) {
          provide.use(T, {});
          lifecycle.use.onDrain(() => void seen.push(`b 收尾时 S ${s.present ? '在' : '不在'}`));
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'c',
        uses: { t: T, lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onDrain(async () => {
            entered();
            await new Promise(resolve => setTimeout(resolve, 40));
          });
          lifecycle.use.onDispose(() => new Promise<void>(resolve => setTimeout(resolve, 40)));
        },
      }),
    );
    await app.plugins.idle();
    const first = app.plugins.bounce('b');
    await cDraining;
    // b 已随前一份计划转 pending、还没收尾：后一份计划拆 a 时要等它关完
    await Promise.all([first, app.plugins.bounce('a')]);
    await app.plugins.idle();
    expect(seen[0]).toBe('b 收尾时 S 在');
  });

  it('偏好在收尾期间切到另一份计划正关着的提供者：再关剩下那家时，依赖方随这批先收尾，收尾时服务仍在', async () => {
    const app = world();
    const S = defineService<{ gen: string }>('t:overlap:prefer');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const aDraining = new Promise<void>(resolve => {
      entered = resolve;
    });
    const provider = (name: string, priority: number, onDrain?: () => Promise<void>) =>
      definePlugin({
        name,
        provides: [S],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide.use(S, { gen: name }, { priority });
          if (onDrain) lifecycle.use.onDrain(onDrain);
        },
      });
    await app.plugin(
      provider('a', 0, async () => {
        entered();
        await gate;
      }),
    );
    await app.plugin(provider('b', 10));
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'c',
        uses: { s: S, lifecycle },
        apply({ s, lifecycle }) {
          lifecycle.use.onDrain(() => void seen.push(s.present ? s.use.gen : 'NONE'));
        },
      }),
    );
    await app.plugins.idle();
    // c 选中 b，不随 a 这批走；a 收尾期间偏好切到 a，此刻再关 b，c 剩下的那家只有另一份计划正关着的 a
    const first = app.plugins.bounce('a');
    await aDraining;
    app.bind({ services }).services.use.prefer(S, 'a');
    await app.plugins.bounce('b');
    const drainedWithB = [...seen];
    release();
    await first;
    await app.plugins.idle();
    expect(drainedWithB).toEqual(['a']);
    expect(seen).toEqual(['a']);
    expect(app.plugins.getPlugin('c')?.state).toBe('active');
  });
});

describe('提供者清理之前，跟随者交接落定', () => {
  it('optional 跟随者的异步清理在提供者 onDispose 之前完成，清理期间提供者仍活着', async () => {
    const app = world();
    const S = defineService<{ alive: boolean }>('t:handover:s');
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        provides: [S],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          const instance = { alive: true };
          provide.use(S, instance);
          lifecycle.use.onDispose(() => {
            instance.alive = false;
            log.push('p dispose');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'follower',
        uses: { s: optional(S) },
        apply({ s }) {
          s.follow(instance => () => {
            log.push(`cleanup start alive=${instance.alive}`);
            return new Promise<void>(r => setTimeout(r, 10)).then(
              () => void log.push(`cleanup end alive=${instance.alive}`),
            );
          });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('p');
    expect(log).toEqual(['cleanup start alive=true', 'cleanup end alive=true', 'p dispose']);
    expect(app.plugins.getPlugin('follower')?.state).toBe('active');
  });
});

describe('交接不经事件投递：慢跟随者不拖住别人，通知不等监听器', () => {
  const S = defineService<{ name: string; alive: boolean }>('t:handover:shared');
  const never = () => new Promise<void>(() => {});

  function provider(log: string[], name: string, priority = 0) {
    return definePlugin({
      name,
      provides: [S],
      uses: { provide, lifecycle },
      apply({ provide, lifecycle }) {
        const instance = { name, alive: true };
        provide.use(S, instance, { priority });
        lifecycle.use.onDispose(() => {
          instance.alive = false;
          log.push(`${name} dispose`);
        });
      },
    });
  }

  function follower(log: string[], name: string, cleanup: () => void | Promise<void>) {
    return definePlugin({
      name,
      uses: { s: optional(S) },
      apply({ s }) {
        s.follow(instance => {
          log.push(`${name} attach ${instance.name}`);
          return () => {
            log.push(`${name} cleanup ${instance.name} alive=${instance.alive}`);
            return cleanup();
          };
        });
      },
    });
  }

  it.each([
    'unload',
    'disable',
  ] as const)('%s 提供者：前一个跟随者的清理挂住，后一个仍在提供者 onDispose 之前清理，后登记的变更监听照常收到', async action => {
    const app = world(50);
    const log: string[] = [];
    await app.plugin(provider(log, 'p'));
    await app.plugin(follower(log, 'slow', never));
    await app.plugin(follower(log, 'fast', () => {}));
    await app.plugin(
      definePlugin({
        name: 'listener',
        uses: { events },
        apply({ events }) {
          events.use.on('service:changed', name => {
            if (name === S.name) log.push('listener got changed');
          });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins[action]('p');
    await app.plugins.idle();
    const fast = log.indexOf('fast cleanup p alive=true');
    expect(fast).toBeGreaterThan(-1);
    expect(fast).toBeLessThan(log.indexOf('p dispose'));
    expect(log).toContain('listener got changed');
  });

  it('注册更高优先级的提供者：前一个跟随者的清理挂住，后一个仍换到新胜者', async () => {
    const app = world(50);
    const log: string[] = [];
    await app.plugin(provider(log, 'p1'));
    await app.plugin(follower(log, 'slow', never));
    await app.plugin(follower(log, 'fast', () => {}));
    await app.plugins.idle();
    await app.plugin(provider(log, 'p2', 10));
    await app.plugins.idle();
    expect(log).toContain('fast attach p2');
  });

  it('跟随者已在切走途中（旧清理在飞）时卸载旧提供者：提供者等这次清理落定才关', async () => {
    const app = world();
    const log: string[] = [];
    await app.plugin(provider(log, 'p1'));
    await app.plugin(
      follower(log, 'f', () => new Promise<void>(r => setTimeout(r, 20)).then(() => void log.push('f cleanup end'))),
    );
    await app.plugins.idle();
    await app.plugin(provider(log, 'p2', 10));
    await app.plugins.idle();
    expect(log).toContain('f cleanup p1 alive=true');
    await app.plugins.unload('p1');
    expect(log.indexOf('f cleanup end')).toBeGreaterThan(-1);
    expect(log.indexOf('f cleanup end')).toBeLessThan(log.indexOf('p1 dispose'));
  });

  it('变更监听里 await plugins.idle() 不与撤回互等', async () => {
    const app = world(0);
    const log: string[] = [];
    await app.plugin(provider(log, 'p'));
    await app.plugin(
      definePlugin({
        name: 'waiter',
        uses: { events },
        apply({ events }) {
          events.use.on('service:changed', async () => {
            await app.plugins.idle();
            log.push('waiter settled');
          });
        },
      }),
    );
    await app.plugins.idle();
    const outcome = await Promise.race([
      app.plugins.unload('p').then(() => 'done'),
      new Promise(resolve => setTimeout(() => resolve('stuck'), 300)),
    ]);
    expect(outcome).toBe('done');
    await app.plugins.idle();
    expect(log).toEqual(['p dispose', 'waiter settled']);
  });
});

describe('跟随者已放弃等待的撤回不再拖住提供者，包装型提供者不制造伪环', () => {
  const S = defineService<{ name: string }>('t:handover:hung');
  const never = () => new Promise<void>(() => {});
  const provider = (name: string) =>
    definePlugin({
      name,
      provides: [S],
      uses: { provide },
      apply({ provide }) {
        provide.use(S, { name });
      },
    });
  const handoverTimeouts = (warnings: string[]) =>
    warnings.filter(w => w.includes('Resources "p"') && w.includes('下游交接'));

  it('required 下游的跟随清理挂住：它自己关闭时已按超时放弃，提供者不再等第二轮', async () => {
    const { app, warnings } = capturing(30);
    await app.plugin(provider('p'));
    await app.plugin(
      definePlugin({
        name: 'd',
        uses: { s: S },
        apply({ s }) {
          s.follow(() => never);
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('p');
    expect(warnings.some(w => w.includes('Resources "d"'))).toBe(true);
    expect(handoverTimeouts(warnings)).toEqual([]);
  });

  it('跟随者 bounce 时清理挂住：遗留的边不拖累之后卸载提供者', async () => {
    const { app, warnings } = capturing(30);
    let hang = true;
    await app.plugin(provider('p'));
    await app.plugin(
      definePlugin({
        name: 'f',
        uses: { s: optional(S) },
        apply({ s }) {
          s.follow(() => () => (hang ? never() : undefined));
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.bounce('f');
    await app.plugins.idle();
    hang = false;
    await app.plugins.unload('p');
    expect(handoverTimeouts(warnings)).toEqual([]);
  });

  it('两个包装型提供者（provides 且 required 同一服务）先于底座注册：没有依赖环告警，全部激活', async () => {
    const { app, warnings } = capturing();
    const wrapper = (name: string) =>
      definePlugin({
        name,
        provides: [S],
        uses: { s: S, provide },
        apply({ s, provide }) {
          provide.use(S, { name: `${name}(${s.use.name})` }, { priority: 10 });
        },
      });
    await app.plugin(wrapper('w1'));
    await app.plugin(wrapper('w2'));
    await app.plugin(provider('base'));
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`)).toEqual([
      'w1:active',
      'w2:active',
      'base:active',
    ]);
    expect(warnings.filter(w => w.includes('依赖环'))).toEqual([]);
  });
});

describe('登记账本条目与原语同一拍撤掉，不等下游交接', () => {
  it('提供者等慢跟随者交接期间：它登记到枢纽服务的条目与监听一起已撤', async () => {
    interface Hub {
      add(name: string): () => void;
    }
    interface BoundHub {
      register(name: string): () => void;
    }
    const hub = defineService<Hub, BoundHub>('t:handover:hub', port => {
      const entries = port.registrar<string>({ key: n => n, register: (p, n) => p.add(n) });
      return { register: n => entries.add(n) };
    });
    const Q = defineService<object>('t:handover:q');
    const app = world();
    const names = new Set<string>();
    await app.plugin(
      definePlugin({
        name: 'hub',
        provides: [hub],
        uses: { provide },
        apply({ provide }) {
          provide.use(hub, {
            add: n => {
              names.add(n);
              return () => void names.delete(n);
            },
          });
        },
      }),
    );
    let heard = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        provides: [Q],
        uses: { h: hub, events, provide },
        apply({ h, events, provide }) {
          provide.use(Q, {});
          h.use.register('tool-p');
          events.use.on('service:changed', () => void heard++);
        },
      }),
    );
    let releaseFollower!: () => void;
    await app.plugin(
      definePlugin({
        name: 'f',
        uses: { q: optional(Q) },
        apply({ q }) {
          q.follow(() => () => new Promise<void>(r => (releaseFollower = r)));
        },
      }),
    );
    await app.plugins.idle();
    const unloading = app.plugins.unload('p');
    await new Promise(r => setTimeout(r, 5));
    heard = 0;
    app.bind({ provide }).provide.use(defineService<object>('t:handover:probe'), {});
    const during = { hubEntry: names.has('tool-p'), heard };
    releaseFollower();
    await unloading;
    expect(during).toEqual({ hubEntry: false, heard: 0 });
  });
});
