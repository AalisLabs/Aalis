import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, lifecycle } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// ModuleHandle 与激活的生命周期面同形：dispose 同步请求关闭（同步清理当场执行，异步清理
// 不等待，名字随同步段释放）；disposeAsync 等到全部异步清理完成，名字在子激活 teardown
// 最末（清理链排空、按 ctx.id 的枢纽清扫之后）才释放。同名重复挂载在旧模块仍占名时拿到
// `parent#name~2`，收尾后再挂回到原名——否则新挂载会在那一跳微任务里被旧清扫连锅端走。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const mkApp = () => {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  apps.push(app);
  return app;
};

function mount(app: App) {
  return app.bind({ lifecycle }).lifecycle;
}

/** 一个把 onDispose 挂成可控 promise 的模块 */
function slowModule(name: string, log: string[]) {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  const definition = definePlugin({
    name,
    uses: { lifecycle },
    apply({ lifecycle }) {
      lifecycle.onDispose(async () => {
        log.push(`${name}:cleanup-start`);
        await gate;
        log.push(`${name}:cleanup-end`);
      });
    },
  });
  return { definition, release: () => release() };
}

describe('lifecycle.module 句柄：可等待卸载与名字释放时机', () => {
  it('disposeAsync 等到模块的异步清理完成才返回', async () => {
    const app = mkApp();
    const log: string[] = [];
    const { definition, release } = slowModule('m', log);
    const h = await mount(app).module(definition);

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
    const { definition, release } = slowModule('m', log);
    const cap = mount(app);
    const h1 = await cap.module(definition);
    expect(h1.id).toBe('root#m');

    const closing = h1.disposeAsync();
    await new Promise(r => setTimeout(r, 0)); // 进入等待窗口

    const h2 = await cap.module(definePlugin({ name: 'm', apply() {} }));
    expect(h2.id, '旧模块还在排空，名字不得复用').toBe('root#m~2');

    release();
    await closing;
    const h3 = await cap.module(definePlugin({ name: 'm', apply() {} }));
    expect(h3.id, '旧模块清理完成后名字已释放').toBe('root#m');
  });

  it('dispose() 保持同步语义：同步清理当场执行，异步清理不等待', async () => {
    const app = mkApp();
    const log: string[] = [];
    const h = await mount(app).module(
      definePlugin({
        name: 'sync',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDispose(() => {
            log.push('sync-cleanup');
          });
          lifecycle.onDispose(async () => {
            await new Promise(r => setTimeout(r, 20));
            log.push('async-cleanup');
          });
        },
      }),
    );
    h.dispose();
    // dispose() 与断言之间没有 await：同步清理已跑完、异步清理未被等待
    expect(log).toEqual(['sync-cleanup']);
  });

  it('apply 抛错：名字随即释放，同名可再挂', async () => {
    const app = mkApp();
    const cap = mount(app);
    await expect(
      cap.module(
        definePlugin({
          name: 'bad',
          apply() {
            throw new Error('boom');
          },
        }),
      ),
    ).rejects.toThrow('boom');
    const h = await cap.module(definePlugin({ name: 'bad', apply() {} }));
    expect(h.id).toBe('root#bad');
  });

  it('释放晚于枢纽清扫：清理链全同步的模块 disposeAsync 发起后同 tick 挂同名，仍拿 ~2', async () => {
    // 清理链全同步时 disposeAsync() 的同步段就把链排空，链到 afterCleanup（按 ctx.id 的
    // 枢纽清扫）之间隔一跳微任务。名字若在链上释放，这一跳里挂的同名
    // 新模块会拿到旧名、随后被旧模块的清扫连锅端走。
    const app = mkApp();
    const cap = mount(app);
    const h1 = await cap.module(definePlugin({ name: 'm', apply() {} }));
    expect(h1.id).toBe('root#m');
    const closing = h1.disposeAsync();
    const h2 = await cap.module(definePlugin({ name: 'm', apply() {} })); // 同 tick：id 在首个 await 前已定
    expect(h2.id, '收尾未完成前名字不得释放').toBe('root#m~2');
    await closing;
    const h3 = await cap.module(definePlugin({ name: 'm', apply() {} }));
    expect(h3.id, '收尾完成后名字已释放').toBe('root#m');
  });
});
