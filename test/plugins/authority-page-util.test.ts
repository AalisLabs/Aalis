import { describe, expect, it } from 'vitest';
import {
  capKey,
  effectiveConfirm,
  effectiveMinTier,
  groupByPlugin,
  groupMinTier,
  type Operation,
} from '../../packages/plugin-webui-client/src/pages/authority-page-util.js';

// ════════════════════════════════════════════════════════════
// 权限页纯逻辑（档位）：分组 / 生效最低档 / 生效确认（override > risk > visibility 兜底）
// ════════════════════════════════════════════════════════════

const op = (over: Partial<Operation>): Operation => ({
  key: over.name ?? 'x',
  name: over.name ?? 'x',
  type: over.type ?? 'tool',
  displayName: over.displayName ?? over.name ?? 'x',
  pluginName: over.pluginName ?? 'p',
  visibility: over.visibility ?? 'public',
  risk: over.risk,
  confirm: over.confirm,
});

describe('capKey / groupByPlugin', () => {
  it('capKey = type:name', () => {
    expect(capKey({ type: 'tool', name: 'shell.exec' })).toBe('tool:shell.exec');
    expect(capKey({ type: 'command', name: 'deploy' })).toBe('command:deploy');
  });
  it('按 pluginName 字典序分组，组内保序', () => {
    const groups = groupByPlugin([
      op({ name: 'b', pluginName: 'zeta' }),
      op({ name: 'a', pluginName: 'alpha' }),
      op({ name: 'c', pluginName: 'alpha' }),
    ]);
    expect(groups.map(g => g.plugin)).toEqual(['alpha', 'zeta']);
    expect(groups[0].ops.map(o => o.name)).toEqual(['a', 'c']);
  });
});

describe('effectiveMinTier（override > risk > visibility 兜底）', () => {
  it('risk 派生 safe0/sensitive1/dangerous2', () => {
    expect(effectiveMinTier(op({ risk: 'safe' }), {})).toBe(0);
    expect(effectiveMinTier(op({ risk: 'sensitive' }), {})).toBe(1);
    expect(effectiveMinTier(op({ risk: 'dangerous' }), {})).toBe(2);
  });
  it('无 risk → visibility 兜底（public0/restricted2）', () => {
    expect(effectiveMinTier(op({ name: 'r', visibility: 'restricted' }), {})).toBe(2);
    expect(effectiveMinTier(op({ name: 'p', visibility: 'public' }), {})).toBe(0);
  });
  it('tierOverrides 压过 risk/visibility', () => {
    expect(effectiveMinTier(op({ name: 'w', risk: 'safe' }), { 'tool:w': 2 })).toBe(2);
  });
});

describe('effectiveConfirm / groupMinTier', () => {
  it("confirm：'off'→无；override 优先；回退默认", () => {
    const o = op({ name: 'shell.exec', confirm: 'session' });
    expect(effectiveConfirm(o, {})).toBe('session');
    expect(effectiveConfirm(o, { 'tool:shell.exec': 'always' })).toBe('always');
    expect(effectiveConfirm(o, { 'tool:shell.exec': 'off' })).toBeUndefined();
  });
  it('groupMinTier：全同→该 rank；混合→mixed', () => {
    const a = op({ name: 'a', risk: 'safe' });
    const b = op({ name: 'b', risk: 'safe' });
    expect(groupMinTier([a, b], {})).toBe(0);
    expect(groupMinTier([a, b], { 'tool:b': 2 })).toBe('mixed');
  });
});
