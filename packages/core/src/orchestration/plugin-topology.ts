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
 * 服务名 → 提供者映射只取首个声明 provides 该服务的 entry，足以表达依赖图。
 *
 * 仅 required 依赖参与建图：optional 的语义是"如果存在则消费"，缺席照样激活，
 * 不应制造排序约束——否则插件之间互为 optional 会产生伪环并退化到声明序。
 *
 * 残留环（仅由 required 形成的真环）按声明序兜底追加。
 */
export function topoSortByDeps(entries: PluginRecord[], logger: Logger): PluginRecord[] {
  const providerOf = new Map<string, string>();
  for (const e of entries) {
    for (const descriptor of e.definition.provides ?? []) {
      if (!providerOf.has(descriptor.name)) providerOf.set(descriptor.name, e.instanceId);
    }
  }
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  const entryById = new Map(entries.map(e => [e.instanceId, e]));
  for (const e of entries) {
    inDegree.set(e.instanceId, 0);
    dependents.set(e.instanceId, new Set());
  }
  for (const e of entries) {
    const seenProviders = new Set<string>();
    for (const service of e.required) {
      const providerId = providerOf.get(service);
      if (!providerId || providerId === e.instanceId) continue;
      if (!entryById.has(providerId)) continue;
      if (seenProviders.has(providerId)) continue;
      seenProviders.add(providerId);
      dependents.get(providerId)!.add(e.instanceId);
      inDegree.set(e.instanceId, (inDegree.get(e.instanceId) ?? 0) + 1);
    }
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
