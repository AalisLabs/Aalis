import { App, logger } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowControlService } from '../../packages/api-flow-control/src/index.js';
import {
  clearSessionIdle,
  type IdleCaps,
  PlatformIdleScheduler,
  scheduleSessionIdle,
} from '../../packages/plugin-trigger-policy/src/idle-scheduler.js';
import { createState, type TriggerSessionState } from '../../packages/plugin-trigger-policy/src/state.js';
import { resolveTriggerPolicyConfig } from './trigger-policy-config.js';

// 背景（A30）：platform 档 all-quiet 策略在「已达标但无候选」和「压根没有活动记录」两种情形下
// 都把重排间隔压成 1s，形成 1 Hz 死转（每秒一个 timer + 一条 debug）。契约是**每轮之间至少隔
// 一个阈值量级**，一轮只发一条。
// 背景（A31）：platform 档挑候选时不看 per-scope overrides，单独配了 idleTriggerScope:'off'
// 的会话照样被主动开聊，提示词也恒用顶层的那份。
// 背景（BQ）：stop() 只清当前 timer，飞行中的 tick 回来照样 schedule() —— 拆卸后留下僵尸定时器，
// 一直把闲置消息注进已停的插件。契约：stop() 之后任何重排都是空操作。
// 流控状态（禁言/冷却/限速）归 flow-control，调度器只经服务读取；这里用可控的假服务。
// 触发策略是否生效（trigger 服务胜者）也经 caps 读取，这里用可控的开关。

interface FakeFlow {
  muted: Set<string>;
  cooling: Set<string>;
  limited: Set<string>;
}

function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  const bound = app.bind({ logger });
  const flow: FakeFlow = { muted: new Set(), cooling: new Set(), limited: new Set() };
  const trigger = { active: true };
  const service: FlowControlService = {
    isMuted: sid => flow.muted.has(sid),
    isCoolingDown: sid => flow.cooling.has(sid),
    isRateLimited: sid => flow.limited.has(sid),
    setMuted: () => {},
  };
  // gateway 用记录型替身：注入走它的 ingressMessage（与生产同一条路），hold 可卡住注入
  const seen: IncomingMessage[] = [];
  const gw = { hold: async (_msg: IncomingMessage): Promise<void> => {} };
  const caps: IdleCaps = {
    logger: bound.logger,
    gateway: {
      current: {
        async ingressMessage(msg: IncomingMessage) {
          seen.push(msg);
          await gw.hold(msg);
        },
      } as never,
    },
    flowControl: { current: service },
    isActive: () => trigger.active,
  };
  return { app, caps, seen, flow, gw, trigger };
}

/** 造一个「很久没动过」的状态（满足 all-quiet） */
function quietState(targetId = 'g1', minutesAgo = 10): TriggerSessionState {
  const s = createState('onebot', 'group', targetId);
  s.lastMessageTime = Date.now() - minutesAgo * 60_000;
  return s;
}

describe('PlatformIdleScheduler：无候选 / 无活动记录时不得 1 Hz 死转', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('候选被禁言挤出后退避到阈值量级，解除禁言也不会在 1s 内开聊', async () => {
    const { app, caps, seen, flow } = setup();
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, TriggerSessionState>([['S1', quietState()]]);
    flow.muted.add('S1');
    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();

    // 第一次 tick：静默已达标但唯一候选被禁言 → 无候选
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen).toHaveLength(0);

    // 解除禁言：修复前 1s 后就会开聊（死转），修复后要等一个阈值量级
    flow.muted.delete('S1');
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
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, TriggerSessionState>();
    states.set('S1', createState('onebot', 'group', 'g1')); // lastMessageTime/lastBotActivityAt 全 0
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

describe('PlatformIdleScheduler：候选筛选', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('单独关掉闲置触发的会话不被抓来开聊，提示词取该会话的有效配置', async () => {
    const { app, caps, seen } = setup();
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
      idleTriggerPrompt: '顶层提示',
      overrides: [
        { scope: 'onebot:group:g-off', idleTriggerScope: 'off' },
        { scope: 'onebot:group:g-on', idleTriggerPrompt: '本群专属提示' },
      ],
    });
    // 关掉的那个「更久没联系」，修复前必被选中
    const states = new Map<string, TriggerSessionState>([
      ['S-off', quietState('g-off', 60)],
      ['S-on', quietState('g-on', 10)],
    ]);

    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();
    await vi.advanceTimersByTimeAsync(1_100);
    sched.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId, 'idleTriggerScope:off 的会话不该被主动开聊').toBe('S-on');
    expect(seen[0].content, '提示词应取候选会话的有效配置').toBe('本群专属提示');
    await app.stop();
  });

  it('禁言、冷却、限速中的会话都不当候选', async () => {
    const { app, caps, seen, flow } = setup();
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'fixed',
      idleTriggerMinutes: 1,
    });
    // 三个过不了流控硬闸的会话都比可选的那个更久没联系
    const states = new Map<string, TriggerSessionState>([
      ['S-muted', quietState('g1', 60)],
      ['S-cooling', quietState('g2', 50)],
      ['S-limited', quietState('g3', 40)],
      ['S-ok', quietState('g4', 10)],
    ]);
    flow.muted.add('S-muted');
    flow.cooling.add('S-cooling');
    flow.limited.add('S-limited');

    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();
    await vi.advanceTimersByTimeAsync(60_500);
    sched.stop();

    expect(seen.map(m => m.sessionId)).toEqual(['S-ok']);
    await app.stop();
  });

  it('agent 对闲置提示沉默时，注入本身记为开口，下一轮轮到其他会话', async () => {
    const { app, caps, seen } = setup();
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'fixed',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, TriggerSessionState>([
      ['S-A', quietState('gA', 60)],
      ['S-B', quietState('gB', 30)],
    ]);

    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();
    // 没有任何 agent 回复：只有注入本身能刷新活动时间
    await vi.advanceTimersByTimeAsync(60_500);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    sched.stop();

    expect(seen.map(m => m.sessionId)).toEqual(['S-A', 'S-B', 'S-A']);
    expect(states.get('S-A')?.lastBotActivityAt, '注入时刻应记为 bot 开口').toBeGreaterThan(0);
    await app.stop();
  });
});

describe('闲置触发只在触发策略生效时开口', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('platform 档：未生效时到点不注入、不记 bot 开口；重新生效后照常', async () => {
    const { app, caps, seen, trigger } = setup();
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'fixed',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, TriggerSessionState>([['S1', quietState()]]);
    trigger.active = false;
    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();

    await vi.advanceTimersByTimeAsync(60_500);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(0);
    expect(states.get('S1')?.lastBotActivityAt, '没开口不记为 bot 开口').toBe(0);

    trigger.active = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.map(m => m.sessionId)).toEqual(['S1']);
    sched.stop();
    await app.stop();
  });

  it('session 档：未生效时到点跳过、按原退避重排，不记 bot 开口；重新生效后照常', async () => {
    const { app, caps, seen, trigger } = setup();
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'session',
      idleTriggerStyle: 'exponential',
      idleTriggerMinutes: 1,
      idleTriggerJitter: false,
    });
    const state = quietState();
    const reschedule = () => scheduleSessionIdle(caps, cfg, state, 'S1', reschedule);
    trigger.active = false;
    reschedule();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(0);
    expect(state.idleBackoff, '没开口不退避').toBe(1);
    expect(state.lastBotActivityAt).toBe(0);
    expect(state.idleTimer, '跳过后仍按原退避重排').not.toBeNull();

    trigger.active = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.map(m => m.sessionId)).toEqual(['S1']);
    expect(state.idleBackoff).toBe(2);
    clearSessionIdle(state);
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
    const { app, caps, seen, gw } = setup();
    let release!: () => void;
    const inFlight = new Promise<void>(r => {
      release = r;
    });
    gw.hold = () => inFlight; // 卡住注入，制造「tick 飞行中」的窗口
    const cfg = resolveTriggerPolicyConfig({
      idleTriggerScope: 'platform',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 1,
    });
    const states = new Map<string, TriggerSessionState>([['S1', quietState()]]);
    const sched = new PlatformIdleScheduler(caps, cfg, states);
    sched.start();

    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen, 'tick 应已进入注入并卡住').toHaveLength(1);

    sched.stop();
    expect(vi.getTimerCount(), 'stop() 应清掉当前定时器').toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(0); // 让飞行中的 tick 收尾
    expect(vi.getTimerCount(), 'stop() 后飞行中的 tick 不得再排新定时器').toBe(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(seen, 'stop() 后不该再有新一轮').toHaveLength(1);
    await app.stop();
  });
});
