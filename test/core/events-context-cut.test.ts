import { describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// events 的 contextId 归属与同点切断：拆卸的注销段整体移除本 ctx 的全部
// 事件监听（与 hooks/contributions 同点），异步排空窗口内本插件的 handler
// 不再响应事件——「半拆状态不外露」对四原语一体成立。
//
// off 身份卫：链上残留的退订闭包在切断后迟到执行，不得误删他人重建的
// 同名事件表。
// ════════════════════════════════════════════════════════════

function makeWorld() {
  const deps = {
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('test'),
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  };
  const make = (id: string) => new Context({ id, ...deps });
  return { make, events: deps.events };
}

describe('events 按 ctx 切断', () => {
  it('异步排空窗口内本 ctx 的 handler 不再响应事件（修前直到链排空才死）', async () => {
    const { make } = makeWorld();
    const dying = make('dying');
    const peer = make('peer');

    let hits = 0;
    dying.on('plugin:loaded', () => {
      hits++;
    });
    let release!: () => void;
    let drainEntered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const drainEnteredP = new Promise<void>(r => {
      drainEntered = r;
    });
    dying.onDispose(async () => {
      drainEntered();
      await gate;
    }, 'slow-res');

    const teardown = dying.disposeAsync(5000);
    await drainEnteredP; // 已过注销段、正卡在链排空里
    await peer.emit('plugin:loaded', 'x');
    expect(hits).toBe(0);

    release();
    await teardown;
    await peer.emit('plugin:loaded', 'y');
    expect(hits).toBe(0);
    peer.dispose();
  });

  it('off 身份卫：切断后迟到的退订闭包不误删他人重建的同名事件表', async () => {
    const { make } = makeWorld();
    const a = make('a');
    const b = make('b');

    a.on('plugin:loaded', () => {});
    let release!: () => void;
    let drainEntered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const drainEnteredP = new Promise<void>(r => {
      drainEntered = r;
    });
    // 后注册的 gated onDispose 在链上先排空——a 的 on 退订闭包在它之后迟到执行
    a.onDispose(async () => {
      drainEntered();
      await gate;
    }, 'gate');

    const teardown = a.disposeAsync(5000);
    await drainEnteredP;
    // 窗口内 b 重建同名事件表
    let bHits = 0;
    b.on('plugin:loaded', () => {
      bHits++;
    });
    release();
    await teardown; // a 的迟到 off 在此执行——身份卫必须放过 b 的新表

    await b.emit('plugin:loaded', 'x');
    expect(bHits).toBe(1);
    b.dispose();
  });

  it('无主 handler（直接用总线）不受任何 ctx 切断影响', async () => {
    const { make, events } = makeWorld();
    const ctx = make('p');
    let raw = 0;
    events.on(
      'plugin:loaded' as never,
      (() => {
        raw++;
      }) as never,
    );
    ctx.on('plugin:loaded', () => {});
    ctx.dispose();

    const peer = make('peer');
    await peer.emit('plugin:loaded', 'x');
    expect(raw).toBe(1);
    peer.dispose();
  });
});
