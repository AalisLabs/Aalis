import { gateway } from '@aalis/api-gateway';
import { App, events, logger } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFlowControlConfig } from '../../packages/plugin-flow-control/src/config.js';
import { PlatformIdleScheduler } from '../../packages/plugin-flow-control/src/idle-scheduler.js';
import { createState, type MutableFlowSessionState } from '../../packages/plugin-flow-control/src/state.js';

// 背景（A30）：platform 档 all-quiet 策略在「已达标但无候选」和「压根没有活动记录」两种情形下
// 都把重排间隔压成 1s，形成 1 Hz 死转（每秒一个 timer + 一条 debug）。发出去那一轮同样如此
// （活动时间要等消息被处理才刷新），故契约是**每轮之间至少隔一个阈值量级**，一轮只发一条。
// 背景（A31）：platform 档挑候选时不看 per-scope overrides，单独配了 idleTriggerScope:'off'
// 的会话照样被主动开聊，提示词也恒用顶层的那份。
// 背景（BQ）：stop() 只清当前 timer，飞行中的 tick 回来照样 schedule() —— 拆卸后留下僵尸定时器，
// 一直把闲置消息注进已停的插件。契约：stop() 之后任何重排都是空操作。

function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // 调度器要的三样能力由宿主侧绑定给出；无 gateway 提供者时它回落到直接发入站事件
  const caps = app.bind({ logger, events, gateway });
  const seen: IncomingMessage[] = [];
  caps.events.on('inbound:message', (msg: IncomingMessage) => {
    seen.push(msg);
  });
  return { app, caps, seen };
}

/** 造一个「很久没动过」的状态（满足 all-quiet） */
function quietState(over: Partial<MutableFlowSessionState> = {}): MutableFlowSessionState {
  const s = createState('onebot', 'group', 'g1');
  s.lastMessageTime = Date.now() - 10 * 60_000;
  Object.assign(s, over);
  return s;
}

describe('PlatformIdleScheduler：无候选 / 无活动记录时不得 1 Hz 死转', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('候选被静音挤出后退避到阈值量级，解除静音也不会在 1s 内开聊', async () => {
    const { app, caps, seen } = setup();
    const cfg = resolveFlowControlConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, MutableFlowSessionState>();
    const s = quietState({ mutedUntil: Date.now() + 60 * 60_000 });
    states.set('S1', s);
    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();

    // 第一次 tick：静默已达标但唯一候选被静音 → 无候选
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen).toHaveLength(0);

    // 解除静音：修复前 1s 后就会开聊（死转），修复后要等一个阈值量级
    s.mutedUntil = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen, '无候选后应退避，不该 1s 就回来开聊').toHaveLength(0);

    // 退避到期后仍会开聊（只是慢，不是停），且一轮只发一条
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.length, '退避到期应开聊，且一轮只发一条').toBe(1);
    sched.stop();
    await app.stop();
  });

  it('会话无任何活动记录时按整个阈值等，而非立刻开聊', async () => {
    const { app, caps, seen } = setup();
    const cfg = resolveFlowControlConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, MutableFlowSessionState>();
    states.set('S1', createState('onebot', 'group', 'g1')); // lastMessageTime/lastReplyTime 全 0
    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen, '无活动记录不等于静默达标').toHaveLength(0);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(seen.length, '阈值到了应开聊，且一轮只发一条').toBe(1);
    sched.stop();
    await app.stop();
  });
});

describe('PlatformIdleScheduler：per-scope overrides', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('单独关掉闲置触发的会话不被抓来开聊，提示词取该会话的有效配置', async () => {
    const { app, caps, seen } = setup();
    const cfg = resolveFlowControlConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
      idleTriggerPrompt: '顶层提示',
      overrides: [
        { scope: 'onebot:group:g-off', idleTriggerScope: 'off' },
        { scope: 'onebot:group:g-on', idleTriggerPrompt: '本群专属提示' },
      ],
    });
    const states = new Map<string, MutableFlowSessionState>();
    // 关掉的那个「更久没联系」，修复前必被选中
    const off = createState('onebot', 'group', 'g-off');
    off.lastMessageTime = Date.now() - 60 * 60_000;
    states.set('S-off', off);
    const on = createState('onebot', 'group', 'g-on');
    on.lastMessageTime = Date.now() - 10 * 60_000;
    states.set('S-on', on);

    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();
    await vi.advanceTimersByTimeAsync(1_100);
    sched.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId, 'idleTriggerScope:off 的会话不该被主动开聊').toBe('S-on');
    expect(seen[0].content, '提示词应取候选会话的有效配置').toBe('本群专属提示');
    await app.stop();
  });
});

describe('PlatformIdleScheduler：stop() 之后不再重排', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tick 飞行中 stop() 后不再重排（无僵尸定时器）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const caps = app.bind({ logger, events, gateway });
    let release!: () => void;
    const inFlight = new Promise<void>(r => {
      release = r;
    });
    let injected = 0;
    caps.events.on('inbound:message', async () => {
      injected++;
      await inFlight; // 卡住注入，制造「tick 飞行中」的窗口
    });
    const cfg = resolveFlowControlConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, MutableFlowSessionState>([['S1', quietState()]]);
    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();

    await vi.advanceTimersByTimeAsync(1_100);
    expect(injected, 'tick 应已进入注入并卡住').toBe(1);

    sched.stop();
    expect(vi.getTimerCount(), 'stop() 应清掉当前定时器').toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(0); // 让飞行中的 tick 收尾
    expect(vi.getTimerCount(), 'stop() 后飞行中的 tick 不得再排新定时器').toBe(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(injected, 'stop() 后不该再有新一轮').toBe(1);
    await app.stop();
  });
});
