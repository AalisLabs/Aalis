import { afterEach, describe, expect, it } from 'vitest';
import { App, type AppOptions, definePlugin, events, type Logger } from '../../packages/core/src/index.js';
import { EventBus } from '../../packages/core/src/primitives/events.js';

// ════════════════════════════════════════════════════════════
// 屏障事件（app:*）的单个监听器至多等 slowThresholdMs：超过即 warn 点名登记者、不再等它，转向下一个监听器，
// 生命周期方法照常推进；它之后才到的拒绝照常经 onHandlerError 上报。通知事件不受这个上限约束。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const never = () => new Promise<void>(() => {});

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${ms}ms 内未落定: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function world(options: Partial<AppOptions> = {}) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logger, slowThresholdMs: 30, ...options });
  apps.push(app);
  return { app, host: app.bind({ events }), warns };
}

describe('屏障监听器超时', () => {
  it('启动三个屏障各挂一个不返回的监听器：start 照常完成，逐个点名登记者，后面的监听器照常执行', async () => {
    const w = world();
    const ran: string[] = [];
    await w.app.plugin(
      definePlugin({
        name: 'hanging-plugin',
        uses: { events },
        apply({ events }) {
          events.on('app:ready', never);
          events.on('app:ready', () => void ran.push('ready'));
        },
      }),
    );
    await w.app.plugins.idle();
    w.host.events.on('app:starting', never);
    w.host.events.on('app:starting', () => void ran.push('starting'));
    w.host.events.on('app:started', never);
    w.host.events.on('app:started', () => void ran.push('started'));
    await within(w.app.start(), 2000, 'start');
    expect(ran).toEqual(['starting', 'ready', 'started']);
    expect(w.warns.filter(text => text.includes('未返回'))).toEqual([
      '事件 "app:starting" 的监听器超过 30ms 未返回（来自 root），不再等待，继续后续步骤',
      '事件 "app:ready" 的监听器超过 30ms 未返回（来自 hanging-plugin），不再等待，继续后续步骤',
      '事件 "app:started" 的监听器超过 30ms 未返回（来自 root），不再等待，继续后续步骤',
    ]);
  });

  it('app:stopping 的监听器不返回：stop 照常完成', async () => {
    const w = world();
    const ran: string[] = [];
    w.host.events.on('app:stopping', never);
    w.host.events.on('app:stopping', () => void ran.push('stopping'));
    await within(w.app.stop(), 2000, 'stop');
    expect(ran).toEqual(['stopping']);
    expect(w.warns).toContain('事件 "app:stopping" 的监听器超过 30ms 未返回（来自 root），不再等待，继续后续步骤');
  });

  it('app:restarting 的监听器不返回：照常把控制交给重启策略', async () => {
    let restarted = false;
    const w = world({
      restartStrategy: {
        restart: () => {
          restarted = true;
        },
      },
    });
    w.host.events.on('app:restarting', never);
    w.app.restart();
    for (let i = 0; i < 200 && !restarted; i++) await sleep(5);
    expect(restarted).toBe(true);
  });

  it('超时之后才到的拒绝照常上报为监听器抛错', async () => {
    const w = world();
    w.host.events.on('app:ready', async () => {
      await sleep(60);
      throw new Error('迟到的失败');
    });
    await within(w.app.start(), 2000, 'start');
    for (let i = 0; i < 200 && !w.warns.some(text => text.includes('抛错')); i++) await sleep(5);
    expect(w.warns).toContain('事件 "app:ready" 的监听器抛错（已隔离，来自 root）: Error: 迟到的失败');
  });

  it('阈值为 0：屏障照旧逐个等到监听器返回，不告警', async () => {
    const w = world({ slowThresholdMs: 0 });
    const ran: string[] = [];
    w.host.events.on('app:ready', async () => {
      await sleep(50);
      ran.push('slow');
    });
    w.host.events.on('app:ready', () => void ran.push('next'));
    await w.app.start();
    expect(ran).toEqual(['slow', 'next']);
    expect(w.warns).toEqual([]);
  });
});

describe('EventBus 的等待上限', () => {
  it('上限按事件给出：没给上限的事件照旧等到底；给了上限的超时后上报并继续', async () => {
    const bus = new EventBus();
    const slow: string[] = [];
    bus.handlerLimit = event => (event.startsWith('app:') ? 10 : undefined);
    bus.onHandlerSlow = (event, limit, contextId) => void slow.push(`${event}:${limit}:${contextId}`);
    const order: string[] = [];
    bus.on('plugin:loaded', async () => {
      await sleep(40);
      order.push('loaded 监听器返回');
    });
    await bus.emit('plugin:loaded', 'x');
    order.push('loaded emit 返回');
    bus.on('app:ready', () => sleep(40), Symbol('owner-id'));
    await bus.emit('app:ready');
    expect(order).toEqual(['loaded 监听器返回', 'loaded emit 返回']);
    expect(slow).toEqual(['app:ready:10:owner-id']);
  });

  it('只设上限、未设上报器：超时静默继续，不抛错', async () => {
    const bus = new EventBus();
    bus.handlerLimit = () => 10;
    bus.on('app:ready', never);
    await expect(within(bus.emit('app:ready'), 1000, 'emit')).resolves.toBeUndefined();
  });
});
