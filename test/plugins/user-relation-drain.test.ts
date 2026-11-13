import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { type ChatModelRequest, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { userRelation } from '../../packages/api-user-relation/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userRelationPlugin, {
  type RelationService,
  RelationStore,
} from '../../packages/plugin-user-relation/src/index.js';
import type { EntityNode, EventNode, PersonNode } from '../../packages/plugin-user-relation/src/types.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { ref } from '../fixtures/service-ref.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 关系图插件停用时，收尾段等本插件自己发起的提取与 /relation 指令落定再撤回：信号在收尾开始时已断，它们停在当前这一步，
// 已经开始的写入写完，停用落定之后不再有写入。模型替身一直不回，信号断开时：提取与别名核验恰在这时回来（照常往下写），
// 别的按中止原因落定。存储的第一次写入卡在一道闸上，用例放行；order 记下写入开始、写完与停用落定的先后。
// ════════════════════════════════════════════════════════════

const SAME = '{"verdict": "same", "reason": "同一对象"}';
const DIFFERENT_EVENTS = '{"isSame": false, "reason": "不同的事"}';
/** 提取的答复：一个人、一件事与人到事的一条边（没有边引用的人不写） */
const EXTRACTION = JSON.stringify({
  persons: [{ platform: 'onebot', userId: 'u1', displayName: '甲' }],
  events: [{ refKey: 'e1', title: '讨论直播计划', category: 'discussion', evidence: { messageIds: ['m1'] } }],
  personEventEdges: [
    {
      personPlatform: 'onebot',
      personUserId: 'u1',
      eventRefKey: 'e1',
      role: 'initiator',
      evidence: { messageIds: ['m1'] },
    },
  ],
});

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

/** 存储的写入都经 put：第一次卡在闸上；order 记下每次写入的开始与写完 */
function gateWrites(order: string[]) {
  const gate = deferred<void>();
  let gated = false;
  const proto = RelationStore.prototype as unknown as { put(...args: unknown[]): Promise<void> };
  const put = proto.put;
  vi.spyOn(proto, 'put').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    order.push('写入开始');
    if (!gated) {
      gated = true;
      await gate.promise;
    }
    await put.apply(this, args);
    order.push('写完');
  });
  return { gate, reached: () => gated };
}

async function boot(config: Record<string, unknown>) {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, memory });
  const calls: ChatModelRequest[] = [];
  const model = {
    id: 'model',
    contextLength: 8000,
    capabilities: ['chat'],
    chat: (request: ChatModelRequest) => {
      calls.push(request);
      const { signal } = request;
      if (signal?.aborted) return Promise.reject(signal.reason);
      const system = String(request.messages[0]?.content ?? '');
      const answer = system.includes('实体消歧')
        ? SAME
        : system.includes('事件消歧')
          ? DIFFERENT_EVENTS
          : system.includes('知识库整理')
            ? undefined
            : EXTRACTION;
      return new Promise((resolve, reject) =>
        signal?.addEventListener(
          'abort',
          () => (answer === undefined ? reject(signal.reason) : resolve({ content: answer })),
          { once: true },
        ),
      );
    },
  } as unknown as LLMModel;
  host.provide.use(llm, model, { entryId: 'zz/model' });
  const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
  const registry = new CommandRegistry(silent as never, ref(), ref());
  registry.setExecutionGuard(async () => ({ ok: true }));
  host.provide.use(commands, registry);
  await app.plugin(memoryInMemory);
  await app.plugin(userRelationPlugin, config);
  await app.plugins.idle();
  if (app.plugins.getPlugin(userRelationPlugin.name)?.state !== 'active')
    throw new Error(`关系图插件没有激活：${app.plugins.getPlugin(userRelationPlugin.name)?.error}`);
  return { app, host, calls, registry, warns, store: new RelationStore(host.memory.use) };
}

/** 停用，落定时记下 */
function disable(app: App, order: string[]) {
  return app.plugins.disable(userRelationPlugin.name).then(() => {
    order.push('停用落定');
  });
}

/** 一个没有任何边的实体：淘汰与孤儿清理会删它 */
function entityNode(id: string, name: string, entityKind: EntityNode['entityKind'] = 'thing'): EntityNode {
  const now = Date.now();
  return {
    id,
    entityKind,
    name,
    aliases: [],
    firstSeenAt: now,
    lastReinforcedAt: now,
    lastMentionedAt: now,
    mentionCount: 1,
    weight: 0.5,
    evidence: [],
  };
}

/** 发一次 /relation maintain --no-llm */
function maintain(registry: CommandRegistry) {
  return registry.run('relation.maintain', {
    args: ['--no-llm'],
    raw: '/relation maintain --no-llm',
    sessionId: 'zz-session',
    platform: 'test',
    userId: 'zz-user',
    sessionType: 'private',
  });
}

describe('关系图插件停用时等在途的提取与指令', () => {
  it('提取的模型调用途中停用：模型这时回来、开始写图，停用等写完才落定，之后不再有写入', async () => {
    const order: string[] = [];
    const { gate, reached } = gateWrites(order);
    const { app, host, calls } = await boot({ triggerEveryNMessages: 1, commandsEnabled: false });
    await host.memory.use.saveMessage('zz-session', {
      role: 'user',
      content: '我是甲',
      metadata: { messageId: 'm1', userId: 'u1', nickname: '甲', platform: 'onebot' },
    });
    await host.events.use.emit('inbound:message:archived', {
      sessionId: 'zz-session',
      incoming: { userId: 'u1', platform: 'onebot' } as IncomingMessage,
    } as never);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const disabled = disable(app, order);
    await vi.waitFor(() => expect(reached()).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });

  it('/relation consolidate 的别名核验途中停用：核验这时回来、开始合并，停用等写完才落定，之后不再有写入', async () => {
    const order: string[] = [];
    const { app, calls, registry, store } = await boot({
      extractionEnabled: false,
      consolidationModel: { provider: 'zz', model: 'model' },
    });
    for (let i = 0; i < 2; i++) await store.upsertEntity(entityNode(`zz-entity-${i}`, '三角洲行动', 'work'));
    const { gate, reached } = gateWrites(order);
    const reply = registry.run('relation.consolidate', {
      args: ['--auto-link'],
      raw: '/relation consolidate --auto-link',
      sessionId: 'zz-session',
      platform: 'test',
      userId: 'zz-user',
      sessionType: 'private',
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const disabled = disable(app, order);
    await vi.waitFor(() => expect(reached()).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await disabled;
    await reply;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });

  it('事件查重的核验途中停用：核验这时回来、写下否决缓存，停用等写完才落定，之后不再有写入', async () => {
    const order: string[] = [];
    const { app, calls, store } = await boot({ extractionEnabled: false, commandsEnabled: false });
    const now = Date.now();
    for (const [i, title] of ['讨论夏天炎热', '讨论夏天很热'].entries()) {
      const node: EventNode = {
        id: `zz-event-${i}`,
        title,
        sessionScope: 'global',
        firstSeenAt: now,
        lastReinforcedAt: now,
        lastMentionedAt: now,
        mentionCount: 1,
        occurrences: [now],
        weight: 0.5,
        evidence: [],
      };
      await store.upsertEvent(node);
    }
    const { gate, reached } = gateWrites(order);
    const service = app.bind({ userRelation }).userRelation.use as unknown as RelationService;
    const run = service.findEventDuplicates({
      llm: { models: app.bind({ llm }).llm, modelRef: { provider: 'zz', model: 'model' } },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const disabled = disable(app, order);
    await vi.waitFor(() => expect(reached()).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await disabled;
    await run;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });

  it.each([
    ['按配额淘汰', {}],
    ['孤儿清理（不设配额）', { maxPersons: 0, maxEvents: 0, maxEntities: 0, maxEdges: 0 }],
  ])('/relation maintain 整理做完、%s删孤立实体途中停用：停用等写完才落定，之后不再有写入', async (_label, quotas) => {
    const order: string[] = [];
    const { app, registry, store } = await boot({ extractionEnabled: false, ...quotas });
    await store.upsertEntity(entityNode('zz-orphan', '孤立的实体'));
    const gate = deferred<void>();
    let reached = false;
    const remove = RelationStore.prototype.deleteEntityCascade;
    vi.spyOn(RelationStore.prototype, 'deleteEntityCascade').mockImplementation(async function (
      this: RelationStore,
      ...args
    ) {
      order.push('写入开始');
      reached = true;
      await gate.promise;
      const result = await remove.apply(this, args);
      order.push('写完');
      return result;
    });
    const reply = maintain(registry);
    await vi.waitFor(() => expect(reached).toBe(true));
    const disabled = disable(app, order);
    await new Promise(resolve => setTimeout(resolve, 20));
    gate.resolve();
    await disabled;
    await reply;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });

  it('改名同步写人物节点途中停用：停用等写完才落定，之后不再有写入', async () => {
    const order: string[] = [];
    const { app, host, store } = await boot({ extractionEnabled: false, commandsEnabled: false });
    const now = Date.now();
    const person: PersonNode = {
      id: 'onebot:u1',
      platform: 'onebot',
      userId: 'u1',
      displayName: '甲',
      firstSeenAt: now,
      lastSeenAt: now,
      lastMentionedAt: now,
      mentionCount: 1,
    };
    await store.upsertPerson(person);
    const { gate, reached } = gateWrites(order);
    await host.events.use.emit('inbound:message:archived', {
      archivedMessage: {
        role: 'user',
        content: '你好',
        metadata: { platform: 'onebot', userId: 'u1', nickname: '甲二' },
      },
    } as never);
    await vi.waitFor(() => expect(reached()).toBe(true));
    const disabled = disable(app, order);
    await new Promise(resolve => setTimeout(resolve, 20));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });

  it('/relation maintain 开头读图途中停用：之后不再开始整理与淘汰，停用落定之后没有写入', async () => {
    const order: string[] = [];
    const { app, registry, store } = await boot({ extractionEnabled: false });
    await store.upsertEntity(entityNode('zz-orphan', '孤立的实体'));
    const gate = deferred<void>();
    let reading = false;
    const loadAll = RelationStore.prototype.loadAll;
    vi.spyOn(RelationStore.prototype, 'loadAll').mockImplementationOnce(async function (this: RelationStore) {
      reading = true;
      await gate.promise;
      return loadAll.call(this);
    });
    const proto = RelationStore.prototype as unknown as { put(...args: unknown[]): Promise<void> };
    const put = proto.put;
    vi.spyOn(proto, 'put').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      order.push('写入');
      await put.apply(this, args);
    });
    const remove = RelationStore.prototype.deleteEntityCascade;
    vi.spyOn(RelationStore.prototype, 'deleteEntityCascade').mockImplementation(async function (
      this: RelationStore,
      ...args
    ) {
      order.push('写入');
      return remove.apply(this, args);
    });
    const reply = maintain(registry);
    await vi.waitFor(() => expect(reading).toBe(true));
    await disable(app, order);
    gate.resolve();
    await reply;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(['停用落定']);
  });

  it('提取的模型调用途中停用、超了配额：提取写完之后不再接着淘汰，不告警', async () => {
    const { app, host, calls, store, warns } = await boot({
      triggerEveryNMessages: 1,
      commandsEnabled: false,
      consolidateAfterEviction: false,
      maxEntities: 1,
    });
    for (let i = 0; i < 3; i++) await store.upsertEntity(entityNode(`zz-entity-${i}`, `实体${i}`));
    await host.memory.use.saveMessage('zz-session', {
      role: 'user',
      content: '我是甲',
      metadata: { messageId: 'm1', userId: 'u1', nickname: '甲', platform: 'onebot' },
    });
    await host.events.use.emit('inbound:message:archived', {
      sessionId: 'zz-session',
      incoming: { userId: 'u1', platform: 'onebot' } as IncomingMessage,
    } as never);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await app.plugins.disable(userRelationPlugin.name);
    const graph = await store.loadAll();
    expect(graph.events.map(e => e.title)).toEqual(['讨论直播计划']);
    expect(graph.entities).toHaveLength(3);
    expect(warns).toEqual([]);
  });
});
