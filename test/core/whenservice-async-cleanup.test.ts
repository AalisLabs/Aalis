import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  EventBus,
  HookRegistry,
  type Logger,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// whenService 的 cleanup 可以是异步的（签名允许），三项承诺分开钉：
//   1. 拒绝有人接：拆卸 / 手动退订 / 提供者切换三条路径都不逃逸成 unhandledRejection；
//   2. 拆卸可等待：disposeAsync 等 cleanup 落地——包括此前经手动退订或切换启动、尚未完成的那些；
//      超时护栏与 onDispose 同一套；
//   3. 提供者切换不等旧 cleanup 落地就挂新实例（对齐是同步的，这条是「不改」的钉子）。
// 旧实现把 cleanup 的返回值扔掉：拒绝逃逸、disposeAsync 提前返回。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.disposeAsync();
});

function makeWorld() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: message => warnings.push(message),
    error: () => {},
    child: () => logger,
  };
  const root = new Context({
    id: 'root',
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger,
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
  roots.push(root);
  return { root, warnings };
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

describe('whenService 异步 cleanup', () => {
  it('拆卸路径：disposeAsync 等 cleanup 落地，拒绝记 warn 不逃逸', async () => {
    const { root, warnings } = makeWorld();
    root.provide('svc', {});
    const ctx = root.fork('p');
    const { state, cleanup } = slowCleanup(20, 'cleanup failed');
    ctx.whenService('svc', () => cleanup);
    await ctx.disposeAsync();
    expect(state.finished, 'disposeAsync 返回时 cleanup 已落地').toBe(true);
    expect(warnings.some(w => w.includes("whenService('svc') cleanup 拒绝"))).toBe(true);
  });

  it('手动退订路径：早先启动的 cleanup 由随后的 disposeAsync 等到；落地前条目留在链上，落地后自移除', async () => {
    const { root, warnings } = makeWorld();
    root.provide('svc', {});
    const ctx = root.fork('p');
    const base = ctx.disposableCount;
    const { state, cleanup } = slowCleanup(20, 'off failed');
    const off = ctx.whenService('svc', () => cleanup);
    off();
    expect(state.finished).toBe(false);
    expect(ctx.disposableCount, '在飞清理未落地：条目留在链上让拆卸等得到').toBe(base + 1);
    await ctx.disposeAsync();
    expect(state.finished, '拆卸等到了手动退订启动的清理').toBe(true);
    expect(warnings.some(w => w.includes("whenService('svc') cleanup 拒绝"))).toBe(true);
  });

  it('手动退订后不拆卸：清理落地即自移除，不滞留闭包', async () => {
    const { root } = makeWorld();
    root.provide('svc', {});
    const ctx = root.fork('p');
    const base = ctx.disposableCount;
    const { cleanup } = slowCleanup(10);
    const off = ctx.whenService('svc', () => cleanup);
    off();
    expect(ctx.disposableCount).toBe(base + 1);
    await sleep(30);
    expect(ctx.disposableCount).toBe(base);
  });

  it('提供者切换路径：不等旧 cleanup 落地就挂新实例；拒绝被接住；随后拆卸等它', async () => {
    const { root, warnings } = makeWorld();
    const offA = root.fork('a').provide('svc', { id: 'A' });
    root.fork('b').provide('svc', { id: 'B' });
    const ctx = root.fork('p');
    const attached: string[] = [];
    const { state, cleanup } = slowCleanup(20, 'switch failed');
    ctx.whenService<{ id: string }>('svc', svc => {
      attached.push(svc.id);
      return svc.id === 'A' ? cleanup : undefined;
    });
    expect(attached).toEqual(['A']);
    offA();
    expect(attached, '切换是同步的：旧 cleanup 还在飞就已挂上 B').toEqual(['A', 'B']);
    expect(state.finished).toBe(false);
    await ctx.disposeAsync();
    expect(state.finished, '拆卸等到了切换时启动的旧 cleanup').toBe(true);
    expect(warnings.some(w => w.includes("whenService('svc') cleanup 拒绝"))).toBe(true);
  });

  it('回调里自退订并返回异步 cleanup：仍被等待，落地后自移除', async () => {
    const { root } = makeWorld();
    const ctx = root.fork('p');
    const base = ctx.disposableCount;
    const { state, cleanup } = slowCleanup(20);
    // 服务晚于订阅上线：cb 在 service:registered 的对齐里跑，此时 off 已赋值，走「对齐期间自退订」的路径
    const off = ctx.whenService('svc', () => {
      off();
      return cleanup;
    });
    root.provide('svc', {});
    expect(state.finished).toBe(false);
    expect(ctx.disposableCount, '自退订时 cleanup 刚启动：条目留在链上').toBe(base + 1);
    await ctx.disposeAsync();
    expect(state.finished, '拆卸等到了它').toBe(true);
  });

  it('超时护栏：卡住的 cleanup 按 disposeAsync(timeoutMs) 放弃并 warn，拆卸不悬挂', async () => {
    const { root, warnings } = makeWorld();
    root.provide('svc', {});
    const ctx = root.fork('p');
    ctx.whenService('svc', () => () => new Promise<void>(() => {}));
    await ctx.disposeAsync(30);
    expect(warnings.some(w => w.includes('whenService:svc') && w.includes('超过 30ms'))).toBe(true);
  });

  it('宿主 logger sink 抛错：拒绝仍不逃逸，在飞集合照常排空、条目照常自移除', async () => {
    const boom = (message: unknown) => {
      if (String(message).includes('cleanup 拒绝')) throw new Error('sink boom');
    };
    const logger = { debug() {}, info() {}, warn: boom, error: boom, child: () => logger } as unknown as Logger;
    const root = new Context({
      id: 'root',
      events: new EventBus(),
      services: new ServiceContainer(),
      hooks: new HookRegistry(),
      contributions: new ContributionRegistry(),
      logger,
      config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
    });
    roots.push(root);
    root.provide('svc', {});
    const ctx = root.fork('p');
    const base = ctx.disposableCount;
    const { cleanup } = slowCleanup(10, 'boom');
    const off = ctx.whenService('svc', () => cleanup);
    off();
    await sleep(40);
    expect(ctx.disposableCount, 'sink 抛错不得让在飞集合永不排空').toBe(base);
  });

  it('同步 dispose() 不等待，但拒绝同样被接住', async () => {
    const { root, warnings } = makeWorld();
    root.provide('svc', {});
    const ctx = root.fork('p');
    const { state, cleanup } = slowCleanup(10, 'sync path');
    ctx.whenService('svc', () => cleanup);
    ctx.dispose();
    expect(state.finished).toBe(false);
    await sleep(30);
    expect(warnings.some(w => w.includes("whenService('svc') cleanup 拒绝"))).toBe(true);
  });
});
