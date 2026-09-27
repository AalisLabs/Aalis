import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type ChatModelRequest, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type VectorSearchResult, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, events, logger, provide } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import {
  EXTRACTOR_CONFIG_DEFAULTS,
  type ExtractorConfig,
  RelationExtractor,
} from '../../packages/plugin-user-relation/src/extractor.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';
import {
  DIRECTIVE_KINDS,
  type IncomingMessage,
  type Message,
  prepareLLMMessages,
  selfInitiatedActor,
  WellKnownKinds,
} from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 宿主通知原语：宿主撰写的事件通知（IncomingMessage.hostNotice）不是任何人的发言。
// 归档为 notice / host-notice、只留宿主正文；不进向量记忆、抽取与记忆扩窗。
// plugin-agent 的渲染面见 agent-host-notice.test.ts，DeepSeek 的豁免见 deepseek-system-placement.test.ts。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const HOST_BODY = 'HOST-NOTICE-BODY 白纸任务 T-1 已完成';
const SENTINEL = 'UNTRUSTED-SENTINEL-7f3a';
const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);

function hostNoticeIncoming(extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: HOST_BODY,
    sessionId: ROOM,
    platform: 'onebot',
    source: 'paper',
    actor: selfInitiatedActor('onebot'),
    hostNotice: { kind: 'paper-task', id: 'n-1', untrusted: `<remote>${SENTINEL}</remote>` },
    ...extra,
  };
}

/** 归档后的宿主通知（与 message-archive 落库的形态一致），直接写进内存 memory 用 */
function archivedNotice(timestamp?: number): Message {
  return {
    role: 'notice',
    kind: WellKnownKinds.HostNotice,
    content: HOST_BODY,
    timestamp,
    metadata: { platform: 'onebot', source: 'paper', hostNoticeKind: 'paper-task' },
  };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  vi.useRealTimers();
});

function newApp(): App {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  return app;
}

/** 事件键经 declaration merging 声明，从源码路径导入拿不到增广，用宽签名发射 */
function looseEmit(app: App) {
  const host = app.bind({ events });
  return host.events.emit.bind(host.events) as (event: string, data: unknown) => Promise<void>;
}

describe('schema-message：宿主通知的 kind 与出口前缀', () => {
  it('DIRECTIVE_KINDS 含跨会话委派与宿主通知', () => {
    expect([...DIRECTIVE_KINDS].sort()).toEqual(['cross-session-delegation', 'host-notice']);
  });

  it('prepareLLMMessages 把 notice/host-notice 转为 system 并加 [宿主通知] 前缀，二次调用不重复加', () => {
    const once = prepareLLMMessages([{ role: 'notice', kind: 'host-notice', content: HOST_BODY }]);
    expect(once[0].role).toBe('system');
    expect(once[0].content).toBe(`[宿主通知] ${HOST_BODY}`);
    const twice = prepareLLMMessages(once.map(m => ({ ...m, role: 'notice', kind: 'host-notice' })));
    expect(twice[0].content).toBe(`[宿主通知] ${HOST_BODY}`);
  });
});

describe('message-archive：宿主通知归档', () => {
  it('落成 notice/host-notice，不带 name，metadata 记子类与来源，不可信段不落库；照常发归档事件', async () => {
    const app = newApp();
    await registerHubs(app);
    await app.plugin(memoryInMemory);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    const host = app.bind({ messageArchive, memory, events });
    const seen: Array<{ archivedMessage: Message }> = [];
    (host.events.on as (e: string, h: (d: unknown) => void) => void)('inbound:message:archived', d => {
      seen.push(d as { archivedMessage: Message });
    });

    const { message } = await host.messageArchive.require().archiveIncoming(hostNoticeIncoming());
    expect(message).toMatchObject({ role: 'notice', kind: 'host-notice', content: HOST_BODY });
    expect(message.name).toBeUndefined();
    expect(message.metadata).toMatchObject({ hostNoticeKind: 'paper-task', source: 'paper' });
    expect(message.metadata?.userId).toBeUndefined();
    expect(message.metadata?.nickname).toBeUndefined();
    expect(JSON.stringify(message)).not.toContain(SENTINEL);

    const stored = await host.memory.require().getHistory(ROOM, 10);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(SENTINEL);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].archivedMessage).toBe(message);
  });

  it('flow-control 禁言期吞掉宿主通知：影子归档写成 notice，不含不可信段', async () => {
    const app = newApp();
    await registerHubs(app);
    await app.plugin(memoryInMemory);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    const host = app.bind({ provide, gateway, flowControl, memory });
    const reached: IncomingMessage[] = [];
    host.provide(agent, {
      async handleMessage(msg: IncomingMessage) {
        reached.push(msg);
      },
    } as never);
    await app.plugins.register(gatewayPlugin, {});
    await app.plugins.register(flowControlPlugin, {});
    await app.plugins.idle();
    for (const p of [gatewayPlugin, flowControlPlugin, messageArchivePlugin]) {
      expect(app.plugins.getPlugin(p.name)?.state, `${p.name} 未激活`).toBe('active');
    }

    host.flowControl.require().setMuted(ROOM, 600, 'onebot');
    await host.gateway.require().ingressMessage(hostNoticeIncoming());
    expect(reached).toEqual([]);
    const stored = await host.memory.require().getHistory(ROOM, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ role: 'notice', kind: 'host-notice', content: HOST_BODY });
    expect(JSON.stringify(stored)).not.toContain(SENTINEL);
  });
});

// ── memory-vector ──────────────────────────────────────────

async function setupVector(hits: VectorSearchResult[] = []) {
  const app = newApp();
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  const host = app.bind({ provide, memory, events });
  const added: Array<Record<string, unknown>> = [];
  host.provide(embedding, { embed: async () => [0.1, 0.2, 0.3] });
  host.provide(vectorstore, {
    async add(_v: number[], metadata: Record<string, unknown>) {
      added.push(metadata);
    },
    search: async (_q: number[], topK: number) => hits.slice(0, topK),
    size: async () => hits.length,
    clear: async () => {},
    save: async () => {},
  });
  const toolHandlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => Promise<string>>();
  host.provide(tools, {
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
  return { app, host, added, toolHandlers, assembly: app.bind({ contributions, logger }) };
}

describe('memory-vector：宿主通知不进向量记忆与扩窗', () => {
  it('安全：带 hostNotice 的归档事件不写向量库；同样内容去掉 hostNotice 时写入（对照）', async () => {
    const { app, added } = await setupVector();
    const emit = looseEmit(app);
    const notice = hostNoticeIncoming();
    // 通知先入队：索引队列 concurrency=1、先进先出，守卫失效时它会先于对照落库
    await emit('inbound:message:archived', {
      sessionId: ROOM,
      incoming: notice,
      archivedMessage: { ...archivedNotice(BASE_TS), content: HOST_BODY },
    });
    const { hostNotice: _dropped, ...control } = notice;
    await emit('inbound:message:archived', {
      sessionId: ROOM,
      incoming: control,
      archivedMessage: { role: 'user', content: HOST_BODY, timestamp: BASE_TS + 1 },
    });
    await vi.waitFor(() => expect(added.length).toBeGreaterThan(0));
    expect(added.map(m => m.timestamp)).toEqual([BASE_TS + 1]);
  });

  async function seedRoom(host: Awaited<ReturnType<typeof setupVector>>['host']) {
    const mem = host.memory.require();
    await mem.saveMessage(ROOM, archivedNotice(BASE_TS - 60_000));
    await mem.saveMessage(ROOM, { role: 'assistant', content: '她对通知的回复', timestamp: BASE_TS });
    await mem.saveMessage(ROOM, {
      role: 'user',
      content: '[群友(30001)]: 群友接着问',
      name: '30001',
      timestamp: BASE_TS + 60_000,
      metadata: { userId: '30001', platform: 'onebot' },
    });
  }

  const replyHit: VectorSearchResult = {
    score: 0.9,
    metadata: { sessionId: ROOM, timestamp: BASE_TS, content: '她对通知的回复', role: 'assistant', platform: 'onebot' },
  };

  it('安全：被动召回命中她的回复时，扩窗不带出紧邻的通知正文', async () => {
    const { host, assembly } = await setupVector([replyHit]);
    await seedRoom(host);
    const messages: Message[] = [
      { role: 'system', content: '人设' },
      { role: 'user', content: '上次那个任务' },
    ];
    await assemblePromptContributions(assembly, { messages, sessionId: 'onebot:10000:private:30002' });
    const block = String(
      messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'))?.content ?? '',
    );
    expect(block).toContain('她对通知的回复');
    expect(block).toContain('群友接着问'); // 扩窗确实生效
    expect(block).not.toContain('HOST-NOTICE-BODY');
  });

  it('安全：memory_recall 命中她的回复时，扩窗上下文不含通知正文', async () => {
    const { host, toolHandlers } = await setupVector([replyHit]);
    await seedRoom(host);
    const recall = toolHandlers.get('memory_recall');
    expect(recall, 'memory_recall 未注册').toBeDefined();
    const out = await recall!(
      { query: '任务', contextWindow: 2 },
      { sessionId: 'onebot:10000:private:30002', platform: 'onebot' },
    );
    expect(out).toContain('她对通知的回复');
    expect(out).toContain('群友接着问'); // 扩窗确实生效
    expect(out).not.toContain('HOST-NOTICE-BODY');
  });
});

// ── user-relation extractor ────────────────────────────────

const RELATION_CFG = {
  ...EXTRACTOR_CONFIG_DEFAULTS,
  evictionEnabled: false,
  maxPersons: 0,
  maxEvents: 0,
  maxEntities: 0,
  maxEdges: 0,
  consolidateAfterEviction: false,
  consolidateAutoLink: false,
  consolidateSkipLowScorePairs: false,
  consolidateLowScoreThreshold: 0,
  triggerEveryNMessages: 3,
  readWindowSize: 10,
  mode: 'incremental',
  senderNeighborhoodEdgeLimit: 0,
  disableThinking: true,
  strictSelfAssertion: false,
  debug: false,
  crossSessionMaxAgeMinutes: 0,
} satisfies ExtractorConfig;

async function setupRelation(cfg: Partial<ExtractorConfig> = {}) {
  const app = newApp();
  const host = app.bind({ provide, events, logger, memory, llm, platform });
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  const mem = host.memory.require();
  const calls: ChatModelRequest[] = [];
  host.provide(
    platform,
    { adapterName: 'mock-onebot', platform: 'onebot', getConnections: () => [], sendMessage: async () => {} } as never,
    { entryId: 'mock/onebot' },
  );
  host.provide(
    llm,
    {
      id: 'fake-extractor',
      contextLength: 8000,
      capabilities: ['chat'],
      async chat(req: ChatModelRequest) {
        calls.push(req);
        return { content: '{}' };
      },
    } as unknown as LLMModel,
    { entryId: 'fake/extractor' },
  );
  const service = new RelationService(new RelationStore(() => mem));
  const extractor = new RelationExtractor(host, service, { ...RELATION_CFG, ...cfg });
  extractor.start();
  // 窗口里有一条可提取的真人消息与一条宿主通知
  await mem.saveMessage(ROOM, {
    role: 'user',
    content: '[群友(30001)]: 帮我画只猫',
    timestamp: BASE_TS,
    metadata: { messageId: 'm1', userId: '30001', nickname: '群友', platform: 'onebot' },
  });
  await mem.saveMessage(ROOM, archivedNotice(BASE_TS + 1000));
  const extractNow = () =>
    (extractor as unknown as { extractSession(sid: string): Promise<void> }).extractSession(ROOM);
  const prompt = () => calls.map(c => JSON.stringify(c.messages)).join('\n');
  return { app, mem, calls, extractor, extractNow, prompt };
}

describe('user-relation extractor：宿主通知不计数、不进抽取窗口', () => {
  it('安全：连续收到宿主通知不触发抽取；真人消息照常计数（对照）', async () => {
    const { app, calls, extractor } = await setupRelation();
    const emit = looseEmit(app);
    const archivedEvent = (archivedMessage: Message) => ({
      sessionId: ROOM,
      incoming: { sessionId: ROOM, platform: 'onebot' },
      archivedMessage,
    });
    for (let i = 0; i < 3; i++) await emit('inbound:message:archived', archivedEvent(archivedNotice()));
    await new Promise(r => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      await emit('inbound:message:archived', archivedEvent({ role: 'user', content: '真人', name: '30001' }));
    }
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    extractor.stop();
  });

  it('安全：同会话读取的窗口不含通知正文', async () => {
    const { calls, extractNow, prompt } = await setupRelation();
    await extractNow();
    expect(calls).toHaveLength(1);
    expect(prompt()).toContain('帮我画只猫');
    expect(prompt()).not.toContain('HOST-NOTICE-BODY');
  });

  it('安全：跨会话读取的窗口不含通知正文', async () => {
    const { calls, extractNow, prompt } = await setupRelation({ readScope: 'same-platform' });
    await extractNow();
    expect(calls).toHaveLength(1);
    expect(prompt()).toContain('帮我画只猫');
    expect(prompt()).not.toContain('HOST-NOTICE-BODY');
  });

  it('安全：跨会话降级到同会话读取时，窗口不含通知正文', async () => {
    const { mem, calls, extractNow, prompt } = await setupRelation({ readScope: 'same-platform' });
    (mem as { getRecentMessagesAcrossSessions?: unknown }).getRecentMessagesAcrossSessions = undefined;
    await extractNow();
    expect(calls).toHaveLength(1);
    expect(prompt()).toContain('帮我画只猫');
    expect(prompt()).not.toContain('HOST-NOTICE-BODY');
  });
});

// ── user-profile ───────────────────────────────────────────

const stubAuthority = {
  isOwner: (p: string, userId?: string) => p === 'onebot' && userId === '30001',
  listUsers: () => [],
} as unknown as AuthorityService;

async function setupProfile(config: Record<string, unknown>, opts: { withArchive?: boolean } = {}) {
  const app = newApp();
  await registerHubs(app);
  const host = app.bind({ provide, events, memory, messageArchive });
  const requests: ChatModelRequest[] = [];
  host.provide(llm, {
    id: 'stub-model',
    capabilities: ['chat'],
    async chat(req: ChatModelRequest) {
      requests.push(req);
      return { content: '{"add":[],"update":[],"remove":[]}' };
    },
  } as never);
  host.provide(authority, stubAuthority);
  await app.plugins.register(memoryInMemory, {});
  if (opts.withArchive) await app.plugins.register(messageArchivePlugin, { debugLogs: false });
  await app.plugins.idle();
  await app.plugins.register(userProfile, {
    extractEveryNMessages: 0,
    enableSelfProfile: false,
    enableInstructions: false,
    ...config,
  });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(userProfile.name)?.state).toBe('active');
  const mem = host.memory.require();
  const seedAndTrigger = async () => {
    await mem.saveMessage(ROOM, {
      role: 'user',
      content: '[群友(30001)]: 我喜欢猫',
      timestamp: BASE_TS,
      metadata: { userId: '30001', nickname: '群友', platform: 'onebot' },
    });
    await mem.saveMessage(ROOM, { role: 'assistant', content: '猫很可爱', timestamp: BASE_TS + 500 });
    await mem.saveMessage(ROOM, archivedNotice(BASE_TS + 1000));
    await looseEmit(app)('inbound:message:archived', {
      sessionId: ROOM,
      incoming: { sessionId: ROOM, userId: '30001', nickname: '群友', platform: 'onebot', content: '我喜欢猫' },
      archivedMessage: { role: 'user', content: '[群友(30001)]: 我喜欢猫' },
    });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    return requests.map(r => JSON.stringify(r.messages)).join('\n');
  };
  return { app, host, mem, requests, seedAndTrigger };
}

describe('user-profile：宿主通知不进三处抽取窗口', () => {
  it('安全：用户事实抽取的输入不含通知正文', async () => {
    const { seedAndTrigger } = await setupProfile({ extractEveryNMessages: 1 });
    const input = await seedAndTrigger();
    expect(input).toContain('我喜欢猫');
    expect(input).not.toContain('HOST-NOTICE-BODY');
  });

  it('安全：自反思的输入不含通知正文', async () => {
    const { seedAndTrigger } = await setupProfile({ enableSelfProfile: true, selfReflectEveryNMessages: 1 });
    const input = await seedAndTrigger();
    expect(input).toContain('猫很可爱');
    expect(input).not.toContain('HOST-NOTICE-BODY');
  });

  it('安全：指令抽取的输入不含通知正文', async () => {
    const { seedAndTrigger } = await setupProfile({ enableInstructions: true, instructionExtractEveryNMessages: 1 });
    const input = await seedAndTrigger();
    expect(input).toContain('我喜欢猫');
    expect(input).not.toContain('HOST-NOTICE-BODY');
  });

  it('不带 userId 的宿主通知归档后不写档案、不改关系分', async () => {
    const { host, mem, requests } = await setupProfile(
      { extractEveryNMessages: 1, enableSelfProfile: true, selfReflectEveryNMessages: 1 },
      { withArchive: true },
    );
    await host.messageArchive.require().archiveIncoming(hostNoticeIncoming());
    await new Promise(r => setTimeout(r, 30));
    expect(await mem.listMetadata('user:profile')).toEqual([]);
    expect(requests).toEqual([]);
  });
});
