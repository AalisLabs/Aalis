declare module '@aalis/core' {
  interface HookContextMap {
    '__t:hook': { probe?: string };
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '../../packages/core/src/context/context.js';
import {
  App,
  ConfigManager,
  ContributionRegistry,
  DefaultLogger,
  definePlugin,
  defineService,
  EventBus,
  HookRegistry,
  hooks,
  type Logger,
  provide,
  ServiceContainer,
  services,
} from '../../packages/core/src/index.js';

// 本测试用一个合成钩子名验证 middleware 的分叉/隔离语义。名字不能凭空写——
// `HookContextMap` 是 core 的空接口扩展点，未登记的名字在类型上就不该被接受
// （那正是它的价值）。这里走**真实的 declaration merging** 把它登记进去，
// 顺带把「第三方能不能自己扩钩子」这条契约一并测到。

function makeContext(id = 'root'): Context {
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const contributions = new ContributionRegistry();
  const logger = new DefaultLogger('test');
  const config = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
  return new Context({ id, events, services, hooks, contributions, logger, config });
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function makeApp() {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return app;
}
async function expectActive(app: App, id: string) {
  await app.plugins.idle();
  expect(app.plugins.getPlugin(id)?.state).toBe('active');
}

describe('hooks.middleware / run：插件登记随卸载清扫', () => {
  it('middleware 注册的 handler 参与 run，插件卸载后自动清扫', async () => {
    const app = makeApp();
    const calls: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'plugin-a',
        uses: { hooks },
        apply({ hooks }) {
          hooks.middleware('__t:hook', async (_data, next) => {
            calls.push('a');
            await next();
          });
        },
      }),
    );
    await expectActive(app, 'plugin-a');

    const host = app.bind({ hooks });
    await host.hooks.run('__t:hook', {});
    expect(calls).toEqual(['a']);

    await app.plugins.unload('plugin-a');
    await host.hooks.run('__t:hook', {});
    expect(calls).toEqual(['a']);
  });

  it('卸载只清扫本插件的 middleware，不动兄弟插件的', async () => {
    const app = makeApp();
    const calls: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'plugin-a',
        uses: { hooks },
        apply({ hooks }) {
          hooks.middleware('__t:hook', async (_d, next) => {
            calls.push('a');
            await next();
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'plugin-b',
        uses: { hooks },
        apply({ hooks }) {
          hooks.middleware('__t:hook', async (_d, next) => {
            calls.push('b');
            await next();
          });
        },
      }),
    );
    await expectActive(app, 'plugin-a');
    await expectActive(app, 'plugin-b');

    await app.plugins.unload('plugin-a');
    await app.bind({ hooks }).hooks.run('__t:hook', {});
    expect(calls).toEqual(['b']);
  });

  it('middleware 返回的 dispose 函数可手动解除', async () => {
    const app = makeApp();
    const calls: number[] = [];
    let off!: () => void;
    await app.plugin(
      definePlugin({
        name: 'plugin-a',
        uses: { hooks },
        apply({ hooks }) {
          off = hooks.middleware('__t:hook', async (_d, next) => {
            calls.push(1);
            await next();
          });
        },
      }),
    );
    await expectActive(app, 'plugin-a');
    const host = app.bind({ hooks });
    await host.hooks.run('__t:hook', {});
    off();
    await host.hooks.run('__t:hook', {});
    expect(calls).toEqual([1]);
  });

  it('注册表对象不外露：执行面是 ctx.runHook 方法，注册唯一入口是 ctx.middleware', () => {
    const ctx = makeContext();
    // 与 events / services 同一门面纪律：插件在运行时就拿不到 HookRegistry
    // （公开的是按激活绑定的 hooks 能力；激活记录上没有 hooks 字段可绕过归属）。
    expect('hooks' in ctx).toBe(false);
    expect(typeof ctx.runHook).toBe('function');
  });
});

describe('provide / services.get', () => {
  const greeter = defineService<{ greet: () => string }>('__greeter');
  const svc = defineService<{ run: () => number }>('__svc');

  it('注册并取出服务', async () => {
    const app = makeApp();
    const impl = { greet: () => 'hello' };
    await app.plugin(
      definePlugin({
        name: 'greeter',
        uses: { provide },
        apply: ({ provide }) => void provide(greeter, impl),
      }),
    );
    await expectActive(app, 'greeter');
    expect(app.bind({ services }).services.get(greeter)?.greet()).toBe('hello');
  });

  it('get 判定服务存在与否', async () => {
    const app = makeApp();
    await app.plugin(
      definePlugin({
        name: 'has-svc',
        uses: { provide },
        apply: ({ provide }) => void provide(svc, { run: () => 1 }),
      }),
    );
    await expectActive(app, 'has-svc');
    const host = app.bind({ services });
    expect(host.services.get(svc) !== undefined).toBe(true);
    expect(host.services.get('__nonexistent') !== undefined).toBe(false);
  });
});

describe('Context.whenService', () => {
  it('服务未就绪时延迟订阅，注册后立即触发回调', async () => {
    const ctx = makeContext();
    let received: unknown = null;
    ctx.whenService('__deferred', svc => {
      received = svc;
      return undefined;
    });
    expect(received).toBeNull();
    ctx.provide('__deferred', { mark: 1 });
    // whenService 内部用 microtask，等一拍
    await Promise.resolve();
    expect(received).toEqual({ mark: 1 });
  });

  it('服务已就绪时立即触发', async () => {
    const ctx = makeContext();
    ctx.provide('__ready', { v: 42 });
    let received: unknown = null;
    ctx.whenService('__ready', svc => {
      received = svc;
      return undefined;
    });
    await Promise.resolve();
    expect(received).toEqual({ v: 42 });
  });

  it('provider 下线时自动调用上次 cb 返回的 cleanup', async () => {
    const ctx = makeContext();
    const cleaned: string[] = [];
    const disposeSvc = ctx.provide('__hub', { mark: 'a' });
    ctx.whenService<{ mark: string }>('__hub', svc => {
      return () => cleaned.push(`cleanup-${svc.mark}`);
    });
    await Promise.resolve();
    expect(cleaned).toEqual([]);
    disposeSvc();
    await Promise.resolve();
    expect(cleaned).toEqual(['cleanup-a']);
  });

  it('provider 重新 provide 触发重挂：旧 cleanup 先调，新 cb 再触发', async () => {
    const ctx = makeContext();
    const attached: string[] = [];
    const cleaned: string[] = [];
    ctx.whenService<{ id: string }>('__hub', svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });

    const dispose1 = ctx.provide('__hub', { id: 'v1' });
    await Promise.resolve();
    expect(attached).toEqual(['v1']);
    expect(cleaned).toEqual([]);

    dispose1();
    await Promise.resolve();
    expect(cleaned).toEqual(['v1']);

    ctx.provide('__hub', { id: 'v2' });
    await Promise.resolve();
    expect(attached).toEqual(['v1', 'v2']);
    expect(cleaned).toEqual(['v1']);
  });

  it('手动 dispose 后 provider 上下线不再触发 cb', async () => {
    const ctx = makeContext();
    let callCount = 0;
    const off = ctx.whenService<{ v: number }>('__hub', _svc => {
      callCount++;
      return undefined;
    });
    off();
    ctx.provide('__hub', { v: 1 });
    await Promise.resolve();
    expect(callCount).toBe(0);
  });

  it('ctx.dispose 触发上次 cleanup', async () => {
    const ctx = makeContext();
    let cleaned = false;
    ctx.provide('__hub', { v: 1 });
    ctx.whenService<{ v: number }>('__hub', _svc => () => {
      cleaned = true;
    });
    await Promise.resolve();
    await ctx.dispose();
    expect(cleaned).toBe(true);
  });
});

describe('Context fork / dispose', () => {
  it('fork 共享服务容器但拥有独立 disposables', async () => {
    const ctx = makeContext();
    ctx.provide('__shared', { v: 1 });
    const child = ctx.fork('child');
    expect(child.getService('__shared')).toEqual({ v: 1 });
    await child.dispose();
    // fork 后 dispose 不会清父级服务
    expect(ctx.getService('__shared')).toEqual({ v: 1 });
  });
});

describe('services.get 即取即用语义（裸实例）', () => {
  interface FooService {
    hello(): string;
    label: string;
  }
  const foo = defineService<FooService>('__foo');
  const foo2 = defineService<FooService>('__foo2');
  const cnt = defineService<{ inc(): number }>('__cnt');

  it('返回当时点的裸实例：拿到后切偏好不会跟随', async () => {
    const app = makeApp();
    const a: FooService = { hello: () => 'A', label: 'a' };
    const b: FooService = { hello: () => 'B', label: 'b' };
    await app.plugin(
      definePlugin({
        name: 'plugin-a',
        uses: { provide },
        apply: ({ provide }) => void provide(foo, a),
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'plugin-b',
        uses: { provide },
        apply: ({ provide }) => void provide(foo, b),
      }),
    );
    await expectActive(app, 'plugin-a');
    await expectActive(app, 'plugin-b');

    const host = app.bind({ services });
    const handle1 = host.services.get(foo)!;
    expect(handle1.hello()).toBe('A');

    host.services.prefer(foo, 'plugin-b');
    expect(handle1.hello()).toBe('A');
    const handle2 = host.services.get(foo)!;
    expect(handle2.hello()).toBe('B');
    expect(handle2.label).toBe('b');
  });

  it('无 provider 时返回 undefined（保留 null-check 语义）', () => {
    const app = makeApp();
    expect(app.bind({ services }).services.get('__nonexistent')).toBeUndefined();
  });

  it('provider 全部注销后再次 get 返回 undefined（旧句柄仍可用，不抛错）', async () => {
    const app = makeApp();
    const a: FooService = { hello: () => 'A', label: 'a' };
    let disp!: () => void;
    await app.plugin(
      definePlugin({
        name: 'foo2',
        uses: { provide },
        apply({ provide }) {
          disp = provide(foo2, a);
        },
      }),
    );
    await expectActive(app, 'foo2');
    const host = app.bind({ services });
    const handle = host.services.get(foo2)!;
    expect(handle.hello()).toBe('A');
    disp();
    expect(handle.hello()).toBe('A');
    expect(host.services.get(foo2)).toBeUndefined();
  });

  it('this 绑定正确：方法调用时 this 指向取出时点的 provider 实例', async () => {
    const app = makeApp();
    class Counter {
      private n = 0;
      inc(): number {
        this.n += 1;
        return this.n;
      }
    }
    const c1 = new Counter();
    const c2 = new Counter();
    await app.plugin(
      definePlugin({
        name: 'one',
        uses: { provide },
        apply: ({ provide }) => void provide(cnt, c1),
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'two',
        uses: { provide },
        apply: ({ provide }) => void provide(cnt, c2),
      }),
    );
    await expectActive(app, 'one');
    await expectActive(app, 'two');

    const host = app.bind({ services });
    const h = host.services.get(cnt)!;
    expect(h.inc()).toBe(1);
    expect(h.inc()).toBe(2);

    host.services.prefer(cnt, 'two');
    expect(h.inc()).toBe(3);
    const h2 = host.services.get(cnt)!;
    expect(h2.inc()).toBe(1);
  });
});

describe('Context.whenService 多 provider（#8.3）', () => {
  it('败者 entry 注销不打扰胜者挂载；胜者注销后自动重挂到次优', async () => {
    const ctx = makeContext();
    const attached: string[] = [];
    const cleaned: string[] = [];

    const winner = { id: 'winner' };
    const loser = { id: 'loser' };
    const disposeWinner = ctx.provide('__hub', winner, { priority: 50 });
    const disposeLoser = ctx.provide('__hub', loser, { priority: 0, entryId: 'root/loser' });

    ctx.whenService<{ id: string }>('__hub', svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });
    await Promise.resolve();
    expect(attached).toEqual(['winner']);

    // 败者下线：胜者不变 → 不 cleanup、不重挂（旧实现会无条件 cleanup 导致永久脱挂）
    disposeLoser();
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual([]);
    expect(attached).toEqual(['winner']);

    // 重新补一个次优，再撤胜者：应 cleanup 旧挂载并重挂到次优
    ctx.provide('__hub', loser, { priority: 0, entryId: 'root/loser' });
    await new Promise(r => setTimeout(r, 0));
    expect(attached).toEqual(['winner']); // 新败者上线同样不打扰

    // 撤掉胜者 entry（provide 的 dispose 自带 service:unregistered 通知）
    disposeWinner();
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual(['winner']);
    expect(attached).toEqual(['winner', 'loser']);
  });

  it('preferService 切偏好触发重挂（service:preference-changed）', async () => {
    const ctx = makeContext();
    const attached: string[] = [];
    const cleaned: string[] = [];

    ctx.provide('__llm', { id: 'default' }, { priority: 50 });
    const child = ctx.fork('plugin-alt');
    child.provide('__llm', { id: 'alt' }, { priority: 0 });

    ctx.whenService<{ id: string }>('__llm', svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });
    await Promise.resolve();
    expect(attached).toEqual(['default']);

    ctx.preferService('__llm', 'plugin-alt');
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual(['default']);
    expect(attached).toEqual(['default', 'alt']);

    ctx.unpreferService('__llm');
    await new Promise(r => setTimeout(r, 0));
    expect(attached).toEqual(['default', 'alt', 'default']);
  });

  it('新败者注册（service:registered 但胜者不变）不触发重挂', async () => {
    const ctx = makeContext();
    let calls = 0;
    ctx.provide('__hub', { id: 'top' }, { priority: 100 });
    ctx.whenService('__hub', () => {
      calls++;
      return undefined;
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    ctx.provide('__hub', { id: 'low' }, { priority: 0, entryId: 'root/low' });
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toBe(1);
  });
});

describe('disposable 闭包自移除（审计 HIGH #1/#2）', () => {
  function tick(): Promise<void> {
    return new Promise(r => setTimeout(r, 0));
  }

  it('provide: 手动 dispose 后闭包从 disposable 链移除（不滞留持有 entry）', () => {
    const ctx = makeContext();
    const base = ctx.disposableCount;
    const dispose = ctx.provide('svc', { v: 1 });
    expect(ctx.disposableCount).toBe(base + 1);
    dispose();
    expect(ctx.disposableCount).toBe(base); // 自移除：闭包不再滞留
    expect(ctx.getService('svc')).toBeUndefined();
  });

  it('whenService: 手动 dispose 后闭包自移除（含内部 3 个事件监听）', () => {
    const ctx = makeContext();
    const base = ctx.disposableCount;
    const dispose = ctx.whenService('svc', () => {});
    expect(ctx.disposableCount).toBeGreaterThan(base); // whenService + 内部 on 监听
    dispose();
    expect(ctx.disposableCount).toBe(base); // 全部清理回基线（whenService dispose 自移除 + 退订内部监听）
  });

  it('whenService: cb 执行期间同步触发自身 dispose 时，新 cleanup 立即执行（不泄漏）', async () => {
    const ctx = makeContext();
    let cleanupRan = 0;
    let dispose: () => void = () => {};
    // provider 后到：让 sync 由 service:registered 事件触发，此时 dispose 已就绪
    dispose = ctx.whenService('svc', () => {
      dispose(); // cb 内同步触发自身 dispose（链式卸载场景）
      return () => {
        cleanupRan++;
      };
    });
    ctx.provide('svc', { v: 1 });
    await tick(); // 等 service:registered 异步派发到 whenService 的 sync
    expect(cleanupRan).toBe(1); // 新 cleanup 被立即执行，而非挂上后永不触发
  });
});

describe('Context.disposeAsync / dispose 同步不变量', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  it('disposeAsync 真正等待异步 onDispose 完成', async () => {
    const ctx = makeContext().fork('plugin-a');
    let flushed = false;
    ctx.onDispose(async () => {
      await sleep(15);
      flushed = true;
    });
    await ctx.disposeAsync();
    expect(flushed).toBe(true);
  });

  it('dispose() 在同一同步栈内完成（以同步副作用断言，不用微任务）', () => {
    const ctx = makeContext().fork('plugin-a');
    const order: string[] = [];
    ctx.onDispose(() => {
      order.push('cleanup');
    });
    ctx.dispose();
    order.push('after-return');
    // 同步清理在 dispose() 返回前已执行完毕——wait=false 分支零 await 命中
    expect(order).toEqual(['cleanup', 'after-return']);
    expect(ctx.disposed).toBe(true);
  });

  it('dispose() 内清理抛错不外泄（同步路径不产生未处理拒绝）', () => {
    const ctx = makeContext().fork('plugin-a');
    ctx.onDispose(() => {
      throw new Error('sync boom');
    });
    expect(() => ctx.dispose()).not.toThrow();
  });

  it('provide 的退订闭包调两次只广播一次 service:unregistered；拆卸已清走的条目不再广播', async () => {
    const root = makeContext();
    const seen: string[] = [];
    root.on('service:unregistered', name => {
      seen.push(name);
    });
    const off = root.fork('plugin-a').provide('__t:svc', { v: 1 });
    off();
    off();
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual(['__t:svc']);

    const child = root.fork('plugin-b');
    const offB = child.provide('__t:svc2', { v: 2 });
    await child.disposeAsync(); // beforeCleanup 的 unregisterByOwner 已摘掉条目并广播过一次
    offB();
    await new Promise(r => setTimeout(r, 0));
    expect(seen.filter(n => n === '__t:svc2')).toHaveLength(1);
  });

  it('异步 flush 窗口内：服务已不可取、中间件已不响应、贡献已不可收集（注销先于清理链）', async () => {
    const root = makeContext();
    const ctx = root.fork('plugin-a');
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const calls: string[] = [];
    ctx.middleware('__t:hook', async (_d, next) => {
      calls.push('mw');
      await next();
    });
    ctx.contribute('agent:prompt' as never, { id: 'blk' } as never);
    // 须在 gate 之前登记：链逆序串行，gate 先挡住，provide 的 dispose 闭包在窗口内不会跑——
    // 窗口内 svc 消失只能是 beforeCleanup 的 unregisterByOwner 干的，钉住 provide 带 owner
    ctx.provide('svc', { alive: true });
    ctx.onDispose(() => gate); // 人为拉长 flush 窗口

    const done = ctx.disposeAsync();
    await Promise.resolve(); // 进入等待窗口
    // 窗口内：钩子与贡献都已注销
    await root.runHook('__t:hook', {});
    expect(calls).toEqual([]);
    expect(root.collect('agent:prompt' as never)).toHaveLength(0);
    expect(root.getService('svc')).toBeUndefined();
    release();
    await done;
  });
});
