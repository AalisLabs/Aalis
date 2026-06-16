import { describe, expect, it } from 'vitest';
import { buildCaps, splitCaps } from '../../packages/plugin-webui-client/src/pages/capability-picker-util.js';

// ════════════════════════════════════════════════════════════
// 授权能力选择器 — 纯转换逻辑（权限编辑安全相关：不丢/不串能力）
// ════════════════════════════════════════════════════════════

const known = new Set(['command:deploy', 'command:memory.clear', 'tool:file', 'tool:search']);

describe('splitCaps（已有 grant/deny → 三态 + 高级框）', () => {
  it('精确命中已知能力 → 三态；通配/未知 → 高级框', () => {
    const r = splitCaps('command:deploy, tool:file.*, *', 'tool:file', known);
    expect(r.caps).toEqual({ 'command:deploy': 'grant', 'tool:file': 'deny' });
    expect(r.advGrant).toBe('tool:file.*, *'); // 通配 + 全局 → 高级（非精确已知）
    expect(r.advDeny).toBe(''); // tool:file 精确命中 → 进三态，不留高级
  });

  it('已知能力的通配变体（command:*）不算精确命中 → 留高级框', () => {
    const r = splitCaps('command:*', '', known);
    expect(r.caps).toEqual({});
    expect(r.advGrant).toBe('command:*');
  });

  it('同一能力同时在 grant 与 deny（异常）→ 呈现 deny 态（与 deny>grant 一致）', () => {
    const r = splitCaps('tool:file', 'tool:file', known);
    expect(r.caps).toEqual({ 'tool:file': 'deny' });
  });

  it('空输入 → 空三态 + 空高级', () => {
    expect(splitCaps('', '', known)).toEqual({ caps: {}, advGrant: '', advDeny: '' });
  });
});

describe('buildCaps（三态 + 高级框 → grant/deny 串）', () => {
  it('合并三态与高级框，各自去重', () => {
    const r = buildCaps(
      { 'command:deploy': 'grant', 'tool:search': 'deny' },
      'tool:file.*, command:deploy',
      'storage:*',
    );
    // command:deploy 既在三态 grant 又在高级 grant → 去重
    expect(r.grant.split(', ').sort()).toEqual(['command:deploy', 'tool:file.*'].sort());
    expect(r.deny.split(', ').sort()).toEqual(['storage:*', 'tool:search'].sort());
  });

  it('空 → 空串', () => {
    expect(buildCaps({}, '', '')).toEqual({ grant: '', deny: '' });
  });
});

describe('round-trip：split → build 保持能力集不变（不丢不串）', () => {
  it('精确 + 通配 + 全局混合，集合稳定', () => {
    const grant = 'command:deploy, tool:file.*, *';
    const deny = 'tool:search, command:shutdown'; // command:shutdown 未知 → 高级 deny
    const s = splitCaps(grant, deny, known);
    const b = buildCaps(s.caps, s.advGrant, s.advDeny);
    expect(new Set(b.grant.split(', '))).toEqual(new Set(grant.split(', ')));
    expect(new Set(b.deny.split(', '))).toEqual(new Set(deny.split(', ')));
  });
});
