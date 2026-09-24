import { describe, expect, it } from 'vitest';
import { bindActivationFixture, createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// events 的 contextId 归属与同点切断：拆卸的注销段整体移除本 ctx 的全部
// 事件监听（与服务登记、登记账本同点），异步排空窗口内本插件的 handler
// 不再响应事件——「半拆状态不外露」对原语与账本登记一体成立。
//
// off 身份卫：链上残留的退订闭包在切断后迟到执行，不得误删他人重建的
// 同名事件表。
// ════════════════════════════════════════════════════════════

function makeWorld() {
  const world = createActivationFixture();
  const make = (id: string) => bindActivationFixture(world.host, world.host.create(world.activation, id));
  return { make, events: world.events };
}

describe('events 按 ctx 切断', () => {
  it('异步排空窗口内本 ctx 的 handler 不再响应事件（修前直到链排空才死）', async () => {
    const { make } = makeWorld();
    const dying = make('dying');
    const peer = make('peer');

    let hits = 0;
    dying.caps.events.on('plugin:loaded', () => {
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
    dying.caps.lifecycle.onDispose(async () => {
      drainEntered();
      await gate;
    }, 'slow-res');

    const teardown = dying.activation.disposeAsync(5000);
    await drainEnteredP; // 已过注销段、正卡在链排空里
    await peer.caps.events.emit('plugin:loaded', 'x');
    expect(hits).toBe(0);

    release();
    await teardown;
    await peer.caps.events.emit('plugin:loaded', 'y');
    expect(hits).toBe(0);
    await peer.activation.disposeAsync();
  });

  it('off 身份卫：切断后迟到的退订闭包不误删他人重建的同名事件表', async () => {
    const { make } = makeWorld();
    const a = make('a');
    const b = make('b');

    a.caps.events.on('plugin:loaded', () => {});
    let release!: () => void;
    let drainEntered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const drainEnteredP = new Promise<void>(r => {
      drainEntered = r;
    });
    // 后注册的 gated onDispose 在链上先排空——a 的 on 退订闭包在它之后迟到执行
    a.caps.lifecycle.onDispose(async () => {
      drainEntered();
      await gate;
    }, 'gate');

    const teardown = a.activation.disposeAsync(5000);
    await drainEnteredP;
    // 窗口内 b 重建同名事件表
    let bHits = 0;
    b.caps.events.on('plugin:loaded', () => {
      bHits++;
    });
    release();
    await teardown; // a 的迟到 off 在此执行——身份卫必须放过 b 的新表

    await b.caps.events.emit('plugin:loaded', 'x');
    expect(bHits).toBe(1);
    await b.activation.disposeAsync();
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
    ctx.caps.events.on('plugin:loaded', () => {});
    await ctx.activation.disposeAsync();

    const peer = make('peer');
    await peer.caps.events.emit('plugin:loaded', 'x');
    expect(raw).toBe(1);
    await peer.activation.disposeAsync();
  });
});
