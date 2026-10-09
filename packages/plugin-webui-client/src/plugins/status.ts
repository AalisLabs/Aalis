import type { UnmetRoot, UnmetService } from '@aalis/api-doctor';
import { withInstance } from '../pages/registry';
import { paths } from '../routes';
import { labelOf, type PluginRow } from './list';

// 插件实例的状态写成一句：插件树上只写短的一句，详情的头部与「需要处理」另写原因，依赖块逐条写缺的服务。缺的服务写链与根
// （服务端按共享判据算好，这里照字段写），链上的显示名与根插件的待配置项从插件列表取。正常运行不上色

interface PluginStatus {
  state?: 'attention' | 'error' | 'running' | 'inactive';
  /** 运行中、启动中、缺服务、等待启动、待配置、失败、已停用 */
  short: string;
}

/** 按实例找插件列表里的一行 */
type FindPlugin = (instance: string) => PluginRow | undefined;

/** 插件实例的名字：显示名（多实例带实例名），插件列表里没有时是实例 id */
export const pluginName = (instance: string, find: FindPlugin): string => {
  const row = find(instance);
  return row ? withInstance(labelOf(row), instance) : instance;
};

export function statusOf(row: Pick<PluginRow, 'state' | 'lacking' | 'unconfigured'>): PluginStatus {
  switch (row.state) {
    case 'active':
      return { short: '运行中' };
    case 'activating':
      return { state: 'running', short: '启动中' };
    case 'pending':
      return row.lacking.length > 0 ? { state: 'attention', short: '缺服务' } : { state: 'running', short: '等待启动' };
    case 'error':
      return row.unconfigured.length > 0 ? { state: 'attention', short: '待配置' } : { state: 'error', short: '失败' };
    case 'disabled':
      return { state: 'inactive', short: '已停用' };
    case 'disposed':
      return { state: 'inactive', short: '已卸载' };
  }
}

/** 列表行首的标记：失败是出错，缺服务与待配置是需要处理，其余没有 */
export const markerOf = ({ state }: PluginStatus) => (state === 'error' || state === 'attention' ? state : undefined);

/** 「只看有问题的」留下的：有标记的，即失败、缺服务与待配置 */
export const hasProblem = (row: Pick<PluginRow, 'state' | 'lacking' | 'unconfigured'>) =>
  markerOf(statusOf(row)) !== undefined;

/**
 * 缺的服务按根合并：同一个根只留最短的那条链。插件常同时要一个服务与依赖它的另一个服务（会话服务要记忆，也要要记忆的会话管理），
 * 根是同一个，写一次就说清了
 */
export function byRoot(lacking: readonly UnmetService[]): UnmetService[] {
  const shortest = new Map<string, UnmetService>();
  for (const unmet of lacking) {
    const key = JSON.stringify(unmet.root);
    const kept = shortest.get(key);
    if (!kept || unmet.chain.length < kept.chain.length) shortest.set(key, unmet);
  }
  return [...shortest.values()];
}

/** 状态与原因写成一句：「缺服务：…」「等待启动：…」「待配置：…」「失败：…」，没有原因时只写状态 */
export function statusLine(
  row: Pick<PluginRow, 'state' | 'error' | 'lacking' | 'waiting' | 'unconfigured'>,
  find: FindPlugin,
): string {
  const { short } = statusOf(row);
  const reason = reasonOf(row, find);
  return reason ? `${short}：${reason}` : short;
}

/** 状态短句之后的原因：缺服务按根写各条链，等待启动写在等的根插件（链的最后一个），待配置写没填的键，失败写失败说明 */
export function reasonOf(
  row: Pick<PluginRow, 'state' | 'error' | 'lacking' | 'waiting' | 'unconfigured'>,
  find: FindPlugin,
): string | undefined {
  if (row.state === 'pending') {
    if (row.lacking.length > 0)
      return byRoot(row.lacking)
        .map(unmet => unmetText(unmet, find))
        .join('；');
    const waited = new Set(row.waiting.map(({ chain }) => pluginName(chain[chain.length - 1], find)));
    return waited.size > 0 ? [...waited].join('、') : undefined;
  }
  if (row.state === 'error')
    return row.unconfigured.length > 0 ? row.unconfigured.join('、') : (row.error ?? '原因见日志');
  return undefined;
}

/** 链的根是什么情形 */
export function rootText(root: UnmetRoot, find: FindPlugin): string {
  switch (root.kind) {
    case 'error': {
      const keys = find(root.instance)?.unconfigured ?? [];
      return keys.length > 0 ? `待配置：${keys.join('、')}` : `失败：${root.error ?? '原因见日志'}`;
    }
    case 'disabled':
      return '已停用';
    case 'starting':
      return `等待 ${pluginName(root.instance, find)} 启动`;
    case 'withdrawn':
      return `在运行但没有提供 ${root.service}`;
    case 'unprovided':
      return `没有已装的插件提供 ${root.service}，可以在插件市场按服务搜 ${root.service}`;
    case 'cycle':
      return `互相等待成环：${root.instances.map(instance => pluginName(instance, find)).join('、')}`;
  }
}

/** 一条缺的服务：链上的插件，括号里写根的情形；没有链（没有提供者）时只写根 */
export function unmetText({ chain, root }: UnmetService, find: FindPlugin): string {
  const path = chain.map(instance => pluginName(instance, find)).join(' → ');
  return path ? `${path}（${rootText(root, find)}）` : rootText(root, find);
}

interface Link {
  to: string;
  label: string;
}

/** 去根插件处理：待配置的去它的配置区，失败、停用与在运行却没在提供的去它的详情；没有提供者、成环与在等时没有根插件可去 */
export function rootAction(root: UnmetRoot, find: FindPlugin): Link | undefined {
  if (root.kind !== 'error' && root.kind !== 'disabled' && root.kind !== 'withdrawn') return undefined;
  const name = pluginName(root.instance, find);
  return root.kind === 'error' && (find(root.instance)?.unconfigured.length ?? 0) > 0
    ? { to: paths.plugin(root.instance, 'config'), label: `去配置 ${name}` }
    : { to: paths.plugin(root.instance), label: `去处理 ${name}` };
}

/** 插件没起来去哪处理：缺服务的去第一条链的根插件；没有根插件可去时，待配置的去它的配置区，其余去它的详情 */
export function fixLink(
  instance: string,
  { lacking, unconfigured }: Pick<PluginRow, 'lacking' | 'unconfigured'>,
  find: FindPlugin,
): Link {
  const root = lacking[0] && rootAction(lacking[0].root, find);
  if (root) return root;
  return unconfigured.length > 0
    ? { to: paths.plugin(instance, 'config'), label: '去配置' }
    : { to: paths.plugin(instance), label: '去处理' };
}
