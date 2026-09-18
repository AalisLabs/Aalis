import { describe, expect, it } from 'vitest';
import { App, type PluginModule } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 内置事件的两节（见 types/events.ts 的「屏障 / 通知」JSDoc）的可观测行为：
//   - 通知（plugin:* / plugins:changed / service:*）：发射方不等监听器——慢监听器不挡状态机推进，
//     监听器里 await plugins.idle() 不死锁。
//   - 屏障（app:* / ready）：发射方等监听器全部返回后才推进下一步。
// 调用形式由 architecture.test.ts 静态守，这里守行为。
// ════════════════════════════════════════════════════════════

function silentApp(): App {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
}

const plugin = (name: string, apply: PluginModule['apply'] = () => {}): PluginModule => ({ name, apply });

/** 挂起的操作在限时内落定则 true——死锁不该表现成用例超时，而是明确的断言失败 */
const settlesWithin = (op: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([op.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);

describe('内置事件：通知节不等监听器', () => {
  it('plugin:loaded 的慢监听器不挡住后续插件的激活', async () => {
    const app = silentApp();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const applied: string[] = [];
    app.ctx.on('plugin:loaded', async name => {
      if (name === 'first') await gate;
    });

    // 两个 register 紧挨着发出：在飞期间的请求合并排队，两个插件在同一趟 flight 的同一轮里先后激活。
    // register() 只保证请求已受理（可能只是排进了在飞的 flight），落定与否要看 idle()。
    void app.plugins.register(plugin('first', () => void applied.push('first')));
    await app.plugins.register(plugin('second', () => void applied.push('second')));
    expect(await settlesWithin(app.plugins.idle(), 200), 'flight 在等 plugin:loaded 的监听器').toBe(true);
    expect(applied).toEqual(['first', 'second']);

    release();
    await app.stop();
  });

  it('plugin:loaded 监听器里 await plugins.idle() 不死锁', async () => {
    const app = silentApp();
    let settled = false;
    app.ctx.on('plugin:loaded', async () => {
      await app.plugins.idle();
      settled = true;
    });

    await app.plugins.register(plugin('p'));
    expect(await settlesWithin(app.plugins.idle(), 200), '监听器等 idle 排干、flight 等监听器返回——互等').toBe(true);
    await new Promise<void>(r => setTimeout(r, 0));
    expect(settled, 'flight 排干后监听器应已落定').toBe(true);
    await app.stop();
  });
});

describe('内置事件：屏障节等监听器', () => {
  it('start() 的三个屏障按序推进，每一步都等上一步的监听器全部完成', async () => {
    const app = silentApp();
    const order: string[] = [];
    const slow = (tag: string) => async () => {
      await new Promise<void>(r => setTimeout(r, 15));
      order.push(tag);
    };
    app.ctx.on('app:starting', slow('starting'));
    app.ctx.on('ready', slow('ready'));
    app.ctx.on('app:started', () => void order.push('started'));

    await app.start();
    expect(order).toEqual(['starting', 'ready', 'started']);
    await app.stop();
  });

  it('app:stopping 的监听器全部完成后才拆插件', async () => {
    const app = silentApp();
    const order: string[] = [];
    app.ctx.on('app:stopping', async () => {
      await new Promise<void>(r => setTimeout(r, 15));
      order.push('stopping');
    });
    await app.plugins.register(
      plugin('p', ctx => {
        ctx.onDispose(() => void order.push('disposed'));
      }),
    );

    await app.stop();
    expect(order).toEqual(['stopping', 'disposed']);
  });
});
