import type { SessionInfo, SessionManagerService } from '../../packages/api-session-manager/src/index.js';

/**
 * 只实现 getSession 的会话管理桩：sessions 是会话表里的记录，跨会话取料的插件按它取会话记下的出生平台（子会话取根会话的）
 */
export function sessionTableManager(sessions: readonly Record<string, unknown>[] = []): SessionManagerService {
  const table = new Map(sessions.map(s => [s.id, s as unknown as SessionInfo]));
  return { getSession: (id: string) => table.get(id) } as unknown as SessionManagerService;
}
