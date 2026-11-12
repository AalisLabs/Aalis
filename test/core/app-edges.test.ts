import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type AppOptions,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';

// App 外壳的可观测行为：构造选项、注入的 logger 出错、启动横幅，以及启动与停机互斥。

type Level = 'debug' | 'info' | 'warn' | 'error';
type LogRecord = { level: Level; message: string };

/** 记录全部日志的 Logger；child 共用同一份记录，便于按条断言 */
function recordingLogger(): Logger & { messages(level: Level): string[] } {
  const records: LogRecord[] = [];
  const at = (level: Level) => (message: string) => void records.push({ level, message });
  const logger = {
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

describe('构造选项', () => {
  it('名称、注入的 logger 与版本号都生效', async () => {
    const log = recordingLogger();
    const app = track(new App({ ...base('Factory'), logger: log, version: '0.0.0-test' }));

    app.logger.warn('经 app.logger 写入');
    expect(log.messages('warn')).toEqual(['经 app.logger 写入']);
    expect(log.messages('info')[0]).toBe('Aalis Core 0.0.0-test - Factory');

    // 注册即激活，停机走完整路径
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

describe('启动与停机互斥', () => {
  it('重复调用 start 返回同一个 Promise，就绪回调只跑一次', async () => {
    const app = track(new App(base()));
    let ready = 0;
    app.bind({ lifecycle }).lifecycle.use.onReady(() => void ready++);
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
});
