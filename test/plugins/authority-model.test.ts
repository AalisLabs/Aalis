import { describe, expect, it } from 'vitest';
import { RESTRICTED_LEVEL } from '../../packages/api-authority/src/index.js';
import {
  DEFAULT_AUTHORITY,
  isGrantEntry,
  isGroupName,
  OWNER_RANK,
  resolveAccess,
  resolveMinLevel,
} from '../../packages/plugin-authority/src/authority-model.js';

// ════════════════════════════════════════════════════════════
// authority-model 裁决引擎（纯函数）：risk→门槛、override>risk>visibility、deny>owner>封禁>等级>权限组
// 安全相关——deny>owner 不变量、封禁(负数)压过 public 与权限组必须钉死。
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

describe('resolveAccess（deny > owner > 封禁 > 等级 > 权限组）', () => {
  const base = {
    level: DEFAULT_AUTHORITY,
    minLevel: DEFAULT_AUTHORITY,
    isOwner: false,
    capability: 'tool:weather',
    granted: [],
  };

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
  it('封禁(负数) 先拒：负数的门槛也不放行', () => {
    expect(resolveAccess({ ...base, level: -1, minLevel: -5 })).toBe(false);
  });

  it('权限组放行门槛之上的操作，条目可写通配', () => {
    const shell = { ...base, capability: 'tool:shell_exec', minLevel: 2 };
    expect(resolveAccess(shell)).toBe(false);
    expect(resolveAccess({ ...shell, granted: ['tool:shell_*'] })).toBe(true);
    expect(resolveAccess({ ...shell, granted: ['command:shell_exec', 'tool:file_*'] })).toBe(false);
  });

  it('封禁压过权限组', () => {
    expect(resolveAccess({ ...base, level: -1, minLevel: 2, granted: ['tool:*'] })).toBe(false);
  });

  it('硬禁压过权限组', () => {
    expect(resolveAccess({ ...base, minLevel: 2, granted: ['tool:*'], denied: ['tool:weather'] })).toBe(false);
  });

  it('tool-group: 按工具的分组覆盖，对没有分组的指令不覆盖', () => {
    const granted = ['tool-group:search'];
    expect(resolveAccess({ ...base, minLevel: 1, granted, toolGroups: ['web', 'search'] })).toBe(true);
    expect(resolveAccess({ ...base, minLevel: 1, granted, toolGroups: ['web'] })).toBe(false);
    expect(resolveAccess({ ...base, capability: 'command:search', minLevel: 1, granted })).toBe(false);
  });

  it('写法不对的条目不放行（否则会放行一切）', () => {
    for (const entry of ['*', 'tool-group:*']) {
      expect(resolveAccess({ ...base, minLevel: 2, granted: [entry], toolGroups: ['*'] }), entry).toBe(false);
    }
  });
});

describe('权限组的写法', () => {
  it('条目：tool:、command:（可带通配）与 tool-group:；裸 *、别的前缀与带空白的不收', () => {
    for (const entry of ['tool:file_read', 'tool:*', 'command:clear.all', 'command:*', 'tool-group:system']) {
      expect(isGrantEntry(entry), entry).toBe(true);
    }
    for (const entry of ['*', 'storage:data', 'tool:', 'tool: x', 'tool-group:*', 'tool-group:', 42]) {
      expect(isGrantEntry(entry), String(entry)).toBe(false);
    }
  });

  it('组名：字母、数字、连字符、下划线与中文，不以连字符开头；空白、尖括号、别的文字与保留名不收', () => {
    for (const name of ['helpers', 'group_1', 'web-team', '群友', 'A2', '_x'])
      expect(isGroupName(name), name).toBe(true);
    for (const name of [
      '',
      'a b',
      '<x>',
      'a:b',
      '-ops',
      'チーム',
      'Привет',
      '①',
      '__proto__',
      'constructor',
      'prototype',
    ])
      expect(isGroupName(name), name).toBe(false);
  });
});
