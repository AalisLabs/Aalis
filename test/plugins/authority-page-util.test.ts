import { describe, expect, it } from 'vitest';
import {
  capKey,
  effectiveConfirm,
  effectiveMinLevel,
  groupByPlugin,
  groupMinLevel,
  type Operation,
} from '../../packages/plugin-webui-client/src/pages/authority-page-util.js';

// ════════════════════════════════════════════════════════════
// 权限页纯逻辑（数字等级）：分组 / 生效最低等级 / 生效确认。
// 定级本身**不在这里**——它收在权限服务侧，前端只做 override 覆盖与渲染。
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
  minLevel: over.minLevel ?? 0,
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

describe('effectiveMinLevel（override > 后端下发的派生默认）', () => {
  // 定级已收进权限服务：前端不再自算，只做 override 覆盖。
  // 曾经这里有一份 derivedMinLevel，在 risk 为非联合成员的真值串时与后端分歧
  // （后端落 visibility 兜底=2、前端只要 risk 为真就吐 0），方向是 fail-open 的显示。
  it('无 override 时原样用后端下发的 minLevel', () => {
    expect(effectiveMinLevel(op({ minLevel: 0 }), {})).toBe(0);
    expect(effectiveMinLevel(op({ minLevel: 2 }), {})).toBe(2);
    // 后端将来加一档 risk（比如 3），前端不需要跟着改
    expect(effectiveMinLevel(op({ minLevel: 3 }), {})).toBe(3);
  });

  it('override 命中则压过下发值', () => {
    const o = op({ minLevel: 2 });
    expect(effectiveMinLevel(o, { [capKey(o)]: 7 })).toBe(7);
    expect(effectiveMinLevel(o, { 'command:other': 7 }), '不是同一个键就不该命中').toBe(2);
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
