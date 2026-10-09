import { windowKey } from '../../packages/api-gateway/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { Events } from '../../packages/core/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// IM 房间的测试件。房间的来源字段（出生平台与聊天窗口）只在会话管理收到原生入站、按这条消息建档时记下，
// 按 id 建档（ensureSession）建不出房间：用例经原生入站收录房间（与生产路径相同），或把收录过的记录预置进会话表。
// 会话 id 用 OneBot 的写法 `onebot:<机器人账号>:<类型名>:<目标>`，测试件按它拆出消息上的字段。
// ════════════════════════════════════════════════════════════

/** 会话 id 拆出的平台、机器人账号、类型名与目标 */
function parse(sessionId: string) {
  const [platform = '', selfId = '', sessionType = '', ...target] = sessionId.split(':');
  return { platform, selfId, sessionType, targetId: target.join(':') };
}

/** 房间会话 id 对应的原生入站：private 带对端账号与昵称，其余类型带群号与群名；name 缺省时消息上不带名字 */
function roomInbound(sessionId: string, name?: string): IncomingMessage {
  const { platform, selfId, sessionType, targetId } = parse(sessionId);
  return {
    content: '<占位>',
    sessionId,
    platform,
    selfId,
    sessionType,
    ...(sessionType === 'private' ? { userId: targetId, nickname: name } : { groupId: targetId, groupName: name }),
  };
}

/** 发一条原生入站收录房间，等建档与所属实例的解析落定（只让出一次事件循环，不经定时器） */
export async function recordRoom(events: Pick<Events, 'emit'>, sessionId: string, name?: string): Promise<void> {
  await events.emit('inbound:message', roomInbound(sessionId, name));
  await new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * 会话表里一条已收录的房间记录，来源字段与 OneBot 的声明相同（private 为一对一，其余类型为多方），供预置会话表：
 * 入站要经网关的用例发原生入站会跑完整条相位链，改用预置
 */
export function storedRoom(sessionId: string, name = sessionId): Record<string, unknown> {
  const { platform, selfId, sessionType, targetId } = parse(sessionId);
  return {
    id: sessionId,
    name,
    children: [],
    status: 'waiting',
    config: {},
    createdAt: 0,
    updatedAt: 0,
    originPlatform: platform,
    originChat: { type: sessionType, multiParty: sessionType !== 'private', selfId, targetId },
  };
}

/**
 * 把已收录的房间（会话 id → 名字）预置进记忆后端：会话表里的房间记录，与它们所在窗口的场所记录（同一窗口一条，显示名取
 * 先列的那个房间的名字，与房间建档时建的一样）。要在会话管理读表之前调用：起了整条入站链的用例发原生入站会跑一轮回合，
 * 改用预置
 */
export async function seedRooms(memory: Pick<MemoryService, 'commitMetadata'>, rooms: Record<string, string>) {
  const windows = new Map<string, Record<string, unknown>>();
  for (const [id, name] of Object.entries(rooms)) {
    const { platform, sessionType, targetId } = parse(id);
    const key = windowKey({ platform, type: sessionType, targetId });
    if (!windows.has(key)) windows.set(key, { key, kind: 'window', name, config: {}, createdAt: 0, updatedAt: 0 });
  }
  await memory.commitMetadata([
    ...Object.entries(rooms).map(([id, name]) => ({
      op: 'put' as const,
      namespace: 'sessions',
      key: id,
      data: storedRoom(id, name),
    })),
    ...[...windows].map(([key, data]) => ({ op: 'put' as const, namespace: 'places', key, data })),
  ]);
}
