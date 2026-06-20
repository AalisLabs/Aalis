// 权限页纯逻辑（与 React 解耦，便于 node 单测）：操作分组、生效最低档/确认解析、档位标签。
// 单 owner 纯档位：用户一个档、操作一个最低档；无 per-user 能力 glob。

import type { TierName } from '@aalis/plugin-authority-api';

export interface Operation {
  key: string;
  name: string;
  type: 'command' | 'tool';
  displayName: string;
  pluginName: string;
  visibility: 'public' | 'restricted';
  /** 原始风险（risk 透传上线后有值）；用于派生默认最低档 */
  risk?: 'safe' | 'sensitive' | 'dangerous';
  confirm?: 'session' | 'always';
}

export type Confirm = 'session' | 'always';
export type ConfirmOverride = Confirm | 'off';

/** 档位标签（前端本地，因不可 import plugin-authority/tier-model）。rank: banned-1 visitor0 friend1 trusted2。 */
export const TIER_LABEL: Record<TierName, string> = { banned: '封禁', visitor: '访客', friend: '朋友', trusted: '信任' };
/** 用户档位段按钮顺序 */
export const USER_TIERS: TierName[] = ['banned', 'visitor', 'friend', 'trusted'];
/** 操作最低档可选项（无 banned；owner 永远在档外） */
export const OP_MIN_TIERS: Array<{ rank: number; label: string }> = [
  { rank: 0, label: '访客' },
  { rank: 1, label: '朋友' },
  { rank: 2, label: '信任' },
];

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

/** risk → 默认最低档：safe0 sensitive1 dangerous2。 */
function riskToRank(risk?: Operation['risk']): number {
  if (risk === 'dangerous') return 2;
  if (risk === 'sensitive') return 1;
  return 0;
}

/** 操作生效最低档（rank）：tierOverrides[cap] > risk 派生 > visibility 兜底(public0/restricted2)。 */
export function effectiveMinTier(op: Operation, tierOverrides: Record<string, number>): number {
  const ov = tierOverrides[capKey(op)];
  if (ov !== undefined) return ov;
  if (op.risk) return riskToRank(op.risk);
  return op.visibility === 'restricted' ? 2 : 0;
}

/** 生效确认：override 优先（'off'→无），回退插件默认。 */
export function effectiveConfirm(op: Operation, confOverrides: Record<string, ConfirmOverride>): Confirm | undefined {
  const o = confOverrides[capKey(op)];
  if (o === 'off') return undefined;
  return o ?? op.confirm;
}

/** 整组最低档聚合：全同→该 rank，否则 'mixed'。 */
export function groupMinTier(ops: Operation[], tierOverrides: Record<string, number>): number | 'mixed' {
  const set = new Set(ops.map(op => effectiveMinTier(op, tierOverrides)));
  return set.size === 1 ? ([...set][0] as number) : 'mixed';
}
