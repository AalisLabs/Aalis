import { describe, expect, it, vi } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// post-dispose 注册政策（两档，政策原文在 context.ts 的 _disposed 字段文档）：
// - 订阅类（on/middleware/contribute/provide/whenService）：warn + no-op
// - 构造类（fork/useModule）：抛错
// - onDispose 特例：warn 后仍就地执行（握着资源，no-op 即泄漏）
// 本文件是该政策的全量行为锚：8 个入口逐一钉死，含幽灵副作用断言与活路径回归。
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
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const contributions = new ContributionRegistry();
  const config = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
  const make = (id: string) => new Context({ id, events, services, hooks, contributions, logger, config });
  return { make, lines, events, services, hooks };
}

function makeContext(id = 'p'): Context {
  return new Context({
    id,
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('test'),
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
}

describe('订阅类 post-dispose：warn + no-op', () => {
  it('on：返回可安全调用的 noop；handler 不进总线（事件发出也不触发）；warn 点名事件', async () => {
    const { make, lines, events } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    dead.dispose();

    const onSpy = vi.spyOn(events, 'on');
    let called = 0;
    const off = dead.on('plugin:loaded', () => {
      called++;
    });
    // 判别性断言：守卫必须让注册**根本不发生**（无守卫时是幽灵注册秒退，spy 会记到 1 次）
    expect(onSpy).not.toHaveBeenCalled();
    await observer.emit('plugin:loaded', 'x');
    expect(called).toBe(0);
    expect(off).toBeTypeOf('function');
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 on("plugin:loaded")'))).toMatch(/^warn\|/);
    observer.dispose();
  });

  it('middleware：runHook 不经过迟到注册的 handler；warn 点名钩子', async () => {
    const { make, lines, hooks } = makeWorld();
    const runner = make('runner');
    const dead = make('dead');
    dead.dispose();

    const regSpy = vi.spyOn(hooks, 'register');
    let called = 0;
    const off = dead.middleware(HOOK, async (_d, next) => {
      called++;
      await next();
    });
    expect(regSpy).not.toHaveBeenCalled();
    await runner.runHook(HOOK, {} as never);
    expect(called).toBe(0);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 middleware("__t:pd-hook")'))).toMatch(/^warn\|/);
    runner.dispose();
  });

  it('provide：不产生幽灵服务，也不向活总线发 service:registered/unregistered', async () => {
    const { make, lines } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    dead.dispose();

    const seen: string[] = [];
    observer.on(
      'service:registered' as never,
      ((name: unknown) => {
        seen.push(String(name));
      }) as never,
    );
    observer.on(
      'service:unregistered' as never,
      ((name: unknown) => {
        seen.push(`un:${String(name)}`);
      }) as never,
    );

    const off = dead.provide('ghost-svc', { v: 1 });
    // 事件总线是异步 emit——冲刷微任务后仍必须零事件
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual([]);
    expect(observer.getService('ghost-svc')).toBeUndefined();
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 provide("ghost-svc")'))).toMatch(/^warn\|/);
    observer.dispose();
  });

  it('whenService：服务已在场也不执行回调（此前会真跑一次再被清理）', () => {
    const { make, lines } = makeWorld();
    const provider = make('provider');
    provider.provide('ready-svc', { v: 1 });
    const dead = make('dead');
    dead.dispose();

    let called = 0;
    const off = dead.whenService('ready-svc', () => {
      called++;
    });
    expect(called).toBe(0);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 whenService("ready-svc")'))).toMatch(/^warn\|/);
    provider.dispose();
  });

  it('contribute（既有守卫，纳入同一政策锚）：warn + no-op，collect 不见条目', () => {
    const { make, lines } = makeWorld();
    const collector = make('collector');
    const dead = make('dead');
    dead.dispose();

    const off = dead.contribute(POINT, { id: 'late' } as never);
    expect(collector.collect(POINT)).toEqual([]);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 contribute'))).toMatch(/^warn\|/);
    collector.dispose();
  });

  it('订阅类 no-op 不污染账本：listDisposables/listContributions/计数全零增长', () => {
    const ctx = makeContext();
    ctx.dispose();
    ctx.on(EVT, () => {});
    ctx.middleware(HOOK, async (_d, n) => n());
    ctx.provide('x', {});
    ctx.whenService('y', () => {});
    ctx.contribute(POINT, { id: 'z' } as never);
    expect(ctx.listDisposables()).toEqual([]);
    expect(ctx.listContributions()).toEqual([]);
    expect(ctx.disposableCount).toBe(0);
    expect(ctx.contributionDisposerCount).toBe(0);
  });
});

describe('构造类 post-dispose：抛错', () => {
  it('fork：抛错且不残留孤儿子 ctx（此前会塞进 _children 永不排空）', () => {
    const ctx = makeContext('parent');
    ctx.dispose();
    expect(() => ctx.fork('orphan')).toThrowError(/已 dispose，无法 fork\("orphan"\)/);
  });

  it('useModule：抛错（既有行为，纳入同一政策锚）', async () => {
    const ctx = makeContext('parent');
    ctx.dispose();
    await expect(ctx.useModule({ name: 'm', apply() {} }, {})).rejects.toThrow(/无法 useModule/);
  });
});

describe('onDispose 特例：warn 后仍就地执行（资源必须释放）', () => {
  it('迟到的清理函数立即执行且 warn 点名', () => {
    const { make, lines } = makeWorld();
    const ctx = make('p');
    ctx.dispose();
    let released = false;
    ctx.onDispose(() => {
      released = true;
    }, 'late-client');
    expect(released).toBe(true);
    expect(lines.find(l => l.includes('onDispose("late-client") 将就地执行（异步返回值不被等待）'))).toMatch(/^warn\|/);
  });
});

describe('活路径回归：守卫对未 dispose 的 ctx 零影响', () => {
  it('五个订阅入口 + onDispose 正常注册、正常触发、dispose 正常清理', async () => {
    const { make } = makeWorld();
    const ctx = make('alive');
    const peer = make('peer');
    const calls: string[] = [];

    ctx.on('plugin:loaded', () => {
      calls.push('on');
    });
    ctx.middleware(HOOK, async (_d, next) => {
      calls.push('mw');
      await next();
    });
    ctx.provide('alive-svc', { v: 1 });
    ctx.whenService('alive-svc', () => {
      calls.push('when');
    });
    ctx.contribute(POINT, { id: 'a' } as never);
    ctx.onDispose(() => {
      calls.push('cleanup');
    });

    await peer.emit('plugin:loaded', 'x');
    await peer.runHook(HOOK, {} as never);
    expect(calls).toContain('on');
    expect(calls).toContain('mw');
    expect(calls).toContain('when');
    expect(peer.getService('alive-svc')).toEqual({ v: 1 });
    expect(peer.collect(POINT)).toHaveLength(1);

    ctx.dispose();
    expect(calls).toContain('cleanup');
    expect(peer.getService('alive-svc')).toBeUndefined();
    expect(peer.collect(POINT)).toEqual([]);
    peer.dispose();
  });

  it('fork 在活 ctx 上照常可用', () => {
    const ctx = makeContext('parent');
    const child = ctx.fork('kid');
    expect(child.id).toBe('kid');
    ctx.dispose();
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
      ctx.onDispose(() => {
        released = true;
      }, 'late-conn');
    })();
    ctx.trackActivation(applying);

    const teardown = ctx.disposeAsync(1000);
    release();
    await teardown;

    // 设计内正确路径：被本次清理等到，且日志不得宣称相反事实
    expect(released).toBe(true);
    expect(lines.find(l => l.includes('将就地执行'))).toBeUndefined();
    expect(lines.find(l => l.includes('onDispose("late-conn") 纳入本次清理链'))).toMatch(/^debug\|/);
  });
});
