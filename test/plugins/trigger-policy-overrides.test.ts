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

  it('overrides 解析评分与闲置触发字段（自 flow-control 迁入），丢弃未知字段与非法枚举', () => {
    const c = resolveTriggerPolicyConfig({
      overrides: [
        {
          scope: 'onebot:group:20002',
          fixedInterval: 20,
          activityScoreLower: 0.5,
          scoreDecayMinutes: 5,
          idleTriggerScope: 'session',
          idleTriggerStyle: 'fixed',
          idleTriggerMinutes: 30,
          idleTriggerJitter: false,
          idleTriggerPrompt: '本群提示',
          cooldownSeconds: 99, // 节流字段属于 flow-control
          idleTriggerStrategy: 'bogus',
        },
      ],
    });
    expect(c.overrides[0]).toEqual({
      scope: 'onebot:group:20002',
      fixedInterval: 20,
      activityScoreLower: 0.5,
      scoreDecayMinutes: 5,
      idleTriggerScope: 'session',
      idleTriggerStyle: 'fixed',
      idleTriggerMinutes: 30,
      idleTriggerJitter: false,
      idleTriggerPrompt: '本群提示',
    });
  });
});

describe('trigger-policy overrides 经 resolveEffectiveConfig 生效', () => {
  it('字符串字段留空（空串/未填）应穿透，不被覆盖为空数组', () => {
    const c = resolveTriggerPolicyConfig({
      triggerNames: 'aalis,bot',
      muteKeywords: 'mute',
      idleTriggerPrompt: 'top-default-prompt',
      fixedInterval: 8,
      overrides: [
        {
          scope: '*:private',
          triggerOnAt: false,
          triggerNames: '', // 空串 → 不覆盖
          muteKeywords: undefined, // undefined → 不覆盖
          idleTriggerPrompt: '', // 空串 → 不覆盖
          fixedInterval: null, // null → 不覆盖
        },
      ],
    });
    expect(c.overrides[0].triggerNames).toBeUndefined();
    expect(c.overrides[0].muteKeywords).toBeUndefined();
    const eff = resolveEffectiveConfig(c, 'onebot', 'private');
    expect(eff.triggerOnAt).toBe(false); // 覆盖生效
    expect(eff.triggerNames).toEqual(['aalis', 'bot']); // 穿透
    expect(eff.muteKeywords).toEqual(['mute']); // 穿透
    expect(eff.idleTriggerPrompt).toBe('top-default-prompt'); // 穿透
    expect(eff.fixedInterval).toBe(8); // 穿透
  });
});
