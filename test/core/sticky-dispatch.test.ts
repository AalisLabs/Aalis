import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, events, type Logger, provide } from '../../packages/core/src/index.js';

// sticky 事件（app:ready / app:started）派发进行中登记的监听器只收到一次：本轮遍历活表会访问到它，
// 不能再补发一次。OneBot 适配器在 app:ready 里建连接，重复送达会建出两条连接。只用公开 API。

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function mk(): App {
  const app = new App({ name: 'S1', logger: quiet, slowThresholdMs: 5_000 });
  apps.push(app);
  return app;
}

describe('sticky 事件派发中途登记的监听器只收到一次', () => {
  it('app:ready 派发中途 bounce：新实例的 app:ready 监听器应恰好一次', async () => {
    const app = mk();
    let readyCalls = 0;
    let generation = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { events },
        apply({ events }) {
          const gen = ++generation;
          events.on('app:ready', () => {
            if (gen === 2) readyCalls++;
          });
        },
      }),
    );
    await app.plugins.idle();
    // 宿主的 app:ready 监听器登记在插件之后也无妨：bounce 发生在它 await 期间
    let bounced: Promise<boolean> | undefined;
    app.bind({ events }).events.on('app:ready', async () => {
      bounced = app.plugins.bounce('p');
      await sleep(30);
    });
    await app.start();
    await bounced;
    await app.plugins.idle();
    await sleep(10);
    expect(generation).toBe(2);
    expect(readyCalls, '新实例的 app:ready 监听器调用次数').toBe(1);
  });

  it('不经 bounce：派发中途服务上线 → 依赖方此刻才激活，其 app:ready 监听器同样只收到一次', async () => {
    const app = mk();
    const S = defineService<{ v: number }>('zz-sticky-dispatch-svc');
    let readyCalls = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { s: S, events },
        apply({ events }) {
          events.on('app:ready', () => {
            readyCalls++;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('pending');
    const host = app.bind({ events, provide });
    // 模拟 webui-server 一类在 app:ready 里才 provide 的提供者；随后另一个监听器还在 await
    host.events.on('app:ready', () => {
      host.provide(S, { v: 1 });
    });
    host.events.on('app:ready', async () => {
      await sleep(30);
    });
    await app.start();
    await app.plugins.idle();
    await sleep(10);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    expect(readyCalls, '派发中途激活的消费者收到 app:ready 的次数').toBe(1);
  });

  it('app:started 同理：派发中途登记的监听器只该收到一次', async () => {
    const app = mk();
    const host = app.bind({ events });
    let lateCalls = 0;
    host.events.on('app:started', async () => {
      host.events.on('app:started', () => {
        lateCalls++;
      });
      await sleep(10);
    });
    await app.start();
    await sleep(10);
    expect(lateCalls).toBe(1);
  });

  it('派发结束后才登记：仍收到一次补发', async () => {
    const app = mk();
    await app.start();
    let calls = 0;
    app.bind({ events }).events.on('app:ready', () => {
      calls++;
    });
    await sleep(5);
    expect(calls).toBe(1);
  });

  it('派发中途该事件的监听表被清空后重建：新监听器仍应收到一次（标记须落在登记表上，按事件名标记会漏送）', async () => {
    const app = mk();
    let generation = 0;
    const calls: number[] = [];
    await app.plugin(
      definePlugin({
        name: 'solo',
        uses: { events },
        apply({ events }) {
          const gen = ++generation;
          events.on('app:ready', async () => {
            calls.push(gen);
            // 第一代在自己的监听器里 await 期间被 bounce：它是 app:ready 唯一的监听器，
            // 拆卸后该事件的登记表被整体删除，第二代登记进一张新表
            if (gen === 1) await sleep(40);
          });
        },
      }),
    );
    await app.plugins.idle();
    const bouncing = new Promise<boolean>(resolve => setTimeout(() => resolve(app.plugins.bounce('solo')), 10));
    await app.start();
    await bouncing;
    await app.plugins.idle();
    await sleep(10);
    expect(generation).toBe(2);
    expect(calls).toEqual([1, 2]);
  });

  it('派发中途登记、被访问前即退订：一次都不收到', async () => {
    const app = mk();
    const host = app.bind({ events });
    let calls = 0;
    host.events.on('app:ready', async () => {
      const off = host.events.on('app:ready', () => {
        calls++;
      });
      off();
      await sleep(5);
    });
    await app.start();
    await sleep(5);
    expect(calls).toBe(0);
  });
});
