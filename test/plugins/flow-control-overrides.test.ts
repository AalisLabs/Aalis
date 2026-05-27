import { describe, expect, it } from 'vitest';
import {
  defaultFlowControlConfig,
  isScopeEnabled,
  resolveEffectiveConfig,
  resolveFlowControlConfig,
} from '../../packages/plugin-flow-control/src/config.js';

describe('flow-control overrides (resolveFlowControlConfig)', () => {
  it('overrides 字段默认空数组', () => {
    const c = resolveFlowControlConfig({});
    expect(c.overrides).toEqual([]);
  });

  it('overrides 解析有效项 + 忽略无效项', () => {
    const c = resolveFlowControlConfig({
      overrides: [
        { scope: '*:private', cooldownSeconds: 10 },
        { scope: '   ', cooldownSeconds: 1 }, // 无效 scope
        null,
        { /* 无 scope */ cooldownSeconds: 2 },
        { scope: 'onebot:group:20002', rateLimitWindow: 60, rateLimitMaxReplies: 3 },
      ],
    });
    expect(c.overrides).toHaveLength(2);
    expect(c.overrides[0]).toEqual({ scope: '*:private', cooldownSeconds: 10 });
    expect(c.overrides[1].scope).toBe('onebot:group:20002');
  });

  it('overrides 只保留已知字段（防注入）', () => {
    const c = resolveFlowControlConfig({
      overrides: [{ scope: '*:private', cooldownSeconds: 10, malicious: 'x' } as Record<string, unknown>],
    });
    expect(c.overrides[0]).toEqual({ scope: '*:private', cooldownSeconds: 10 });
  });
});

describe('isScopeEnabled (3-tier + overrides)', () => {
  const base = (scopes: string[], overrides: { scope: string }[] = []) => ({
    ...defaultFlowControlConfig,
    scopes,
    overrides,
  });

  it('targetId 段命中', () => {
    expect(isScopeEnabled(base(['onebot:group:1014']), 'onebot', 'group', '1014')).toBe(true);
    expect(isScopeEnabled(base(['onebot:group:1014']), 'onebot', 'group', '9999')).toBe(false);
  });

  it('未提供 targetId 时 targetId-限定 scope 不命中', () => {
    expect(isScopeEnabled(base(['onebot:group:1014']), 'onebot', 'group')).toBe(false);
  });

  it('通配 targetId 兼容旧 2 段写法', () => {
    expect(isScopeEnabled(base(['*:group']), 'onebot', 'group', '1014')).toBe(true);
    expect(isScopeEnabled(base(['*:group']), 'onebot', 'private', '1014')).toBe(false);
  });

  it('只有 overrides 命中也视为启用', () => {
    const cfg = base([], [{ scope: '*:private' }]);
    expect(isScopeEnabled(cfg, 'onebot', 'private')).toBe(true);
    expect(isScopeEnabled(cfg, 'onebot', 'group')).toBe(false);
  });

  it('空 scopes + 空 overrides → 不启用', () => {
    expect(isScopeEnabled(base([]), 'onebot', 'private')).toBe(false);
  });
});

describe('resolveEffectiveConfig', () => {
  it('无 overrides 返回原对象引用', () => {
    const c = { ...defaultFlowControlConfig, overrides: [] };
    expect(resolveEffectiveConfig(c, 'onebot', 'group')).toBe(c);
  });

  it('单一匹配 → 部分字段覆盖，其他穿透', () => {
    const c = {
      ...defaultFlowControlConfig,
      cooldownSeconds: 10,
      fixedInterval: 5,
      overrides: [{ scope: '*:private', cooldownSeconds: 30 }],
    };
    const eff = resolveEffectiveConfig(c, 'onebot', 'private');
    expect(eff.cooldownSeconds).toBe(30);
    expect(eff.fixedInterval).toBe(5); // 穿透
  });

  it('最具体匹配优先：targetId > sessionType > platform > 通配', () => {
    const c = {
      ...defaultFlowControlConfig,
      cooldownSeconds: 10,
      overrides: [
        { scope: '*', cooldownSeconds: 20 },
        { scope: '*:private', cooldownSeconds: 30 },
        { scope: 'onebot:private', cooldownSeconds: 40 },
        { scope: 'onebot:private:42', cooldownSeconds: 50 },
      ],
    };
    expect(resolveEffectiveConfig(c, 'onebot', 'private', '42').cooldownSeconds).toBe(50);
    expect(resolveEffectiveConfig(c, 'onebot', 'private', '99').cooldownSeconds).toBe(40);
    expect(resolveEffectiveConfig(c, 'cli', 'private').cooldownSeconds).toBe(30);
    expect(resolveEffectiveConfig(c, 'cli', 'group').cooldownSeconds).toBe(20);
  });

  it('未匹配的 override 不影响', () => {
    const c = {
      ...defaultFlowControlConfig,
      cooldownSeconds: 10,
      overrides: [{ scope: 'onebot:private', cooldownSeconds: 99 }],
    };
    expect(resolveEffectiveConfig(c, 'cli', 'group').cooldownSeconds).toBe(10);
  });

  it('user 场景：仅给私聊单独 10s 冷却（默认群聊 0）', () => {
    const c = {
      ...defaultFlowControlConfig,
      cooldownSeconds: 0,
      overrides: [{ scope: '*:private', cooldownSeconds: 10 }],
    };
    expect(resolveEffectiveConfig(c, 'onebot', 'private').cooldownSeconds).toBe(10);
    expect(resolveEffectiveConfig(c, 'onebot', 'group').cooldownSeconds).toBe(0);
  });
});
