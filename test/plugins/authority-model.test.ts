import { describe, expect, it } from 'vitest';
import { RESTRICTED_LEVEL } from '../../packages/api-authority/src/index.js';
import {
  DEFAULT_AUTHORITY,
  OWNER_RANK,
  resolveAccess,
  resolveMinLevel,
} from '../../packages/plugin-authority/src/authority-model.js';

// ════════════════════════════════════════════════════════════
// authority-model 裁决引擎（纯函数）：risk→门槛、override>risk>visibility、deny>owner>等级、资源 fail-closed
// 安全相关——deny>owner 不变量、封禁(负数)压过 public 必须钉死。
// ════════════════════════════════════════════════════════════

describe('resolveMinLevel', () => {
  // risk → 等级的映射本身在 @aalis/api-authority 的 capabilityMinLevel，由那边的用例覆盖；
  // 这里只测 authority 自己那一层（overrides 优先级）。曾经这里有个 riskToLevel 转发壳，
  // 零生产调用点、只靠本用例续命，已删。
  it('minLevel 优先级：override(任意整数) > risk > visibility 兜底', () => {
    expect(resolveMinLevel('tool:x', { risk: 'sensitive' })).toBe(1);
    // override 压过 risk，且可为任意整数（不限 0/1/2）
    expect(resolveMinLevel('tool:x', { authorityOverrides: { 'tool:x': 7 }, risk: 'safe' })).toBe(7);
    // 无 risk → visibility 兜底
    expect(resolveMinLevel('tool:x', { visibility: 'restricted' })).toBe(RESTRICTED_LEVEL);
    expect(resolveMinLevel('tool:x', { visibility: 'public' })).toBe(DEFAULT_AUTHORITY);
  });
});

describe('resolveAccess（deny > owner > 等级）', () => {
  const base = { level: DEFAULT_AUTHORITY, minLevel: DEFAULT_AUTHORITY, isOwner: false, capability: 'tool:weather' };

  it('等级达标放行；不足拒（支持任意整数）', () => {
    expect(resolveAccess({ ...base, level: 5, minLevel: 5 })).toBe(true);
    expect(resolveAccess({ ...base, level: 4, minLevel: 5 })).toBe(false);
  });
  it('owner(∞) 放行（等级无关，永不被有限门槛锁出）', () => {
    expect(resolveAccess({ ...base, isOwner: true, level: OWNER_RANK, minLevel: 999 })).toBe(true);
  });
  it('全局硬禁 deniedCapabilities 压过 owner（deny>owner 不变量）', () => {
    expect(resolveAccess({ ...base, isOwner: true, level: OWNER_RANK, denied: ['tool:weather'] })).toBe(false);
    expect(resolveAccess({ ...base, isOwner: true, level: OWNER_RANK, denied: ['tool:*'] })).toBe(false);
  });
  it('封禁(负数) 压过 public/safe：连 minLevel=0 的安全操作也拒', () => {
    expect(resolveAccess({ ...base, level: -1, minLevel: DEFAULT_AUTHORITY })).toBe(false);
  });
});
