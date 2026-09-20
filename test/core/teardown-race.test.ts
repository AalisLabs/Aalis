import { App, definePlugin, defineService, lifecycle, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { rootActivation } from '../../packages/core/src/orchestration/app.js';

// ════════════════════════════════════════════════════════════
// 拆卸路径的并发正确性
//
// disposed 在清理开始前置位，若仅凭它早退，后来者会拿到"已完成"的假象而
// 清理其实没落；停机若撞上在飞 recompute，shutdown 请求被单飞排队后立即返回，
// 拓扑逆序编排整个落空 → 消费者的落盘写进已关闭的提供者。
// App.stop 先 await idle 再 stopAll，把这一窗口堵上；本文件仍用 bounce 在飞
// 去撞停机，钉住消费者落盘先于提供者关闭。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const store = defineService<{ write: () => void }>('__t:tr-store');

describe('Context 并发拆卸', () => {
  it('并发 disposeAsync：后来者 join 在飞拆卸，返回时清理已真正完成', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const log: string[] = [];
    const child = rootActivation(app).fork('slow-child');
    child.onDispose(async () => {
      log.push('flush-start');
      await sleep(40);
      log.push('flush-done');
    });

    const first = child.disposeAsync();
    await sleep(5); // 让第一条走进清理链
    const second = child.disposeAsync();
    await second;
    expect(log, '第二个调用返回时异步清理必须已完成').toEqual(['flush-start', 'flush-done']);
    await first;
    await app.stop();
  });

  it('父级联撞上半拆的子 ctx：父的 disposeAsync 等到子清理落地', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const log: string[] = [];
    const parent = rootActivation(app).fork('parent');
    const child = parent.fork('parent/child');
    child.onDispose(async () => {
      await sleep(40);
      log.push('child-flushed');
    });

    void child.disposeAsync(); // 子先自行拆卸
    await sleep(5);
    await parent.disposeAsync(); // 父级联撞上半拆的子
    expect(log, '父返回时子的异步清理必须已完成').toEqual(['child-flushed']);
    await app.stop();
  });

  it('join 在飞拆卸时受本次调用者的 timeoutMs 约束（在飞方用更松的上限也不拖垮停机）', async () => {
    // disposeTimeoutMs 配短：末尾 app.stop 同样要等这个永不 resolve 的清理项
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, disposeTimeoutMs: 100 });
    const child = rootActivation(app).fork('never-settles');
    child.onDispose(() => new Promise<void>(() => {})); // 永不 resolve

    void child.disposeAsync(); // 先以「不设限」启动在飞拆卸
    await sleep(5);
    const t0 = Date.now();
    await child.disposeAsync(80); // 后来者要求 80ms 上限
    const elapsed = Date.now() - t0;
    expect(elapsed, `join 必须受调用者 timeoutMs 约束，实际等了 ${elapsed}ms`).toBeLessThan(1000);
    // app.stop 同理不得被拖住（它传的是 disposeTimeoutMs）
    await app.stop();
  });

  it('拆卸完成后再次 disposeAsync 立即返回（幂等，不重跑清理）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    let runs = 0;
    const child = rootActivation(app).fork('idempotent');
    child.onDispose(async () => {
      runs++;
      await sleep(10);
    });
    await child.disposeAsync();
    await child.disposeAsync();
    await child.disposeAsync();
    expect(runs).toBe(1);
    await app.stop();
  });
});

describe('App.stop 撞上在飞 recompute', () => {
  it('bounce 在飞时停机，仍保持拓扑逆序：消费者落盘先于提供者关闭', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const order: string[] = [];

    await app.plugin(
      definePlugin({
        name: 'prov',
        uses: { provide, lifecycle },
        provides: [store],
        apply({ provide: pub, lifecycle }) {
          pub(store, { write: () => order.push('write') });
          lifecycle.onDispose(() => {
            order.push('provider-closed');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'cons',
        uses: { store, lifecycle },
        apply({ store: storeRef, lifecycle }) {
          lifecycle.onDispose(async () => {
            await sleep(10);
            // 落盘：此刻提供者必须还活着（声明依赖在清理段仍可调用）
            const impl = storeRef.current;
            order.push(impl ? 'consumer-flushed' : 'consumer-flush-FAILED');
            impl?.write();
          });
        },
      }),
    );
    // 被 bounce 的第三个插件，制造在飞 recompute
    await app.plugin(definePlugin({ name: 'noisy', apply() {} }));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('prov')?.state).toBe('active');
    expect(app.plugins.getPlugin('cons')?.state).toBe('active');
    expect(app.plugins.getPlugin('noisy')?.state).toBe('active');

    // 不 await：让 bounce 处于在飞状态时发起停机
    void app.plugins.bounce('noisy', { config: { n: 2 } });
    await app.stop();

    expect(order).toContain('consumer-flushed');
    expect(order).not.toContain('consumer-flush-FAILED');
    expect(
      order.indexOf('consumer-flushed') < order.indexOf('provider-closed'),
      `消费者落盘必须先于提供者关闭，实际顺序: ${order.join(' → ')}`,
    ).toBe(true);
  });
});
