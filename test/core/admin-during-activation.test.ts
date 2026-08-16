import { describe, expect, it } from 'vitest';
import type { Context, PluginModule } from '../../packages/core/src/index.js';
import { App } from '../../packages/core/src/index.js';

// ============================================================
// 管理操作撞上 activating 窗口（apply 在飞）的行为锚。
//
// 修复前的三种坏后果（探针实证）：unload 静默跳过拆卸→幽灵插件继续处理流量；
// disablePlugin 返回 true 但终态被激活收尾覆写回 'active'；updatePluginConfig
// 静默 no-op（apply 从未见过新配置）。三者共因：拆卸判据 `state === 'active'`
// 漏掉 'activating'，且 activatePlugin 收尾无条件写 'active'。
//
// 修后契约：拆卸方（三管理入口 + recomputeOnce Phase A + evictDownstreamConsumers）
// 一律「先写目标态、再对在飞 ctx disposeAsync」——管理意图是后写者、拆卸收尾
// 不再写状态；activatePlugin 以「state 仍为 'activating'」为收尾继续条件（接管
// 即让位）。新旧实例不同期由两道闸分担：同一 entry 靠「entry.context 未清不
// 重新激活」（bounce 路径），同 id 重装靠注册表查重（unload 在拆卸完成后才
// delete，窗口内 register 被 plugins.has 挡下）。
//
// 时序不靠 sleep 赌：apply / onDispose 进门时解析 entered、卡在 gate 上，
// 「管理操作发起时对方必定在飞」是结构保证。
// ============================================================

const HOOK = '__t:ada-hook' as never;

function makeWorld() {
  const trace: string[] = [];
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.on('plugin:loaded', (id: string) => {
    trace.push(`loaded:${id}`);
  });
  app.ctx.on('plugin:unloaded', (id: string) => {
    trace.push(`unloaded:${id}`);
  });
  return { app, trace };
}

/** apply 进门解析 entered、卡在 gate 上；期间注册服务/中间件/onDispose。 */
function makeGatedPlugin(
  trace: string[],
  opts: { failAfterGate?: boolean } = {},
): { module: PluginModule; entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(r => {
    enter = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  const module: PluginModule = {
    name: 'gated',
    async apply(ctx: Context, config: Record<string, unknown>) {
      trace.push(`apply:${JSON.stringify(config)}`);
      ctx.provide('gated-svc', { alive: true });
      ctx.middleware(HOOK, (async (_d: unknown, next: () => Promise<void>) => {
        trace.push('middleware-hit');
        await next();
      }) as never);
      ctx.onDispose(() => {
        trace.push('disposed');
      }, 'gated:res');
      enter();
      await gate;
      if (opts.failAfterGate) throw new Error('apply 自爆');
    },
  };
  return { module, entered, release };
}

describe('unload 撞上 activating 窗口', () => {
  it('在飞 ctx 被完整拆卸：无服务残留、无幽灵中间件、发 unloaded 不发 loaded', async () => {
    const { app, trace } = makeWorld();
    const { module, entered, release } = makeGatedPlugin(trace);
    const registering = app.plugin(module);
    await entered;

    expect(app.plugins.getPlugin('gated')?.state).toBe('activating');
    const unloading = app.plugins.unload('gated');
    release();
    await Promise.all([registering, unloading]);
    await new Promise(r => setTimeout(r, 0)); // 冲刷异步 emit

    expect(app.plugins.getPlugin('gated')).toBeUndefined();
    expect(app.ctx.getService('gated-svc')).toBeUndefined();
    expect(trace).toContain('disposed');
    expect(trace).toContain('unloaded:gated');
    expect(trace).not.toContain('loaded:gated');

    await app.ctx.runHook(HOOK, {} as never);
    expect(trace).not.toContain('middleware-hit');
  });

  it('apply 在窗口内抛错也不残留：接管让位，无 error 终态写入', async () => {
    const { app, trace } = makeWorld();
    const { module, entered, release } = makeGatedPlugin(trace, { failAfterGate: true });
    const registering = app.plugin(module);
    await entered;

    const unloading = app.plugins.unload('gated');
    release();
    await Promise.all([registering, unloading]);

    expect(app.plugins.getPlugin('gated')).toBeUndefined();
    expect(app.ctx.getService('gated-svc')).toBeUndefined();
    expect(trace).toContain('disposed');
  });
});

describe('disablePlugin 撞上 activating 窗口', () => {
  it('终态锁定 disabled，不被激活收尾覆写回 active；服务已拆', async () => {
    const { app, trace } = makeWorld();
    const { module, entered, release } = makeGatedPlugin(trace);
    const registering = app.plugin(module);
    await entered;

    const disabling = app.plugins.disablePlugin('gated');
    release();
    const ok = await disabling;
    await registering;

    expect(ok).toBe(true);
    expect(app.plugins.getPlugin('gated')?.state).toBe('disabled');
    expect(app.ctx.getService('gated-svc')).toBeUndefined();
    expect(trace).toContain('disposed');
    // enablePlugin 依赖的不变量：disabled 态 context 必已清（否则重激活被闸永跳）
    expect(app.plugins.getPlugin('gated')?.context).toBeUndefined();
  });
});

describe('evict 不得进入终态拆卸窗口（disabled 的慢 onDispose 撞并发 bounce）', () => {
  it('disable 在飞时 provider 被 bounce：消费者终态锁 disabled，不被 evict 复活', async () => {
    const { app, trace } = makeWorld();
    const provider: PluginModule = {
      name: 'prov',
      provides: ['p-svc'],
      apply(ctx: Context, config: Record<string, unknown>) {
        ctx.provide('p-svc', { v: config.v ?? 1 });
      },
    };
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });
    const consumer: PluginModule = {
      name: 'cons',
      inject: { optional: ['p-svc'] },
      requiresBounceOnDepChange: true,
      apply(ctx: Context) {
        trace.push('cons:apply');
        ctx.onDispose(async () => {
          disposeEntered();
          await disposeGate;
        }, 'cons:gated');
      },
    };
    await app.plugin(provider, { v: 1 });
    await app.plugin(consumer);
    await app.plugins.idle();

    // disable 写下 'disabled' 终态、卡在慢 onDispose 上（ctx 未清的终态窗口）
    const disabling = app.plugins.disablePlugin('cons');
    await disposeEnteredP;
    // 并发 bounce provider——修前 evict 凭 ctx 在场扫进窗口，把 disabled 覆写回 pending 复活
    const bouncing = app.plugins.updatePluginConfig('prov', { v: 2 });
    releaseDispose();
    await Promise.all([disabling, bouncing]);
    await app.plugins.idle();

    expect(app.plugins.getPlugin('cons')?.state).toBe('disabled');
    expect(trace.filter(t => t === 'cons:apply')).toHaveLength(1);
    expect(app.ctx.getService('cons-svc')).toBeUndefined();
  });
});

describe('evict 疏散 activating 下游（判据=entry.context）', () => {
  it('provider 重载时在飞下游同样被疏散并以新 provider 重激活', async () => {
    const { app, trace } = makeWorld();
    const provider: PluginModule = {
      name: 'prov',
      provides: ['p-svc'],
      apply(ctx: Context, config: Record<string, unknown>) {
        ctx.provide('p-svc', { v: config.v ?? 1 });
      },
    };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const enteredP = new Promise<void>(r => {
      entered = r;
    });
    let seq = 0;
    const consumer: PluginModule = {
      name: 'cons',
      inject: { optional: ['p-svc'] },
      requiresBounceOnDepChange: true,
      async apply() {
        const n = ++seq;
        trace.push(`cons:apply#${n}`);
        if (n === 1) {
          entered();
          await gate; // 首次激活卡在飞——bounce provider 时它正处 activating
        }
      },
    };
    await app.plugin(provider, { v: 1 });
    const registering = app.plugin(consumer);
    await enteredP;

    const bouncing = app.plugins.updatePluginConfig('prov', { v: 2 });
    release();
    await Promise.all([registering, bouncing]);
    await new Promise(r => setTimeout(r, 20));

    // 修前：activating 的下游漏疏散，抱着旧 provider 引用完成激活且不重载
    expect(trace.filter(t => t.startsWith('cons:apply'))).toEqual(['cons:apply#1', 'cons:apply#2']);
    expect(app.plugins.getPlugin('cons')?.state).toBe('active');
    expect((app.ctx.getService('p-svc') as { v: number }).v).toBe(2);
  });
});

describe('error 终态的不变量：context 已清', () => {
  it('apply 抛错进 error 后 context 为空（enablePlugin 复活路径依赖此不变量）', async () => {
    const { app } = makeWorld();
    let attempts = 0;
    await app.plugin({
      name: 'boom',
      apply() {
        attempts++;
        throw new Error('立即爆炸');
      },
    });
    // 等静置：ctor 里 provide('app'/'plugins') 触发的反应式 recompute 可能在飞，
    // 首个 app.plugin() 会走单飞排队分支提前返回（resolve≠激活完成——已立刀候选）
    await app.plugins.idle();
    expect(app.plugins.getPlugin('boom')?.state).toBe('error');
    expect(app.plugins.getPlugin('boom')?.context).toBeUndefined();
    // 复活路径畅通的鉴别性断言：enable 后第二次激活**确实发生**（apply 计数 +1）。
    // 若 context 未清，激活会被「旧 ctx 未清」闸永久跳过，attempts 停在 1。
    const ok = await app.plugins.enablePlugin('boom');
    expect(ok).toBe(true);
    await app.plugins.idle();
    expect(attempts).toBe(2);
    expect(app.plugins.getPlugin('boom')?.state).toBe('error');
  });
});

describe('disablePlugin 撞 activating 且 apply 抛错：catch 段接管让位', () => {
  it('终态锁 disabled 而非 error（catch 让位被删则此处写入 error）', async () => {
    const { app, trace } = makeWorld();
    const { module, entered, release } = makeGatedPlugin(trace, { failAfterGate: true });
    const registering = app.plugin(module);
    await entered;

    const disabling = app.plugins.disablePlugin('gated');
    release();
    const ok = await disabling;
    await registering;

    expect(ok).toBe(true);
    expect(app.plugins.getPlugin('gated')?.state).toBe('disabled');
    expect(app.ctx.getService('gated-svc')).toBeUndefined();
  });
});

describe('级联拆卸窗口内 disable：终态不被拆卸收尾覆写', () => {
  it('Phase A 拆卸消费者中途禁用之，终态锁 disabled；提供者回归也不复活', async () => {
    const { app, trace } = makeWorld();
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });

    const provider: PluginModule = {
      name: 'prov',
      provides: ['p-svc'],
      apply(ctx: Context) {
        ctx.provide('p-svc', { v: 1 });
      },
    };
    const consumer: PluginModule = {
      name: 'cons',
      inject: { required: ['p-svc'] },
      apply(ctx: Context) {
        trace.push('cons:apply');
        ctx.onDispose(async () => {
          disposeEntered();
          await disposeGate;
        }, 'cons:gated');
      },
    };
    await app.plugin(provider);
    await app.plugin(consumer);
    expect(app.plugins.getPlugin('cons')?.state).toBe('active');

    // unload 提供者 → softReload Phase A 开拆 cons，卡在 gated onDispose 上
    const unloading = app.plugins.unload('prov');
    await disposeEnteredP;
    const disabling = app.plugins.disablePlugin('cons');
    releaseDispose();
    await Promise.all([unloading, disabling]);

    expect(app.plugins.getPlugin('cons')?.state).toBe('disabled');
    // 提供者回归也不得复活（修前 Phase A 后写 'pending' 会让它自动二次 apply）
    await app.plugin(provider);
    expect(app.plugins.getPlugin('cons')?.state).toBe('disabled');
    expect(trace.filter(t => t === 'cons:apply')).toHaveLength(1);
  });
});

describe('unload 拆卸未完成时同 id 重装', () => {
  it('窗口内 register 被注册表查重闸挡下；拆完重装干净（服务在场，无被扫空的假 active）', async () => {
    const { app, trace } = makeWorld();
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });

    const make = (): PluginModule => ({
      name: 'gated',
      apply(ctx: Context) {
        trace.push('apply');
        ctx.provide('gated-svc', { alive: true });
        ctx.onDispose(async () => {
          disposeEntered();
          await disposeGate;
        }, 'gated:res');
      },
    });
    await app.plugin(make());
    const unloading = app.plugins.unload('gated');
    await disposeEnteredP;

    // 旧 ctx 仍在排空：同 id 注册必须被挡下（entry 仍在注册表、state=disposed）
    await app.plugin(make());
    expect(app.plugins.getPlugin('gated')?.state).toBe('disposed');
    expect(trace.filter(t => t === 'apply')).toHaveLength(1);

    releaseDispose();
    await unloading;
    expect(app.plugins.getPlugin('gated')).toBeUndefined();

    // 拆完重装：干净激活，服务真实在场（修前窗口重装会被旧链扫成空壳 active）
    await app.plugin(make());
    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    expect(app.ctx.getService('gated-svc')).toEqual({ alive: true });
    expect(trace.filter(t => t === 'apply')).toHaveLength(2);
  });
});

describe('并发双 unload', () => {
  it('第二个 unload join 首个的拆卸：单次 unloaded 事件，且不盲删重装的新 entry', async () => {
    const { app, trace } = makeWorld();
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });
    const make = (): PluginModule => ({
      name: 'gated',
      apply(ctx: Context) {
        trace.push('apply');
        ctx.provide('gated-svc', { alive: true });
        ctx.onDispose(async () => {
          disposeEntered();
          await disposeGate;
        }, 'gated:res');
      },
    });
    await app.plugin(make());

    const u1 = app.plugins.unload('gated');
    await disposeEnteredP;
    const u2 = app.plugins.unload('gated'); // 撞在拆卸窗口内
    releaseDispose();
    await Promise.all([u1, u2]);
    await new Promise(r => setTimeout(r, 0));

    expect(trace.filter(t => t === 'unloaded:gated')).toHaveLength(1);
    expect(app.plugins.getPlugin('gated')).toBeUndefined();

    // 双 unload 落定后重装必须干净成活（此前第二个 delete 会按名盲删新 entry）
    await app.plugin(make());
    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    expect(app.ctx.getService('gated-svc')).toEqual({ alive: true });
  });
});

describe('updatePluginConfig 撞上 activating 窗口', () => {
  it('旧实例先排空、新实例再以新配置激活（严格串行，不同期）', async () => {
    const { app, trace } = makeWorld();
    const { module, entered, release } = makeGatedPlugin(trace);
    const registering = app.plugin(module, { n: 1 });
    await entered;

    const updating = app.plugins.updatePluginConfig('gated', { n: 2 });
    release();
    expect(await updating).toBe(true);
    await registering;

    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    expect(app.plugins.getPlugin('gated')?.config).toEqual({ n: 2 });
    expect(app.ctx.getService('gated-svc')).toEqual({ alive: true });

    // 顺序钉死：旧实例 disposed 必须先于新 apply（否则同 contextId 并存，
    // 旧链的 unregisterByContext 会扫掉新实例的注册）
    const disposedAt = trace.indexOf('disposed');
    const reapplyAt = trace.indexOf('apply:{"n":2}');
    expect(disposedAt).toBeGreaterThanOrEqual(0);
    expect(reapplyAt).toBeGreaterThanOrEqual(0);
    expect(disposedAt).toBeLessThan(reapplyAt);
    // 且新实例只激活一次、旧配置的 apply 只出现一次
    expect(trace.filter(t => t.startsWith('apply:')).sort()).toEqual(['apply:{"n":1}', 'apply:{"n":2}']);
  });
});
