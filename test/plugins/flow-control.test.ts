import { describe, expect, it } from 'vitest';
import { defaultFlowControlConfig, resolveFlowControlConfig } from '../../packages/plugin-flow-control/src/config.js';
import {
  createState,
  rateLimitUsedNow,
  SESSION_TTL_MS,
  sweepStaleStates,
} from '../../packages/plugin-flow-control/src/state.js';

describe('flow-control config', () => {
  it('resolve 缺省字段使用默认', () => {
    const c = resolveFlowControlConfig({});
    expect(c.cooldownSeconds).toBe(defaultFlowControlConfig.cooldownSeconds);
    expect(c.scopes).toEqual(defaultFlowControlConfig.scopes);
  });

  it('resolve 解析逗号分隔 scopes', () => {
    const c = resolveFlowControlConfig({ scopes: 'onebot:group, cli:*' });
    expect(c.scopes).toEqual(['onebot:group', 'cli:*']);
  });

  it('resolve 数组 scopes 直接用', () => {
    const c = resolveFlowControlConfig({ scopes: ['onebot:private'] });
    expect(c.scopes).toEqual(['onebot:private']);
  });

  it('只保留节流字段：评分与闲置触发字段已归 trigger-policy', () => {
    const c = resolveFlowControlConfig({ fixedInterval: 100, idleTriggerScope: 'session' });
    expect(Object.keys(c).sort()).toEqual(
      ['cooldownSeconds', 'overrides', 'rateLimitMaxReplies', 'rateLimitWindow', 'scopes'].sort(),
    );
  });
});

describe('flow-control state', () => {
  it('createState 初始值合理', () => {
    const s = createState('cli');
    expect(s.platform).toBe('cli');
    expect(s.mutedUntil).toBe(0);
    expect(s.cooldownUntil).toBe(0);
    expect(s.replyTimestamps).toEqual([]);
  });

  it('rateLimitUsedNow 仅计窗口内', () => {
    const cfg = { ...defaultFlowControlConfig, rateLimitWindow: 60 };
    const s = createState('p');
    const now = Date.now();
    s.replyTimestamps = [now - 90_000, now - 30_000, now - 10_000];
    expect(rateLimitUsedNow(s, cfg)).toBe(2);
  });
});

describe('flow-control TTL 清扫', () => {
  it('超过 TTL 未见且无挂起禁言/冷却的会话被删，其余保留', () => {
    const now = Date.now();
    const stale = createState('onebot');
    stale.lastSeenAt = now - SESSION_TTL_MS - 1;
    const recent = createState('onebot');
    recent.lastSeenAt = now - SESSION_TTL_MS + 60_000;
    const muted = createState('onebot');
    muted.lastSeenAt = now - SESSION_TTL_MS - 1;
    muted.mutedUntil = now + 60_000;
    const cooling = createState('onebot');
    cooling.lastSeenAt = now - SESSION_TTL_MS - 1;
    cooling.cooldownUntil = now + 1_000;
    const states = new Map([
      ['stale', stale],
      ['recent', recent],
      ['muted', muted],
      ['cooling', cooling],
    ]);

    expect(sweepStaleStates(states, now)).toBe(1);
    expect([...states.keys()].sort()).toEqual(['cooling', 'muted', 'recent']);
  });

  it('禁言/冷却到期后同一会话在下一次清扫时被删', () => {
    const now = Date.now();
    const s = createState('onebot');
    s.lastSeenAt = now - SESSION_TTL_MS - 1;
    s.mutedUntil = now + 60_000;
    const states = new Map([['S', s]]);
    expect(sweepStaleStates(states, now)).toBe(0);
    expect(sweepStaleStates(states, now + 60_001)).toBe(1);
    expect(states.size).toBe(0);
  });
});
