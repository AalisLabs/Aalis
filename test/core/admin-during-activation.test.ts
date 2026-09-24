declare module '@aalis/core' {
  interface HookContextMap {
    '__t:ada-hook': Record<string, never>;
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  hooks,
  lifecycle,
  type PluginDefinition,
  provide,
  services,
} from '../../packages/core/src/index.js';
import type { PluginRecord } from '../../packages/core/src/orchestration/plugin-activation.js';

// 管理操作撞上 activating 窗口（apply 在飞）的行为锚。
//
// 拆卸方一律「先写目标态、再对在飞 ctx disposeAsync」——管理意图是后写者，
// 激活收尾以「state 仍为 activating」为继续条件（接管即让位）。
// bounce = retireBatch(pending) + 重算；required 下游看容器现态，optional 不级联重启。
//
// 新旧实例不同期由两道闸分担：同一 entry 靠「激活记录未清不重新激活」
// （bounce 路径，白盒读 PluginRecord.context），同 id 重装靠注册表查重
// （unload 在拆卸完成后才 delete，窗口内 register 被 plugins.has 挡下）。
//
// 时序不靠 sleep 赌：apply / onDispose 进门时解析 entered、卡在 gate 上，
// 「管理操作发起时对方必定在飞」是结构保证。

const gatedSvc = defineService<{ alive: boolean }>('ada-gated-svc');
const pSvc = defineService<{ v: number }>('ada-p-svc');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function recordOf(app: App, id: string): PluginRecord | undefined {
  return app.plugins.getPlugin(id) as PluginRecord | undefined;
}

function makeWorld() {
  const trace: string[] = [];
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ events, services, hooks });
  host.events.on('plugin:loaded', (id: string) => {
    trace.push(`loaded:${id}`);
  });
  host.events.on('plugin:unloaded', (id: string) => {
    trace.push(`unloaded:${id}`);
  });
  return { app, host, trace };
}

/** apply 进门解析 entered、卡在 gate 上；期间注册服务/中间件/onDispose。 */
function makeGatedPlugin(
  trace: string[],
  opts: { failAfterGate?: boolean } = {},
): { definition: PluginDefinition; entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(r => {
    enter = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  const definition = definePlugin({
    name: 'gated',
    provides: [gatedSvc],
    uses: { provide, hooks, lifecycle, config },
    async apply({ provide, hooks, lifecycle, config }) {
      trace.push(`apply:${JSON.stringify(config)}`);
      provide(gatedSvc, { alive: true });
      hooks.middleware('__t:ada-hook', async (_d, next) => {
        trace.push('middleware-hit');
        await next();
      });
      lifecycle.onDispose(() => {
        trace.push('disposed');
      }, 'gated:res');
      enter();
      await gate;
      if (opts.failAfterGate) throw new Error('apply 自爆');
    },
  });
  return { definition, entered, release };
}

describe('unload 撞上 activating 窗口', () => {
  it('在飞 ctx 被完整拆卸：无服务残留、无幽灵中间件、发 unloaded 不发 loaded', async () => {
    const { app, host, trace } = makeWorld();
    const { definition, entered, release } = makeGatedPlugin(trace);
    const registering = app.plugin(definition);
    await entered;

    expect(app.plugins.getPlugin('gated')?.state).toBe('activating');
    const unloading = app.plugins.unload('gated');
    release();
    await Promise.all([registering, unloading]);
    await new Promise(r => setTimeout(r, 0)); // 冲刷异步 emit

    expect(app.plugins.getPlugin('gated')).toBeUndefined();
    expect(host.services.get(gatedSvc)).toBeUndefined();
    expect(trace).toContain('disposed');
    expect(trace).toContain('unloaded:gated');
    expect(trace).not.toContain('loaded:gated');

    await host.hooks.run('__t:ada-hook', {});
    expect(trace).not.toContain('middleware-hit');
  });

  it('apply 在窗口内抛错也不残留：接管让位，无 error 终态写入', async () => {
    const { app, host, trace } = makeWorld();
    const { definition, entered, release } = makeGatedPlugin(trace, { failAfterGate: true });
    const registering = app.plugin(definition);
    await entered;

    const unloading = app.plugins.unload('gated');
    release();
    await Promise.all([registering, unloading]);

    expect(app.plugins.getPlugin('gated')).toBeUndefined();
    expect(host.services.get(gatedSvc)).toBeUndefined();
    expect(trace).toContain('disposed');
  });
});

describe('disable 撞上 activating 窗口', () => {
  it('终态锁定 disabled，不被激活收尾覆写回 active；服务已拆', async () => {
    const { app, host, trace } = makeWorld();
    const { definition, entered, release } = makeGatedPlugin(trace);
    const registering = app.plugin(definition);
    await entered;

    const disabling = app.plugins.disable('gated');
    release();
    const ok = await disabling;
    await registering;

    expect(ok).toBe(true);
    expect(app.plugins.getPlugin('gated')?.state).toBe('disabled');
    expect(host.services.get(gatedSvc)).toBeUndefined();
    expect(trace).toContain('disposed');
    // enable 依赖的不变量：disabled 态激活记录必已清（否则重激活被闸永跳）
    expect(recordOf(app, 'gated')?.activation).toBeUndefined();
  });
});

describe('disable 终态窗口内 provider 重载不得复活消费者', () => {
  it('disable 在飞时 provider 被 bounce：消费者终态锁 disabled，不被重算复活', async () => {
    const { app, host, trace } = makeWorld();
    const provider = definePlugin({
      name: 'prov',
      provides: [pSvc],
      uses: { provide, config },
      apply({ provide, config }) {
        provide(pSvc, { v: typeof config.v === 'number' ? config.v : 1 });
      },
    });
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });
    const consumer = definePlugin({
      name: 'cons',
      uses: { lifecycle, pSvc },
      apply({ lifecycle }) {
        trace.push('cons:apply');
        lifecycle.onDispose(async () => {
          disposeEntered();
          await disposeGate;
        }, 'cons:gated');
      },
    });
    await app.plugin(provider, { v: 1 });
    await app.plugin(consumer);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('cons')?.state).toBe('active');

    const disabling = app.plugins.disable('cons');
    await disposeEnteredP;
    const bouncing = app.plugins.updateConfig('prov', { v: 2 });
    releaseDispose();
    await Promise.all([disabling, bouncing]);
    await app.plugins.idle();

    expect(app.plugins.getPlugin('cons')?.state).toBe('disabled');
    expect(trace.filter(t => t === 'cons:apply')).toHaveLength(1);
    expect(host.services.get(gatedSvc)).toBeUndefined();
  });
});

describe('provider 重载时 activating 的 required 下游一并收敛', () => {
  it('provider 重载时在飞下游同样被拆并以新 provider 重激活', async () => {
    const { app, host, trace } = makeWorld();
    const provider = definePlugin({
      name: 'prov',
      provides: [pSvc],
      uses: { provide, config },
      apply({ provide, config }) {
        provide(pSvc, { v: typeof config.v === 'number' ? config.v : 1 });
      },
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const enteredP = new Promise<void>(r => {
      entered = r;
    });
    let seq = 0;
    const consumer = definePlugin({
      name: 'cons',
      uses: { pSvc },
      async apply() {
        const n = ++seq;
        trace.push(`cons:apply#${n}`);
        if (n === 1) {
          entered();
          await gate;
        }
      },
    });
    await app.plugin(provider, { v: 1 });
    await app.plugins.idle();
    const registering = app.plugin(consumer);
    await enteredP;

    const bouncing = app.plugins.updateConfig('prov', { v: 2 });
    release();
    await Promise.all([registering, bouncing]);
    await app.plugins.idle();

    expect(trace.filter(t => t.startsWith('cons:apply'))).toEqual(['cons:apply#1', 'cons:apply#2']);
    expect(app.plugins.getPlugin('cons')?.state).toBe('active');
    expect(host.services.get(pSvc)?.v).toBe(2);
  });
});

describe('error 终态的不变量：激活记录已清', () => {
  it('apply 抛错进 error 后 context 为空（enable 复活路径依赖此不变量）', async () => {
    const { app } = makeWorld();
    let attempts = 0;
    await app.plugin(
      definePlugin({
        name: 'boom',
        apply() {
          attempts++;
          throw new Error('立即爆炸');
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('boom')?.state).toBe('error');
    expect(recordOf(app, 'boom')?.activation).toBeUndefined();
    // 复活路径畅通的鉴别性断言：enable 后第二次激活确实发生（apply 计数 +1）。
    // 若激活记录未清，激活会被「旧 ctx 未清」闸永久跳过，attempts 停在 1。
    const ok = await app.plugins.enable('boom');
    expect(ok).toBe(true);
    await app.plugins.idle();
    expect(attempts).toBe(2);
    expect(app.plugins.getPlugin('boom')?.state).toBe('error');
  });
});

describe('disable 撞 activating 且 apply 抛错：catch 段接管让位', () => {
  it('终态锁 disabled 而非 error（catch 让位被删则此处写入 error）', async () => {
    const { app, host, trace } = makeWorld();
    const { definition, entered, release } = makeGatedPlugin(trace, { failAfterGate: true });
    const registering = app.plugin(definition);
    await entered;

    const disabling = app.plugins.disable('gated');
    release();
    const ok = await disabling;
    await registering;

    expect(ok).toBe(true);
    expect(app.plugins.getPlugin('gated')?.state).toBe('disabled');
    expect(host.services.get(gatedSvc)).toBeUndefined();
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

    const provider = definePlugin({
      name: 'prov',
      provides: [pSvc],
      uses: { provide },
      apply({ provide }) {
        provide(pSvc, { v: 1 });
      },
    });
    const consumer = definePlugin({
      name: 'cons',
      uses: { lifecycle, pSvc },
      apply({ lifecycle }) {
        trace.push('cons:apply');
        lifecycle.onDispose(async () => {
          disposeEntered();
          await disposeGate;
        }, 'cons:gated');
      },
    });
    await app.plugin(provider);
    await app.plugin(consumer);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('cons')?.state).toBe('active');

    const unloading = app.plugins.unload('prov');
    await disposeEnteredP;
    const disabling = app.plugins.disable('cons');
    releaseDispose();
    await Promise.all([unloading, disabling]);

    expect(app.plugins.getPlugin('cons')?.state).toBe('disabled');
    await app.plugin(provider);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('cons')?.state).toBe('disabled');
    expect(trace.filter(t => t === 'cons:apply')).toHaveLength(1);
  });
});

describe('unload 拆卸未完成时同 id 重装', () => {
  it('窗口内 register 被注册表查重闸挡下；拆完重装干净（服务在场，无被扫空的假 active）', async () => {
    const { app, host, trace } = makeWorld();
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });

    const make = (): PluginDefinition =>
      definePlugin({
        name: 'gated',
        provides: [gatedSvc],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          trace.push('apply');
          provide(gatedSvc, { alive: true });
          lifecycle.onDispose(async () => {
            disposeEntered();
            await disposeGate;
          }, 'gated:res');
        },
      });
    await app.plugin(make());
    await app.plugins.idle();
    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    const unloading = app.plugins.unload('gated');
    await disposeEnteredP;

    await app.plugin(make());
    expect(app.plugins.getPlugin('gated')?.state).toBe('disposed');
    expect(trace.filter(t => t === 'apply')).toHaveLength(1);

    releaseDispose();
    await unloading;
    expect(app.plugins.getPlugin('gated')).toBeUndefined();

    await app.plugin(make());
    await app.plugins.idle();
    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    expect(host.services.get(gatedSvc)).toEqual({ alive: true });
    expect(trace.filter(t => t === 'apply')).toHaveLength(2);
  });
});

describe('并发双 unload', () => {
  it('第二个 unload join 首个的拆卸：单次 unloaded 事件，且不盲删重装的新 entry', async () => {
    const { app, host, trace } = makeWorld();
    let releaseDispose!: () => void;
    let disposeEntered!: () => void;
    const disposeGate = new Promise<void>(r => {
      releaseDispose = r;
    });
    const disposeEnteredP = new Promise<void>(r => {
      disposeEntered = r;
    });
    const make = (): PluginDefinition =>
      definePlugin({
        name: 'gated',
        provides: [gatedSvc],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          trace.push('apply');
          provide(gatedSvc, { alive: true });
          lifecycle.onDispose(async () => {
            disposeEntered();
            await disposeGate;
          }, 'gated:res');
        },
      });
    await app.plugin(make());
    await app.plugins.idle();

    const u1 = app.plugins.unload('gated');
    await disposeEnteredP;
    const u2 = app.plugins.unload('gated');
    releaseDispose();
    await Promise.all([u1, u2]);
    await new Promise(r => setTimeout(r, 0));

    expect(trace.filter(t => t === 'unloaded:gated')).toHaveLength(1);
    expect(app.plugins.getPlugin('gated')).toBeUndefined();

    await app.plugin(make());
    await app.plugins.idle();
    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    expect(host.services.get(gatedSvc)).toEqual({ alive: true });
  });
});

describe('updateConfig 撞上 activating 窗口', () => {
  it('旧实例先排空、新实例再以新配置激活（严格串行，不同期）', async () => {
    const { app, host, trace } = makeWorld();
    const { definition, entered, release } = makeGatedPlugin(trace);
    const registering = app.plugin(definition, { n: 1 });
    await entered;

    const updating = app.plugins.updateConfig('gated', { n: 2 });
    release();
    expect(await updating).toBe(true);
    await registering;
    await app.plugins.idle();

    expect(app.plugins.getPlugin('gated')?.state).toBe('active');
    expect(app.plugins.getPlugin('gated')?.config).toEqual({ n: 2 });
    expect(host.services.get(gatedSvc)).toEqual({ alive: true });

    const disposedAt = trace.indexOf('disposed');
    const reapplyAt = trace.indexOf('apply:{"n":2}');
    expect(disposedAt).toBeGreaterThanOrEqual(0);
    expect(reapplyAt).toBeGreaterThanOrEqual(0);
    expect(disposedAt).toBeLessThan(reapplyAt);
    expect(trace.filter(t => t.startsWith('apply:')).sort()).toEqual(['apply:{"n":1}', 'apply:{"n":2}']);
  });
});
