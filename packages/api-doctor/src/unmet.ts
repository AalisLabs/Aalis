// ============================================================
// unmet.ts — 「缺」与「在等」的共享判据
//
// pending 的插件是有 required 服务此刻没有提供者。每个这样的服务沿声明提供它的已装插件往下追，直到一个不是 pending 的
// 插件或追不下去的地方，那里就是根。根失败、停用、在运行却没在提供、没有已装的插件提供、互相等待成环，是「缺」：要人
// 处理；根在启动，是「在等」：它启动完就有。runtime 的启动告警、plugin-doctor 的诊断、webui-server 的插件列表与「需要
// 处理」、plugin-cli 的欢迎行与 plugin-package-manager 的卸载闸都调这里，几处的判断与说法因此一致。
//
// 只收普通数据：插件状态快照与当前有提供者的服务名（core 的 `services.names()`）。required 与 optional 按快照里 `uses`
// 每项的 kind 分。判缺看服务名，不看谁声明提供：宿主在根上提供的服务不在任何插件的 provides 里；声明提供它的插件
// 只用来往下追根。
// ============================================================

import type { PluginStatusEntry } from '@aalis/core';

/** 判据读的插件状态：core 插件状态快照里的这几项 */
export type PluginSnapshot = Pick<PluginStatusEntry, 'instanceId' | 'state' | 'provides' | 'uses' | 'error'>;

/**
 * 一条链的根：
 * - `error`：根插件激活失败，`error` 是它的失败说明；
 * - `disabled`：根插件已停用；
 * - `starting`：根插件在启动（激活中，含转入后台的慢激活；或它要的都在了、马上激活）。只是在等，不算缺；
 * - `withdrawn`：根插件在运行，却没在提供 `service`（激活之后自己撤回了，例如模型全被删掉的模型插件）；
 * - `unprovided`：没有已装的插件声明提供 `service`；
 * - `cycle`：几个插件互相等待成环，`instances` 是环上的插件，按等待的先后。
 */
export type UnmetRoot =
  | { kind: 'error'; instance: string; error?: string }
  | { kind: 'disabled'; instance: string }
  | { kind: 'starting'; instance: string }
  | { kind: 'withdrawn'; instance: string; service: string }
  | { kind: 'unprovided'; service: string }
  | { kind: 'cycle'; instances: string[] };

/** 一个没满足的 required 服务，沿一个声明提供它的插件追到的根 */
export interface UnmetService {
  service: string;
  /** 从直接提供者往下、一路没起来的插件实例；根是插件时最后一个就是它，没有提供者与成环时是走到那里之前的 */
  chain: string[];
  root: UnmetRoot;
}

/** 一个 pending 插件没满足的 required 服务 */
export interface UnmetDependencies {
  /** 缺：根失败、停用、在运行却没在提供、没有提供者或成环，要人处理 */
  lacking: UnmetService[];
  /** 在等：根在启动，它启动完就满足 */
  waiting: UnmetService[];
}

/** 提供者自己就是根时的情形，service 是它该提供却没在提供的；pending 的要往下追，没有 */
function rootOf(provider: PluginSnapshot, service: string): UnmetRoot | undefined {
  const instance = provider.instanceId;
  switch (provider.state) {
    case 'error':
      return { kind: 'error', instance, ...(provider.error !== undefined && { error: provider.error }) };
    case 'disabled':
      return { kind: 'disabled', instance };
    case 'activating':
      return { kind: 'starting', instance };
    case 'active':
      return { kind: 'withdrawn', instance, service };
    default:
      return undefined;
  }
}

/** 往下追的一段：从这里到根的插件与根 */
type Trace = Omit<UnmetService, 'service'>;

/** 每个 pending 插件没满足的 required 服务，按实例 id；available 是当前有提供者的服务名 */
export function unmetDependencies(
  plugins: readonly PluginSnapshot[],
  available: Iterable<string>,
): Map<string, UnmetDependencies> {
  const present = new Set(available);
  const unsatisfied = (plugin: PluginSnapshot) => [
    ...new Set(plugin.uses.filter(use => use.kind === 'required' && !present.has(use.service)).map(use => use.service)),
  ];

  /** path：从起点追到这里经过的插件，再遇到其中一个就是成环 */
  const unmetOf = (plugin: PluginSnapshot, path: readonly string[]): UnmetDependencies => {
    const here = [...path, plugin.instanceId];
    const result: UnmetDependencies = { lacking: [], waiting: [] };
    for (const service of unsatisfied(plugin)) {
      const providers = plugins.filter(p => p.state !== 'disposed' && p.provides?.includes(service));
      if (providers.length === 0) {
        result.lacking.push({ service, chain: [], root: { kind: 'unprovided', service } });
        continue;
      }
      // 有一个提供者只是在等，这个服务就是在等：它启动完就有；都不是才是缺，各提供者的根都列出来
      const traced = providers.map(provider => traceProvider(provider, service, here));
      const waits = traced.some(t => t.waits);
      const found = traced.filter(t => t.waits === waits).flatMap(t => t.traces.map(trace => ({ service, ...trace })));
      result[waits ? 'waiting' : 'lacking'].push(...found);
    }
    return result;
  };

  /** 一个提供者：它自己是根，或它也 pending、它缺的就是这条链往下的部分（它只是在等时取在等的部分） */
  const traceProvider = (
    provider: PluginSnapshot,
    service: string,
    path: readonly string[],
  ): { waits: boolean; traces: Trace[] } => {
    const id = provider.instanceId;
    const at = path.indexOf(id);
    if (at >= 0) return { waits: false, traces: [{ chain: [], root: { kind: 'cycle', instances: path.slice(at) } }] };
    const root = rootOf(provider, service);
    if (root) return { waits: root.kind === 'starting', traces: [{ chain: [id], root }] };
    const below = unmetOf(provider, path);
    const waits = below.lacking.length === 0;
    const rest = waits ? below.waiting : below.lacking;
    if (rest.length === 0) return { waits: true, traces: [{ chain: [id], root: { kind: 'starting', instance: id } }] };
    // 它缺的几样可能经同一条链追到同一个根（几个服务都由同一个插件提供），只算一条
    const traces = new Map(
      rest.map(({ chain, root }) => [JSON.stringify([chain, root]), { chain: [id, ...chain], root }]),
    );
    return { waits, traces: [...traces.values()] };
  };

  return new Map(plugins.filter(p => p.state === 'pending').map(p => [p.instanceId, unmetOf(p, [])]));
}

/** 一条链写成一句：缺的写链上的插件与根的情形，在等的写等待谁 */
function traceText({ chain, root }: Trace): string {
  const path = chain.join(' → ');
  switch (root.kind) {
    case 'error':
      return `${path} 失败：${root.error ?? '原因见日志'}`;
    case 'disabled':
      return `${path} 已停用`;
    case 'starting':
      return `等待 ${root.instance} 启动`;
    case 'withdrawn':
      return `${path} 在运行但没有提供 ${root.service}`;
    case 'unprovided':
      return path ? `${path} → 没有已装的插件提供 ${root.service}` : '没有已装的插件提供';
    case 'cycle':
      return `${path ? `${path} → ` : ''}互相等待成环：${root.instances.join('、')}`;
  }
}

/** 一个插件没满足的写成一句（启动告警、诊断与回执用）：缺的逐条写服务与链，在等的写等待谁，同一句只写一次 */
export function describeUnmet({ lacking, waiting }: UnmetDependencies): string {
  return [
    ...lacking.map(unmet => `缺少服务 ${unmet.service}（${traceText(unmet)}）`),
    ...new Set(waiting.map(traceText)),
  ].join('；');
}
