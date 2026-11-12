import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userRelationPlugin from '../../packages/plugin-user-relation/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 关系图的提取模型（extractionModel）：provider 与 model 两项都填了才按它取，只填一项按没填处理，取 llm 服务按本插件偏好、
// 全局偏好与优先级挑的那一个，与其余模型字段一致；不按半个引用去挑那个提供者的第一个模型。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:10000:group:20001';
const EMPTY = JSON.stringify({ persons: [], events: [], entities: [] });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 两家提供者：p-low/a（优先级低）与 p-high/b（优先级高，没指定时挑它）。跑一轮提取，返回被调的模型 */
async function extractWith(extractionModel: Record<string, unknown>): Promise<string[]> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, memory });
  const called: string[] = [];
  const model = (id: string) =>
    ({
      id,
      contextLength: 8000,
      capabilities: ['chat'],
      chat: async () => {
        called.push(id);
        return { content: EMPTY };
      },
    }) as never;
  host.provide.use(llm, model('a'), { entryId: 'p-low/a', priority: 0 });
  host.provide.use(llm, model('b'), { entryId: 'p-high/b', priority: 10 });
  await app.plugin(memoryInMemory);
  await app.plugin(userRelationPlugin, {
    extractionEnabled: true,
    triggerEveryNMessages: 1,
    agentInjection: false,
    toolsEnabled: false,
    commandsEnabled: false,
    extractionModel,
  });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(userRelationPlugin.name)?.state).toBe('active');
  await host.memory.use.saveMessage(SESSION, {
    role: 'user',
    content: '<原文>',
    metadata: { messageId: 'm1', userId: 'u1', platform: 'onebot' },
  });
  await host.events.use.emit('inbound:message:archived', {
    sessionId: SESSION,
    incoming: { content: '<原文>', sessionId: SESSION, platform: 'onebot', userId: 'u1' },
    archivedMessage: { role: 'user', content: '<原文>' },
  });
  await vi.waitFor(() => expect(called).toHaveLength(1));
  return called;
}

describe('plugin-user-relation：提取模型', () => {
  it('两项都填了按它取', async () => {
    expect(await extractWith({ provider: 'p-low', model: 'a' })).toEqual(['a']);
  });

  it('只填 provider 或只填 model 时按没填处理：取服务挑的那一个', async () => {
    expect(await extractWith({ provider: 'p-low' })).toEqual(['b']);
    expect(await extractWith({ model: 'a' })).toEqual(['b']);
  });
});
