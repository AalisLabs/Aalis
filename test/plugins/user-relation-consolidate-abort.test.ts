import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { userRelation } from '../../packages/api-user-relation/src/index.js';
import { App, definePlugin, LogHub, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userRelationPlugin, {
  type RelationService,
  RelationStore,
} from '../../packages/plugin-user-relation/src/index.js';
import type { EntityNode, EventNode } from '../../packages/plugin-user-relation/src/types.js';
import { registerHubs } from '../fixtures/hubs.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 关系图整理（consolidate）是本插件自己发起的：别名核验、事件核验、合并后的摘要重写、层级推断、侧向父实体推断五种模型调用
// 与实体、事件的向量化都接本插件这次激活的中止信号。停用时在飞的那一次随之停下，整理抛中止原因、停在这一步，之前做完的
// 写入留着，不记告警。模型按系统提示认出是哪一种调用：目标那一种一直不回、只在收到的信号断开时按中止原因落定，其余照给的
// 答复回；向量化的替身同样一直不回。图数据直写存储，绕开建时去重。
// ════════════════════════════════════════════════════════════

type Kind = 'alias' | 'event' | 'summary' | 'hierarchy' | 'parent';

const KIND_MARKERS: Array<[Kind, string]> = [
  ['alias', '实体消歧'],
  ['event', '事件消歧'],
  ['summary', '知识库整理'],
  ['parent', '兄弟实体'],
  ['hierarchy', '实体层级推断'],
];

function kindOf(request: ChatModelRequest): Kind {
  const system = String(request.messages[0]?.content ?? '');
  const hit = KIND_MARKERS.find(([, marker]) => system.includes(marker));
  if (!hit) throw new Error(`认不出的整理调用：${system.slice(0, 40)}`);
  return hit[0];
}

const now = Date.now();
const evidence = [{ sessionId: 's', messageIds: ['m1'], quote: 'hello', extractedAt: now }];

const entity = (name: string, entityKind: EntityNode['entityKind']): EntityNode => ({
  id: globalThis.crypto.randomUUID(),
  entityKind,
  name,
  aliases: [],
  firstSeenAt: now,
  lastReinforcedAt: now,
  lastMentionedAt: now,
  mentionCount: 1,
  weight: 0.5,
  evidence,
});

const event = (title: string): EventNode => ({
  id: globalThis.crypto.randomUUID(),
  title,
  sessionScope: 'global',
  firstSeenAt: now,
  lastReinforcedAt: now,
  lastMentionedAt: now,
  mentionCount: 1,
  occurrences: [now],
  weight: 0.5,
  evidence,
});

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * 真插件装进 App，存储里放好给的实体与事件，接着开始执行一次带模型的整理（run）。hang 是一直不回的那一步（一种模型调用，或
 * 向量化，这时另登记向量化服务；给了 embed 时向量化按它回）；answers 是其余模型调用的答复。signals 记下一直不回的那一步每次
 * 收到的中止信号
 */
async function boot(opts: {
  hang: Kind | 'embed';
  answers?: Partial<Record<Kind, string>>;
  entities?: EntityNode[];
  events?: EventNode[];
  embed?: (text: string, signal: AbortSignal | undefined) => Promise<number[]>;
}) {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const signals: Array<AbortSignal | undefined> = [];
  const stall = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => {
      signals.push(signal);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  if (opts.hang === 'embed') {
    const { embed } = opts;
    const vectors: EmbeddingService = {
      modelId: 'zz-embed',
      embed: (text, options) => {
        if (!embed) return stall(options?.signal);
        signals.push(options?.signal);
        return embed(text, options?.signal);
      },
    };
    await app.plugin(
      definePlugin({
        name: 'zz-embedding-host',
        provides: [embedding],
        uses: { provide },
        apply: ({ provide }) => {
          provide.use(embedding, vectors);
        },
      }),
    );
  }
  await app.plugin(memoryInMemory);
  await app.plugin(userRelationPlugin, { extractionEnabled: false });
  await app.plugins.idle();
  const bound = app.bind({ memory, userRelation });
  if (!bound.userRelation.present) throw new Error('关系图插件没有激活');
  const store = new RelationStore(bound.memory.use);
  for (const node of opts.entities ?? []) await store.upsertEntity(node);
  for (const node of opts.events ?? []) await store.upsertEvent(node);
  const model = {
    id: 'zz-consolidate',
    capabilities: ['chat'],
    chat: async (request: ChatModelRequest) => {
      const kind = kindOf(request);
      if (kind === opts.hang) return stall(request.signal);
      return { content: opts.answers?.[kind] ?? '{}' };
    },
  } as unknown as LLMModel;
  const service = bound.userRelation.use as unknown as RelationService;
  const run = service.consolidate({
    autoLink: true,
    skipLowScorePairs: false,
    llm: { models: ref<LLMModel>([{ instance: model, contextId: 'zz/consolidate' }]), modelRef: {} },
  });
  return { app, store, signals, warns, run };
}

const SAME = '{"verdict": "same", "reason": "同一对象"}';
const DIFFERENT = '{"verdict": "different", "reason": "不同对象"}';

describe('关系图整理随停用中止', () => {
  it.each([
    [
      '同名实体的别名核验',
      { hang: 'alias' as const, entities: [entity('三角洲行动', 'work'), entity('三角洲行动', 'work')] },
    ],
    [
      '宽召回的别名核验',
      { hang: 'alias' as const, entities: [entity('三角洲', 'work'), entity('三角洲行动', 'work')] },
    ],
    [
      '层级推断',
      {
        hang: 'hierarchy' as const,
        answers: { alias: DIFFERENT },
        entities: [entity('三角洲', 'work'), entity('三角洲行动', 'work')],
      },
    ],
    [
      '侧向父实体推断',
      { hang: 'parent' as const, entities: [entity('三角洲行动刀皮', 'thing'), entity('三角洲行动绝密航天', 'thing')] },
    ],
    ['事件核验', { hang: 'event' as const, events: [event('讨论夏天炎热'), event('讨论夏天很热')] }],
    ['实体的向量化', { hang: 'embed' as const, entities: [entity('橘猫', 'thing'), entity('柯基', 'thing')] }],
    ['事件的向量化', { hang: 'embed' as const, events: [event('讨论夏天炎热')] }],
  ])('%s途中停用：交给它的中止信号随之断开，整理抛中止原因，不告警', async (_label, opts) => {
    const t = await boot(opts);
    await expect.poll(() => t.signals.length).toBeGreaterThan(0);
    await t.app.plugins.disable(userRelationPlugin.name);
    expect(t.signals.map(signal => signal?.aborted)).toEqual(t.signals.map(() => true));
    await expect(t.run).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.warns).toEqual([]);
  });

  it('合并后的摘要重写途中停用：之前做完的合并留着，摘要重写收到的信号断开，整理抛中止原因，不告警；重新启用后的下一次整理（这次没有合并）补写留下的那个实体的摘要，写成之后不再重写', async () => {
    const t = await boot({
      hang: 'summary',
      answers: { alias: SAME },
      entities: [entity('三角洲行动', 'work'), entity('三角洲行动', 'work')],
    });
    await expect.poll(() => t.signals.length).toBe(1);
    await t.app.plugins.disable(userRelationPlugin.name);
    expect(t.signals[0]?.aborted).toBe(true);
    await expect(t.run).rejects.toMatchObject({ name: 'AbortError' });
    expect((await t.store.loadAll()).entities.map(e => e.name)).toEqual(['三角洲行动']);
    expect(t.warns).toEqual([]);

    await t.app.plugins.enable(userRelationPlugin.name);
    await t.app.plugins.idle();
    const rewrites: string[] = [];
    const model = {
      id: 'zz-consolidate',
      capabilities: ['chat'],
      chat: async (request: ChatModelRequest) => {
        const kind = kindOf(request);
        if (kind === 'summary') rewrites.push(kind);
        return { content: kind === 'summary' ? '一款战术射击游戏' : '{}' };
      },
    } as unknown as LLMModel;
    const service = t.app.bind({ userRelation }).userRelation.use as unknown as RelationService;
    const consolidate = () =>
      service.consolidate({
        autoLink: true,
        llm: { models: ref<LLMModel>([{ instance: model, contextId: 'zz/consolidate' }]), modelRef: {} },
      });
    expect((await consolidate()).summariesRewritten).toBe(1);
    expect(rewrites).toEqual(['summary']);
    expect((await t.store.loadAll()).entities.map(e => e.summary)).toEqual(['一款战术射击游戏']);
    await consolidate();
    expect(rewrites, '写成之后去掉了待重写标记').toEqual(['summary']);
  });

  it('事件向量预热途中停用：同批已拿到向量的那条写完 hash 与向量之后，整理才抛中止原因，之后不再有写入', async () => {
    const order: string[] = [];
    const upsertVector = RelationStore.prototype.upsertVector;
    vi.spyOn(RelationStore.prototype, 'upsertVector').mockImplementation(async function (this: RelationStore, ...args) {
      await upsertVector.apply(this, args);
      order.push('向量已写');
    });
    const t = await boot({
      hang: 'embed',
      events: [event('讨论夏天炎热'), event('讨论冬天很冷')],
      // 第一条的向量恰在中止时回来（照常写回），第二条按中止原因落定
      embed: (text, signal) =>
        new Promise<number[]>((resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => (text.startsWith('讨论夏天') ? resolve([0.1, 0.2]) : reject(signal.reason)),
            {
              once: true,
            },
          ),
        ),
    });
    const rejected = t.run.catch((err: unknown) => {
      order.push('整理已拒绝');
      return err;
    });
    await expect.poll(() => t.signals.length).toBe(2);
    await t.app.plugins.disable(userRelationPlugin.name);
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(['向量已写', '整理已拒绝']);
  });
});
