import { describe, expect, it } from 'vitest';
import {
  defaultFlowControlConfig,
  isScopeEnabled,
  resolveFlowControlConfig,
} from '../../packages/plugin-flow-control/src/config.js';
import {
  applyScoreDecay,
  calculateScoreIncrement,
  createState,
  getCurrentThreshold,
  rateLimitUsedNow,
  snapshot,
} from '../../packages/plugin-flow-control/src/state.js';

describe('flow-control config', () => {
  it('resolve 缺省字段使用默认', () => {
    const c = resolveFlowControlConfig({});
    expect(c.fixedInterval).toBe(defaultFlowControlConfig.fixedInterval);
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

  it('idleTriggerScope 非法值回退默认', () => {
    const c = resolveFlowControlConfig({ idleTriggerScope: 'bogus' as unknown });
    expect(c.idleTriggerScope).toBe(defaultFlowControlConfig.idleTriggerScope);
  });
});

describe('isScopeEnabled', () => {
  const cfg = (scopes: string[]) => ({ ...defaultFlowControlConfig, scopes });

  it('精确匹配', () => {
    expect(isScopeEnabled(cfg(['onebot:group']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:group']), 'onebot', 'private')).toBe(false);
  });

  it('platform 通配', () => {
    expect(isScopeEnabled(cfg(['*:group']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['*:group']), 'cli', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['*:group']), 'cli', 'private')).toBe(false);
  });

  it('sessionType 通配', () => {
    expect(isScopeEnabled(cfg(['onebot:*']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:*']), 'onebot', 'private')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:*']), 'cli', 'group')).toBe(false);
  });

  it('全通配', () => {
    expect(isScopeEnabled(cfg(['*']), 'anything', 'thing')).toBe(true);
  });

  it('空 scopes 不命中', () => {
    expect(isScopeEnabled(cfg([]), 'onebot', 'group')).toBe(false);
  });
});

describe('flow-control state', () => {
  it('createState 初始值合理', () => {
    const s = createState('cli');
    expect(s.messageCount).toBe(0);
    expect(s.activityScore).toBe(0);
    expect(s.platform).toBe('cli');
    expect(s.replyTimestamps).toEqual([]);
  });

  it('calculateScoreIncrement 默认权重 = 1/fixedInterval', () => {
    const s = createState('p');
    const inc = calculateScoreIncrement(s, defaultFlowControlConfig);
    expect(inc).toBeCloseTo(1 / defaultFlowControlConfig.fixedInterval, 5);
  });

  it('calculateScoreIncrement 用户高频时权重抬升', () => {
    const s = createState('p');
    s.userInteractions.set('u1', { count: 20, lastTime: Date.now() });
    const incHigh = calculateScoreIncrement(s, defaultFlowControlConfig, 'u1');
    const incBase = calculateScoreIncrement(s, defaultFlowControlConfig);
    expect(incHigh).toBeGreaterThan(incBase);
    // 上限 1.5×
    expect(incHigh).toBeLessThanOrEqual(incBase * 1.5 + 1e-6);
  });

  it('applyScoreDecay 在 scoreDecayMinutes=0 时不衰减', () => {
    const s = createState('p');
    s.activityScore = 0.8;
    s.lastMessageTime = Date.now() - 60_000;
    applyScoreDecay(s, defaultFlowControlConfig);
    expect(s.activityScore).toBe(0.8);
  });

  it('applyScoreDecay 时间过去半周期 ≈ 半值', () => {
    const cfg = { ...defaultFlowControlConfig, scoreDecayMinutes: 10 };
    const s = createState('p');
    s.activityScore = 1.0;
    s.lastMessageTime = Date.now() - 5 * 60 * 1000; // 半个衰减周期
    applyScoreDecay(s, cfg);
    expect(s.activityScore).toBeGreaterThan(0.4);
    expect(s.activityScore).toBeLessThan(0.6);
  });

  it('applyScoreDecay 超过周期清零', () => {
    const cfg = { ...defaultFlowControlConfig, scoreDecayMinutes: 1 };
    const s = createState('p');
    s.activityScore = 1.0;
    s.lastMessageTime = Date.now() - 10 * 60 * 1000;
    applyScoreDecay(s, cfg);
    expect(s.activityScore).toBe(0);
  });

  it('getCurrentThreshold 首次回复前 = lower', () => {
    const s = createState('p');
    expect(getCurrentThreshold(s, defaultFlowControlConfig)).toBe(defaultFlowControlConfig.activityScoreLower);
  });

  it('getCurrentThreshold 刚回复后 ≈ upper', () => {
    const s = createState('p');
    s.lastReplyTime = Date.now();
    const t = getCurrentThreshold(s, defaultFlowControlConfig);
    expect(t).toBeGreaterThan(defaultFlowControlConfig.activityScoreUpper - 0.01);
  });

  it('rateLimitUsedNow 仅计窗口内', () => {
    const cfg = { ...defaultFlowControlConfig, rateLimitWindow: 60 };
    const s = createState('p');
    const now = Date.now();
    s.replyTimestamps = [now - 90_000, now - 30_000, now - 10_000];
    expect(rateLimitUsedNow(s, cfg)).toBe(2);
  });

  it('rateLimitUsedNow 关闭时返回 0', () => {
    const s = createState('p');
    s.replyTimestamps = [Date.now()];
    expect(rateLimitUsedNow(s, defaultFlowControlConfig)).toBe(0);
  });

  it('snapshot 字段完整', () => {
    const s = createState('p');
    s.messageCount = 3;
    s.activityScore = 0.5;
    const snap = snapshot(s, defaultFlowControlConfig);
    expect(snap.messageCount).toBe(3);
    expect(snap.activityScore).toBe(0.5);
    expect(snap.fixedInterval).toBe(defaultFlowControlConfig.fixedInterval);
    expect(snap.userInteractions).toBe(s.userInteractions);
  });
});
