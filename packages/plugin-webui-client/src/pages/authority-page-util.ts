// 权限页纯逻辑（与 React 解耦，便于 node 单测）：操作分组、生效最低等级/确认解析。
// 单 owner 纯数字等级：用户一个整数等级、操作一个整数最低等级；owner=∞，无 per-user 能力 glob。

export interface Operation {
  key: string;
  name: string;
  type: 'command' | 'tool';
  displayName: string;
  pluginName: string;
  visibility: 'public' | 'restricted';
  /** 原始风险（risk 透传上线后有值）；用于派生默认最低等级 */
  risk?: 'safe' | 'sensitive' | 'dangerous';
  confirm?: 'session' | 'always';
  /** 该操作静态触达的资源能力（含自身 type:name + 额外如 storage:write）；用于展示「不同参数触达的细粒度资源」 */
  permissions?: string[];
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

/** risk → 默认最低等级：safe0 sensitive1 dangerous2。 */
function riskToLevel(risk?: Operation['risk']): number {
  if (risk === 'dangerous') return 2;
  if (risk === 'sensitive') return 1;
  return 0;
}

/** 操作的派生默认最低等级（不含 override）：risk 派生 > visibility 兜底(public0/restricted2)。 */
export function derivedMinLevel(op: Operation): number {
  if (op.risk) return riskToLevel(op.risk);
  return op.visibility === 'restricted' ? 2 : 0;
}

/** 操作生效最低等级：authorityOverrides[cap] > 派生默认。 */
export function effectiveMinLevel(op: Operation, authorityOverrides: Record<string, number>): number {
  const ov = authorityOverrides[capKey(op)];
  if (ov !== undefined) return ov;
  return derivedMinLevel(op);
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
