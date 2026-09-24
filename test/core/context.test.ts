import { bindActivationFixture, createActivationFixture } from '../helpers/activation.js';

declare module '@aalis/core' {
  interface HookContextMap {
    '__t:hook': { probe?: string };
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  hooks,
  type Logger,
  provide,
  services,
} from '../../packages/core/src/index.js';

// 本测试用一个合成钩子名验证 middleware 的分叉/隔离语义。名字不能凭空写——
// `HookContextMap` 是 core 的空接口扩展点，未登记的名字在类型上就不该被接受
// （那正是它的价值）。这里走**真实的 declaration merging** 把它登记进去，
// 顺带把「第三方能不能自己扩钩子」这条契约一并测到。

function makeFixture(id = 'root') {
  return createActivationFixture({ id });
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

  it('注册表对象不外露：插件只能使用 hooks.run / middleware', () => {
    const ctx = makeFixture();
    // 与 events / services 同一门面纪律：插件在运行时就拿不到 HookRegistry
    // （公开的是按激活绑定的 hooks 能力；激活记录上没有 hooks 字段可绕过归属）。
    expect('hooks' in ctx.activation).toBe(false);
    expect(ctx.caps.hooks).not.toBe(ctx.hooks);
    expect('register' in ctx.caps.hooks).toBe(false);
    expect(typeof ctx.caps.hooks.run).toBe('function');
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

describe('ServiceRef.follow', () => {
  it('服务未就绪时延迟订阅，注册后立即触发回调', async () => {
    const ctx = makeFixture();
    let received: unknown = null;
    ctx.host.bind(ctx.activation, { ref: defineService('__deferred') }).ref.follow(svc => {
      received = svc;
      return undefined;
    });
    expect(received).toBeNull();
    ctx.caps.provide(defineService('__deferred'), { mark: 1 });
    // 服务变更通知用 microtask，等一拍
    await Promise.resolve();
    expect(received).toEqual({ mark: 1 });
  });

  it('服务已就绪时立即触发', async () => {
    const ctx = makeFixture();
    ctx.caps.provide(defineService('__ready'), { v: 42 });
    let received: unknown = null;
    ctx.host.bind(ctx.activation, { ref: defineService('__ready') }).ref.follow(svc => {
      received = svc;
      return undefined;
    });
    await Promise.resolve();
    expect(received).toEqual({ v: 42 });
  });

  it('provider 下线时自动调用上次 cb 返回的 cleanup', async () => {
    const ctx = makeFixture();
    const cleaned: string[] = [];
    const disposeSvc = ctx.caps.provide(defineService('__hub'), { mark: 'a' });
    ctx.host.bind(ctx.activation, { ref: defineService<{ mark: string }>('__hub') }).ref.follow(svc => {
      return () => cleaned.push(`cleanup-${svc.mark}`);
    });
    await Promise.resolve();
    expect(cleaned).toEqual([]);
    disposeSvc();
    await Promise.resolve();
    expect(cleaned).toEqual(['cleanup-a']);
  });

  it('provider 重新 provide 触发重挂：旧 cleanup 先调，新 cb 再触发', async () => {
    const ctx = makeFixture();
    const attached: string[] = [];
    const cleaned: string[] = [];
    ctx.host.bind(ctx.activation, { ref: defineService<{ id: string }>('__hub') }).ref.follow(svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });

    const dispose1 = ctx.caps.provide(defineService('__hub'), { id: 'v1' });
    await Promise.resolve();
    expect(attached).toEqual(['v1']);
    expect(cleaned).toEqual([]);

    dispose1();
    await Promise.resolve();
    expect(cleaned).toEqual(['v1']);

    ctx.caps.provide(defineService('__hub'), { id: 'v2' });
    await Promise.resolve();
    expect(attached).toEqual(['v1', 'v2']);
    expect(cleaned).toEqual(['v1']);
  });

  it('手动 dispose 后 provider 上下线不再触发 cb', async () => {
    const ctx = makeFixture();
    let callCount = 0;
    const off = ctx.host.bind(ctx.activation, { ref: defineService<{ v: number }>('__hub') }).ref.follow(_svc => {
      callCount++;
      return undefined;
    });
    off();
    ctx.caps.provide(defineService('__hub'), { v: 1 });
    await Promise.resolve();
    expect(callCount).toBe(0);
  });

  it('ctx.activation.disposeAsync 触发上次 cleanup', async () => {
    const ctx = makeFixture();
    let cleaned = false;
    ctx.caps.provide(defineService('__hub'), { v: 1 });
    ctx.host.bind(ctx.activation, { ref: defineService<{ v: number }>('__hub') }).ref.follow(_svc => () => {
      cleaned = true;
    });
    await Promise.resolve();
    await ctx.activation.disposeAsync();
    expect(cleaned).toBe(true);
  });
});

describe('Activation ownership / dispose', () => {
  it('fork 共享服务容器但拥有独立 disposables', async () => {
    const ctx = makeFixture();
    ctx.caps.provide(defineService('__shared'), { v: 1 });
    const child = bindActivationFixture(ctx.host, ctx.host.create(ctx.activation, 'child'));
    expect(child.caps.services.get('__shared')).toEqual({ v: 1 });
    await child.activation.disposeAsync();
    // fork 后 dispose 不会清父级服务
    expect(ctx.caps.services.get('__shared')).toEqual({ v: 1 });
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

describe('ServiceRef.follow 多 provider（#8.3）', () => {
  it('败者 entry 注销不打扰胜者挂载；胜者注销后自动重挂到次优', async () => {
    const ctx = makeFixture();
    const attached: string[] = [];
    const cleaned: string[] = [];

    const winner = { id: 'winner' };
    const loser = { id: 'loser' };
    const disposeWinner = ctx.caps.provide(defineService('__hub'), winner, { priority: 50 });
    const disposeLoser = ctx.caps.provide(defineService('__hub'), loser, { priority: 0, entryId: 'root/loser' });

    ctx.host.bind(ctx.activation, { ref: defineService<{ id: string }>('__hub') }).ref.follow(svc => {
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
    ctx.caps.provide(defineService('__hub'), loser, { priority: 0, entryId: 'root/loser' });
    await new Promise(r => setTimeout(r, 0));
    expect(attached).toEqual(['winner']); // 新败者上线同样不打扰

    // 撤掉胜者 entry（provide 的 dispose 自带 service:unregistered 通知）
    disposeWinner();
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual(['winner']);
    expect(attached).toEqual(['winner', 'loser']);
  });

  it('preferService 切偏好触发重挂（service:preference-changed）', async () => {
    const ctx = makeFixture();
    const attached: string[] = [];
    const cleaned: string[] = [];

    ctx.caps.provide(defineService('__llm'), { id: 'default' }, { priority: 50 });
    const child = bindActivationFixture(ctx.host, ctx.host.create(ctx.activation, 'plugin-alt'));
    child.caps.provide(defineService('__llm'), { id: 'alt' }, { priority: 0 });

    ctx.host.bind(ctx.activation, { ref: defineService<{ id: string }>('__llm') }).ref.follow(svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });
    await Promise.resolve();
    expect(attached).toEqual(['default']);

    ctx.caps.services.prefer('__llm', 'plugin-alt');
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual(['default']);
    expect(attached).toEqual(['default', 'alt']);

    ctx.caps.services.unprefer('__llm');
    await new Promise(r => setTimeout(r, 0));
    expect(attached).toEqual(['default', 'alt', 'default']);
  });

  it('新败者注册（service:registered 但胜者不变）不触发重挂', async () => {
    const ctx = makeFixture();
    let calls = 0;
    ctx.caps.provide(defineService('__hub'), { id: 'top' }, { priority: 100 });
    ctx.host.bind(ctx.activation, { ref: defineService('__hub') }).ref.follow(() => {
      calls++;
      return undefined;
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    ctx.caps.provide(defineService('__hub'), { id: 'low' }, { priority: 0, entryId: 'root/low' });
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toBe(1);
  });
});

describe('disposable 闭包自移除（审计 HIGH #1/#2）', () => {
  function tick(): Promise<void> {
    return new Promise(r => setTimeout(r, 0));
  }

  it('provide: 登记不进 disposable 链，手动 dispose 由原语自己撤回（不滞留持有 entry）', () => {
    const ctx = makeFixture();
    const base = ctx.activation.resources.disposables.size;
    const impl = { v: 1 };
    const dispose = ctx.caps.provide(defineService('svc'), impl);
    expect(ctx.caps.services.get('svc')).toBe(impl);
    expect(ctx.activation.resources.disposables.size).toBe(base); // 登记只记在原语账上，链不增长
    dispose();
    expect(ctx.activation.resources.disposables.size).toBe(base);
    expect(ctx.caps.services.get('svc')).toBeUndefined(); // 原语自己的 off 已撤回条目
  });

  it('follow: 反复订阅退订复用观察器，旧回调不复活，关闭后观察器也撤回', async () => {
    const ctx = makeFixture();
    const svc = defineService<{ v: number }>('svc');
    const { ref } = ctx.host.bind(ctx.activation, { ref: svc });
    let calls = 0;
    const first = ref.follow(() => {
      calls++;
    });
    first();
    const watching = ctx.activation.resources.disposables.size;
    for (let i = 0; i < 200; i++) {
      ref.follow(() => {
        calls++;
      })();
    }
    expect(ctx.activation.resources.disposables.size).toBe(watching);
    ctx.caps.provide(svc, { v: 1 });
    await tick();
    expect(calls).toBe(0);
    await ctx.activation.disposeAsync();
    expect(ctx.activation.resources.disposables.size).toBe(0);
  });

  it('follow: attach 执行期间同步触发自身退订时，新 cleanup 立即执行（不泄漏）', async () => {
    const ctx = makeFixture();
    let cleanupRan = 0;
    let dispose: () => void = () => {};
    // provider 后到：让 sync 由 service:registered 事件触发，此时 dispose 已就绪
    dispose = ctx.host.bind(ctx.activation, { ref: defineService('svc') }).ref.follow(() => {
      dispose(); // cb 内同步触发自身 dispose（链式卸载场景）
      return () => {
        cleanupRan++;
      };
    });
    ctx.caps.provide(defineService('svc'), { v: 1 });
    await tick(); // 等 service:registered 异步派发到观察器
    expect(cleanupRan).toBe(1); // 新 cleanup 被立即执行，而非挂上后永不触发
  });
});

describe('Activation.disposeAsync 不变量', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  it('disposeAsync 真正等待异步 onDispose 完成', async () => {
    const ctx = makeFixture('plugin-a');
    let flushed = false;
    ctx.caps.lifecycle.onDispose(async () => {
      await sleep(15);
      flushed = true;
    });
    await ctx.activation.disposeAsync();
    expect(flushed).toBe(true);
  });

  it('disposeAsync() 与调用同栈发起首个清理回调（以同步副作用断言，不用微任务）', async () => {
    const ctx = makeFixture('plugin-a');
    const order: string[] = [];
    ctx.caps.lifecycle.onDispose(() => {
      order.push('cleanup');
    });
    const done = ctx.activation.disposeAsync();
    order.push('after-return');
    // 无收尾项、无初始化待等时不多让出一拍：同步清理在 disposeAsync() 返回前已执行
    expect(order).toEqual(['cleanup', 'after-return']);
    expect(ctx.activation.resources.disposed).toBe(true);
    await done;
  });

  it('disposeAsync() 内清理抛错不外泄（不同步抛出，也不拒绝）', async () => {
    const ctx = makeFixture('plugin-a');
    ctx.caps.lifecycle.onDispose(() => {
      throw new Error('sync boom');
    });
    await expect(ctx.activation.disposeAsync()).resolves.toBeUndefined();
  });

  it('provide 的退订闭包调两次只广播一次 service:unregistered；拆卸已清走的条目不再广播', async () => {
    const root = makeFixture();
    const seen: string[] = [];
    root.caps.events.on('service:unregistered', name => {
      seen.push(name);
    });
    const childA = bindActivationFixture(root.host, root.host.create(root.activation, 'plugin-a'));
    const off = childA.caps.provide(defineService('__t:svc'), { v: 1 });
    off();
    off();
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual(['__t:svc']);

    const child = bindActivationFixture(root.host, root.host.create(root.activation, 'plugin-b'));
    const offB = child.caps.provide(defineService('__t:svc2'), { v: 2 });
    await child.activation.disposeAsync(); // beforeCleanup 的 unregisterByOwner 已摘掉条目并广播过一次
    offB();
    await new Promise(r => setTimeout(r, 0));
    expect(seen.filter(n => n === '__t:svc2')).toHaveLength(1);
  });

  it('异步 flush 窗口内：服务已不可取、中间件已不响应、贡献已不可收集（注销先于清理链）', async () => {
    const root = makeFixture();
    const ctx = bindActivationFixture(root.host, root.host.create(root.activation, 'plugin-a'));
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const calls: string[] = [];
    ctx.caps.hooks.middleware('__t:hook', async (_d, next) => {
      calls.push('mw');
      await next();
    });
    ctx.caps.contributions.contribute('agent:prompt' as never, { id: 'blk' } as never);
    // provide 不进清理链：窗口内 svc 消失只能是 beforeCleanup 的 unregisterByOwner 干的，钉住 provide 带 owner
    ctx.caps.provide(defineService('svc'), { alive: true });
    ctx.caps.lifecycle.onDispose(() => gate); // 人为拉长 flush 窗口

    const done = ctx.activation.disposeAsync();
    await Promise.resolve(); // 进入等待窗口
    // 窗口内：钩子与贡献都已注销
    await root.caps.hooks.run('__t:hook', {});
    expect(calls).toEqual([]);
    expect(root.caps.contributions.collect('agent:prompt' as never)).toHaveLength(0);
    expect(root.caps.services.get('svc')).toBeUndefined();
    release();
    await done;
  });
});
