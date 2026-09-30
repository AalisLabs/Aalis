import type { RunActivity } from '@aalis/api-remote-agent';
import type { TaskRecord } from './ledger.js';

const ACTION: Record<RunActivity['action'], string> = {
  planning: '规划',
  responding: '回复',
  reading: '读取',
  writing: '写入',
  command: '执行命令',
  tool: '使用工具',
};

const STATUS: Record<RunActivity['status'], string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
};

/** 只投影声明的摘要字段；完整调用结果留在独立的管理端任务日志中。 */
export function normalizeActivity(activity: RunActivity): RunActivity | undefined {
  if (!activity || !Object.hasOwn(ACTION, activity.action) || !Object.hasOwn(STATUS, activity.status)) return;
  const text = (value: unknown, limit: number) =>
    typeof value === 'string'
      ? value
          .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
          .trim()
          .slice(0, limit)
      : undefined;
  const projected: RunActivity = { action: activity.action, status: activity.status };
  for (const key of ['tool', 'target', 'summary'] as const) {
    const value = text(activity[key], key === 'tool' ? 80 : 240);
    if (value) projected[key] = value;
  }
  if (typeof activity.exitCode === 'number' && Number.isSafeInteger(activity.exitCode))
    projected.exitCode = activity.exitCode;
  return projected;
}

/** 默认只交出固定类别；详细文字只供宿主日志和管理界面。 */
export function progressLabel(activity: RunActivity, detailed = false): string | undefined {
  const action = Object.hasOwn(ACTION, activity.action) ? ACTION[activity.action] : undefined;
  const status = Object.hasOwn(STATUS, activity.status) ? STATUS[activity.status] : undefined;
  if (!action || !status) return;
  const base = `${action}（${status}）`;
  if (!detailed) return base;
  const safe = normalizeActivity(activity)!;
  return [
    base,
    safe.tool,
    safe.target,
    safe.summary,
    safe.exitCode === undefined ? undefined : `退出码 ${safe.exitCode}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function currentProgress(task: TaskRecord, detailed = false): { activity: string; at: string } | undefined {
  if (task.state !== 'running' || !task.progress) return undefined;
  const activity = progressLabel(task.progress.activity, detailed);
  if (!activity || !Number.isFinite(task.progress.at)) return undefined;
  const date = new Date(task.progress.at);
  if (Number.isNaN(date.getTime())) return undefined;
  return { activity, at: date.toISOString() };
}
