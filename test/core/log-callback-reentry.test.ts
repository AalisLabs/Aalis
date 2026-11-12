import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  provide,
  services,
} from '../../packages/core/src/index.js';

// 宿主日志器的回调是外部代码。插件管理器在状态改到一半时记日志，回调若当场执行，里面发起的管理动作或 stop() 看到的是
// 半截状态，写下的状态随后又被这次改动剩下的步骤覆盖。管理器的日志推迟一个微任务再交给宿主，回调看到的是改完之后的状态。

type Box = { save(v?: string): void };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** 日志器：某一级的消息含 needle 时触发一次 action */
function hooked(level: 'debug' | 'info' | 'warn' | 'error', needle: string, action: () => void): Logger {
  let fired = false;
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  logger[level] = (message: string, ...args: unknown[]) => {
    if (fired || ![message, ...args].map(String).join(' ').includes(needle)) return;
    fired = true;
    action();
  };
  return logger;
}

function makeApp(logger: Logger, devMode = false): App {
  const app = new App({ name: 'T', logger, devMode });
  apps.push(app);
  return app;
}

const stopWithin = (app: App, ms: number): Promise<'ok' | 'timeout'> =>
  Promise.race([
    app.stop().then(() => 'ok' as const),
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms)),
  ]);

const state = (app: App, id: string) => app.plugins.getPlugin(id)?.state;

describe('日志回调里停用插件：不被这次改动写回', () => {
  it('依赖丢失记「停用插件」时停用它：之后仍停用，依赖恢复也不再激活', async () => {
    let app!: App;
    let disabling: Promise<boolean> | undefined;
    app = makeApp(
      hooked('info', '停用插件: c-a', () => {
        disabling = app.plugins.disable('c-a');
      }),
    );
    const dep = defineService<{ v: number }>('zz-log-dep');
    const host = app.bind({ provide });
    const off = host.provide.use(dep, { v: 1 });
    for (const name of ['c-a', 'c-b']) await app.plugin(definePlugin({ name, uses: { dep }, apply() {} }));
    await app.plugins.idle();
    off();
    await app.plugins.idle();
    expect(await disabling).toBe(true);
    await app.plugins.idle();
    expect(state(app, 'c-a')).toBe('disabled');
    host.provide.use(dep, { v: 2 });
    await app.plugins.idle();
    expect([state(app, 'c-a'), state(app, 'c-b')]).toEqual(['disabled', 'active']);
  });

  it('激活失败记日志时停用它：终态是 disabled，不被写回 error', async () => {
    let app!: App;
    let disabling: Promise<boolean> | undefined;
    app = makeApp(
      hooked('error', '激活失败', () => {
        disabling = app.plugins.disable('boom');
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'boom',
        apply() {
          throw new Error('zz-boom');
        },
      }),
    );
    await app.plugins.idle();
    expect(await disabling).toBe(true);
    await app.plugins.idle();
    expect(state(app, 'boom')).toBe('disabled');
  });

  it('初始化期间 required 服务不可用、记日志时停用它：终态是 disabled，不被写回 pending', async () => {
    let app!: App;
    let disabling: Promise<boolean> | undefined;
    app = makeApp(
      hooked('debug', 'required 服务不可用', () => {
        disabling = app.plugins.disable('zz-retry');
      }),
    );
    const svc = defineService<Box>('zz-log-retry');
    const host = app.bind({ provide });
    const off = host.provide.use(svc, { save() {} });
    await app.plugin(
      definePlugin({
        name: 'zz-retry',
        uses: { s: svc },
        apply({ s }) {
          off();
          s.use.save('x');
        },
      }),
    );
    await app.plugins.idle();
    expect(await disabling).toBe(true);
    host.provide.use(svc, { save() {} });
    await app.plugins.idle();
    expect(state(app, 'zz-retry')).toBe('disabled');
  });

  it('devMode 告警未声明的服务时停用它：终态是 disabled，服务不再上线', async () => {
    let app!: App;
    let disabling: Promise<boolean> | undefined;
    app = makeApp(
      hooked('warn', '未在 provides 中声明', () => {
        disabling = app.plugins.disable('zz-loose');
      }),
      true,
    );
    const svc = defineService<Box>('zz-log-undeclared');
    await app.plugin(
      definePlugin({
        name: 'zz-loose',
        uses: { provide },
        apply({ provide }) {
          provide.use(svc, { save() {} });
        },
      }),
    );
    await app.plugins.idle();
    expect(await disabling).toBe(true);
    await app.plugins.idle();
    expect(state(app, 'zz-loose')).toBe('disabled');
    expect(app.bind({ services }).services.use.get(svc)).toBeUndefined();
  });
});

describe('日志回调里调 stop()：停机照常结束', () => {
  it('激活失败记日志时', async () => {
    let app!: App;
    let stopping: Promise<void> | undefined;
    let disposed = 0;
    app = makeApp(hooked('error', '激活失败', () => (stopping = app.stop())));
    await app.plugin(
      definePlugin({
        name: 'zz-fail',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onDispose(() => void disposed++);
          throw new Error('zz-boom');
        },
      }),
    );
    expect(stopping).toBeDefined();
    expect(await stopWithin(app, 2000)).toBe('ok');
    expect(disposed).toBe(1);
  });
});

describe('排序告警的日志回调里登记插件', () => {
  it('required 依赖成环的告警回调里登记新插件：新插件照常激活，不被过期的激活顺序漏掉', async () => {
    let app!: App;
    let late: Promise<boolean> | undefined;
    app = makeApp(
      hooked('warn', '依赖环', () => {
        late = app.plugin(definePlugin({ name: 'zz-late', apply() {} }));
      }),
    );
    const sx = defineService<Box>('zz-log-cycle-x');
    const sy = defineService<Box>('zz-log-cycle-y');
    await app.pluginAll([
      { definition: definePlugin({ name: 'zz-x', uses: { y: sy }, provides: [sx], apply() {} }) },
      { definition: definePlugin({ name: 'zz-y', uses: { x: sx }, provides: [sy], apply() {} }) },
    ]);
    await app.plugins.idle();
    expect(await late).toBe(true);
    await app.plugins.idle();
    expect(state(app, 'zz-late')).toBe('active');
  });
});

describe('日志回调里调 start()：只启动一次', () => {
  it('记「正在启动」时再调 start()：拿到同一次启动，就绪回调只跑一次', async () => {
    let app!: App;
    let again: Promise<void> | undefined;
    app = makeApp(hooked('info', '正在启动', () => (again = app.start())));
    let ready = 0;
    app.bind({ lifecycle }).lifecycle.use.onReady(() => void ready++);
    const first = app.start();
    expect(again).toBe(first);
    await first;
    expect(ready).toBe(1);
  });
});
