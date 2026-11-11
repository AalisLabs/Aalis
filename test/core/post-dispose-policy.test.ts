import { describe, expect, it, vi } from 'vitest';
import { defineService } from '../../packages/core/src/index.js';
import { bindActivationFixture, createActivationFixture } from '../helpers/activation.js';
import { HubRegistry, hub } from '../helpers/hub.js';

// ════════════════════════════════════════════════════════════
// post-dispose 注册政策：实际能力与窄激活记录的行为契约。
// - 订阅类（events/provide/选择层 follow/资源口 registrar 归属表）：warn + no-op
// - 构造类（host.create）：抛错
// - 清理类（onDispose、onDrain、track）：warn 后仍就地执行（握着资源，no-op 即泄漏）
// 本文件是该政策的全量行为锚：8 个入口逐一钉死，含幽灵副作用断言与活路径回归。
// 归属表以测试枢纽 hub 为样本（hooks / contributions / tools 等契约包枢纽同一做法）。
// ════════════════════════════════════════════════════════════

const EVT = '__t:pd-evt' as never;

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
  // 枢纽提供者挂在根上：子激活关闭后登记表仍在场可读，迟到登记若落进去看得见
  const registry = new HubRegistry();
  world.caps.provide.use(hub, registry);
  const make = (id: string) => {
    const activation = world.host.create(id);
    return { ...bindActivationFixture(world.host, activation), hub: world.host.bind(activation, { hub }).hub };
  };
  return { make, lines, events: world.events, services: world.services, registry };
}

describe('订阅类 post-dispose：warn + no-op', () => {
  it('on：返回可安全调用的 noop；handler 不进总线（事件发出也不触发）；warn 点名事件', async () => {
    const { make, lines, events } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const onSpy = vi.spyOn(events, 'on');
    let called = 0;
    const off = dead.caps.events.use.on('plugin:loaded', () => {
      called++;
    });
    // 判别性断言：守卫必须让注册**根本不发生**（无守卫时是幽灵注册秒退，spy 会记到 1 次）
    expect(onSpy).not.toHaveBeenCalled();
    await observer.caps.events.use.emit('plugin:loaded', 'x');
    expect(called).toBe(0);
    expect(off).toBeTypeOf('function');
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 on("plugin:loaded")'))).toMatch(/^warn\|/);
    await observer.activation.disposeAsync();
  });

  it('归属表登记（registrar）：迟到的 add 不进登记表；warn 点名服务与键', async () => {
    const { make, lines, registry } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const regSpy = vi.spyOn(registry, 'register');
    const off = dead.hub.use.add('late', 'v');
    // 迟到登记不得到达登记表；warn 是关闭守卫生效的直接证据
    expect(regSpy).not.toHaveBeenCalled();
    expect(observer.hub.use.list()).toEqual([]);
    expect(off).toBeTypeOf('function');
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('"dead" 已关闭，忽略 __t:hub 登记 "late"'))).toMatch(/^warn\|/);
    await observer.activation.disposeAsync();
  });

  it('provide：不产生幽灵服务，也不向活总线发 service:changed', async () => {
    const { make, lines } = makeWorld();
    const observer = make('observer');
    const dead = make('dead');
    await dead.activation.disposeAsync();

    const seen: string[] = [];
    observer.caps.events.use.on('service:changed', name => void seen.push(name));

    const off = dead.caps.provide.use(defineService('ghost-svc'), { v: 1 });
    // 事件总线是异步 emit——冲刷微任务后仍必须零事件
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual([]);
    expect(observer.caps.services.use.get('ghost-svc')).toBeUndefined();
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 provide("ghost-svc")'))).toMatch(/^warn\|/);
    await observer.activation.disposeAsync();
  });

  it('follow：服务已在场也不执行回调（此前会真跑一次再被清理）', async () => {
    const { make, lines } = makeWorld();
    const provider = make('provider');
    provider.caps.provide.use(defineService('ready-svc'), { v: 1 });
    const dead = make('dead');
    const { ref } = dead.host.bind(dead.activation, { ref: defineService('ready-svc') });
    await dead.activation.disposeAsync();

    let called = 0;
    const off = ref.follow(() => {
      called++;
    });
    expect(called).toBe(0);
    expect(() => off()).not.toThrow();
    expect(lines.find(l => l.includes('忽略 ready-svc 的跟随'))).toMatch(/^warn\|/);
    await provider.activation.disposeAsync();
  });

  it('订阅类 no-op 不污染记录：资源清理链与枢纽登记表全零增长', async () => {
    const { make, registry } = makeWorld();
    const ctx = make('p');
    const { ref } = ctx.host.bind(ctx.activation, { ref: defineService('y') });
    await ctx.activation.disposeAsync();
    ctx.caps.events.use.on(EVT, () => {});
    ctx.hub.use.add('z', 'v');
    ctx.caps.provide.use(defineService('x'), {});
    ref.follow(() => {});
    expect(ctx.activation.resources.disposables.labels()).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(ctx.activation.resources.disposables.labels()).toHaveLength(0);
  });
});

describe('构造类 post-dispose：抛错', () => {
  it('create：抛错且不残留孤儿子激活（此前会放入 _children 永不排空）', async () => {
    const ctx = createActivationFixture();
    await ctx.activation.disposeAsync();
    expect(() => bindActivationFixture(ctx.host, ctx.host.create('orphan'))).toThrowError(
      /^激活 "[^"]+" 已关闭，无法创建插件激活 "orphan"/,
    );
    expect(ctx.activation.children.size).toBe(0);
  });
});

describe('活路径回归：守卫对未 dispose 的 ctx 零影响', () => {
  it('四个订阅入口 + onDispose 正常注册、正常触发、dispose 正常清理', async () => {
    const { make } = makeWorld();
    const ctx = make('alive');
    const peer = make('peer');
    const calls: string[] = [];

    ctx.caps.events.use.on('plugin:loaded', () => {
      calls.push('on');
    });
    ctx.hub.use.add('a', 'v');
    ctx.caps.provide.use(defineService('alive-svc'), { v: 1 });
    ctx.host.bind(ctx.activation, { ref: defineService('alive-svc') }).ref.follow(() => {
      calls.push('when');
    });
    ctx.caps.lifecycle.use.onDispose(() => {
      calls.push('cleanup');
    });

    await peer.caps.events.use.emit('plugin:loaded', 'x');
    expect(calls).toContain('on');
    expect(calls).toContain('when');
    expect(peer.caps.services.use.get('alive-svc')).toEqual({ v: 1 });
    expect(peer.hub.use.list()).toEqual(['alive/a=v']);

    await ctx.activation.disposeAsync();
    expect(calls).toContain('cleanup');
    expect(peer.caps.services.use.get('alive-svc')).toBeUndefined();
    expect(peer.hub.use.list()).toEqual([]);
    await peer.activation.disposeAsync();
  });

  it('create 在活激活上照常可用', async () => {
    const ctx = createActivationFixture();
    const child = bindActivationFixture(ctx.host, ctx.host.create('kid'));
    expect(child.activation.id).toBe('kid');
    await ctx.activation.disposeAsync();
  });
});

describe('拆卸进行中（activation 在飞窗口）：迟到的 onDispose', () => {
  it('窗口内迟到的 onDispose 进链被等待，不报「就地执行」', async () => {
    const { make, lines } = makeWorld();
    const ctx = make('p');
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let released = false;
    const applying = (async () => {
      await gate;
      ctx.caps.lifecycle.use.onDispose(() => {
        released = true;
      }, 'late-conn');
    })();
    ctx.activation.resources.trackInitialization(applying);

    const teardown = ctx.activation.disposeAsync(1000);
    release();
    await teardown;

    // 设计内正确路径：被本次清理等到，且日志不得宣称相反事实
    expect(released).toBe(true);
    expect(lines.find(l => l.includes('就地执行'))).toBeUndefined();
  });
});

describe('清理类迟到登记一律告警并就地执行', () => {
  it('onDispose、onDrain 与 track：链已取走后登记的就地执行，并各记一条告警点名', async () => {
    const { make, lines } = makeWorld();
    const holder = defineService<{ v: number }, { hold(off: () => void, label: string): () => void }>(
      '__t:pd-holder',
      port => ({ hold: (off, label) => port.track(off, label) }),
    );
    const owner = make('owner');
    owner.caps.provide.use(holder, { v: 1 });
    const ctx = make('p');
    const bound = ctx.host.bind(ctx.activation, { holder }).holder;
    await ctx.activation.disposeAsync();
    const ran: string[] = [];
    ctx.caps.lifecycle.use.onDispose(() => void ran.push('dispose'), 'late-dispose');
    ctx.caps.lifecycle.use.onDrain(() => void ran.push('drain'), 'late-drain');
    bound.use.hold(() => void ran.push('track'), 'late-track');
    ctx.caps.lifecycle.use.onDispose(() => {
      throw new Error('late boom');
    }, 'late-boom');
    expect(ran).toEqual(['dispose', 'drain', 'track']);
    for (const label of ['late-dispose', 'late-drain', 'late-track']) {
      expect(
        lines.filter(l => l.includes(label)),
        label,
      ).toEqual([expect.stringMatching(new RegExp(`^warn\\|.*\\[${label}\\].*就地执行`))]);
    }
    expect(lines.find(l => l.includes('迟到登记的清理 [late-boom] 执行失败'))).toMatch(/^warn\|/);
    await owner.activation.disposeAsync();
  });

  it('关闭后拒收的告警同一措辞：激活 "<id>" 已关闭，忽略 …', async () => {
    const { make, lines } = makeWorld();
    const dead = make('dead');
    const { ref } = dead.host.bind(dead.activation, { ref: defineService('__t:pd-late-follow') });
    await dead.activation.disposeAsync();
    dead.caps.events.use.on('plugin:loaded', () => {});
    dead.caps.provide.use(defineService('__t:pd-late-svc'), { v: 1 });
    dead.hub.use.add('late', 'v');
    ref.follow(() => {});
    const refusals = lines.filter(l => l.includes('忽略'));
    expect(refusals).toHaveLength(4);
    for (const line of refusals) expect(line).toMatch(/^warn\|激活 "dead" 已关闭，忽略/);
  });
});
