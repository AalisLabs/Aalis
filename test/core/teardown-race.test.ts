import { definePlugin, defineService, lifecycle, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 拆卸路径的并发正确性
//
// disposed 在清理开始前置位，若仅凭它早退，后来者会拿到"已完成"的假象而清理其实没落：后来者加入在飞的关闭，
// 返回时清理已经完成。停机撞上在飞的 bounce：App.stop 先 idle 再执行冻好的停机计划，消费者落盘仍先于提供者关闭。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const store = defineService<{ write: () => void }>('__t:tr-store');

describe('Activation 并发拆卸', () => {
  it('并发 disposeAsync：后来者 join 在飞拆卸，返回时清理已真正完成', async () => {
    const app = createInspectableApp({ name: 'T', logLevel: 'error' });
    const log: string[] = [];
    const child = activationHost(app).create('slow-child');
    child.resources.onDispose(async () => {
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

  it('根激活级联撞上半拆的插件激活：根的 disposeAsync 等到它清理落地', async () => {
    const app = createInspectableApp({ name: 'T', logLevel: 'error' });
    const log: string[] = [];
    const parent = rootActivation(app);
    const child = activationHost(app).create('child');
    child.resources.onDispose(async () => {
      await sleep(40);
      log.push('child-flushed');
    });

    void child.disposeAsync(); // 子先自行拆卸
    await sleep(5);
    await parent.disposeAsync(); // 根级联撞上半拆的插件激活
    expect(log, '根返回时插件激活的异步清理必须已完成').toEqual(['child-flushed']);
    await app.stop();
  });

  it('拆卸完成后再次 disposeAsync 立即返回（幂等，不重跑清理）', async () => {
    const app = createInspectableApp({ name: 'T', logLevel: 'error' });
    let runs = 0;
    const child = activationHost(app).create('idempotent');
    child.resources.onDispose(async () => {
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
    const app = createInspectableApp({ name: 'T', logLevel: 'error' });
    const order: string[] = [];

    await app.plugin(
      definePlugin({
        name: 'prov',
        uses: { provide, lifecycle },
        provides: [store],
        apply({ provide: pub, lifecycle }) {
          pub.use(store, { write: () => order.push('write') });
          lifecycle.use.onDispose(() => {
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
          lifecycle.use.onDispose(async () => {
            await sleep(10);
            // 落盘：此刻提供者必须还活着（声明依赖在清理段仍可调用）
            const alive = storeRef.present;
            order.push(alive ? 'consumer-flushed' : 'consumer-flush-FAILED');
            if (alive) storeRef.use.write();
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
