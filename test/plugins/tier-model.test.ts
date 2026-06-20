import { describe, expect, it } from 'vitest';
import {
  OWNER_RANK,
  rankOf,
  resolveAccess,
  resolveMinTier,
  riskToTier,
  TIERS,
  tierName,
} from '../../packages/plugin-authority/src/tier-model.js';

// ════════════════════════════════════════════════════════════
// tier-model 裁决引擎（纯函数）：档位↔rank、risk→门槛、deny>owner>例外>档位、资源 fail-closed
// 安全相关——deny>owner 不变量、禁自授、封禁压过 public 必须钉死。
// ════════════════════════════════════════════════════════════

describe('档位与 rank', () => {
  it('rankOf / tierName 往返', () => {
    expect(rankOf('banned')).toBe(-1);
    expect(rankOf('trusted')).toBe(2);
    expect(tierName(-1)).toBe('banned');
    expect(tierName(0)).toBe('visitor');
    expect(tierName(1)).toBe('friend');
    expect(tierName(2)).toBe('trusted');
    expect(tierName(99)).toBe('trusted'); // 越界向下取最高档名
  });
});

describe('riskToTier / resolveMinTier', () => {
  it('risk → 门槛档：safe0 sensitive1 dangerous2', () => {
    expect(riskToTier('safe')).toBe(TIERS.visitor);
    expect(riskToTier('sensitive')).toBe(TIERS.friend);
    expect(riskToTier('dangerous')).toBe(TIERS.trusted);
    expect(riskToTier(undefined)).toBe(TIERS.visitor);
  });
  it('minTier 优先级：override > risk > visibility 兜底', () => {
    expect(resolveMinTier('tool:x', { risk: 'sensitive' })).toBe(1);
    // override 压过 risk
    expect(resolveMinTier('tool:x', { tierOverrides: { 'tool:x': 2 }, risk: 'safe' })).toBe(2);
    // 无 risk → visibility 兜底
    expect(resolveMinTier('tool:x', { visibility: 'restricted' })).toBe(TIERS.trusted);
    expect(resolveMinTier('tool:x', { visibility: 'public' })).toBe(TIERS.visitor);
  });
});

describe('resolveAccess（deny > owner > 例外grant > 档位）', () => {
  const base = {
    rank: TIERS.visitor,
    minTier: TIERS.visitor,
    isOwner: false,
    capability: 'tool:weather',
  };

  it('档位达标放行；不足拒', () => {
    expect(resolveAccess({ ...base, rank: 1, minTier: 1 })).toBe(true);
    expect(resolveAccess({ ...base, rank: 0, minTier: 1 })).toBe(false);
  });
  it('owner 放行（档位无关）', () => {
    expect(resolveAccess({ ...base, isOwner: true, rank: OWNER_RANK, minTier: 2 })).toBe(true);
  });
  it('全局硬禁 deniedCapabilities 压过 owner（deny>owner 不变量）', () => {
    expect(resolveAccess({ ...base, isOwner: true, rank: OWNER_RANK, denied: ['tool:weather'] })).toBe(false);
    expect(resolveAccess({ ...base, isOwner: true, rank: OWNER_RANK, denied: ['tool:*'] })).toBe(false);
  });
  it('封禁(-1) 压过 public/safe：连 minTier=0 的安全操作也拒', () => {
    expect(resolveAccess({ ...base, rank: TIERS.banned, minTier: TIERS.visitor })).toBe(false);
  });
  it('资源能力 fail-closed：高 minTier 下普通用户被拒、owner 放行', () => {
    const cap = 'storage:path:data:/users.json:read';
    expect(resolveAccess({ rank: 0, minTier: TIERS.trusted, isOwner: false, capability: cap })).toBe(false);
    expect(resolveAccess({ rank: OWNER_RANK, minTier: TIERS.trusted, isOwner: true, capability: cap })).toBe(true);
  });
});
