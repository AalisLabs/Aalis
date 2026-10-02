import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 历史消息的时间标注只加在发给模型的那一份上：存着的消息不变。内存记忆直接交出存着的消息对象，
// 在它们身上加标注会把标注写进会话历史，界面上的用户消息就带上了「(10/3 04:41)」
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-time-label';
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('历史消息的时间标注', () => {
  it('发给模型的历史带时间标注，存着的用户消息不带', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const recorder: ChatModelRequest[] = [];
    await app.plugin(createMockLLMPlugin({ responses: [{ content: '好的' }], recorder }));
    await app.plugin(toolsPlugin, {});
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
    const host = app.bind({ agent, memory });
    const say = (content: string) =>
      host.agent.require().handleMessage({ content, sessionId: SESSION, platform: 'webui', userId: 'console' });
    const userMessages = async () =>
      (await host.memory.require().getHistory(SESSION)).filter(m => m.role === 'user').map(m => m.content);

    await say('第一句');
    const stored = await userMessages();
    expect(stored).toHaveLength(1);
    await say('第二句');

    expect((await userMessages())[0]).toBe(stored[0]);
    const history = recorder.at(-1)?.messages.find(m => m.role === 'user' && String(m.content).includes('第一句'));
    expect(history?.content).toMatch(/^\(\d{1,2}\/\d{1,2} \d{2}:\d{2}\) /);
  });
});
