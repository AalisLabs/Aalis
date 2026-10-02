import { describe, expect, it } from 'vitest';
import { resolveCapabilityPolicy, riskDefaults } from '../../packages/api-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// 能力两轴正交模型：轴 A 授权(visibility) × 轴 B 确认(confirm) + risk 糖 + 自动判危
// ════════════════════════════════════════════════════════════

describe('resolveCapabilityPolicy（risk 展开 + 显式覆盖 + 默认）', () => {
  it('risk 对角线：safe/sensitive/dangerous → (visibility, confirm)', () => {
    expect(resolveCapabilityPolicy({ risk: 'safe' })).toEqual({ visibility: 'public', confirm: undefined });
    expect(resolveCapabilityPolicy({ risk: 'sensitive' })).toEqual({ visibility: 'restricted', confirm: undefined });
    expect(resolveCapabilityPolicy({ risk: 'dangerous' })).toEqual({ visibility: 'restricted', confirm: 'session' });
  });
  it('显式 visibility/confirm 覆盖 risk 推导', () => {
    expect(resolveCapabilityPolicy({ risk: 'dangerous', visibility: 'public' })).toEqual({
      visibility: 'public',
      confirm: 'session',
    });
    expect(resolveCapabilityPolicy({ risk: 'safe', confirm: 'always' })).toEqual({
      visibility: 'public',
      confirm: 'always',
    });
  });
  it('三者皆缺省 → 兜底默认：tools/commands=public，actions=restricted', () => {
    expect(resolveCapabilityPolicy({})).toEqual({ visibility: 'public', confirm: undefined });
    expect(resolveCapabilityPolicy({}, 'restricted')).toEqual({ visibility: 'restricted', confirm: undefined });
  });
  it('正交：(public × confirm) 合法——人人可用但需确认', () => {
    expect(resolveCapabilityPolicy({ visibility: 'public', confirm: 'session' })).toEqual({
      visibility: 'public',
      confirm: 'session',
    });
  });
  it('riskDefaults：无 risk 返回空对象（保留「未声明=继承」语义）', () => {
    expect(riskDefaults(undefined)).toEqual({});
    expect(riskDefaults('dangerous')).toEqual({ visibility: 'restricted', confirm: 'session' });
  });
});
