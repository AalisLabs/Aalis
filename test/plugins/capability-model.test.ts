import { describe, expect, it } from 'vitest';
import {
  type CapabilityResolution,
  capMatches,
  hasCapability,
  matchAnyCap,
} from '../../packages/plugin-authority/src/capability-model.js';

// ════════════════════════════════════════════════════════════
// 能力模型纯函数（单 owner 终态：无委托子集，故无 rejectedDelegations）
// ════════════════════════════════════════════════════════════

describe('capMatches（能力 glob 匹配）', () => {
  it('精确 + 全通配 + 段通配', () => {
    expect(capMatches('tool:foo', 'tool:foo')).toBe(true);
    expect(capMatches('*', 'anything:here')).toBe(true);
    expect(capMatches('tool:*', 'tool:foo')).toBe(true);
    expect(capMatches('storage:*:write', 'storage:data:write')).toBe(true);
    expect(capMatches('storage:path:*:write', 'storage:path:data:/users.json:write')).toBe(true);
  });
  it('不匹配 + 无通配的字面量', () => {
    expect(capMatches('tool:foo', 'tool:bar')).toBe(false);
    expect(capMatches('tool:foo', 'tool:foobar')).toBe(false);
    expect(capMatches('tool:*', 'command:foo')).toBe(false);
  });
  it('正则特殊字符按字面处理（不破匹配）', () => {
    expect(capMatches('storage:path:data:/a.json:write', 'storage:path:data:/a.json:write')).toBe(true);
    expect(capMatches('storage:path:data:/a.json:write', 'storage:path:data:/aXjson:write')).toBe(false);
  });
});

describe('matchAnyCap', () => {
  it('任一命中即真', () => {
    expect(matchAnyCap(['command:*', 'tool:foo'], 'tool:foo')).toBe(true);
    expect(matchAnyCap(['command:*'], 'tool:foo')).toBe(false);
    expect(matchAnyCap([], 'tool:foo')).toBe(false);
  });
});

describe('hasCapability（deny > owner > public > granted）', () => {
  const base = (o: Partial<CapabilityResolution>): CapabilityResolution => ({
    isOwner: false,
    publicCaps: [],
    grants: [],
    denies: [],
    ...o,
  });

  it('public 能力所有人默认拥有', () => {
    expect(hasCapability(base({ publicCaps: ['tool:weather'] }), 'tool:weather')).toBe(true);
  });
  it('restricted（非 public）未授予则无', () => {
    expect(hasCapability(base({}), 'tool:shutdown')).toBe(false);
  });
  it('被授予的 restricted 能力生效', () => {
    expect(hasCapability(base({ grants: ['tool:shutdown'] }), 'tool:shutdown')).toBe(true);
    expect(hasCapability(base({ grants: ['storage:*:write'] }), 'storage:data:write')).toBe(true);
  });
  it('owner = `*` 拥有一切', () => {
    expect(hasCapability(base({ isOwner: true }), 'storage:path:data:/users.json:write')).toBe(true);
  });
  it('deny 最高优先——连 owner / public / granted 都压过', () => {
    expect(hasCapability(base({ isOwner: true, denies: ['tool:shutdown'] }), 'tool:shutdown')).toBe(false);
    expect(hasCapability(base({ publicCaps: ['tool:weather'], denies: ['tool:weather'] }), 'tool:weather')).toBe(false);
    expect(hasCapability(base({ grants: ['tool:x'], denies: ['tool:*'] }), 'tool:x')).toBe(false);
  });
});
