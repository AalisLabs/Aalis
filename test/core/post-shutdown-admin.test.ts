import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';

// 停机后管理动作：disposed 单向终态，register / enable / updateConfig / bounce 一律 false。
// app:stopping 时停机已冻结，disable / unload / bounce 汇入停机计划，不得抢关提供者。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

interface Store {
  save(data: string): void;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function capturingApp(opts?: { disposeTimeoutMs?: number }): { app: App; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: (...a: unknown[]) => void warnings.push(`debug:${a.map(String).join(' ')}`),
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(`error:${a.map(String).join(' ')}`),
    child: () => logger,
  };
  const app = new App({
    name: 'T',
    logLevel: 'error',
    logger,
    disposeTimeoutMs: opts?.disposeTimeoutMs,
  });
  apps.push(app);
  return { app, warnings };
}

async function idleSettles(app: App): Promise<void> {
  const settled = await Promise.race([
    app.plugins.idle().then(() => true),
    new Promise<boolean>(r => setTimeout(() => r(false), 200)),
  ]);
  expect(settled, 'idle() 必须落定').toBe(true);
}

function noActivating(app: App): void {
  expect(
    app.plugins
      .getStatus()
      .filter(s => s.state === 'activating')
      .map(s => s.instanceId),
    '注册表不得残留 activating',
  ).toEqual([]);
}

async function stopWithin(app: App, ms = 2000): Promise<'ok' | 'hung'> {
  return Promise.race([
    app.stop().then(() => 'ok' as const),
    new Promise<'hung'>(r => setTimeout(() => r('hung'), ms)),
  ]);
}

async function stoppedWithDisposed(name: string): Promise<{ app: App; warnings: string[] }> {
  const { app, warnings } = capturingApp();
  await app.plugin(definePlugin({ name, apply() {} }));
  await app.plugins.idle();
  expect(app.plugins.getPlugin(name)?.state).toBe('active');
  await app.stop();
  expect(app.plugins.getPlugin(name)?.state).toBe('disposed');
  return { app, warnings };
}

async function storeAndWriter(
  app: App,
  storeName: string,
  onWriterDrain?: () => void | Promise<void>,
): Promise<{ saved: string[]; log: string[]; store: ReturnType<typeof defineService<Store>> }> {
  const saved: string[] = [];
  const log: string[] = [];
  const store = defineService<Store>(storeName);
  await app.plugin(
    definePlugin({
      name: 'store',
      uses: { provide, lifecycle },
      provides: [store],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(store, {
          save(data) {
            if (closed) throw new Error('store 已关闭');
            saved.push(data);
          },
        });
        lifecycle.onDispose(() => {
          closed = true;
          log.push('store-closed');
        });
      },
    }),
  );
  await app.plugin(
    definePlugin({
      name: 'writer',
      uses: { store, lifecycle },
      apply({ store, lifecycle }) {
        lifecycle.onDrain(async () => {
          if (onWriterDrain) await onWriterDrain();
          store.require().save('writer:last');
          log.push('writer-drain');
        });
      },
    }),
  );
  await app.plugins.idle();
  expect(app.plugins.getPlugin('store')?.state).toBe('active');
  expect(app.plugins.getPlugin('writer')?.state).toBe('active');
  return { saved, log, store };
}

describe('停机后管理动作', () => {
  it('register 新定义：不抛、返回 false、注册表无该 id、记 debug', async () => {
    const { app, warnings } = await stoppedWithDisposed('p');
    warnings.length = 0;
    const log: string[] = [];
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.register(
        definePlugin({
          name: 'after-stop',
          apply() {
            log.push('after-stop.apply');
          },
        }),
      );
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, apply: log, state: app.plugins.getPlugin('after-stop')?.state }).toEqual({
      ok: false,
      threw: false,
      apply: [],
      state: undefined,
    });
    expect(
      warnings.some(x => x.startsWith('debug:') && x.includes('after-stop') && x.includes('停机')),
      warnings.join(' | '),
    ).toBe(true);
  });

  it('enable 已 disposed：不抛、返回 false，仍为 disposed', async () => {
    const { app } = await stoppedWithDisposed('x');
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.enable('x');
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, state: app.plugins.getPlugin('x')?.state }).toEqual({
      ok: false,
      threw: false,
      state: 'disposed',
    });
  });

  it('updateConfig 已 disposed：不抛、返回 false，仍为 disposed', async () => {
    const { app } = await stoppedWithDisposed('x');
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.updateConfig('x', { v: 1 });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, state: app.plugins.getPlugin('x')?.state }).toEqual({
      ok: false,
      threw: false,
      state: 'disposed',
    });
  });

  it('bounce 已 disposed：不抛、返回 false，仍为 disposed', async () => {
    const { app } = await stoppedWithDisposed('x');
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.bounce('x');
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, state: app.plugins.getPlugin('x')?.state }).toEqual({
      ok: false,
      threw: false,
      state: 'disposed',
    });
  });
});

describe('app:stopping 窗口', () => {
  it('监听器里 await disable 提供者：消费者 onDrain 仍能 require', async () => {
    const { app } = capturingApp();
    const { saved, log } = await storeAndWriter(app, 'psa-stop-dis');
    const { events: bus } = app.bind({ events });
    bus.on('app:stopping', async () => {
      log.push('stopping');
      await app.plugins.disable('store');
      log.push('disabled');
    });
    expect(await stopWithin(app)).toBe('ok');
    expect(saved, `log=${log.join('>')}`).toEqual(['writer:last']);
    expect(log.indexOf('stopping')).toBeLessThan(log.indexOf('writer-drain'));
  });

  it('监听器里 fire-and-forget unload 提供者：消费者 onDrain 仍能 require', async () => {
    const { app } = capturingApp();
    const { saved, log } = await storeAndWriter(app, 'psa-stop-ul');
    const { events: bus } = app.bind({ events });
    bus.on('app:stopping', () => {
      log.push('stopping');
      void app.plugins.unload('store');
    });
    expect(await stopWithin(app)).toBe('ok');
    expect(saved, `log=${log.join('>')}`).toEqual(['writer:last']);
  });

  it('监听器里 bounce 提供者：返回 false、不重建，停机计划仍关掉原实例', async () => {
    const { app, warnings } = capturingApp();
    const saved: string[] = [];
    const log: string[] = [];
    const store = defineService<Store>('psa-stop-bnc');
    let gen = 0;
    await app.plugin(
      definePlugin({
        name: 'store',
        uses: { provide, lifecycle },
        provides: [store],
        apply({ provide, lifecycle }) {
          const my = ++gen;
          let closed = false;
          provide(store, {
            save(data) {
              if (closed) throw new Error(`store#${my} 已关闭`);
              saved.push(`#${my}:${data}`);
            },
          });
          lifecycle.onDispose(() => {
            closed = true;
            log.push(`closed#${my}`);
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'writer',
        uses: { store, lifecycle },
        apply({ store, lifecycle }) {
          lifecycle.onDrain(() => {
            log.push('writer-drain');
            store.require().save('writer:last');
          });
        },
      }),
    );
    await app.plugins.idle();
    const { events: bus } = app.bind({ events });
    let bounced: boolean | undefined;
    bus.on('app:stopping', async () => {
      bounced = await app.plugins.bounce('store');
    });
    expect(await stopWithin(app)).toBe('ok');
    expect(bounced).toBe(false);
    expect(
      warnings.some(x => x.startsWith('debug:') && x.includes('store') && x.includes('停机中不重建')),
      warnings.join(' | '),
    ).toBe(true);
    expect(gen).toBe(1);
    expect(app.plugins.getPlugin('store')?.state).toBe('disposed');
    expect(log.indexOf('writer-drain'), `log=${log.join('>')}`).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('closed#1'), `log=${log.join('>')}`).toBeGreaterThan(log.indexOf('writer-drain'));
    expect(
      saved.some(x => x.endsWith('writer:last')),
      `saved=${saved.join(',')}`,
    ).toBe(true);
  });

  it('监听器里 register：返回 false，apply 不执行', async () => {
    const { app, warnings } = capturingApp();
    await app.plugin(definePlugin({ name: 'p', apply() {} }));
    await app.plugins.idle();
    const { events: bus } = app.bind({ events });
    let accepted: boolean | undefined;
    let apply = 0;
    bus.on('app:stopping', async () => {
      accepted = await app.plugin(
        definePlugin({
          name: 'latecomer',
          apply() {
            apply++;
          },
        }),
      );
    });
    expect(await stopWithin(app)).toBe('ok');
    expect(accepted).toBe(false);
    expect(apply).toBe(0);
    expect(app.plugins.getPlugin('latecomer')).toBeUndefined();
    expect(
      warnings.some(x => x.startsWith('debug:') && x.includes('latecomer') && x.includes('停机')),
      warnings.join(' | '),
    ).toBe(true);
  });

  it('监听器里 provide：按冻结语义 warn 忽略，不抛', async () => {
    const { app, warnings } = capturingApp();
    const extra = defineService<{ n: number }>('psa-late-prov');
    const { provide: hostProvide } = app.bind({ provide });
    const { events: bus } = app.bind({ events });
    let threw: string | false = false;
    bus.on('app:stopping', () => {
      try {
        hostProvide(extra, { n: 1 });
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
    });
    expect(await stopWithin(app)).toBe('ok');
    expect(threw).toBe(false);
    expect(
      warnings.some(x => x.includes('已 dispose') && x.includes('provide')),
      warnings.join(' | '),
    ).toBe(true);
  });
});

describe('停机中 unload 快路径', () => {
  it('stopAll 进行中外部 await unload 再放 drainHold：交接仍在、unload 立即 true、不撞 disposeTimeout', async () => {
    // retireBatch 先把条目标 disposed。若 unload 先 join #closing，会与仍持 hold 的
    // 消费者 drain 互等：writer:last 丢，撞 disposeTimeoutMs。shuttingDown 快路径须在
    // disposed-join 之前，立即 true；beginShutdown 已把整棵树冻进计划，不再发起 disposeAsync。
    const { app, warnings } = capturingApp({ disposeTimeoutMs: 800 });
    const hold = deferred();
    const entered = deferred();
    const saved = (
      await storeAndWriter(app, 'psa-unload-hold', async () => {
        entered.resolve();
        await hold.promise;
      })
    ).saved;

    const stopping = app.stop();
    await entered.promise;
    expect(app.plugins.getPlugin('store')?.state, 'retireBatch 在 closeActivations 之前就把条目标 disposed').toBe(
      'disposed',
    );

    const t0 = Date.now();
    const unloaded = await app.plugins.unload('store');
    const unloadMs = Date.now() - t0;
    hold.resolve();
    const outcome = await Promise.race([stopping.then(() => 'ok' as const), sleep(4000).then(() => 'hung' as const)]);

    expect({ outcome, unloaded, saved }).toEqual({ outcome: 'ok', unloaded: true, saved: ['writer:last'] });
    expect(unloadMs, `unload 应立即返回，实际 ${unloadMs}ms`).toBeLessThan(400);
    expect(
      warnings.filter(x => x.includes('超过 800ms') || x.includes('等待在飞拆卸超过')),
      warnings.join(' | '),
    ).toEqual([]);
  });
});
