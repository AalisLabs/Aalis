// 权限页纯逻辑（与 React 解耦，便于 node 单测）：操作分组、生效最低等级/确认解析。
// 单 owner 纯数字等级：用户一个整数等级、操作一个整数最低等级；owner=∞，无 per-user 能力 glob。

export interface Operation {
  key: string;
  name: string;
  type: 'command' | 'tool';
  displayName: string;
  pluginName: string;
  visibility: 'public' | 'restricted';
  /** 原始风险（仅供展示；定级不在前端做） */
  risk?: 'safe' | 'sensitive' | 'dangerous';
  confirm?: 'session' | 'always';
  /**
   * 后端算好的**派生默认**最低等级（不含 authorityOverrides）。
   *
   * 定级收在权限服务一侧，前端只渲染。曾经这里自带一份 `derivedMinLevel`，在 risk 为非联合
   * 成员的真值串时与后端分歧——后端三个 `===` 都不中才落 visibility 兜底（restricted→2），
   * 前端却是 `if (op.risk) return riskToLevel(op.risk)`，只要 risk 为真就再也不看 visibility，
   * 吐 0。方向是 fail-open 的显示：第三方插件把 risk 拼错，权限页会显示「所有人可用」。
   */
  minLevel: number;
}

export type Confirm = 'session' | 'always';
export type ConfirmOverride = Confirm | 'off';

/** 操作的能力键（与后端 authorize/override 键一致）。 */
export const capKey = (op: { type: string; name: string }): string => `${op.type}:${op.name}`;

/** 按 pluginName 分组（插件名字典序；组内保持输入序）。 */
export function groupByPlugin(ops: Operation[]): Array<{ plugin: string; ops: Operation[] }> {
  const m = new Map<string, Operation[]>();
  for (const op of ops) {
    const arr = m.get(op.pluginName);
    if (arr) arr.push(op);
    else m.set(op.pluginName, [op]);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([plugin, list]) => ({ plugin, ops: list }));
}

/** 操作生效最低等级：authorityOverrides[cap] > 后端下发的派生默认。 */
export function effectiveMinLevel(op: Operation, authorityOverrides: Record<string, number>): number {
  const ov = authorityOverrides[capKey(op)];
  if (ov !== undefined) return ov;
  return op.minLevel;
}

/** 生效确认：override 优先（'off'→无），回退插件默认。 */
export function effectiveConfirm(op: Operation, confOverrides: Record<string, ConfirmOverride>): Confirm | undefined {
  const o = confOverrides[capKey(op)];
  if (o === 'off') return undefined;
  return o ?? op.confirm;
}

/** 整组最低等级聚合：全同→该等级，否则 'mixed'。 */
export function groupMinLevel(ops: Operation[], authorityOverrides: Record<string, number>): number | 'mixed' {
  const set = new Set(ops.map(op => effectiveMinLevel(op, authorityOverrides)));
  return set.size === 1 ? ([...set][0] as number) : 'mixed';
}
