import type { MemoryRecallScope, SessionManagerService } from '../../packages/api-session-manager/src/index.js';

/**
 * 只实现 resolveConfig 的会话管理桩，供召回范围的消费方测试用：房间自身写的召回范围优先，
 * 其次按传入的平台取平台档。平台档那一层只有消费方按会话所属平台解析时才生效。
 */
export function roomScopeManager(
  rooms: Record<string, MemoryRecallScope> = {},
  profiles: Record<string, MemoryRecallScope> = {},
): SessionManagerService {
  return {
    resolveConfig(sessionId: string, platform?: string) {
      const scope = rooms[sessionId] ?? (platform ? profiles[platform] : undefined);
      return scope ? { memoryRecallScope: scope } : {};
    },
  } as unknown as SessionManagerService;
}
