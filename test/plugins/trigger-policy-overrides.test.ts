import { describe, expect, it } from 'vitest';
import {
  defaultTriggerPolicyConfig,
  isScopeEnabled,
  resolveEffectiveConfig,
  resolveTriggerPolicyConfig,
} from '../../packages/plugin-trigger-policy/src/config.js';

describe('trigger-policy overrides (resolve)', () => {
  it('overrides 默认空数组', () => {
    expect(resolveTriggerPolicyConfig({}).overrides).toEqual([]);
  });

  it('overrides 解析（含 triggerNames/muteKeywords 逗号串）', () => {
    const c = resolveTriggerPolicyConfig({
      overrides: [
        {
          scope: '*:private',
          intervalMode: 'dynamic',
          triggerOnAt: false,
          triggerNames: 'a,b,c',
          muteKeywords: '安静',
          muteTimeSeconds: 30,
        },
        { scope: 'invalid_no_change' }, // 仅 scope，无覆盖字段
      ],
    });
    expect(c.overrides[0]).toEqual({
      scope: '*:private',
      intervalMode: 'dynamic',
      triggerOnAt: false,
      triggerNames: ['a', 'b', 'c'],
      muteKeywords: ['安静'],
      muteTimeSeconds: 30,
    });
    expect(c.overrides[1]).toEqual({ scope: 'invalid_no_change' });
  });
});

describe('trigger-policy isScopeEnabled (3-tier + overrides)', () => {
  const make = (scopes: string[], overrides: { scope: string }[] = []) => ({
    ...defaultTriggerPolicyConfig,
    scopes,
    overrides,
  });
  it('targetId 段', () => {
    expect(isScopeEnabled(make(['onebot:group:1014']), 'onebot', 'group', '1014')).toBe(true);
    expect(isScopeEnabled(make(['onebot:group:1014']), 'onebot', 'group', '99')).toBe(false);
  });
  it('overrides 命中即启用', () => {
    expect(isScopeEnabled(make([], [{ scope: '*:private' }]), 'onebot', 'private')).toBe(true);
  });
  it('空 + 空 → false', () => {
    expect(isScopeEnabled(make([]), 'p', 't')).toBe(false);
  });
});

describe('trigger-policy resolveEffectiveConfig', () => {
  it('最具体匹配优先', () => {
    const c = {
      ...defaultTriggerPolicyConfig,
      intervalMode: 'both' as const,
      overrides: [
        { scope: '*', intervalMode: 'fixed' as const },
        { scope: '*:private', intervalMode: 'dynamic' as const },
        { scope: 'onebot:private', intervalMode: 'both' as const },
        { scope: 'onebot:private:42', intervalMode: 'fixed' as const },
      ],
    };
    expect(resolveEffectiveConfig(c, 'onebot', 'private', '42').intervalMode).toBe('fixed');
    expect(resolveEffectiveConfig(c, 'onebot', 'private', '99').intervalMode).toBe('both');
    expect(resolveEffectiveConfig(c, 'cli', 'private').intervalMode).toBe('dynamic');
    expect(resolveEffectiveConfig(c, 'cli', 'group').intervalMode).toBe('fixed');
  });
  it('未匹配字段穿透', () => {
    const c = {
      ...defaultTriggerPolicyConfig,
      triggerOnAt: true,
      muteTimeSeconds: 60,
      overrides: [{ scope: '*:private', triggerOnAt: false }],
    };
    const eff = resolveEffectiveConfig(c, 'onebot', 'private');
    expect(eff.triggerOnAt).toBe(false);
    expect(eff.muteTimeSeconds).toBe(60);
  });
});
