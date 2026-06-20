import { describe, expect, it } from 'vitest';
import {
  capKey,
  derivedMinLevel,
  effectiveConfirm,
  effectiveMinLevel,
  groupByPlugin,
  groupMinLevel,
  type Operation,
} from '../../packages/plugin-webui-client/src/pages/authority-page-util.js';

// ════════════════════════════════════════════════════════════
// 权限页纯逻辑（数字等级）：分组 / 派生默认 / 生效最低等级 / 生效确认（override > risk > visibility 兜底）
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

describe('derivedMinLevel / effectiveMinLevel（override > risk > visibility 兜底）', () => {
  it('派生默认：risk safe0/sensitive1/dangerous2', () => {
    expect(derivedMinLevel(op({ risk: 'safe' }))).toBe(0);
    expect(derivedMinLevel(op({ risk: 'sensitive' }))).toBe(1);
    expect(derivedMinLevel(op({ risk: 'dangerous' }))).toBe(2);
  });
  it('派生默认：无 risk → visibility 兜底（public0/restricted2）', () => {
    expect(derivedMinLevel(op({ visibility: 'restricted' }))).toBe(2);
    expect(derivedMinLevel(op({ visibility: 'public' }))).toBe(0);
  });
  it('authorityOverrides 压过派生（任意整数）', () => {
    expect(effectiveMinLevel(op({ name: 'w', risk: 'safe' }), { 'tool:w': 7 })).toBe(7);
    expect(effectiveMinLevel(op({ name: 'w', risk: 'safe' }), {})).toBe(0);
  });
});

describe('effectiveConfirm / groupMinLevel', () => {
  it("confirm：'off'→无；override 优先；回退默认", () => {
    const o = op({ name: 'shell.exec', confirm: 'session' });
    expect(effectiveConfirm(o, {})).toBe('session');
    expect(effectiveConfirm(o, { 'tool:shell.exec': 'always' })).toBe('always');
    expect(effectiveConfirm(o, { 'tool:shell.exec': 'off' })).toBeUndefined();
  });
  it('groupMinLevel：全同→该等级；混合→mixed', () => {
    const a = op({ name: 'a', risk: 'safe' });
    const b = op({ name: 'b', risk: 'safe' });
    expect(groupMinLevel([a, b], {})).toBe(0);
    expect(groupMinLevel([a, b], { 'tool:b': 2 })).toBe('mixed');
  });
});
