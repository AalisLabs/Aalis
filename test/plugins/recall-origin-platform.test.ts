import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { type VectorSearchResult, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { sessionTableManager } from '../fixtures/session-table.js';
import { type RequestDraft, toolContext } from '../fixtures/tool-call.js';
import { inputFromLastUser } from '../fixtures/turn-input.js';

// ════════════════════════════════════════════════════════════
// 召回按出生平台：IM 房间不论从哪个入口驱动，跨会话料的「当前平台」都是会话管理记下的出生平台（子会话取根会话的），
// 不看入口平台。出生平台只看会话表里的记录，不从会话 id 推。owner 从 WebUI 往 onebot 群插话时，memory-history 的被动注入
// 与 recent_messages、session-history 服务都按群判（取别的会话的规则），memory-vector 的 platform 范围按 onebot 算，
// owner 自己 WebUI 会话的内容不进这一轮。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const OWNER = 'session-abcd1234';
const OWNER_OTHER = 'webui-default';
/** id 不按 onebot 写法的房间：会话表里记下了出生平台 onebot */
const PLAIN_ROOM = 'room-plain';
/** id 写成 onebot 群的样子，会话表里却没有出生平台（按 id 建档的） */
const UNRECORDED = 'onebot:10000:group:20009';

/** 会话表：两个已收录的群与一个 id 不带平台前缀的房间 */
const SESSIONS = [storedRoom(GROUP), storedRoom(OTHER_GROUP), { ...storedRoom(GROUP), id: PLAIN_ROOM }];
/** 另加 owner 在 WebUI 建的两个会话：取别的会话的规则要判得出它们 */
const WITH_OWNER_FACES: Record<string, Record<string, unknown>> = Object.fromEntries(
  [
    ...SESSIONS,
    ...[OWNER, OWNER_OTHER].map(id => ({
      id,
      children: [],
      status: 'waiting',
      createdAt: 0,
      updatedAt: 0,
      createdFrom: 'webui',
    })),
  ].map(record => [String(record.id), record]),
);

/** WebUI 入口往群房间发消息时的调用上下文：授权身份是 owner 的控制台身份 */
const WEBUI_INTO_GROUP = { sessionId: GROUP, platform: 'webui', userId: 'console' };

/** 记下的处理函数：上下文没写参与者的按一条消息的口径补上（toolContext） */
type ToolHandler = (args: Record<string, unknown>, ctx: RequestDraft) => Promise<string>;

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function toolRecorder() {
  const handlers = new Map<string, ToolHandler>();
  const stub = {
    register: (tool: { definition: { function: { name: string } }; handler: RegisteredTool['handler'] }) => {
      handlers.set(tool.definition.function.name, async (args, ctx) =>
        String(await tool.handler(args, toolContext(ctx))),
      );
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

describe('memory-history：按群判', () => {
  async function setup() {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, services });
    const assembly = app.bind({ contributions, logger });
    await app.plugin(memoryInMemory);
    await app.plugins.idle();
    const memory = host.services.use.get(memoryService);
    if (!memory) throw new Error('memory 服务未就绪');
    await memory.commitMetadata(
      Object.entries(WITH_OWNER_FACES).map(([key, data]) => ({ op: 'put' as const, namespace: 'sessions', key, data })),
    );
    const baseTs = Date.now() - 10_000;
    const entries: Array<[string, string, string]> = [
      [OTHER_GROUP, 'onebot', '别的群原文'],
      [OWNER, 'webui', 'WebUI原文'],
      [OWNER_OTHER, 'webui', 'WebUI另一会话原文'],
    ];
    for (const [i, [sessionId, platform, content]] of entries.entries()) {
      await memory.saveMessage(sessionId, { role: 'user', content, timestamp: baseTs + i, metadata: { platform } });
    }
    const { handlers, stub } = toolRecorder();
    host.provide.use(tools, stub);
    await app.plugin(sessionManagerPlugin);
    await app.plugin(memoryHistory, { maxAgeMinutes: 0, perSessionLimit: 0 });
    await app.plugins.idle();
    requireActive(app, sessionManagerPlugin.name);
    requireActive(app, memoryHistory.name);
    const passive = async (sessionId: string, platform: string): Promise<string | undefined> => {
      const messages: Message[] = [{ role: 'user', content: 'now' }];
      await assemblePromptContributions(assembly, { messages, sessionId, platform }, []);
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
    const out = await recentMessages({}, WEBUI_INTO_GROUP);
    expect(out).toContain('别的群原文');
    expect(out).not.toContain('WebUI原文');
  });

  it('出生平台取会话表里记下的，不看 id：id 不带平台前缀的房间按 onebot，没有记录的判不出、不取别的会话', async () => {
    const { passive } = await setup();
    const plain = await passive(PLAIN_ROOM, 'webui');
    expect(plain).toContain('别的群原文');
    expect(plain).not.toContain('WebUI原文');
    expect(await passive(UNRECORDED, 'webui')).toBeUndefined();
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
    host.provide.use(embedding, {
      async embed(): Promise<number[]> {
        return [0.1, 0.2, 0.3];
      },
    });
    const all = hits();
    host.provide.use(vectorstore, {
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
    host.provide.use(tools, stub);
    host.provide.use(sessionManager, sessionTableManager(SESSIONS));
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
      await assemblePromptContributions(assembly, { messages, sessionId, platform }, inputFromLastUser(messages));
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

  it('出生平台取会话表里记下的，不看 id：id 不带平台前缀的房间按 onebot，没有记录的按入口平台', async () => {
    const { passive } = await setup();
    const plain = await passive(PLAIN_ROOM, 'webui');
    expect(plain).toContain('别的群记忆');
    expect(plain).not.toContain('WebUI记忆');
    const unrecorded = await passive(UNRECORDED, 'webui');
    expect(unrecorded).toContain('WebUI记忆');
    expect(unrecorded).not.toContain('别的群记忆');
  });
});

describe('session-history：按出生平台判', () => {
  async function setup() {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide });
    const handlers = new Map<string, RegisteredTool['handler']>();
    host.provide.use(tools, {
      register(tool: Omit<RegisteredTool, 'pluginName'>) {
        handlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    host.provide.use(memoryService, fakeMemory(WITH_OWNER_FACES) as never);
    await app.plugin(sessionManagerPlugin);
    await app.plugin(sessionTools);
    await app.plugins.idle();
    requireActive(app, sessionManagerPlugin.name);
    requireActive(app, sessionTools.name);
    return async (ctx: { sessionId: string; platform: string }, target: string) =>
      JSON.parse((await handlers.get('session_get_history')!({ session_id: target }, toolContext(ctx))) as string);
  }

  it('安全：WebUI 入口往群房间发消息，同平台别的群照常可读，WebUI 的会话被拒', async () => {
    const read = await setup();
    expect(await read(WEBUI_INTO_GROUP, OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
    expect(await read(WEBUI_INTO_GROUP, OWNER)).toEqual({ error: expect.stringContaining('同平台') });
  });

  it('WebUI 会话按创建来源：读 onebot 群被拒', async () => {
    const read = await setup();
    expect(await read({ sessionId: OWNER, platform: 'webui' }, OTHER_GROUP)).toEqual({
      error: expect.stringContaining('同平台'),
    });
  });

  it('目标的平台取会话表里记下的，不看 id：id 不带平台前缀的房间可读，没有记录的判不出', async () => {
    const read = await setup();
    expect(await read(WEBUI_INTO_GROUP, PLAIN_ROOM)).toMatchObject({ ok: true, sessionId: PLAIN_ROOM });
    expect(await read(WEBUI_INTO_GROUP, UNRECORDED)).toEqual({ error: expect.stringContaining('判不出') });
  });
});
