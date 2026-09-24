import { describe, expect, it } from 'vitest';
import { App, definePlugin, type PluginDefinition } from '../../packages/core/src/index.js';

// register 的 resolve 语义定格 + 引导期收敛保证。
//
// 契约（app.plugin JSDoc）：resolve = 注册落账 + 尽力即时激活。有在飞
// recompute 时本次请求排队并入其收尾——resolve 时激活可能尚未发生（自愈
// 不丢失）；确定时机用 plugins.idle()。本文件把这个语义故意钉死：
// 未来想改成「resolve=激活完成」是契约变更，必须先让这里红、有意识地过刀
// （register 内部等静置判不必要——in-apply 调用转死锁 + 安装延迟
// 与无关慢 apply 耦合 + 第一方消费面零依赖）。
// 宿主冷启动「返回即全部收敛」与热扫描「不等静置」的锚在 test/runtime/plugin-discovery.test.ts。

function gatedModule(
  name: string,
  trace: string[],
): { module: PluginDefinition; entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(r => {
    enter = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  return {
    module: definePlugin({
      name,
      async apply() {
        trace.push(`${name}:enter`);
        enter();
        await gate;
        trace.push(`${name}:done`);
      },
    }),
    entered,
    release,
  };
}

describe('register 的 resolve 语义（故意钉死的排队早退）', () => {
  it('在飞 recompute 期间 register：resolve 时 pending，idle 后 active', async () => {
    const trace: string[] = [];
    const app = new App({ name: 'T', logLevel: 'error' });
    const g = gatedModule('slow', trace);
    const registering = app.plugin(g.module);
    await g.entered; // recompute run 在飞（正 await slow 的 apply）

    // 契约锚：resolve≠激活完成——排队早退，注册已落账、激活并入在飞 run 收尾
    await app.plugin(definePlugin({ name: 'fast', apply() {} }));
    expect(app.plugins.getPlugin('fast')?.state).toBe('pending');

    g.release();
    await registering;
    await app.plugins.idle();
    expect(app.plugins.getPlugin('fast')?.state).toBe('active');
    expect(app.plugins.getPlugin('slow')?.state).toBe('active');
    await app.stop();
  });
});
