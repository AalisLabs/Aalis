// 能力选择器的纯转换逻辑（与 React 解耦，便于单测）：
// - splitCaps：把已有 grant/deny 逗号串拆成「已知命令/工具的三态」+「选择器表达不了的高级 glob」。
// - buildCaps：把三态 + 高级框重新合成 grant/deny 逗号串。
// 权限编辑安全相关——务必保证不丢/不串能力。

export type CapState = 'grant' | 'deny';

const split = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean);

/** 拆解：精确命中 knownIds 的 → 三态；其余（通配/动作/存储/未知）→ 高级框。 */
export function splitCaps(
  grant: string,
  deny: string,
  knownIds: Set<string>,
): { caps: Record<string, CapState>; advGrant: string; advDeny: string } {
  const caps: Record<string, CapState> = {};
  for (const t of split(grant)) if (knownIds.has(t)) caps[t] = 'grant';
  // deny 后写：若同一能力同时出现在 grant 与 deny（异常输入），以 deny 态呈现（与 deny>grant 的裁决一致）。
  for (const t of split(deny)) if (knownIds.has(t)) caps[t] = 'deny';
  const advGrant = split(grant).filter(t => !knownIds.has(t));
  const advDeny = split(deny).filter(t => !knownIds.has(t));
  return { caps, advGrant: advGrant.join(', '), advDeny: advDeny.join(', ') };
}

/** 合成：三态中的 grant/deny 能力 + 高级框各自的 glob → 去重后的 grant/deny 串。 */
export function buildCaps(
  caps: Record<string, CapState>,
  advGrant: string,
  advDeny: string,
): { grant: string; deny: string } {
  const g = [...Object.keys(caps).filter(id => caps[id] === 'grant'), ...split(advGrant)];
  const d = [...Object.keys(caps).filter(id => caps[id] === 'deny'), ...split(advDeny)];
  return { grant: [...new Set(g)].join(', '), deny: [...new Set(d)].join(', ') };
}
