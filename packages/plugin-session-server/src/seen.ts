// ════════════════════════════════════════════════════════════
// 「我的」区的已读时间：会话 id → owner 最近一次 session/markSeen 的时刻。落在本插件的插件数据里，
// 换连接、换设备、会话服务重启都一致。她最近一次开口晚于这个时刻，会话就是完成未读。
// ════════════════════════════════════════════════════════════

import { isStorageNotFound, type OwnStorage } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';

/** 私有目录下的已读记录 */
const SEEN = 'seen.json';

export interface SeenStore {
  get(sessionId: string): number | undefined;
  /** 记下看过的时刻并落盘；落盘失败时抛出 */
  mark(sessionId: string, at: number): Promise<void>;
  /** 会话删掉后丢掉它的记录 */
  forget(sessionId: string): Promise<void>;
}

/**
 * 读出已读记录。文件不存在按没有记录起步；内容坏了告警后同样从空起步，下次记已读时覆盖。
 * 读不出来（权限、存储不可用）直接抛出：照空表落盘会覆盖原有记录。
 */
export async function openSeenStore(
  storage: Pick<OwnStorage, 'readFile' | 'writeFile' | 'uri'>,
  logger: Logger,
): Promise<SeenStore> {
  const seen = new Map<string, number>();
  let text: string | undefined;
  try {
    text = String(await storage.readFile(SEEN, 'utf8'));
  } catch (err) {
    if (!isStorageNotFound(err)) throw err;
  }
  if (text !== undefined) {
    try {
      const { seen: entries } = JSON.parse(text) as { seen: Record<string, unknown> };
      for (const [id, at] of Object.entries(entries)) if (typeof at === 'number') seen.set(id, at);
    } catch (err) {
      logger.warn(`已读记录 ${storage.uri(SEEN)} 读不懂，按没有记录起步，下次记已读时覆盖:`, err);
    }
  }

  // 写入排队：后一次落盘等前一次落定，文件里留下的总是最新的那份
  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const body = JSON.stringify({ seen: Object.fromEntries(seen) });
    const write = writing.then(() => storage.writeFile(SEEN, body));
    writing = write.catch(() => {});
    return write;
  };

  return {
    get: sessionId => seen.get(sessionId),
    async mark(sessionId, at) {
      seen.set(sessionId, at);
      await persist();
    },
    async forget(sessionId) {
      if (seen.delete(sessionId)) await persist();
    },
  };
}
