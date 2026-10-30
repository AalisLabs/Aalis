import type { RunActivity } from '@aalis/api-remote-agent';
import type { TextRef } from '@aalis/schema-i18n';
import type { TaskRecord } from './ledger.js';
import { t } from './texts.js';

const ACTION: Record<RunActivity['action'], TextRef> = {
  planning: t('actionPlanning'),
  responding: t('actionResponding'),
  reading: t('actionReading'),
  writing: t('actionWriting'),
  command: t('actionCommand'),
  tool: t('actionTool'),
};

const STATUS: Record<RunActivity['status'], TextRef> = {
  running: t('activityRunning'),
  completed: t('activityCompleted'),
  failed: t('activityFailed'),
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

/**
 * 默认只交出固定类别（经 paper_status 交给模型时取原文）；详细的另带远端给的工具、对象、摘要与退出码，只供宿主日志和管理界面
 */
export function progressLabel(activity: RunActivity, detailed = false): TextRef | undefined {
  const action = Object.hasOwn(ACTION, activity.action) ? ACTION[activity.action] : undefined;
  const status = Object.hasOwn(STATUS, activity.status) ? STATUS[activity.status] : undefined;
  if (!action || !status) return;
  const base = t('annotated', { text: action, note: status });
  if (!detailed) return base;
  const safe = normalizeActivity(activity)!;
  return [
    safe.tool,
    safe.target,
    safe.summary,
    safe.exitCode === undefined ? undefined : t('exitCode', { code: safe.exitCode }),
  ]
    .filter((part): part is string | TextRef => Boolean(part))
    .reduce<TextRef>((head, tail) => t('joined', { head, tail }), base);
}

export function currentProgress(task: TaskRecord, detailed = false): { activity: TextRef; at: string } | undefined {
  if (task.state !== 'running' || !task.progress) return undefined;
  const activity = progressLabel(task.progress.activity, detailed);
  if (!activity || !Number.isFinite(task.progress.at)) return undefined;
  const date = new Date(task.progress.at);
  if (Number.isNaN(date.getTime())) return undefined;
  return { activity, at: date.toISOString() };
}
