import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 她的回复落库时记下的自身账号随窗口：子会话没有窗口，取根会话的。多账号时，在后上线的账号所在的群里建的子任务，
// 回复记的是这个账号。适配器桩与 onebot 一样按会话 id 里的账号给身份，认不出的取先上线的账号。
// ════════════════════════════════════════════════════════════

const FIRST = '10000';
const SECOND = '20000';
const ROOM = `onebot:${SECOND}:group:20002`;

const twoAccounts = definePlugin({
  name: 'zz-two-accounts',
  provides: [platform],
  uses: { provide },
  apply: ({ provide }) => {
    provide.use(platform, {
      adapterName: 'OneBot',
      platform: 'onebot',
      getConnections: () => [],
      sendMessage: async () => {},
      getSelfIdentity: (sessionId?: string) =>
        sessionId?.startsWith(`onebot:${SECOND}:`)
          ? { platform: 'onebot', selfId: SECOND, nickname: '<账号乙>' }
          : { platform: 'onebot', selfId: FIRST, nickname: '<账号甲>' },
    });
  },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('回复记下的自身账号随窗口', () => {
  it('多账号时群里建的子任务：回复记的是群所在的账号', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(createMockLLMPlugin({ responses: [{ content: '<回复>' }] }));
    await app.plugin(toolsPlugin, {});
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(sessionManagerPlugin);
    await app.plugin(twoAccounts);
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    for (const name of [sessionManagerPlugin.name, agentPlugin.name]) {
      expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
    }
    const host = app.bind({ agent: agentService, memory, sessionManager });
    const child = await host.sessionManager.use.createChildSession(ROOM, { name: '<子任务>' });

    await host.agent.use.handleMessage({
      content: '<任务>',
      sessionId: child.id,
      platform: 'onebot',
      userId: `parent:${ROOM}`,
      source: 'subtask',
    });

    const replies = (await host.memory.use.getHistory(child.id, 10)).filter(m => m.role === 'assistant');
    expect(replies.map(m => m.metadata?.[WellKnownMetadataKeys.UserId])).toEqual([SECOND]);
  });
});
