import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type AppOptions,
  createApp,
  definePlugin,
  events,
  type Logger,
  lifecycle,
} from '../../packages/core/src/index.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// App 外壳上几处此前没有用例守住的可观测行为：createApp 工厂、事件监听器抛错的告警文案、
// 启动横幅的版本段、restart 在有无重启策略时的两种形状（策略拿到的 stop 与 rollback）。
// ════════════════════════════════════════════════════════════

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

const baseConfig = (name = 'T'): AppOptions['config'] => ({ name, logLevel: 'error', plugins: {} });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function track<T extends App>(app: T): T {
  apps.push(app);
  return app;
}

describe('createApp 工厂', () => {
  it('返回按传入选项构造的 App：配置、注入的 logger 与版本号都生效', async () => {
    const log = recordingLogger();
    const app = track(createApp({ config: baseConfig('Factory'), logger: log, version: '0.0.0-test' }));

    expect(app).toBeInstanceOf(App);
    expect(app.config.get('name')).toBe('Factory');
    expect(app.logger).toBe(log);
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

describe('启动横幅', () => {
  it('宿主注入 version：横幅带「Core <版本>」段', () => {
    const log = recordingLogger();
    track(new App({ config: baseConfig('Banner'), logger: log, version: '1.2.3' }));
    expect(log.messages('info')).toEqual(['Aalis Core 1.2.3 - Banner']);
  });

  it('未注入 version：横幅省略版本段，只留「Core」', () => {
    const log = recordingLogger();
    track(new App({ config: baseConfig('Banner'), logger: log }));
    expect(log.messages('info')).toEqual(['Aalis Core - Banner']);
  });
});

describe('事件监听器抛错的告警', () => {
  it('经 events 能力登记的监听器：告警点名来源插件实例 id，错误对象原样附上，其余监听器照跑', async () => {
    const log = recordingLogger();
    const app = track(new App({ config: baseConfig(), logger: log }));
    const boom = new Error('boom');
    const reached: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'bad-listener',
        uses: { events },
        apply({ events }) {
          events.on('app:starting', () => {
            throw boom;
          });
          events.on('app:starting', () => void reached.push('after'));
        },
      }),
    );
    await app.plugins.idle();

    await app.start();

    const warns = log.records.filter(r => r.level === 'warn');
    expect(warns.map(r => r.message)).toEqual(['事件 "app:starting" 的监听器抛错（已隔离，来自 bad-listener）:']);
    expect(warns[0].args).toEqual([boom]);
    expect(reached).toEqual(['after']);
  });

  it('无归属的监听器（直接挂在总线上、不经 events 能力）：告警不带来源段', async () => {
    const log = recordingLogger();
    const app = track(createInspectableApp({ config: baseConfig(), logger: log }));
    const boom = new Error('ownerless');
    // 公开面拿不到总线；core 内部确有不带 owner 的订阅（binding 的提供者跟随），这里白盒复现同一形状
    activationHost(app).runtime.events.on('app:starting', () => {
      throw boom;
    });

    await app.start();

    const warns = log.records.filter(r => r.level === 'warn');
    expect(warns.map(r => r.message)).toEqual(['事件 "app:starting" 的监听器抛错（已隔离）:']);
    expect(warns[0].args).toEqual([boom]);
  });
});

describe('App.restart', () => {
  it('未注入 restartStrategy：同步抛「不可用」，不发 app:restarting、不停机', async () => {
    const log = recordingLogger();
    const app = track(new App({ config: baseConfig(), logger: log }));
    const { events: bus } = app.bind({ events });
    const seen: string[] = [];
    bus.on('app:restarting', () => void seen.push('restarting'));
    bus.on('app:stopping', () => void seen.push('stopping'));

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
        config: baseConfig(),
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
    bus.on('app:restarting', () => void order.push('restarting'));
    bus.on('app:stopping', () => void order.push('stopping'));
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDispose(() => void order.push('disposed'));
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
