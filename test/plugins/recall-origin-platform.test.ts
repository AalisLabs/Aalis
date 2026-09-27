import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { type MemoryRecallScope, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { type VectorSearchResult, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomScopeManager } from '../fixtures/room-scope.js';

// ════════════════════════════════════════════════════════════
// 召回按出生平台：IM 房间不论从哪个入口驱动，跨会话料的「当前平台」都是房间的出生平台
// （api-gateway 的 resolveSessionOrigin），入口平台只对没有出生平台的会话（WebUI、CLI 等）起作用。
// owner 从 WebUI 往 onebot 群插话时，memory-history 的同平台注入、memory-vector 的 platform
// 范围、session-history 服务的平台裁决都按 onebot 算，owner 自己 WebUI 会话的内容不进这一轮。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const OWNER = 'session-abcd1234';
const OWNER_OTHER = 'webui-default';
const CLI = 'cli-default';
const CLI_TASK = 'cli-default::efgh5678';

/** WebUI 入口往群房间发消息时的调用上下文 */
const WEBUI_INTO_GROUP = { sessionId: GROUP, platform: 'webui' };

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function toolRecorder() {
  const handlers = new Map<string, ToolHandler>();
  const stub = {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  };
  return { handlers, stub: stub as never };
}

function requireActive(app: App, name: string): void {
  // required 依赖缺席时插件停在 pending 且不报错，「不含某内容」类断言会恒真
  const state = app.plugins.getPlugin(name)?.state;
  if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
}

describe('memory-history：同平台注入按出生平台', () => {
  async function setup() {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, services });
    const assembly = app.bind({ contributions, logger });
    await app.plugin(memoryInMemory);
    await app.plugins.idle();
    const memory = host.services.get(memoryService);
    if (!memory) throw new Error('memory 服务未就绪');
    const baseTs = Date.now() - 10_000;
    const entries: Array<[string, string, string]> = [
      [OTHER_GROUP, 'onebot', '别的群原文'],
      [OWNER, 'webui', 'WebUI原文'],
      [OWNER_OTHER, 'webui', 'WebUI另一会话原文'],
      [CLI_TASK, 'cli', 'CLI子任务原文'],
    ];
    for (const [i, [sessionId, platform, content]] of entries.entries()) {
      await memory.saveMessage(sessionId, { role: 'user', content, timestamp: baseTs + i, metadata: { platform } });
    }
    const { handlers, stub } = toolRecorder();
    host.provide(tools, stub);
    await app.plugin(memoryHistory, { scope: 'same-platform', maxAgeMinutes: 0, perSessionLimit: 0 });
    await app.plugins.idle();
    requireActive(app, memoryHistory.name);
    const passive = async (sessionId: string, platform: string): Promise<string | undefined> => {
      const messages: Message[] = [{ role: 'user', content: 'now' }];
      await assemblePromptContributions(assembly, { messages, sessionId, platform });
      const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-history'));
      return typeof block?.content === 'string' ? block.content : undefined;
    };
    return { passive, recentMessages: handlers.get('recent_messages')! };
  }

  it('安全：WebUI 入口往群房间发消息，被动注入与 recent_messages 只取 onebot 的会话', async () => {
    const { passive, recentMessages } = await setup();
    const block = await passive(GROUP, 'webui');
    expect(block).toContain('别的群原文');
    expect(block).not.toContain('WebUI原文');
    expect(block).not.toContain('WebUI另一会话原文');
    for (const scope of [undefined, 'same-platform']) {
      const out = await recentMessages(scope ? { scope } : {}, WEBUI_INTO_GROUP);
      expect(out, `scope=${scope}`).toContain('别的群原文');
      expect(out, `scope=${scope}`).not.toContain('WebUI原文');
    }
  });

  it('owner 面会话照旧按入口平台：WebUI 会话取 webui，CLI 会话取 cli', async () => {
    const { passive, recentMessages } = await setup();
    const web = await passive(OWNER, 'webui');
    expect(web).toContain('WebUI另一会话原文');
    expect(web).not.toContain('别的群原文');
    expect(await recentMessages({}, { sessionId: OWNER, platform: 'webui' })).toContain('WebUI另一会话原文');
    const cli = await passive(CLI, 'cli');
    expect(cli).toContain('CLI子任务原文');
    expect(cli).not.toContain('别的群原文');
    expect(cli).not.toContain('WebUI原文');
  });
});

describe('memory-vector：platform 范围按出生平台', () => {
  const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);

  function hits(): VectorSearchResult[] {
    return [
      { score: 0.95, metadata: { sessionId: GROUP, platform: 'onebot', timestamp: BASE_TS, content: '本群记忆' } },
      {
        score: 0.9,
        metadata: { sessionId: OTHER_GROUP, platform: 'onebot', timestamp: BASE_TS + 1, content: '别的群记忆' },
      },
      { score: 0.85, metadata: { sessionId: OWNER, platform: 'webui', timestamp: BASE_TS + 2, content: 'WebUI记忆' } },
      {
        score: 0.8,
        metadata: { sessionId: OWNER_OTHER, platform: 'webui', timestamp: BASE_TS + 3, content: 'WebUI另一会话记忆' },
      },
    ];
  }

  async function setup() {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide });
    const assembly = app.bind({ contributions, logger });
    host.provide(embedding, {
      async embed(): Promise<number[]> {
        return [0.1, 0.2, 0.3];
      },
    });
    const all = hits();
    host.provide(vectorstore, {
      async add(): Promise<void> {},
      async search(_q: number[], topK: number): Promise<VectorSearchResult[]> {
        return all.slice(0, topK);
      },
      async size(): Promise<number> {
        return all.length;
      },
      async clear(): Promise<void> {},
      async save(): Promise<void> {},
    });
    const { handlers, stub } = toolRecorder();
    host.provide(tools, stub);
    await app.plugins.register(memoryVector, {
      search: { topK: 10, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
      contextExpand: { window: 0, crossSession: true },
      indexing: { concurrency: 1, maxQueueSize: 10 },
      crossSessionMode: 'platform',
      recallRoles: 'all',
    });
    await app.plugins.idle();
    requireActive(app, memoryVector.name);
    const passive = async (sessionId: string, platform: string): Promise<string> => {
      const messages: Message[] = [
        { role: 'system', content: '人设' },
        { role: 'user', content: '还记得吗' },
      ];
      await assemblePromptContributions(assembly, { messages, sessionId, platform });
      const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'));
      return typeof block?.content === 'string' ? block.content : '';
    };
    const recall = async (ctx: { sessionId: string; platform: string }) => {
      const out = JSON.parse(await handlers.get('memory_recall')!({ query: '记忆' }, ctx));
      return {
        scope: out.scope as string,
        texts: (out.results ?? []).map((r: { text: string }) => r.text).join('\n'),
      };
    };
    return { passive, recall };
  }

  it('安全：WebUI 入口往群房间发消息，被动召回与 memory_recall 只取 onebot 的记忆', async () => {
    const { passive, recall } = await setup();
    const text = await passive(GROUP, 'webui');
    expect(text).toContain('本群记忆');
    expect(text).toContain('别的群记忆');
    expect(text).not.toContain('WebUI记忆');
    expect(text).not.toContain('WebUI另一会话记忆');
    const out = await recall(WEBUI_INTO_GROUP);
    expect(out.scope).toBe('platform');
    expect(out.texts).toContain('别的群记忆');
    expect(out.texts).not.toContain('WebUI记忆');
  });

  it('owner 面会话照旧按入口平台：WebUI 会话召回 webui 的记忆', async () => {
    const { passive, recall } = await setup();
    const text = await passive(OWNER, 'webui');
    expect(text).toContain('WebUI另一会话记忆');
    expect(text).not.toContain('别的群记忆');
    const out = await recall({ sessionId: OWNER, platform: 'webui' });
    expect(out.texts).toContain('WebUI另一会话记忆');
    expect(out.texts).not.toContain('别的群记忆');
  });
});

describe('session-history：平台裁决按出生平台', () => {
  // WebUI 的会话 id（session-<8位>、webui-default）不带冒号，按 id 前缀比平台时本来就读不到；
  // 带 webui: 前缀的目标代表「当前平台按入口算成 webui 时会被放行」的那一类
  const WEBUI_PREFIXED = 'webui:console';

  async function setup(
    historyScope: 'platform' | 'all',
    room?: { rooms?: Record<string, MemoryRecallScope>; profiles?: Record<string, MemoryRecallScope> },
  ) {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide });
    const handlers = new Map<string, RegisteredTool['handler']>();
    host.provide(tools, {
      register(tool: Omit<RegisteredTool, 'pluginName'>) {
        handlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    host.provide(memoryService, {
      getHistory: async (sessionId: string) => [{ role: 'user', content: `${sessionId} 的原文`, timestamp: 1 }],
    } as never);
    if (room) host.provide(sessionManager, roomScopeManager(room.rooms, room.profiles));
    await app.plugin(sessionTools, { scope: historyScope });
    await app.plugins.idle();
    requireActive(app, sessionTools.name);
    return async (ctx: { sessionId: string; platform: string }, target: string) =>
      JSON.parse((await handlers.get('session_get_history')!({ session_id: target }, ctx)) as string);
  }

  it('安全：WebUI 入口往群房间发消息，同平台别的群照常可读，webui 一侧的会话被拒', async () => {
    const read = await setup('platform');
    expect(await read(WEBUI_INTO_GROUP, OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
    expect(await read(WEBUI_INTO_GROUP, WEBUI_PREFIXED)).toEqual({
      error: expect.stringContaining('当前=onebot'),
    });
    expect(await read(WEBUI_INTO_GROUP, OWNER)).toMatchObject({ error: expect.any(String) });
  });

  it('房间召回范围为 platform 时同样按出生平台裁决', async () => {
    const read = await setup('all', { rooms: { [GROUP]: 'platform' } });
    expect(await read(WEBUI_INTO_GROUP, OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
    expect(await read(WEBUI_INTO_GROUP, WEBUI_PREFIXED)).toEqual({
      error: expect.stringContaining('本房间的召回范围限于同平台会话（当前=onebot'),
    });
  });

  it('owner 面会话照旧按入口平台：WebUI 会话读 onebot 群被拒', async () => {
    const read = await setup('platform');
    const ctx = { sessionId: OWNER, platform: 'webui' };
    expect(await read(ctx, OTHER_GROUP)).toEqual({ error: expect.stringContaining('当前=webui') });
    expect(await read(ctx, WEBUI_PREFIXED)).toMatchObject({ ok: true, sessionId: WEBUI_PREFIXED });
  });
});
