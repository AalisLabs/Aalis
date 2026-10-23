import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type VectorSearchResult, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { type App, events, logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { type Message, outboundMarkerMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { inputFromLastUser } from '../fixtures/turn-input.js';

// ════════════════════════════════════════════════════════════
// 不是她回复的出站文字（指令的回复、宿主提示）在送达之后按 outboundMarkerMessage 记成事件标记。它不是对话内容：
// agent 交给模型的历史、token:request 的提示快照、memory-vector 召回的扩窗都不带它。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
/** 正文不含提问里的 /help：带出提问的正向检查只认得出提问 */
const MARKER = 'ZZ-MARKER 指令列表：/clear /status';
const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);

/** 房间里一条提问、紧接着的指令回复（事件标记）、她的一句回复 */
async function seedRoom(store: { saveMessage(sessionId: string, message: Message): Promise<void> }) {
  const marker = outboundMarkerMessage({ sessionId: ROOM, platform: 'onebot', source: 'command', content: MARKER });
  if (!marker) throw new Error('outboundMarkerMessage 没给出事件标记');
  await store.saveMessage(ROOM, { role: 'user', content: '[群友(30001)]: /help', timestamp: BASE_TS - 60_000 });
  await store.saveMessage(ROOM, { ...marker, timestamp: BASE_TS - 30_000 });
  await store.saveMessage(ROOM, { role: 'assistant', content: '她说的话', timestamp: BASE_TS });
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('agent：事件标记不进模型的上下文', () => {
  async function boot() {
    const { app } = hostedApp();
    apps.push(app);
    await registerHubs(app);
    const recorder: ChatModelRequest[] = [];
    await app.plugin(createMockLLMPlugin({ contextLength: 1_000_000, responses: [{ content: '好' }], recorder }));
    await app.plugin(toolsPlugin, {});
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(sessionManagerPlugin);
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
    const host = app.bind({ agent: agentService, events, hooks, memory });
    await seedRoom(host.memory.use);
    return { host, recorder };
  }
  const contents = (messages: readonly Pick<Message, 'content'>[]) => messages.map(m => String(m.content ?? ''));

  it('一轮交给模型的消息里有提问与她的回复，没有指令回复', async () => {
    const { host, recorder } = await boot();
    await host.agent.use.handleMessage({ content: '在吗', sessionId: ROOM, platform: 'onebot', userId: '30001' });
    const sent = contents(recorder[0]?.messages ?? []);
    expect(sent.some(text => text.includes('/help'))).toBe(true);
    expect(sent).toContain('她说的话');
    expect(sent.some(text => text.includes('ZZ-MARKER'))).toBe(false);
  });

  it('token:request 的提示快照同样不带指令回复', async () => {
    const { host } = await boot();
    const snapshots: string[][] = [];
    host.hooks.use.middleware('agent:llm:before', async (data, next) => {
      if (data.dryRun) snapshots.push(contents(data.messages));
      await next();
    });
    await host.events.use.emit('token:request', { sessionId: ROOM });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain('她说的话');
    expect(snapshots[0].some(text => text.includes('ZZ-MARKER'))).toBe(false);
  });
});

describe('memory-vector：召回的扩窗不带出事件标记', () => {
  const replyHit: VectorSearchResult = {
    score: 0.9,
    metadata: { sessionId: ROOM, timestamp: BASE_TS, content: '她说的话', role: 'assistant', platform: 'onebot' },
  };

  async function boot() {
    const { app } = hostedApp();
    apps.push(app);
    await registerHubs(app);
    await app.plugin(memoryInMemoryPlugin);
    const host = app.bind({ provide, memory });
    host.provide.use(embedding, { embed: async () => [0.1, 0.2, 0.3] });
    host.provide.use(vectorstore, {
      add: async () => {},
      search: async (_q: number[], topK: number) => [replyHit].slice(0, topK),
      size: async () => 1,
      clear: async () => {},
      save: async () => {},
    });
    const toolHandlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => Promise<string>>();
    host.provide.use(tools, {
      register: (tool: { definition: { function: { name: string } }; handler: never }) => {
        toolHandlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    await app.plugin(memoryVector, {
      search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
      contextExpand: { window: 2, crossSession: true },
      indexing: { concurrency: 1, maxQueueSize: 10 },
      crossSessionMode: 'all',
      recallRoles: 'all',
    });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(memoryVector.name)?.state).toBe('active');
    await seedRoom(host.memory.use);
    return { toolHandlers, assembly: app.bind({ contributions, logger }) };
  }

  it('被动召回命中她的回复：扩窗带出提问，不带出指令回复', async () => {
    const { assembly } = await boot();
    const messages: Message[] = [
      { role: 'system', content: '人设' },
      { role: 'user', content: '上次说了什么' },
    ];
    await assemblePromptContributions(
      assembly,
      { messages, sessionId: 'onebot:10000:private:30002' },
      inputFromLastUser(messages),
    );
    const block = String(
      messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'))?.content ?? '',
    );
    expect(block).toContain('/help'); // 扩窗确实生效
    expect(block).not.toContain('ZZ-MARKER');
  });

  it('memory_recall 命中她的回复：扩窗上下文带出提问，不带出指令回复', async () => {
    const { toolHandlers } = await boot();
    const recall = toolHandlers.get('memory_recall');
    if (!recall) throw new Error('memory_recall 未注册');
    const out = await recall(
      { query: '说了什么', contextWindow: 2 },
      { sessionId: 'onebot:10000:private:30002', platform: 'onebot' },
    );
    expect(out).toContain('/help'); // 扩窗确实生效
    expect(out).not.toContain('ZZ-MARKER');
  });
});
