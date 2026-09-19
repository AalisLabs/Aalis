// ============================================================
// plugin-topology.ts — 插件依赖图工具
//
// 从 plugin.ts 拆出的纯依赖图算法：
//   - topoSortByDeps：按"提供者→消费者"方向的 Kahn 拓扑排序
//   - evictDownstreamConsumers：把依赖某 provider provided 服务、且声明了
//     requiresBounceOnDepChange 的下游持活 ctx 插件（active/activating）降级为
//     pending（默认不级联，
//     期望下游惰性 getService；用于 updateConfig / bounce 瞬态：
//     provider 即将被 dispose+重启，下游持有的服务引用即失效）
//
// 这些是无状态/弱状态的操作，分出去让 PluginManager 主体只关心生命周期编排。
// ============================================================

import type { PluginEntry } from '../types/plugin.js';

import type { Logger } from '../context/logger.js';

import { type ActivationDeps, retireEntry } from './plugin-activation.js';

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
 * 关停顺序：消费者先于它依赖的提供者关闭，让消费者的收尾与清理里还能调到下层。
 *
 * 边的来源是框架自己管理的关系，不猜 JavaScript 引用：
 * - 声明的依赖（required 与 optional）当前解析到的胜者归属的插件；
 * - 这次激活（含子模块）实际绑定过的提供者——换人后仍在撤回的旧绑定也在内（只增不减，宁多勿漏）。
 * 经 services 动态查到的服务不产生边。
 *
 * 成环时点名告警，环上节点按注册逆序关闭——环上无法保证人人都先于自己的提供者关闭。
 */
export function closeOrder(
  entries: PluginEntry[],
  winnerOwner: (service: string) => string | undefined,
  logger: Logger,
): PluginEntry[] {
  const ids = entries.map(e => e.instanceId);
  /** contextId（可能是 `插件id/子条目` 或 `插件id#子模块`）→ 归属的插件：最长前缀匹配 */
  const pluginOf = (contextId: string): string | undefined => {
    let best: string | undefined;
    for (const id of ids) {
      const owns = contextId === id || contextId.startsWith(`${id}/`) || contextId.startsWith(`${id}#`);
      if (owns && (best === undefined || id.length > best.length)) best = id;
    }
    return best;
  };

  /** 消费者 → 它依赖的提供者插件 */
  const providersOf = new Map<string, Set<string>>();
  /** 提供者 → 还没关的消费者数 */
  const consumers = new Map<string, number>();
  for (const id of ids) {
    providersOf.set(id, new Set());
    consumers.set(id, 0);
  }
  for (const entry of entries) {
    const owners = new Set<string>(entry.context?.boundProviders ?? []);
    for (const dep of [...entry.requiredDeps, ...entry.optionalDeps]) {
      const owner = winnerOwner(dep.service);
      if (owner !== undefined) owners.add(owner);
    }
    for (const owner of owners) {
      const provider = pluginOf(owner);
      if (provider === undefined || provider === entry.instanceId) continue;
      const set = providersOf.get(entry.instanceId)!;
      if (set.has(provider)) continue;
      set.add(provider);
      consumers.set(provider, consumers.get(provider)! + 1);
    }
  }

  const byId = new Map(entries.map(e => [e.instanceId, e]));
  const result: PluginEntry[] = [];
  // 同为「已无消费者」的节点按注册逆序关（后注册的先关），结果确定
  const ready = ids.filter(id => consumers.get(id) === 0).reverse();
  const done = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    done.add(id);
    result.push(byId.get(id)!);
    const released: string[] = [];
    for (const provider of providersOf.get(id)!) {
      const left = consumers.get(provider)! - 1;
      consumers.set(provider, left);
      if (left === 0) released.push(provider);
    }
    released.sort((a, b) => ids.indexOf(b) - ids.indexOf(a));
    ready.push(...released);
  }
  if (result.length < entries.length) {
    const cyclic = ids.filter(id => !done.has(id)).reverse();
    logger.warn(`关停顺序：依赖成环 [${cyclic.join(', ')}]，环上按注册逆序关闭，无法保证都先于各自的提供者`);
    for (const id of cyclic) result.push(byId.get(id)!);
  }
  return result;
}

/**
 * 把下游消费者降级为 pending —— 仅对显式声明 `requiresBounceOnDepChange: true`
 * 的插件生效。
 *
 * 历史背景：早期 core 默认对所有 active 下游做级联 bounce，前提是所有插件都会
 * 在 apply 时把 `ctx.getService(...)` 的结果缓存到长寿命对象里（class field /
 * 闭包），导致 provider 一旦 dispose+重启，下游缓存的裸引用立刻失效。
 *
 * 当前的契约改为："插件应在每次访问时通过 `ctx.getService(...)` 惰性查询"，
 * 这样 provider 切换天然跟随，无需级联 bounce。绝大多数 first-party 插件已经
 * 满足该契约，因此默认行为是**不**级联 dispose 下游。
 *
 * `requiresBounceOnDepChange: true` 是给少数无法响应式处理状态的插件
 * （或迁移成本高的第三方插件）的逃生舱。
 *
 * 异步执行：逐个 await 被 evict 插件的 disposeAsync——它们正是声明了
 * `requiresBounceOnDepChange` 的状态敏感插件，落盘类清理更需要真正完成。
 * caller 紧接着会 await softReload 完成全部重激活。
 */
export async function evictDownstreamConsumers(
  provider: PluginEntry,
  plugins: ReadonlyMap<string, PluginEntry>,
  deps: ActivationDeps,
): Promise<void> {
  const { logger } = deps;
  const provided = provider.module.provides ?? [];
  if (provided.length === 0) return;
  const providedSet = new Set(provided);
  for (const other of plugins.values()) {
    // 目标集按状态正面枚举 active/activating（'activating' 的在飞下游同样持着
    // 即将失效的 provider 引用，漏疏散会让它抱着死引用完成激活；retireEntry 先写
    // 'pending'，在飞激活由接管检查让位）。不能仅凭 ctx 在场判目标：disabled/
    // error/disposed 的拆卸窗口内 ctx 未清，凭 ctx 会把刚写下的终态覆写回
    // 'pending'——实测复活刚禁用的插件。ctx 判「有没有东西要拆」，状态判
    // 「是不是合法疏散目标」，两个问题两个判据。
    if (other === provider) continue;
    if (other.state !== 'active' && other.state !== 'activating') continue;
    if (!other.module.requiresBounceOnDepChange) continue;
    const allDeps = [...other.requiredDeps, ...other.optionalDeps];
    if (!allDeps.some(d => providedSet.has(d.service))) continue;
    await retireEntry(other, 'pending', deps);
    logger.info(
      `级联 bounce 下游消费者 "${other.instanceId}"（requiresBounceOnDepChange=true，依赖 provider "${provider.instanceId}"）`,
    );
  }
}
