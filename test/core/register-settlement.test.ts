import { describe, expect, it } from 'vitest';
import type { Context, PluginDescriptor, PluginModule } from '../../packages/core/src/index.js';
import { App } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// register 的 resolve 语义定格 + 引导期收敛保证。
//
// 契约（app.plugin JSDoc）：resolve = 注册落账 + 尽力即时激活。有在飞
// recompute 时本次请求排队并入其收尾——resolve 时激活可能尚未发生（自愈
// 不丢失）；确定时机用 plugins.idle()。本文件把这个语义**故意**钉死：
// 未来想改成「resolve=激活完成」是契约变更，必须先让这里红、有意识地过刀
// （裁决书：register 内部等静置判不必要——in-apply 调用转死锁 + 安装延迟
// 与无关慢 apply 耦合 + 第一方消费面零依赖）。
//
// autoLoadPlugins 则相反：末尾等静置，「返回即全部收敛」是结构保证——
// ready / app:started 的发出时机依赖它。
// ════════════════════════════════════════════════════════════

function gatedModule(
  name: string,
  trace: string[],
): { module: PluginModule; entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(r => {
    enter = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  return {
    module: {
      name,
      async apply(_ctx: Context) {
        trace.push(`${name}:enter`);
        enter();
        await gate;
        trace.push(`${name}:done`);
      },
    },
    entered,
    release,
  };
}

describe('register 的 resolve 语义（故意钉死的排队早退）', () => {
  it('在飞 recompute 期间 register：resolve 时 pending，idle 后 active', async () => {
    const trace: string[] = [];
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const g = gatedModule('slow', trace);
    const registering = app.plugin(g.module);
    await g.entered; // recompute run 在飞（正 await slow 的 apply）

    // 契约锚：resolve≠激活完成——排队早退，注册已落账、激活并入在飞 run 收尾
    await app.plugin({ name: 'fast', apply() {} });
    expect(app.plugins.getPlugin('fast')?.state).toBe('pending');

    g.release();
    await registering;
    await app.plugins.idle();
    expect(app.plugins.getPlugin('fast')?.state).toBe('active');
    expect(app.plugins.getPlugin('slow')?.state).toBe('active');
  });
});

describe('autoLoadPlugins 的引导期收敛保证（结构化而非碰运气）', () => {
  it('返回时全部发现的插件已收敛，即使 register 曾撞上在飞 run 排队', async () => {
    const trace: string[] = [];
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });

    // 先制造一个在飞 run：gated 插件占住单飞
    const g = gatedModule('occupier', trace);
    const occupying = app.plugin(g.module);
    await g.entered;

    // 此刻跑引导：loader 里的插件 register 必然排队早退
    const mods = new Map<string, PluginModule>([['booted', { name: 'booted', apply() {} }]]);
    (app as unknown as { pluginLoader: unknown }).pluginLoader = {
      async discover(): Promise<PluginDescriptor[]> {
        return [{ name: 'booted', source: 'stub', metadata: {} }];
      },
      async load(desc: PluginDescriptor): Promise<PluginModule | null> {
        return mods.get(desc.name) ?? null;
      },
    };
    const autoloading = app.autoLoadPlugins();
    // 在 resolve 的瞬间捕获状态——保证是「返回时已收敛」而非「之后某刻收敛」：
    // 变异版（删末尾 idle）会在占位者还卡着时就 resolve，此处捕获到 pending 即红。
    const stateAtResolve = autoloading.then(() => app.plugins.getPlugin('booted')?.state);
    await new Promise(r => setTimeout(r, 10));
    g.release();
    expect(await stateAtResolve).toBe('active');
    await occupying;
  });
});
