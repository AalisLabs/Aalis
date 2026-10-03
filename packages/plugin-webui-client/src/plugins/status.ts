import type { PluginRow } from './list';

// 插件实例的状态写成一句：插件树上只写短的一句，详情的头部另写原因。正常运行不上色

interface PluginStatus {
  state?: 'attention' | 'error' | 'running' | 'inactive';
  /** 运行中、启动中、缺服务、失败、已停用 */
  short: string;
  reason?: string;
}

export function statusOf(row: Pick<PluginRow, 'state' | 'error' | 'missing'>): PluginStatus {
  switch (row.state) {
    case 'active':
      return { short: '运行中' };
    case 'activating':
      return { state: 'running', short: '启动中' };
    case 'pending':
      return { state: 'attention', short: '缺服务', reason: row.missing.join('、') || undefined };
    case 'error':
      return { state: 'error', short: '失败', reason: row.error ?? '原因见日志' };
    case 'disabled':
      return { state: 'inactive', short: '已停用' };
    case 'disposed':
      return { state: 'inactive', short: '已卸载' };
  }
}

/** 列表行首的标记：失败是出错，缺服务是需要处理，其余没有 */
export const markerOf = ({ state }: PluginStatus) => (state === 'error' || state === 'attention' ? state : undefined);

/** 「只看有问题的」留下的：有标记的，即失败与缺服务 */
export const hasProblem = (row: Pick<PluginRow, 'state' | 'error' | 'missing'>) =>
  markerOf(statusOf(row)) !== undefined;
