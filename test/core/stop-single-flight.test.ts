import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';

// stop() 单飞：重入汇入同一 Promise；app:stopping 派发期间再调不得无界重入。
// 已静置时先冻 shuttingDown 再 await idle，避免微任务窗口里 bounce 抢跑留下 pending 幽灵。
// 停机中 unload 在 disposed-join 之前汇入计划并立即 true。

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (...a: unknown[]) => void lines.push(`debug:${a.map(String).join(' ')}`),
    info: (...a: unknown[]) => void lines.push(`info:${a.map(String).join(' ')}`),
    warn: (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void lines.push(`error:${a.map(String).join(' ')}`),
    child: () => logger,
  };
  return { logger, lines };
}

function capturingApp(opts?: { disposeTimeoutMs?: number }): { app: App; lines: string[] } {
  const { logger, lines } = capturingLogger();
  return {
    app: new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      logger,
      disposeTimeoutMs: opts?.disposeTimeoutMs,
    }),
    lines,
  };
}

async function stopWithin(app: App, ms = 4000): Promise<'ok' | 'hung'> {
  return Promise.race([app.stop().then(() => 'ok' as const), sleep(ms).then(() => 'hung' as const)]);
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

interface Box {
  save(data: string): void;
}

describe('App.stop() 单飞与停机窗口', () => {
  it('并发两次 stop()：都落定、drain/close 只跑一遍，app:stopping 只发一次', async () => {
    const { app, lines } = capturingApp();
    apps.push(app);
    let drains = 0;
    let closes = 0;
    let stoppingEmits = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDrain(async () => {
            drains++;
            await sleep(40);
          });
          lifecycle.onDispose(() => {
            closes++;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    app.bind({ events }).events.on('app:stopping', () => {
      stoppingEmits++;
    });
    const [a, b] = await Promise.all([stopWithin(app, 4000), stopWithin(app, 4000)]);
    expect({ a, b, drains, closes, stoppingEmits }, lines.join(' | ')).toEqual({
      a: 'ok',
      b: 'ok',
      drains: 1,
      closes: 1,
      stoppingEmits: 1,
    });
  });

  it('app:stopping 里再 await stop()：不得无界重入，深度为 1 且落定', async () => {
    const { app, lines } = capturingApp();
    apps.push(app);
    const log: string[] = [];
    let stoppingDepth = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDrain(() => void log.push('drain'));
          lifecycle.onDispose(() => void log.push('dispose'));
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    app.bind({ events }).events.on('app:stopping', async () => {
      stoppingDepth++;
      log.push(`stopping#${stoppingDepth}`);
      // 深度护栏：未修时无界重入会把 worker 打到 OOM；有护栏才能把「深度≠1」写成红断言
      if (stoppingDepth > 8) return;
      await app.stop();
      log.push(`nested-returned#${stoppingDepth}`);
    });
    const outcome = await stopWithin(app, 3000);
    expect(
      { outcome, stoppingDepth, disposed: app.plugins.getPlugin('p')?.state },
      `无界重入会把进程打到 OOM；log=${log.join('>')} lines=${lines.join('|')}`,
    ).toEqual(expect.objectContaining({ outcome: 'ok', stoppingDepth: 1, disposed: 'disposed' }));
    expect(log).toContain('drain');
    expect(log).toContain('dispose');
    expect(
      lines.filter(x => !x.startsWith('debug:') && !x.startsWith('info:') && x.includes('stop')).length,
      `派发 app:stopping 期间重入应 warn 一次；lines=${lines.join(' | ')}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('stop 完成后再次 stop()：立即落定', async () => {
    const { app } = capturingApp();
    apps.push(app);
    await app.plugin(definePlugin({ name: 'p', apply() {} }));
    await app.plugins.idle();
    expect(await stopWithin(app)).toBe('ok');
    expect(await stopWithin(app, 500)).toBe('ok');
  });

  it('已静置时 Promise.resolve().then(bounce) 与 stop() 并行：bounce=false 且停机后 disposed', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    await app.plugin(
      definePlugin({
        name: 'store',
        configSchema: { n: { type: 'number', label: 'n', default: 0 } },
        uses: { config, lifecycle },
        apply({ lifecycle: lc }) {
          lc.onDispose(() => {});
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('store')?.state).toBe('active');

    const bounceP = Promise.resolve().then(() => app.plugins.updateConfig('store', { n: 1 }));
    const stopP = app.stop();
    const bounced = await bounceP;
    await stopP;
    const state = app.plugins.getPlugin('store')?.state;
    expect({ bounced, state }, '先冻 shuttingDown 再 await idle，微任务窗口内 bounce 必须被拒').toEqual({
      bounced: false,
      state: 'disposed',
    });
  });

  it('onDrain 窗口内 unload 提供者：立即 true 且消费者仍交接，不得 join 互等', async () => {
    const { app } = capturingApp({ disposeTimeoutMs: 800 });
    apps.push(app);
    const store = defineService<Box>('sf-drain-unl');
    const saved: string[] = [];
    const gate = deferred();
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
            gate.resolve();
            await sleep(80);
            store.require().save('writer:last');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('store')?.state).toBe('active');
    const stopping = app.stop();
    await gate.promise;
    const t0 = Date.now();
    const unloaded = await app.plugins.unload('store');
    const unloadMs = Date.now() - t0;
    const outcome = await Promise.race([stopping.then(() => 'ok' as const), sleep(4000).then(() => 'hung' as const)]);
    expect({ outcome, unloaded, saved }, 'unload 应立即 true 且不得把 writer 交接拖过 disposeTimeout').toEqual(
      expect.objectContaining({ outcome: 'ok', unloaded: true, saved: ['writer:last'] }),
    );
    expect(unloadMs, `unload join 了在飞计划 unloadMs=${unloadMs}`).toBeLessThan(400);
  });
});
