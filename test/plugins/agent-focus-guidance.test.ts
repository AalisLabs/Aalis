import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { ONEBOT_TYPES } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 群聊焦点指引按这条消息的多方标记注入，与网关算聊天范围同一个算法（chatScopeOf 加这个平台适配器的类型声明）：频道等
// 多方窗口里被点名时注入，一对一的不注入，不认类型名 group。不依赖会话管理；平台服务缺席时按没声明类型判（group 这类
// 不在声明里的类型名按多方）。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(withPlatform: boolean) {
  const recorder: ChatModelRequest[] = [];
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  if (withPlatform) {
    await app.plugin(
      definePlugin({
        name: 'zz-onebot',
        provides: [platform],
        uses: { provide },
        apply: ({ provide }) => {
          provide.use(platform, {
            platform: 'onebot',
            adapterName: 'zz-onebot',
            sessionTypes: ONEBOT_TYPES,
            getConnections: () => [],
            sendMessage: async () => {},
          } as never);
        },
      }),
    );
  }
  let replies = 0;
  await app.plugin(createMockLLMPlugin({ recorder, responses: () => ({ content: `好 ${++replies}` }) }));
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const agent = app.bind({ agent: agentService }).agent.use;
  /** 这一轮发给模型的请求里有没有焦点指引 */
  return async (message: Partial<IncomingMessage>) => {
    await agent.handleMessage({
      content: '你怎么看',
      sessionId: `onebot:10000:${message.sessionType}:20001`,
      platform: 'onebot',
      userId: 'u1',
      groupId: '20001',
      ...message,
    });
    return recorder.at(-1)!.messages.some(m => m.metadata?.injector === 'focus-guidance');
  };
}

describe('群聊焦点指引', () => {
  it('按平台声明的多方标记：频道与群里被点名时注入，私聊与插话回合不注入', async () => {
    const focused = await boot(true);
    expect(await focused({ sessionType: 'channel', triggerType: 'immediate' }), '频道').toBe(true);
    expect(await focused({ sessionType: 'group', triggerType: 'direct' }), '群').toBe(true);
    expect(await focused({ sessionType: 'private', triggerType: 'direct' }), '私聊').toBe(false);
    expect(await focused({ sessionType: 'channel', triggerType: 'interval' }), '插话').toBe(false);
  });

  it('平台服务缺席时按没声明类型判：group 按多方注入，private 按一对一不注入', async () => {
    const focused = await boot(false);
    expect(await focused({ sessionType: 'group', triggerType: 'immediate' })).toBe(true);
    expect(await focused({ sessionType: 'private', triggerType: 'immediate' })).toBe(false);
  });
});
