import { expect, vi } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { gateway, windowKey } from '../../packages/api-gateway/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { type SessionInfo, sessionKind } from '../../packages/api-session-manager/src/index.js';
import { type App, type Events, events } from '../../packages/core/src/index.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';

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
 * 入站要经网关的用例发原生入站会执行整条相位链，改用预置
 */
export function storedRoom(sessionId: string, name?: string): Record<string, unknown> {
  const { platform, selfId, sessionType, targetId } = parse(sessionId);
  return {
    id: sessionId,
    ...(name === undefined ? {} : { name }),
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
 * session-manager 替身回的会话档：OneBot 写法的房间 id（四段）带上收录时记下的出生平台与聊天窗口（与预置会话表的
 * {@link storedRoom} 相同），种类按父会话与出生平台推出，与参考实现同一口径
 */
export function sessionInfoOf(id: string, parentId?: string): SessionInfo {
  const { originPlatform, originChat } =
    parentId === undefined && id.split(':').length >= 4
      ? storedRoom(id)
      : { originPlatform: undefined, originChat: undefined };
  const info = {
    id,
    name: id,
    parentId,
    children: [],
    status: 'active' as const,
    createdAt: 0,
    updatedAt: 0,
    ...(originPlatform === undefined
      ? {}
      : { originPlatform: originPlatform as string, originChat: originChat as SessionInfo['originChat'] }),
  };
  return { ...info, kind: sessionKind(info) };
}

/**
 * 把已收录的房间（会话 id → 名字）预置进记忆后端：会话表里的房间记录，与它们所在窗口的场所记录（同一窗口一条，显示名取
 * 先列的那个房间的名字，与房间建档时建的一样）。要在会话管理读表之前调用：启动了整条入站链的用例发原生入站会跑一轮回合，
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

/**
 * 在房间里发指令、拿回执：执行守卫一律放行（/clear 要确认，没有权限插件的守卫时拒绝执行），等 /clear 挂上（指令经归属表挂上，
 * 比激活晚一拍，先发的会落到「Agent 服务不可用」），收这个平台的出站。返回的函数发一条指令，等到它的回执交出
 */
export async function roomCommands(
  app: App,
  room: string,
  platform: string,
): Promise<(content: string) => Promise<OutgoingMessage['content']>> {
  const host = app.bind({ events, commands, gateway });
  host.commands.use.setExecutionGuard(async () => ({ ok: true }));
  await vi.waitFor(() => expect(host.commands.use.has('clear')).toBe(true));
  const sent: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => {
    if (message.platform === platform) sent.push(message);
  });
  return async content => {
    const before = sent.length;
    void host.gateway.use.ingressMessage({ content, sessionId: room, platform, userId: 'zz-user' });
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return sent[before].content;
  };
}
