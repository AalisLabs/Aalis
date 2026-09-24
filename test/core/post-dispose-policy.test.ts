import { describe, expect, it, vi } from 'vitest';
import { defineService } from '../../packages/core/src/index.js';
import { bindActivationFixture, createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// post-dispose 注册政策：实际能力与窄激活记录的行为契约。
// - 订阅类（events/hooks/contributions/provide/ServiceRef.follow）：warn + no-op
// - 构造类（host.create）：抛错
// - onDispose 特例：warn 后仍就地执行（握着资源，no-op 即泄漏）
// 本文件是该政策的全量行为锚：7 个入口逐一钉死，含幽灵副作用断言与活路径回归。
// ════════════════════════════════════════════════════════════

const EVT = '__t:pd-evt' as never;
const HOOK = '__t:pd-hook' as never;
const POINT = '__t:pd-point' as never;

function makeWorld() {
  const lines: string[] = [];
  const tag = (lv: string) => (m: unknown, e?: unknown) =>
    lines.push(`${lv}|${String(m)} ${e instanceof Error ? e.message : ''}`);
  const logger = {
    warn: tag('warn'),
    debug: tag('debug'),
    info: tag('info'),
    error: tag('error'),
    child: () => logger,
  } as never;
  const world = createActivationFixture({ logger });
  const make = (id: string) => bindActivationFixture(world.host, world.host.create(world.activation, id));
  return { make, lines, events: world.events, services: world.services, hooks: world.hooks };
}

describe('订阅类 post-dispose：warn + no-op', () => {
  it('on：返回可安全调用的 noop；handler 不进总线（事件发出也不触发）；warn 点名事件', async () => {
    const { make, lines, events } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const onSpy = vi.spyOn(events, 'on');
    let called = 0;
    const off = dead.caps.events.on('plugin:loaded', () => {
      called++;
    });
    // 判别性断言：守卫必须让注册**根本不发生**（无守卫时是幽灵注册秒退，spy 会记到 1 次）
    expect(onSpy).not.toHaveBeenCalled();
    await observer.caps.events.emit('plugin:loaded', 'x');
    expect(called).toBe(0);
    expect(off).toBeTypeOf('function');
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 on("plugin:loaded")'))).toMatch(/^warn\|/);
    await observer.activation.disposeAsync();
  });

  it('middleware：runHook 不经过迟到注册的 handler；warn 点名钩子', async () => {
    const { make, lines, hooks } = makeWorld();
    const runner = make('runner');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const regSpy = vi.spyOn(hooks, 'register');
    let called = 0;
    const off = dead.caps.hooks.middleware(HOOK, async (_d, next) => {
      called++;
      await next();
    });
    expect(regSpy).not.toHaveBeenCalled();
    await runner.caps.hooks.run(HOOK, {} as never);
    expect(called).toBe(0);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 middleware("__t:pd-hook")'))).toMatch(/^warn\|/);
    await runner.activation.disposeAsync();
  });

  it('provide：不产生幽灵服务，也不向活总线发 service:registered/unregistered', async () => {
    const { make, lines } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const seen: string[] = [];
    observer.caps.events.on(
      'service:registered' as never,
      ((name: unknown) => {
        seen.push(String(name));
      }) as never,
    );
    observer.caps.events.on(
      'service:unregistered' as never,
      ((name: unknown) => {
        seen.push(`un:${String(name)}`);
      }) as never,
    );

    const off = dead.caps.provide(defineService('ghost-svc'), { v: 1 });
    // 事件总线是异步 emit——冲刷微任务后仍必须零事件
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual([]);
    expect(observer.caps.services.get('ghost-svc')).toBeUndefined();
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 provide("ghost-svc")'))).toMatch(/^warn\|/);
    await observer.activation.disposeAsync();
  });

  it('follow：服务已在场也不执行回调（此前会真跑一次再被清理）', async () => {
    const { make, lines } = makeWorld();
    const provider = make('provider');
    provider.caps.provide(defineService('ready-svc'), { v: 1 });
    const dead = make('dead');
    const { ref } = dead.host.bind(dead.activation, { ref: defineService('ready-svc') });
    await dead.activation.disposeAsync();

    let called = 0;
    const off = ref.follow(() => {
      called++;
    });
    expect(called).toBe(0);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略对 ready-svc 的跟随'))).toMatch(/^warn\|/);
    await provider.activation.disposeAsync();
  });

  it('contribute（既有守卫，纳入同一政策锚）：warn + no-op，collect 不见条目', async () => {
    const { make, lines } = makeWorld();
    const collector = make('collector');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const off = dead.caps.contributions.contribute(POINT, { id: 'late' } as never);
    expect(collector.caps.contributions.collect(POINT)).toEqual([]);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 contribute'))).toMatch(/^warn\|/);
    await collector.activation.disposeAsync();
  });

  it('订阅类 no-op 不污染账本：资源清理链与贡献登记全零增长', async () => {
    const ctx = createActivationFixture();
    const { ref } = ctx.host.bind(ctx.activation, { ref: defineService('y') });
    await ctx.activation.disposeAsync();
    ctx.caps.events.on(EVT, () => {});
    ctx.caps.hooks.middleware(HOOK, async (_d, n) => n());
    ctx.caps.provide(defineService('x'), {});
    ref.follow(() => {});
    ctx.caps.contributions.contribute(POINT, { id: 'z' } as never);
    expect(ctx.activation.resources.disposables.labels()).toEqual([]);
    expect(ctx.caps.contributions.collect(POINT)).toEqual([]);
    expect(ctx.activation.resources.disposables.size).toBe(0);
  });
});

describe('构造类 post-dispose：抛错', () => {
  it('create：抛错且不残留孤儿子激活（此前会塞进 _children 永不排空）', async () => {
    const ctx = createActivationFixture();
    await ctx.activation.disposeAsync();
    expect(() => bindActivationFixture(ctx.host, ctx.host.create(ctx.activation, 'orphan'))).toThrowError(
      /无法创建子激活 "orphan"/,
    );
    expect(ctx.activation.children.size).toBe(0);
  });
});

describe('onDispose 特例：warn 后仍就地执行（资源必须释放）', () => {
  it('迟到的清理函数立即执行且 warn 点名', async () => {
    const { make, lines } = makeWorld();
    const ctx = make('p');
    await ctx.activation.disposeAsync();
    let released = false;
    ctx.caps.lifecycle.onDispose(() => {
      released = true;
    }, 'late-client');
    expect(released).toBe(true);
    expect(lines.find(l => l.includes('onDispose("late-client") 将就地执行'))).toMatch(/^warn\|/);
  });
});

describe('活路径回归：守卫对未 dispose 的 ctx 零影响', () => {
  it('五个订阅入口 + onDispose 正常注册、正常触发、dispose 正常清理', async () => {
    const { make } = makeWorld();
    const ctx = make('alive');
    const peer = make('peer');
    const calls: string[] = [];

    ctx.caps.events.on('plugin:loaded', () => {
      calls.push('on');
    });
    ctx.caps.hooks.middleware(HOOK, async (_d, next) => {
      calls.push('mw');
      await next();
    });
    ctx.caps.provide(defineService('alive-svc'), { v: 1 });
    ctx.host.bind(ctx.activation, { ref: defineService('alive-svc') }).ref.follow(() => {
      calls.push('when');
    });
    ctx.caps.contributions.contribute(POINT, { id: 'a' } as never);
    ctx.caps.lifecycle.onDispose(() => {
      calls.push('cleanup');
    });

    await peer.caps.events.emit('plugin:loaded', 'x');
    await peer.caps.hooks.run(HOOK, {} as never);
    expect(calls).toContain('on');
    expect(calls).toContain('mw');
    expect(calls).toContain('when');
    expect(peer.caps.services.get('alive-svc')).toEqual({ v: 1 });
    expect(peer.caps.contributions.collect(POINT)).toHaveLength(1);

    await ctx.activation.disposeAsync();
    expect(calls).toContain('cleanup');
    expect(peer.caps.services.get('alive-svc')).toBeUndefined();
    expect(peer.caps.contributions.collect(POINT)).toEqual([]);
    await peer.activation.disposeAsync();
  });

  it('create 在活激活上照常可用', async () => {
    const ctx = createActivationFixture();
    const child = bindActivationFixture(ctx.host, ctx.host.create(ctx.activation, 'kid'));
    expect(child.activation.id).toBe('kid');
    await ctx.activation.disposeAsync();
  });
});

describe('拆卸进行中（activation 在飞窗口）：onDispose 两分支判据', () => {
  it('窗口内迟到的 onDispose 进链被等待，打 debug 而非「将就地执行」', async () => {
    const { make, lines } = makeWorld();
    const ctx = make('p');
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let released = false;
    const applying = (async () => {
      await gate;
      ctx.caps.lifecycle.onDispose(() => {
        released = true;
      }, 'late-conn');
    })();
    ctx.activation.resources.trackInitialization(applying);

    const teardown = ctx.activation.disposeAsync(1000);
    release();
    await teardown;

    // 设计内正确路径：被本次清理等到，且日志不得宣称相反事实
    expect(released).toBe(true);
    expect(lines.find(l => l.includes('将就地执行'))).toBeUndefined();
    expect(lines.find(l => l.includes('onDispose("late-conn") 纳入本次清理链'))).toMatch(/^debug\|/);
  });
});
