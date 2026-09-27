// ============================================================
// 包内共用的小辅助：错误说明、按码点截断、字节数与时长的可读写法
// ============================================================

/** 错误的说明文字 */
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
