import { afterEach, describe, expect, it } from 'vitest';
import { hostRestart, type RestartRollback } from '../../packages/api-host-restart/src/index.js';
import { App, definePlugin, type Logger, lifecycle, optional, provide } from '../../packages/core/src/index.js';
import { createHostRestart, type RestartStrategy } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 宿主的 host-restart 服务：core 没有重启的概念，重启由宿主以服务提供。这里钉住它受理一次重启请求的行为：
// 下一个微任务里把控制交给策略、交出的 stop 停的是本应用、只受理一次、停机已开始时拒绝、策略出错只记日志。
// 怎么换新进程是策略的事，见 respawn-strategy.test.ts。
// ════════════════════════════════════════════════════════════

type Level = 'debug' | 'info' | 'warn' | 'error';
type LogRecord = { level: Level; message: string; args: unknown[] };

function recordingLogger(): Logger & { records: LogRecord[]; messages(level: Level): string[] } {
  const records: LogRecord[] = [];
  const at =
    (level: Level) =>
    (message: string, ...args: unknown[]) =>
      void records.push({ level, message, args });
  const logger = {
    records,
    messages: (level: Level) => records.filter(r => r.level === level).map(r => r.message),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world(strategy: RestartStrategy) {
  const log = recordingLogger();
  const app = new App({ name: 'T', logLevel: 'error', logger: log });
  apps.push(app);
  const restart = createHostRestart(app, strategy);
  return { app, log, restart };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('createHostRestart', () => {
  it('下一个微任务里把控制交给策略，不在调用方的栈上；自己不停机，交出的 stop 停的是本应用，rollback 原样交给策略', async () => {
    const order: string[] = [];
    let received: Parameters<RestartStrategy['restart']>[0] | undefined;
    let handed!: () => void;
    const handedOver = new Promise<void>(r => {
      handed = r;
    });
    const { app, log, restart } = world({
      restart(opts) {
        order.push('strategy');
        received = opts;
        handed();
      },
    });
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onDispose(() => void order.push('disposed'));
        },
      }),
    );
    await app.plugins.idle();

    const rollback: RestartRollback = { reason: '<来由>', restore: [] };
    restart.restart({ rollback });
    expect(order, 'restart() 返回时策略还没被调').toEqual([]);
    await handedOver;

    expect(received?.rollback).toBe(rollback);
    // 何时停由策略决定：交出控制时应用仍在运行
    expect(order).toEqual(['strategy']);
    expect(app.stopping).toBe(false);
    expect(app.plugins.getPlugin('p')?.state).toBe('active');

    const stopping = received!.stop();
    expect(app.stopping, '策略调交给它的 stop 之后即为 true').toBe(true);
    // 交出的 stop 就是本应用的单飞停机：与直接调 app.stop() 是同一个 Promise
    expect(app.stop()).toBe(stopping);
    await stopping;
    expect(order).toEqual(['strategy', 'disposed']);
    expect(log.messages('info')).toContain('已停止');
  });

  it.each([
    [
      '同步抛错',
      () => {
        throw new Error('策略坏了');
      },
    ],
    ['返回被拒的 Promise', () => Promise.reject(new Error('策略坏了'))],
  ])('策略的 restart %s：记 error「restart 失败」并附上原因，不外泄成未处理拒绝', async (_, failing) => {
    const { log, restart } = world({ restart: failing });
    restart.restart();
    await sleep(0);
    const failed = log.records.find(r => r.level === 'error' && r.message === 'restart 失败:');
    expect((failed?.args[0] as Error | undefined)?.message).toBe('策略坏了');
  });

  it('已受理后再调记 debug 后返回，停机开始后也是：只调一次策略', async () => {
    let calls = 0;
    let received: { stop: () => Promise<void> } | undefined;
    const { log, restart } = world({
      restart(opts) {
        calls++;
        received = opts;
      },
    });
    restart.restart();
    restart.restart();
    await sleep(5);
    const stopping = received!.stop();
    expect(() => restart.restart()).not.toThrow();
    await stopping;
    expect(calls).toBe(1);
    expect(log.messages('debug').filter(m => m.startsWith('restart'))).toEqual([
      'restart: 已受理过一次，本次忽略',
      'restart: 已受理过一次，本次忽略',
    ]);
  });

  it('未受理过、停机已开始：抛错，不调策略', async () => {
    let calls = 0;
    const { app, restart } = world({ restart: () => void calls++ });
    void app.stop();
    expect(() => restart.restart()).toThrow('重启不可用：应用已开始停机');
    await sleep(0);
    expect(calls).toBe(0);
  });
});

describe('host-restart 服务', () => {
  it('宿主在根上提供之后，插件经可选依赖调到它；没有提供时 present 为 false', async () => {
    let calls = 0;
    const { app, restart } = world({ restart: () => void calls++ });
    const seen: boolean[] = [];
    let ask!: () => void;
    await app.plugin(
      definePlugin({
        name: 'asker',
        uses: { restart: optional(hostRestart) },
        apply({ restart }) {
          seen.push(restart.present);
          ask = () => restart.use.restart();
        },
      }),
    );
    await app.plugins.idle();
    expect(seen).toEqual([false]);
    expect(() => ask()).toThrow('不可用');

    app.bind({ provide }).provide.use(hostRestart, restart, { exclusive: true });
    ask();
    await sleep(0);
    expect(calls).toBe(1);
  });
});
