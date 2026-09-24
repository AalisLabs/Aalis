import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig } from '../../packages/api-gateway/src/index.js';
import { resolveFlowControlConfig } from '../../packages/plugin-flow-control/src/config.js';

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

describe('flow-control overrides 经 resolveEffectiveConfig 生效', () => {
  it('留空字段穿透：override 只填部分字段，未填字段沿用顶层默认（不被覆盖为 0/空）', () => {
    const c = resolveFlowControlConfig({
      cooldownSeconds: 5,
      rateLimitWindow: 60,
      rateLimitMaxReplies: 3,
      idleTriggerPrompt: 'top-default-prompt',
      overrides: [
        {
          scope: '*:private',
          cooldownSeconds: 10,
          // 其他字段全留空 / 显式空串 / undefined → 应沿用顶层
          rateLimitWindow: undefined,
          rateLimitMaxReplies: null,
          idleTriggerPrompt: '',
        },
      ],
    });
    const eff = resolveEffectiveConfig(c, 'onebot', 'private');
    expect(eff.cooldownSeconds).toBe(10); // override 生效
    expect(eff.rateLimitWindow).toBe(60); // 穿透
    expect(eff.rateLimitMaxReplies).toBe(3); // 穿透
    expect(eff.idleTriggerPrompt).toBe('top-default-prompt'); // 空串也穿透
  });
});
