// 权限页纯逻辑（与 React 解耦，便于 node 单测）：分组、生效策略解析、用户预设互转。
// 安全相关——务必不丢/不串能力。

export interface Operation {
  key: string;
  name: string;
  type: 'command' | 'tool';
  displayName: string;
  pluginName: string;
  visibility: 'public' | 'restricted';
  confirm?: 'session' | 'always';
}

export type Vis = 'public' | 'restricted';
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
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([plugin, list]) => ({ plugin, ops: list }));
}

/** 生效可见性：override（type:name 键）优先，回退插件默认。 */
export function effectiveVisibility(op: Operation, visOverrides: Record<string, Vis>): Vis {
  return visOverrides[capKey(op)] ?? op.visibility;
}

/** 生效确认：override 优先（'off' → 无确认），回退插件默认。 */
export function effectiveConfirm(op: Operation, confOverrides: Record<string, ConfirmOverride>): Confirm | undefined {
  const o = confOverrides[capKey(op)];
  if (o === 'off') return undefined;
  return o ?? op.confirm;
}

/** 整组可见性聚合态：全 public→'public'，全 restricted→'restricted'，否则 'mixed'。 */
export function groupVisibility(ops: Operation[], visOverrides: Record<string, Vis>): Vis | 'mixed' {
  const set = new Set(ops.map(op => effectiveVisibility(op, visOverrides)));
  return set.size === 1 ? ([...set][0] as Vis) : 'mixed';
}

// ── 用户权限预设（外部身份的一键档位）──────────────────────
export type Preset = 'banned' | 'normal' | 'trusted' | 'custom';

/** 预设 → grant/deny（封禁=deny *；信任=grant *；普通=空）。custom 不走此函数。 */
export function presetToCaps(preset: Exclude<Preset, 'custom'>): { grant: string[]; deny: string[] } {
  if (preset === 'banned') return { grant: [], deny: ['*'] };
  if (preset === 'trusted') return { grant: ['*'], deny: [] };
  return { grant: [], deny: [] }; // normal
}

/** 反推用户当前匹配的预设（用于高亮选中档位）。 */
export function detectPreset(grant: string[] = [], deny: string[] = []): Preset {
  const g = grant.filter(Boolean);
  const d = deny.filter(Boolean);
  if (d.includes('*')) return 'banned';
  if (g.includes('*') && d.length === 0) return 'trusted';
  if (g.length === 0 && d.length === 0) return 'normal';
  return 'custom';
}

export const PRESET_LABEL: Record<Preset, string> = {
  banned: '封禁',
  normal: '普通',
  trusted: '信任',
  custom: '自定义',
};
