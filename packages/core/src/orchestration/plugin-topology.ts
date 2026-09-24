// ============================================================
// plugin-topology.ts — 插件依赖图工具
//
// topoSortByDeps：按"提供者→消费者"方向的 Kahn 拓扑排序，决定激活次序。
// 关闭次序不在这里：那由关停编排按实际依赖与归属树决定（orchestration/close-plan.ts）。
// ============================================================

import type { PluginRecord } from './plugin-activation.js';
import type { Logger } from '../infrastructure/logger.js';

/**
 * 按"提供者 → 消费者"方向的拓扑排序（Kahn），结果正序即激活顺序。
 * required 依赖方排在该服务的每个声明提供者之后，apply 时看到的是最终胜者（重启首选提供者后
 * 不挂到后备上）。首个声明的提供者是硬边（依赖方自己就是首个声明者时不加）；其余提供者若传递地依赖这个依赖方，
 * 不加那条边，不制造伪环。
 *
 * 仅 required 依赖参与建图：optional 的语义是"如果存在则消费"，缺席照样激活，
 * 不应制造排序约束——否则插件之间互为 optional 会产生伪环并退化到声明序。
 *
 * 残留环（仅由 required 形成的真环）按声明序兜底追加。
 */
export function topoSortByDeps(entries: PluginRecord[], logger: Logger): PluginRecord[] {
  const providersOf = new Map<string, string[]>();
  for (const e of entries) {
    for (const descriptor of e.definition.provides ?? []) {
      const ids = providersOf.get(descriptor.name) ?? [];
      if (!ids.includes(e.instanceId)) providersOf.set(descriptor.name, [...ids, e.instanceId]);
    }
  }
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  const entryById = new Map(entries.map(e => [e.instanceId, e]));
  for (const e of entries) {
    inDegree.set(e.instanceId, 0);
    dependents.set(e.instanceId, new Set());
  }
  const edges: Array<[providerId: string, dependent: string, hard: boolean]> = [];
  for (const e of entries) {
    for (const service of e.required) {
      for (const [i, providerId] of (providersOf.get(service) ?? []).entries()) {
        if (providerId !== e.instanceId) edges.push([providerId, e.instanceId, i === 0]);
      }
    }
  }
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...dependents.get(id)!);
    }
    return false;
  };
  // 硬边先全部落下，软边的成环检查才看得到它们
  for (const [providerId, id, hard] of [...edges.filter(edge => edge[2]), ...edges.filter(edge => !edge[2])]) {
    if (dependents.get(providerId)!.has(id) || (!hard && reaches(id, providerId))) continue;
    dependents.get(providerId)!.add(id);
    inDegree.set(id, inDegree.get(id)! + 1);
  }
  const result: PluginRecord[] = [];
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  while (queue.length) {
    const id = queue.shift()!;
    result.push(entryById.get(id)!);
    for (const dep of dependents.get(id) ?? []) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
      if (inDegree.get(dep) === 0) queue.push(dep);
    }
  }
  if (result.length < entries.length) {
    const seen = new Set(result.map(e => e.instanceId));
    for (const e of entries) {
      if (!seen.has(e.instanceId)) result.push(e);
    }
    logger.warn(`topoSortByDeps: 检测到 required 依赖环，残留 ${entries.length - seen.size} 个按声明序追加`);
  }
  return result;
}
