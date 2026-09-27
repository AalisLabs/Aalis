// ============================================================
// 包内共用的小辅助：错误说明与类别、按码点截断、字节数与时长的可读写法
// ============================================================

import { isRemoteAgentError, type RemoteAgentErrorCode } from '@aalis/api-remote-agent';

/** 错误的说明文字 */
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ERROR_CATEGORIES: Record<RemoteAgentErrorCode, string> = {
  unavailable: '提供者不可用',
  busy: '代理忙',
  archived: '代理已归档',
  'not-found': '远端找不到',
  'rate-limited': '远端限流',
  rejected: '远端拒绝了请求',
  transient: '远端临时故障',
};

/**
 * 远端错误的类别，写进任务的失败原因与拒绝理由：提供者报错的原文可能带远端可控的内容与本机网络细节，只进日志
 */
export function category(err: unknown): string {
  return isRemoteAgentError(err) && Object.hasOwn(ERROR_CATEGORIES, err.code)
    ? ERROR_CATEGORIES[err.code]
    : '本机处理出错';
}

/** 按码点截到 max 个字，截掉了就加省略号（不会切坏代理对） */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/** 字节数的可读写法：B、KB、MB */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时长的可读写法：秒，或分加秒 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
