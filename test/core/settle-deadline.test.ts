// 关闭后不断续登的清理（清理里再登记一项、漏清的定时器一直往里登记）受同一个总时限：每段收口至多等
// disposeTimeoutMs，到点放弃剩下的并记 warn。只给每轮那一批限时的话，每一项都比上限短时一轮接一轮永不收口。
// 没有在飞工作的收口不设时限，不设定时器。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, definePlugin, type Logger, lifecycle } from '../../packages/core/src/index.js';
import { quietLogger } from '../../packages/core/src/infrastructure/logger.js';
import { Resources } from '../../packages/core/src/infrastructure/resources.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const cleanups: Array<() => void> = [];
const apps: App[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) stop();
  for (const app of apps.splice(0)) await app.stop();
});

function world() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ logger, disposeTimeoutMs: 100 });
  apps.push(app);
  return { app, warnings };
}

/** 至多等 ms：期间落定回 true */
const settlesWithin = (work: Promise<unknown>, ms: number) =>
  Promise.race([work.then(() => true), sleep(ms).then(() => false)]);

describe('关闭后续登的清理受同一个总时限', () => {
  it('清理里再登记一项异步清理：unload 在时限内落定，放弃时记 warn', async () => {
    const { app, warnings } = world();
    let rounds = 0;
    await app.plugin(
      definePlugin({
        name: 'settle-self',
        uses: { lifecycle },
        apply({ lifecycle }) {
          const again = async () => {
            await sleep(20);
            // 收口不设总时限时这条链永不收口；数到上限停手，免得阻塞测试进程
            if (++rounds < 150) lifecycle.use.onDispose(again);
          };
          lifecycle.use.onDispose(again);
        },
      }),
    );
    await app.plugins.idle();
    expect(await settlesWithin(app.plugins.unload('settle-self'), 1000)).toBe(true);
    expect(rounds).toBeLessThan(150);
    expect(warnings.some(w => w.includes('放弃等待'))).toBe(true);
  });

  it('漏清的定时器一直往里登记清理：unload 与 stop 都在时限内落定', async () => {
    const { app, warnings } = world();
    await app.plugin(
      definePlugin({
        name: 'settle-timer',
        uses: { lifecycle },
        apply({ lifecycle }) {
          const timer = setInterval(() => lifecycle.use.onDispose(() => sleep(30)), 10);
          cleanups.push(() => clearInterval(timer));
        },
      }),
    );
    await app.plugins.idle();
    await sleep(50);
    expect(await settlesWithin(app.plugins.unload('settle-timer'), 1000)).toBe(true);
    expect(await settlesWithin(app.stop(), 1000)).toBe(true);
    expect(warnings.some(w => w.includes('放弃等待'))).toBe(true);
  });

  it('清理全是同步的、没有在飞工作：关闭不设定时器', async () => {
    const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
    const resources = new Resources('settle-idle', quietLogger(silent), {});
    resources.onDrain(() => {});
    resources.trackWithdrawal(() => {});
    resources.onDispose(() => {});
    const armed = vi.spyOn(globalThis, 'setTimeout');
    await resources.disposeAsync(100);
    const calls = armed.mock.calls.length;
    armed.mockRestore();
    expect(calls).toBe(0);
  });
});
