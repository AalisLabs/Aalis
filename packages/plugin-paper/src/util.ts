// ============================================================
// 包内共用的小辅助：错误说明与类别、按码点截断、字节数与时长的可读写法
// ============================================================

import { isRemoteAgentError, type RemoteAgentErrorCode } from '@aalis/api-remote-agent';
import type { TextRef } from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 错误的说明文字 */
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ERROR_CATEGORIES: Record<RemoteAgentErrorCode, TextRef> = {
  unavailable: t('categoryUnavailable'),
  busy: t('categoryBusy'),
  archived: t('categoryArchived'),
  'not-found': t('categoryNotFound'),
  'rate-limited': t('categoryRateLimited'),
  rejected: t('categoryRejected'),
  transient: t('categoryTransient'),
};

/**
 * 远端错误的类别，写进任务的失败原因与拒绝理由（交给模型时取原文）：提供者报错的原文可能带远端可控的内容与本机网络细节，
 * 只进日志
 */
export function category(err: unknown): TextRef {
  return isRemoteAgentError(err) && Object.hasOwn(ERROR_CATEGORIES, err.code)
    ? ERROR_CATEGORIES[err.code]
    : t('categoryLocal');
}

/** 按码点截到 max 个字，截掉了就加省略号（不会切坏代理对） */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/** 落盘或提供者报来的值：表里有就取名字，没有照原值显示 */
export const named = <K extends string>(names: Record<K, TextRef>, value: string): string | TextRef =>
  Object.hasOwn(names, value) ? names[value as K] : value;

/** 字节数的可读写法：B、KB、MB */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时长的可读写法：秒，或分加秒。完成通知的正文取它的原文交给模型，数字照原样写 */
export function formatDuration(ms: number): TextRef {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? t('durationMinutes', { m: minutes, s: seconds % 60 }) : t('durationSeconds', { s: seconds });
}
