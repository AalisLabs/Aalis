import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig } from '../../packages/api-gateway/src/index.js';
import { resolveTriggerPolicyConfig } from '../../packages/plugin-trigger-policy/src/config.js';

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

describe('trigger-policy overrides 经 resolveEffectiveConfig 生效', () => {
  it('字符串字段留空（空串/未填）应穿透，不被覆盖为空数组', () => {
    const c = resolveTriggerPolicyConfig({
      triggerNames: 'aalis,bot',
      muteKeywords: 'mute',
      overrides: [
        {
          scope: '*:private',
          triggerOnAt: false,
          triggerNames: '', // 空串 → 不覆盖
          muteKeywords: undefined, // undefined → 不覆盖
        },
      ],
    });
    expect(c.overrides[0].triggerNames).toBeUndefined();
    expect(c.overrides[0].muteKeywords).toBeUndefined();
    const eff = resolveEffectiveConfig(c, 'onebot', 'private');
    expect(eff.triggerOnAt).toBe(false); // 覆盖生效
    expect(eff.triggerNames).toEqual(['aalis', 'bot']); // 穿透
    expect(eff.muteKeywords).toEqual(['mute']); // 穿透
  });
});
