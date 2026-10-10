import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, events, type Logger, type PluginDefinition, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 会话没设模型时用 llm 服务的偏好；偏好指向的模型不在（模型删了、提供者在重载或激活失败）时服务落到别的模型上，
// 回合照常回复，但不静默：每个（偏好，实际）组合告警一次，写明偏好与实际用的模型。
// ════════════════════════════════════════════════════════════

const GONE = '@aalis/test-fixture-mock-llm/gone';
const ACTUAL = '@aalis/test-fixture-mock-llm/mock-model';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function use(app: App, module: PluginDefinition, config?: Record<string, unknown>): Promise<void> {
  await app.plugin(module, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(module.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${module.name} 未激活（state=${state}）`);
}

describe('plugin-agent: 偏好的模型没有生效', () => {
  it('偏好指向不在的模型：回合照常回复，告警一条写明偏好与实际，第二轮不重复', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const app = new App({ name: 'T', logLevel: 'error', logger });
    apps.push(app);
    await registerHubs(app);
    await use(app, createMockLLMPlugin({ responses: [{ content: '在的' }, { content: '还在' }] }));
    await use(app, memoryInMemoryPlugin);
    await use(app, messageArchivePlugin, { debugLogs: false });
    await use(app, agentPlugin, { systemPrompt: 'test', memoryTokenBudget: 1024 });
    const host = app.bind({ events, agent, services });
    host.services.use.prefer(llm, GONE);
    const sent: string[] = [];
    host.events.use.on('outbound:message', (msg: OutgoingMessage) => void sent.push(msg.content));

    for (let i = 0; i < 2; i++) {
      await host.agent.use.handleMessage({ content: '在吗', sessionId: 's', platform: 'webui', userId: 'console' });
    }

    expect(sent).toEqual(['在的', '还在']);
    const fallback = warns.filter(w => w.includes(GONE));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toContain(ACTUAL);
  });
});
