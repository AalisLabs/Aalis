import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, events, LogHub } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import archivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot() {
  const hub = new LogHub();
  const warnings: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn' && entry.message.includes('message-archive')) warnings.push(entry.message);
  });
  const app = new App({ logHub: hub, name: 'archive-test', logLevel: 'warn' });
  apps.push(app);
  await app.plugin(memoryPlugin);
  await app.plugin(createMockLLMPlugin({ responses: [{ content: '已回复' }] }));
  await app.plugin(agentPlugin);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent, memory, events });
  const replies: string[] = [];
  host.events.on('outbound:message', message => {
    replies.push(message.content);
  });
  const send = (sessionId: string, extra: Partial<IncomingMessage> = {}) =>
    host.agent.require().handleMessage({
      sessionId,
      platform: 'cli',
      userId: 'u1',
      content: '你好',
      ...extra,
    });
  return { app, host, warnings, replies, send };
}

describe('agent 可选归档服务', () => {
  it('加载阶段不误报；实际写入缺归档时每次激活只告警一次，对话继续且不直接写 memory', async () => {
    const h = await boot();
    expect(h.warnings).toEqual([]);

    await h.send('missing-a');
    await h.send('missing-b');
    expect(h.replies).toEqual(['已回复', '已回复']);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('不会写入记忆');
    expect(await h.host.memory.require().getHistory('missing-a', 20)).toEqual([]);
    expect(await h.host.memory.require().getHistory('missing-b', 20)).toEqual([]);

    await h.app.plugins.bounce(agentPlugin.name);
    await h.app.plugins.idle();
    expect(h.warnings).toHaveLength(1);
    await h.send('after-bounce');
    expect(h.warnings).toHaveLength(2);
    expect(h.replies).toEqual(['已回复', '已回复', '已回复']);
  });

  it('归档服务迟到后，无需重启 Agent 就恢复输入与回复归档；再次缺席不刷屏', async () => {
    const h = await boot();
    const instance = h.host.agent.require();
    await h.send('before-archive');
    expect(h.warnings).toHaveLength(1);

    await h.app.plugin(archivePlugin, { debugLogs: false });
    await h.app.plugins.idle();
    expect(h.app.plugins.getPlugin(archivePlugin.name)?.state).toBe('active');
    expect(h.host.agent.require()).toBe(instance);
    await h.send('after-archive');
    const history = await h.host.memory.require().getHistory('after-archive', 20);
    expect(history.map(message => [message.role, message.content])).toEqual([
      ['user', '你好'],
      ['assistant', '已回复'],
    ]);
    expect(h.warnings).toHaveLength(1);

    await h.app.plugins.unload(archivePlugin.name);
    await h.app.plugins.idle();
    await h.send('missing-again');
    expect(h.warnings).toHaveLength(1);
    expect(await h.host.memory.require().getHistory('missing-again', 20)).toEqual([]);
  });

  it('跳过用户入档的主动回合，在保存助手回复时同样提示缺少归档', async () => {
    const h = await boot();
    await h.send('proactive', { source: 'idle-trigger' });
    expect(h.replies).toEqual(['已回复']);
    expect(h.warnings).toHaveLength(1);
    expect(await h.host.memory.require().getHistory('proactive', 20)).toEqual([]);
  });
});
