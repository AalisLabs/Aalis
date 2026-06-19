import { describe, expect, it } from 'vitest';
import {
  capKey,
  detectPreset,
  effectiveConfirm,
  effectiveVisibility,
  groupByPlugin,
  groupVisibility,
  type Operation,
  presetToCaps,
} from '../../packages/plugin-webui-client/src/pages/authority-page-util.js';

// ════════════════════════════════════════════════════════════
// 权限页纯逻辑：分组 / 生效策略 / 预设互转（安全相关，不丢不串能力）
// ════════════════════════════════════════════════════════════

const op = (over: Partial<Operation>): Operation => ({
  key: over.name ?? 'x',
  name: over.name ?? 'x',
  type: over.type ?? 'tool',
  displayName: over.displayName ?? over.name ?? 'x',
  pluginName: over.pluginName ?? 'p',
  visibility: over.visibility ?? 'public',
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

describe('effectiveVisibility / effectiveConfirm（override 优先）', () => {
  it('visibility：override(type:name) 优先，回退默认', () => {
    const o = op({ name: 'weather', type: 'tool', visibility: 'public' });
    expect(effectiveVisibility(o, {})).toBe('public');
    expect(effectiveVisibility(o, { 'tool:weather': 'restricted' })).toBe('restricted');
  });
  it("confirm：'off' → 无；override 优先；回退默认", () => {
    const o = op({ name: 'shell.exec', type: 'tool', confirm: 'session' });
    expect(effectiveConfirm(o, {})).toBe('session');
    expect(effectiveConfirm(o, { 'tool:shell.exec': 'always' })).toBe('always');
    expect(effectiveConfirm(o, { 'tool:shell.exec': 'off' })).toBeUndefined();
  });
  it('groupVisibility：全同→该值；混合→mixed', () => {
    const a = op({ name: 'a' });
    const b = op({ name: 'b' });
    expect(groupVisibility([a, b], {})).toBe('public');
    expect(groupVisibility([a, b], { 'tool:b': 'restricted' })).toBe('mixed');
  });
});

describe('预设互转（presetToCaps / detectPreset）', () => {
  it('封禁=deny *；信任=grant *；普通=空', () => {
    expect(presetToCaps('banned')).toEqual({ grant: [], deny: ['*'] });
    expect(presetToCaps('trusted')).toEqual({ grant: ['*'], deny: [] });
    expect(presetToCaps('normal')).toEqual({ grant: [], deny: [] });
  });
  it('detectPreset 反推档位；细调归 custom', () => {
    expect(detectPreset([], [])).toBe('normal');
    expect(detectPreset([], ['*'])).toBe('banned');
    expect(detectPreset(['*'], [])).toBe('trusted');
    expect(detectPreset(['tool:weather'], [])).toBe('custom');
    expect(detectPreset(['*'], ['tool:x'])).toBe('custom'); // grant* 但有 deny → 非纯信任
  });
});
