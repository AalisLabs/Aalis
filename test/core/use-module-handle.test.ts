import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 评估 C2：useModule 返回的 disposer 是同步函数，`await off()` 返回时异步清理尚未完成；且它立刻
// 释放模块名，同名新挂载可在旧模块排空期间复用名字。现在返回 ModuleHandle（与 Context 生命周期面
// 同形），名字在子 ctx teardown 的最末释放（清理链排空、按 ctx.id 的枢纽清扫之后）：disposeAsync
// 等到模块的异步清理全部完成才释放。本文件把评估探针从「断言现状缺口」翻成「断言目标行为」。
// ════════════════════════════════════════════════════════════

const mkApp = () => new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });

/** 一个把 onDispose 挂成可控 promise 的模块 */
function slowModule(name: string, log: string[]) {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  const mod = {
    name,
    apply(c: { onDispose: (fn: () => Promise<void>) => void }) {
      c.onDispose(async () => {
        log.push(`${name}:cleanup-start`);
        await gate;
        log.push(`${name}:cleanup-end`);
      });
    },
  };
  return { mod, release: () => release() };
}

describe('useModule 句柄：可等待卸载与名字释放时机', () => {
  it('disposeAsync 等到模块的异步清理完成才返回', async () => {
    const app = mkApp();
    const log: string[] = [];
    const { mod, release } = slowModule('m', log);
    const h = await app.ctx.useModule(mod as never);

    let settled = false;
    const closing = h.disposeAsync().then(() => {
      settled = true;
    });
    await new Promise(r => setTimeout(r, 10));
    expect(log).toEqual(['m:cleanup-start']);
    expect(settled, '异步清理未完成时 disposeAsync 不得返回').toBe(false);

    release();
    await closing;
    expect(log).toEqual(['m:cleanup-start', 'm:cleanup-end']);
  });

  it('名字在异步清理完成后才释放：排空期间同名新挂载拿到 ~2，之后再挂回到原名', async () => {
    const app = mkApp();
    const log: string[] = [];
    const { mod, release } = slowModule('m', log);
    const h1 = await app.ctx.useModule(mod as never);
    expect(h1.id).toBe('root#m');

    const closing = h1.disposeAsync();
    await new Promise(r => setTimeout(r, 0)); // 进入等待窗口

    const h2 = await app.ctx.useModule({ name: 'm', apply() {} });
    expect(h2.id, '旧模块还在排空，名字不得复用').toBe('root#m~2');

    release();
    await closing;
    const h3 = await app.ctx.useModule({ name: 'm', apply() {} });
    expect(h3.id, '旧模块清理完成后名字已释放').toBe('root#m');
  });

  it('dispose() 保持同步语义：同步清理当场执行，异步清理不等待', async () => {
    const app = mkApp();
    const log: string[] = [];
    const h = await app.ctx.useModule({
      name: 'sync',
      apply(c) {
        c.onDispose(() => {
          log.push('sync-cleanup');
        });
        c.onDispose(async () => {
          await new Promise(r => setTimeout(r, 20));
          log.push('async-cleanup');
        });
      },
    });
    h.dispose();
    // dispose() 与断言之间没有 await：同步清理已跑完、异步清理未被等待
    expect(log).toEqual(['sync-cleanup']);
  });

  it('apply 抛错：名字随即释放，同名可再挂', async () => {
    const app = mkApp();
    await expect(
      app.ctx.useModule({
        name: 'bad',
        apply() {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const h = await app.ctx.useModule({ name: 'bad', apply() {} });
    expect(h.id).toBe('root#bad');
  });

  it('释放晚于枢纽清扫：清理链全同步的模块 disposeAsync 发起后同 tick 挂同名，仍拿 ~2', async () => {
    // 清理链全同步时 disposeAsync() 的同步段就把链排空，链到 afterCleanup（按 ctx.id 的
    // unregisterByPlugin 枢纽清扫）之间隔一跳微任务。名字若在链上释放，这一跳里挂的同名
    // 新模块会拿到旧名、随后被旧模块的清扫连锅端走。
    const app = mkApp();
    const h1 = await app.ctx.useModule({ name: 'm', apply() {} });
    expect(h1.id).toBe('root#m');
    const closing = h1.disposeAsync();
    const h2 = await app.ctx.useModule({ name: 'm', apply() {} }); // 同 tick：id 在首个 await 前已定
    expect(h2.id, '收尾未完成前名字不得释放').toBe('root#m~2');
    await closing;
    const h3 = await app.ctx.useModule({ name: 'm', apply() {} });
    expect(h3.id, '收尾完成后名字已释放').toBe('root#m');
  });
});
