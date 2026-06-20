import { describe, expect, it } from 'vitest';
import {
  autoConfirmActive,
  DEFAULT_AUTHORITY,
  OWNER_RANK,
  RESTRICTED_LEVEL,
  resolveAccess,
  resolveMinLevel,
  riskToLevel,
} from '../../packages/plugin-authority/src/authority-model.js';

// ════════════════════════════════════════════════════════════
// authority-model 裁决引擎（纯函数）：risk→门槛、override>risk>visibility、deny>owner>等级、资源 fail-closed
// 安全相关——deny>owner 不变量、封禁(负数)压过 public 必须钉死。
// ════════════════════════════════════════════════════════════

describe('riskToLevel / resolveMinLevel', () => {
  it('risk → 门槛等级：safe0 sensitive1 dangerous2', () => {
    expect(riskToLevel('safe')).toBe(0);
    expect(riskToLevel('sensitive')).toBe(1);
    expect(riskToLevel('dangerous')).toBe(2);
    expect(riskToLevel(undefined)).toBe(DEFAULT_AUTHORITY);
  });
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
  it('资源能力 fail-closed：高 minLevel 下普通用户被拒、owner 放行', () => {
    const cap = 'storage:path:data:/users.json:read';
    expect(resolveAccess({ level: 0, minLevel: RESTRICTED_LEVEL, isOwner: false, capability: cap })).toBe(false);
    expect(resolveAccess({ level: OWNER_RANK, minLevel: RESTRICTED_LEVEL, isOwner: true, capability: cap })).toBe(true);
  });
});

describe('autoConfirmActive（auto 模式开关）', () => {
  const now = 1_000_000;
  it('-1=一直；未来截止=激活；0/过期=关', () => {
    expect(autoConfirmActive(-1, now)).toBe(true);
    expect(autoConfirmActive(now + 60000, now)).toBe(true);
    expect(autoConfirmActive(now - 1, now)).toBe(false);
    expect(autoConfirmActive(0, now)).toBe(false);
  });
});
