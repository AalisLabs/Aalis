import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { userRelation } from '../../packages/api-user-relation/src/index.js';
import { App, logger, provide } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userRelationPlugin, { type RelationService } from '../../packages/plugin-user-relation/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { sessionTableManager } from '../fixtures/session-table.js';
import { turnInput } from '../fixtures/turn-input.js';

// ════════════════════════════════════════════════════════════
// 关系图的「仅在群聊中注入」（groupOnly）按会话记下的多方标记判：根会话的聊天窗口是多方才注入（子会话取根会话的），
// 不看上下文里的消息带不带群号、类型名是不是 group。第三方平台的多方房间同样注入；WebUI 会话没有聊天窗口，不注入；
// owner 从 WebUI 往群房间插话，这一轮的消息不带群号，照样注入。会话管理不在时判不出，不注入。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';
/** 第三方平台的多方房间：消息不带群号 */
const FORUM_ROOM = 'forum:bot1:room:r1';
const WEBUI = 'session-abcd1234';
const CHILD = 'session-child001';

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 装上关系图插件（只开注入、仅群聊），会话表里是这些记录；会话管理不装时 sessions 为 undefined */
async function boot(sessions: readonly Record<string, unknown>[] | undefined) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  if (sessions) app.bind({ provide }).provide.use(sessionManager, sessionTableManager(sessions));
  await app.plugin(userRelationPlugin, {
    extractionEnabled: false,
    toolsEnabled: false,
    commandsEnabled: false,
    agentInjection: true,
    groupOnly: true,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userRelationPlugin.name)?.state !== 'active')
    throw new Error('plugin-user-relation 未激活');
  const host = app.bind({ contributions, logger, relation: userRelation });
  const service = host.relation.use as RelationService;
  await service.observePerson('onebot', 'u1', 'Alice');
  await service.observePerson('onebot', 'u2', 'Bob');
  await service.observePerson('webui', 'console', 'Owner');
  await service.addPersonPersonEdge({ fromPersonId: 'onebot:u1', toPersonId: 'onebot:u2', relationType: 'friend' });
  await service.addPersonPersonEdge({ fromPersonId: 'webui:console', toPersonId: 'onebot:u2', relationType: 'friend' });

  /** 跑一次这个会话里的注入（默认 onebot 的 u1 说话），上下文的消息不带群号与类型名；注入了就返回 true */
  return async (
    sessionId: string,
    {
      metadata = {},
      platform = 'onebot',
      userId = 'u1',
    }: { metadata?: Record<string, unknown>; platform?: string; userId?: string } = {},
  ) => {
    const messages: Message[] = [
      { role: 'system', content: '人设' },
      { role: 'user', content: '你好', metadata },
    ];
    await assemblePromptContributions(host, { messages, sessionId, platform }, [
      turnInput({ userId, platform, triggerType: 'direct' }),
    ]);
    return messages.some(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
  };
}

describe('plugin-user-relation：仅在群聊中注入按会话记下的多方标记', () => {
  const TABLE = [
    storedRoom(GROUP),
    storedRoom(PRIVATE),
    storedRoom(FORUM_ROOM),
    { id: WEBUI, children: [], status: 'waiting', config: {}, createdAt: 0, updatedAt: 0 },
    { id: CHILD, parentId: GROUP, children: [], status: 'waiting', config: {}, createdAt: 0, updatedAt: 0 },
  ];

  it('多方房间注入（第三方平台的、owner 从 WebUI 插话的、群里的子任务）：消息不带群号也注入', async () => {
    const injects = await boot(TABLE);
    expect(await injects(FORUM_ROOM), '第三方平台的多方房间').toBe(true);
    expect(await injects(GROUP, { platform: 'webui', userId: 'console' }), 'owner 从 WebUI 往群房间插话').toBe(true);
    expect(await injects(CHILD), '群里的子任务').toBe(true);
  });

  it('一对一窗口与 WebUI 会话不注入：消息带了群号与类型名也不算', async () => {
    const injects = await boot(TABLE);
    const metadata = { groupId: '20001', sessionType: 'group' };
    expect(await injects(PRIVATE, { metadata }), '私聊').toBe(false);
    expect(await injects(WEBUI, { metadata }), 'WebUI 会话').toBe(false);
  });

  it('会话管理不在：判不出，不注入', async () => {
    const injects = await boot(undefined);
    expect(await injects(GROUP, { metadata: { groupId: '20001', sessionType: 'group' } })).toBe(false);
  });
});
