import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type AppOptions,
  createApp,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

// App 外壳的可观测行为：createApp 工厂、注入的 logger 出错、启动横幅、监听器抛错的告警、restart，以及启动 / 停机 / 重启互斥。

type Level = 'debug' | 'info' | 'warn' | 'error';
type LogRecord = { level: Level; message: string; args: unknown[] };

/** 记录全部日志的 Logger；child 共用同一份记录，便于按条断言 */
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

const base = (name = 'T'): Pick<AppOptions, 'name' | 'logLevel'> => ({ name, logLevel: 'error' });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function track<T extends App>(app: T): T {
  apps.push(app);
  return app;
}

describe('createApp 工厂', () => {
  it('返回按传入选项构造的 App：名称、注入的 logger 与版本号都生效', async () => {
    const log = recordingLogger();
    const app = track(createApp({ ...base('Factory'), logger: log, version: '0.0.0-test' }));

    expect(app).toBeInstanceOf(App);
    app.logger.warn('经 app.logger 写入');
    expect(log.messages('warn')).toEqual(['经 app.logger 写入']);
    expect(log.messages('info')[0]).toBe('Aalis Core 0.0.0-test - Factory');

    // 工厂产物是完整可用的 App：注册即激活，停机走完整路径
    const applied: string[] = [];
    await app.plugin(definePlugin({ name: 'p', apply: () => void applied.push('p') }));
    await app.plugins.idle();
    expect(applied).toEqual(['p']);
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    await app.stop();
    expect(log.messages('info')).toContain('已停止');
  });
});

describe('注入的 logger 出错', () => {
  it('同步抛错、返回被拒的 Promise、child 派生失败：管理动作与停机照常返回，idle 落定，不外泄成未处理拒绝', async () => {
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => void escaped.push(reason);
    process.on('unhandledRejection', onEscape);
    try {
      const boom = (): void => {
        throw new Error('sink failed');
      };
      const logger: Logger = {
        debug: boom,
        info: boom,
        warn: boom,
        error: () => Promise.reject(new Error('sink rejected')),
        child: () => {
          throw new Error('child failed');
        },
      };
      const app = track(new App({ name: 'T', logger }));
      const dep = defineService<object>('zz-quiet-logger-dep');
      let disposed = 0;
      const plugin = definePlugin({
        name: 'p',
        uses: { provide, lifecycle },
        provides: [dep],
        apply({ provide, lifecycle }) {
          provide.use(dep, {});
          lifecycle.use.onDispose(() => void disposed++);
        },
      });
      const broken = definePlugin({
        name: 'broken',
        apply() {
          throw new Error('apply failed');
        },
      });
      expect(await app.pluginAll([{ definition: plugin }, { definition: broken }])).toEqual([true, true]);
      expect(await app.plugins.disable('p')).toBe(true);
      expect(await app.plugins.enable('p')).toBe(true);
      expect(await app.plugins.unload('p')).toBe(true);
      await app.plugins.idle();
      await app.stop();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect({ disposed, broken: app.plugins.getPlugin('broken')?.state, escaped }).toEqual({
        disposed: 2,
        broken: 'error',
        escaped: [],
      });
    } finally {
      process.off('unhandledRejection', onEscape);
    }
  });
});

describe('启动横幅', () => {
  it('宿主注入 version：横幅带「Core <版本>」段', () => {
    const log = recordingLogger();
    track(new App({ ...base('Banner'), logger: log, version: '1.2.3' }));
    expect(log.messages('info')).toEqual(['Aalis Core 1.2.3 - Banner']);
  });

  it('未注入 version：横幅省略版本段，只留「Core」', () => {
    const log = recordingLogger();
    track(new App({ ...base('Banner'), logger: log }));
    expect(log.messages('info')).toEqual(['Aalis Core - Banner']);
  });

  it('未注入 name：横幅用默认名 Aalis', () => {
    const log = recordingLogger();
    track(new App({ logger: log }));
    expect(log.messages('info')).toEqual(['Aalis Core - Aalis']);
  });
});

describe('事件监听器抛错的告警', () => {
  it('经 events 能力登记的监听器：告警点名来源插件实例 id，错误对象原样附上，其余监听器照跑', async () => {
    const log = recordingLogger();
    const app = track(new App({ ...base(), logger: log }));
    const boom = new Error('boom');
    const reached: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'bad-listener',
        uses: { events },
        apply({ events }) {
          events.use.on('app:started', () => {
            throw boom;
          });
          events.use.on('app:started', () => void reached.push('after'));
        },
      }),
    );
    await app.plugins.idle();

    await app.start();

    const warns = log.records.filter(r => r.level === 'warn');
    expect(warns.map(r => r.message)).toEqual(['事件 "app:started" 的监听器抛错（已隔离，来自 bad-listener）:']);
    expect(warns[0].args).toEqual([boom]);
    expect(reached).toEqual(['after']);
  });

  it('无归属的监听器（直接挂在总线上、不经 events 能力）：告警不带来源段', async () => {
    const log = recordingLogger();
    const app = track(createInspectableApp({ ...base(), logger: log }));
    const boom = new Error('ownerless');
    // 公开面拿不到总线；core 内部确有不带 owner 的订阅（binding 的提供者跟随），这里白盒复现同一形状
    activationHost(app).runtime.events.on('app:started', () => {
      throw boom;
    });

    await app.start();

    const warns = log.records.filter(r => r.level === 'warn');
    expect(warns.map(r => r.message)).toEqual(['事件 "app:started" 的监听器抛错（已隔离）:']);
    expect(warns[0].args).toEqual([boom]);
  });
});

describe('App.restart', () => {
  it('未注入 restartStrategy：同步抛「不可用」，不发 app:restarting、不停机', async () => {
    const log = recordingLogger();
    const app = track(new App({ ...base(), logger: log }));
    const { events: bus } = app.bind({ events });
    const seen: string[] = [];
    bus.use.on('app:restarting', () => void seen.push('restarting'));
    bus.use.on('app:stopping', () => void seen.push('stopping'));

    expect(() => app.restart()).toThrow('App.restart() 不可用：未注入 restartStrategy。');

    await new Promise<void>(r => setTimeout(r, 0));
    expect(seen).toEqual([]);
    expect(log.messages('info')).not.toContain('正在停止...');
  });

  it('注入策略：先发 app:restarting 再交控制；core 自己不停机，交给策略的 stop 停的是本应用，rollback 原样透传', async () => {
    const log = recordingLogger();
    const order: string[] = [];
    let received: { stop: () => Promise<void>; rollback?: unknown } | undefined;
    let handed!: () => void;
    const handedOver = new Promise<void>(r => {
      handed = r;
    });
    const app = track(
      new App({
        ...base(),
        logger: log,
        restartStrategy: {
          restart(opts) {
            order.push('strategy');
            received = opts;
            handed();
          },
        },
      }),
    );
    const { events: bus } = app.bind({ events });
    bus.use.on('app:restarting', () => void order.push('restarting'));
    bus.use.on('app:stopping', () => void order.push('stopping'));
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

    const token = { snapshot: 'placeholder' };
    app.restart({ rollback: token });
    await handedOver;

    expect(received?.rollback).toBe(token);
    // 何时停由策略决定：交出控制时应用仍在运行
    expect(order).toEqual(['restarting', 'strategy']);
    expect(app.plugins.getPlugin('p')?.state).toBe('active');

    const stopping = received!.stop();
    // 交出的 stop 就是本应用的单飞停机：与直接调 app.stop() 是同一个 Promise
    expect(app.stop()).toBe(stopping);
    await stopping;
    expect(order).toEqual(['restarting', 'strategy', 'stopping', 'disposed']);
    expect(log.messages('info')).toContain('已停止');
  });
});

describe('启动与停机、重启互斥', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  it('重复调用 start 返回同一个 Promise，启动事件只发一次', async () => {
    const app = track(new App(base()));
    let ready = 0;
    app.bind({ events }).events.use.on('app:ready', () => void ready++);
    const first = app.start();
    expect(app.start()).toBe(first);
    await first;
    expect(ready).toBe(1);
  });

  it('停机开始后调 start：记 warn 后直接返回，不跑启动', async () => {
    const log = recordingLogger();
    const app = track(new App({ ...base(), logger: log }));
    await app.stop();
    await app.start();
    expect(log.messages('warn')).toEqual(['应用已开始停机，忽略 start()']);
    expect(log.messages('info')).not.toContain('正在启动...');
  });

  it('启动途中被 stop：进行中的 start 照常落定，不再发 app:started', async () => {
    const app = track(new App(base()));
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { events, lifecycle },
        apply({ events, lifecycle }) {
          events.use.on('app:started', () => void seen.push('started'));
          // 收尾期间监听还在：停机没走完时发出的 app:started 会打到它
          lifecycle.use.onDrain(() => sleep(30));
        },
      }),
    );
    await app.plugins.idle();
    let stopping: Promise<void> | undefined;
    app.bind({ events }).events.use.on('app:ready', () => {
      stopping = app.stop();
    });
    await app.start();
    await stopping;
    expect(seen).toEqual([]);
  });

  it('重启已受理后再调 restart 记 debug 后返回，停机开始后也是：只发一次 app:restarting、只调一次策略', async () => {
    let calls = 0;
    let received: { stop: () => Promise<void> } | undefined;
    const log = recordingLogger();
    const app = track(
      new App({
        ...base(),
        logger: log,
        restartStrategy: {
          restart(opts) {
            calls++;
            received = opts;
          },
        },
      }),
    );
    let restarting = 0;
    app.bind({ events }).events.use.on('app:restarting', () => void restarting++);
    app.restart();
    app.restart();
    await sleep(5);
    const stopping = received!.stop();
    expect(() => app.restart()).not.toThrow();
    await stopping;
    expect({ calls, restarting }).toEqual({ calls: 1, restarting: 1 });
    expect(log.messages('debug').filter(m => m.startsWith('restart'))).toEqual([
      'restart: 已受理过一次，本次忽略',
      'restart: 已受理过一次，本次忽略',
    ]);
  });

  it('未受理过重启、停机已开始：restart 抛错', () => {
    const app = track(new App({ ...base(), restartStrategy: { restart() {} } }));
    void app.stop();
    expect(() => app.restart()).toThrow('App.restart() 不可用：应用已开始停机。');
  });
});
