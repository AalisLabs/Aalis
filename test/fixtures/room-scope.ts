import type { MemoryRecallScope } from '../../packages/api-memory/src/index.js';
import type { SessionInfo, SessionManagerService } from '../../packages/api-session-manager/src/index.js';

/**
 * 只实现 resolveConfig、getSession 与登记设置项的会话管理桩，供召回范围的消费方测试用：房间自身写的召回范围优先，
 * 其次按传入的平台取平台档。平台档那一层只有消费方按会话所属平台解析时才生效。sessions 是会话表里的记录，消费方按它取
 * 会话记下的出生平台。消费方登记的设置项不看
 */
export function roomScopeManager(
  rooms: Record<string, MemoryRecallScope> = {},
  profiles: Record<string, MemoryRecallScope> = {},
  sessions: readonly Record<string, unknown>[] = [],
): SessionManagerService {
  const table = new Map(sessions.map(s => [s.id, s as unknown as SessionInfo]));
  return {
    registerSetting: () => () => {},
    getSession: (id: string) => table.get(id),
    resolveConfig(sessionId: string, platform?: string) {
      const scope = rooms[sessionId] ?? (platform ? profiles[platform] : undefined);
      return scope ? { memoryRecallScope: scope } : {};
    },
  } as unknown as SessionManagerService;
}
