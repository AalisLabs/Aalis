import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { sessionInfoOf } from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 群聊焦点指引：多方与否取会话管理里根会话记下的聊天窗口（建档时按出生平台的适配器声明算出），每轮开轮时取一次，不按每条
// 消息现算：频道与群里被点名时注入，一对一的与插话的不注入；owner 从 WebUI 往群里发的话照样按群算。会话管理不在时按不是多方。
// 会话管理是按 id 现造记录的替身（onebot 的房间，private 为一对一，其余类型为多方）。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(withSessions: boolean) {
  const recorder: ChatModelRequest[] = [];
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  if (withSessions) {
    app.bind({ provide }).provide.use(sessionManager, {
      getSession: (id: string) => sessionInfoOf(id),
    } as unknown as SessionManagerService);
  }
  let replies = 0;
  await app.plugin(createMockLLMPlugin({ recorder, responses: () => ({ content: `好 ${++replies}` }) }));
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const agent = app.bind({ agent: agentService }).agent.use;
  /** 这一轮发给模型的请求里有没有焦点指引 */
  return async (type: string, message: Partial<IncomingMessage>) => {
    await agent.handleMessage({
      content: '你怎么看',
      sessionId: `onebot:10000:${type}:20001`,
      platform: 'onebot',
      userId: 'u1',
      ...message,
    });
    return recorder.at(-1)!.messages.some(m => m.metadata?.injector === 'focus-guidance');
  };
}

describe('群聊焦点指引', () => {
  it('按根会话记下的多方标记：频道与群里被点名时注入，私聊与插话不注入；从 WebUI 往群里发的照样按群算', async () => {
    const focused = await boot(true);
    expect(await focused('channel', { triggerType: 'immediate' }), '频道').toBe(true);
    expect(await focused('group', { triggerType: 'direct' }), '群').toBe(true);
    expect(await focused('private', { triggerType: 'direct' }), '私聊').toBe(false);
    expect(await focused('group', { triggerType: 'interval' }), '插话').toBe(false);
    expect(
      await focused('group', { platform: 'webui', userId: 'console', triggerType: 'direct' }),
      'WebUI 往群里',
    ).toBe(true);
  });

  it('会话管理不在：按不是多方，不注入', async () => {
    const focused = await boot(false);
    expect(await focused('group', { triggerType: 'immediate' })).toBe(false);
  });
});
