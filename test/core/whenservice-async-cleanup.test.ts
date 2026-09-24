import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
  type ServiceRef,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// follow 的 cleanup 可以是异步的。三项承诺分开钉：
//   1. 拒绝有人接：拆卸 / 手动退订 / 提供者切换三条路径都不逃逸成 unhandledRejection；
//   2. 拆卸可等待：关闭等 cleanup 落地——包括此前经手动退订或切换启动、尚未完成的那些；
//      超时护栏与 onDispose 同一套；
//   3. 串行交接：旧 cleanup 的 Promise 落定后才挂新提供者；等待期间关闭则不再挂。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const svc = defineService<{ id?: string }>('__t:ws-async');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeApp(disposeTimeoutMs?: number) {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, extra) => warnings.push(extra instanceof Error ? `${message} ${extra.message}` : String(message)),
    error: () => {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger, disposeTimeoutMs });
  apps.push(app);
  return { app, warnings, host: app.bind({ provide }) };
}

/** 一个会拖 `ms` 毫秒再（可选）拒绝的异步 cleanup，外带落地标记 */
function slowCleanup(ms: number, reject?: string) {
  const state = { finished: false };
  const cleanup = async () => {
    await sleep(ms);
    state.finished = true;
    if (reject) throw new Error(reject);
  };
  return { state, cleanup };
}

async function watch(app: App, attach: Parameters<ServiceRef<{ id?: string }>['follow']>[0], name = 'watcher') {
  let off!: () => void;
  await app.plugin(
    definePlugin({
      name,
      uses: { x: optional(svc) },
      apply({ x }) {
        off = x.follow(attach);
      },
    }),
  );
  await app.plugins.idle();
  expect(app.plugins.getPlugin(name)?.state).toBe('active');
  return off;
}

describe('follow 异步 cleanup', () => {
  it('拆卸路径：关闭等 cleanup 落地，拒绝记 warn 不逃逸', async () => {
    const { app, warnings, host } = makeApp();
    host.provide(svc, {});
    const { state, cleanup } = slowCleanup(20, 'cleanup failed');
    await watch(app, () => cleanup);
    await app.plugins.unload('watcher');
    expect(state.finished, '关闭返回时 cleanup 已落地').toBe(true);
    expect(warnings.some(w => w.includes('撤回拒绝'))).toBe(true);
  });

  it('手动退订路径：早先启动的 cleanup 由随后的关闭等到', async () => {
    const { app, warnings, host } = makeApp();
    host.provide(svc, {});
    const { state, cleanup } = slowCleanup(20, 'off failed');
    const off = await watch(app, () => cleanup);
    off();
    expect(state.finished).toBe(false);
    await app.plugins.unload('watcher');
    expect(state.finished, '关闭等到了手动退订启动的清理').toBe(true);
    expect(warnings.some(w => w.includes('撤回拒绝'))).toBe(true);
  });

  it('手动退订后不拆卸：清理落地即出在飞账，随后关闭不悬挂', async () => {
    const { app, host } = makeApp();
    host.provide(svc, {});
    const { state, cleanup } = slowCleanup(10);
    const off = await watch(app, () => cleanup);
    off();
    expect(state.finished).toBe(false);
    await sleep(30);
    expect(state.finished).toBe(true);
    await app.plugins.unload('watcher');
  });

  it('提供者切换路径：旧 cleanup 落定前不挂新实例；关闭等到它；拒绝被接住', async () => {
    const { app, warnings, host } = makeApp();
    const offA = host.provide(svc, { id: 'A' }, { entryId: 'root/A' });
    host.provide(svc, { id: 'B' }, { entryId: 'root/B' });
    const attached: string[] = [];
    const { state, cleanup } = slowCleanup(20, 'switch failed');
    await watch(app, provider => {
      attached.push(provider.id ?? '');
      return provider.id === 'A' ? cleanup : undefined;
    });
    expect(attached).toEqual(['A']);
    offA();
    await sleep(0); // emitQuietly 对齐后，串行交接必须仍停在 A
    expect(attached, '串行交接：旧 cleanup 还在飞时不得挂上 B').toEqual(['A']);
    expect(state.finished).toBe(false);
    await app.plugins.unload('watcher');
    expect(state.finished, '关闭等到了切换时启动的旧 cleanup').toBe(true);
    expect(attached, '关闭开始后不再挂载，哪怕旧清理后来才落定').toEqual(['A']);
    expect(warnings.some(w => w.includes('撤回拒绝'))).toBe(true);
  });

  it('回调里自退订并返回异步 cleanup：仍被等待', async () => {
    const { app, host } = makeApp();
    const { state, cleanup } = slowCleanup(20);
    // 服务晚于订阅上线：attach 在 registered 对齐里跑，此时 off 已赋值
    const off = await watch(app, () => {
      off();
      return cleanup;
    });
    host.provide(svc, {});
    await sleep(0); // emitQuietly 的对齐在微任务里，attach 必须先跑起来
    expect(state.finished).toBe(false);
    await app.plugins.unload('watcher');
    expect(state.finished, '关闭等到了它').toBe(true);
  });

  it('超时护栏：卡住的 cleanup 按 disposeTimeoutMs 放弃并 warn，拆卸不悬挂', async () => {
    const { app, warnings, host } = makeApp(30);
    host.provide(svc, {});
    await watch(app, () => () => new Promise<void>(() => {}));
    await app.stop();
    expect(warnings.some(w => w.includes('__t:ws-async') && w.includes('超过 30ms'))).toBe(true);
  });

  it('宿主 logger sink 抛错：拒绝仍不逃逸，在飞集合照常排空', async () => {
    const boom = (message: unknown) => {
      if (String(message).includes('撤回拒绝')) throw new Error('sink boom');
    };
    const logger = { debug() {}, info() {}, warn: boom, error: boom, child: () => logger } as unknown as Logger;
    const app = new App({ name: 'T', logLevel: 'error', logger });
    apps.push(app);
    const host = app.bind({ provide });
    host.provide(svc, {});
    const { cleanup } = slowCleanup(10, 'boom');
    const off = await watch(app, () => cleanup);
    off();
    await sleep(40);
    await app.plugins.unload('watcher');
  });
});
