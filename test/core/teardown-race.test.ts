import { App, type PluginModule } from '@aalis/core';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 拆卸路径的并发正确性
//
// _disposed 在清理开始前置位，若仅凭它早退，后来者会拿到"已完成"的假象而
// 清理其实没落；停机若撞上在飞 recompute，shutdown 请求被单飞排队后立即返回，
// 拓扑逆序编排整个落空 → 消费者的落盘写进已关闭的提供者。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('Context 并发拆卸', () => {
  it('并发 disposeAsync：后来者 join 在飞拆卸，返回时清理已真正完成', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const log: string[] = [];
    const child = app.ctx.fork('slow-child');
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
    const parent = app.ctx.fork('parent');
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

  it('拆卸完成后再次 disposeAsync 立即返回（幂等，不重跑清理）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    let runs = 0;
    const child = app.ctx.fork('idempotent');
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

    const provider: PluginModule = {
      name: 'prov',
      provides: ['store'],
      apply(ctx) {
        ctx.provide('store', { write: () => order.push('write') });
        ctx.onDispose(() => {
          order.push('provider-closed');
        });
      },
    };
    const consumer: PluginModule = {
      name: 'cons',
      inject: { required: ['store'] },
      apply(ctx) {
        ctx.onDispose(async () => {
          await sleep(10);
          // 落盘：此刻提供者必须还活着
          const store = ctx.getService<{ write: () => void }>('store');
          order.push(store ? 'consumer-flushed' : 'consumer-flush-FAILED');
        });
      },
    };
    // 被 bounce 的第三个插件，制造在飞 recompute
    const noisy: PluginModule = { name: 'noisy', apply() {}, defaultConfig: { n: 1 } };

    await app.plugin(provider);
    await app.plugin(consumer);
    await app.plugin(noisy);
    await app.start();

    // 不 await：让 bounce 处于在飞状态时发起停机
    void app.plugins.bouncePlugin('noisy', { config: { n: 2 } });
    await app.stop();

    expect(order).toContain('consumer-flushed');
    expect(order).not.toContain('consumer-flush-FAILED');
    expect(
      order.indexOf('consumer-flushed') < order.indexOf('provider-closed'),
      `消费者落盘必须先于提供者关闭，实际顺序: ${order.join(' → ')}`,
    ).toBe(true);
  });
});
