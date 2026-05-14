// ============================================================
// plugin-topology.ts — 插件依赖图工具
//
// 从 plugin.ts 拆出的纯依赖图算法：
//   - topoSortByDeps：按"提供者→消费者"方向的 Kahn 拓扑排序
//   - evictDownstreamConsumers：把所有依赖某 provider provided 服务的下游
//     active 插件降级为 pending（用于 updatePluginConfig / bouncePlugin
//     瞬态：provider 即将被 dispose+重启，下游持有的服务引用即失效）
//
// 这些是无状态/弱状态的操作，分出去让 PluginManager 主体只关心生命周期编排。
// ============================================================

import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type { PluginEntry } from './types/plugin.js';

/**
 * 按"提供者 → 消费者"方向的拓扑排序（Kahn）。
 *
 * 关闭顺序 = 此结果反向；激活顺序 = 此结果正序。
 * 服务名 → 提供者映射只取首个 provides 该服务名的 entry，足以表达依赖图。
 *
 * 仅 `requiredDeps` 参与建图：optional 依赖语义为"如果存在则消费"，
 * 由运行时 `service-up`/`service-down` recompute 异步补救（whenService 钩子等），
 * 不应制造排序约束。否则插件之间互相 optional 会产生伪环并退化到声明序。
 *
 * 残留环（仅由 required 形成的真环）按声明序兜底追加。
 */
export function topoSortByDeps(entries: PluginEntry[], logger: Logger): PluginEntry[] {
  const providerOf = new Map<string, string>();
  for (const e of entries) {
    for (const svc of e.module.provides ?? []) {
      if (!providerOf.has(svc)) providerOf.set(svc, e.instanceId);
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
    for (const dep of e.requiredDeps) {
      const providerId = providerOf.get(dep.service);
      if (!providerId || providerId === e.instanceId) continue;
      if (!entryById.has(providerId)) continue;
      if (seenProviders.has(providerId)) continue;
      seenProviders.add(providerId);
      dependents.get(providerId)!.add(e.instanceId);
      inDegree.set(e.instanceId, (inDegree.get(e.instanceId) ?? 0) + 1);
    }
  }
  const result: PluginEntry[] = [];
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

/**
 * 把所有依赖 `provider` 所提供服务的 active 下游消费者降级为 pending。
 *
 * 用于 updatePluginConfig / bouncePlugin：当某 provider 即将被 dispose+重启
 * 时，optional 依赖该 provider 服务的下游插件持有的服务引用会失效，必须 bounce
 * 以重新 apply 拿到新实例。required 依赖则更明显：服务消失 = 必须停。
 *
 * 同步执行（不 await），caller 紧接着会 await softReload 完成全部重激活。
 */
export function evictDownstreamConsumers(args: {
  provider: PluginEntry;
  plugins: ReadonlyMap<string, PluginEntry>;
  rootCtx: Context;
  logger: Logger;
}): void {
  const { provider, plugins, rootCtx, logger } = args;
  const provided = provider.module.provides ?? [];
  if (provided.length === 0) return;
  const providedSet = new Set(provided);
  for (const other of plugins.values()) {
    if (other === provider || other.state !== 'active') continue;
    const allDeps = [...other.requiredDeps, ...other.optionalDeps];
    if (!allDeps.some(d => providedSet.has(d.service))) continue;
    if (other.context) {
      try {
        other.context.dispose();
      } catch (err) {
        logger.error(
          `下游消费者 "${other.instanceId}" dispose 抛错: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      other.context = undefined;
    }
    other.state = 'pending';
    rootCtx.emit('plugin:unloaded', other.instanceId).catch(() => {});
  }
}
