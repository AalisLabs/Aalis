import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type VectorStoreService, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, events, LogHub, provide } from '../../packages/core/src/index.js';
import type { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 改写已落库的消息（出站附件补上识图描述、update_image_description 写回描述）的一方在改写成功后发
// memory:messages-rewritten，带改写后的整条。向量记忆按会话与时间戳删掉旧条目，删到了才按改写后的正文重收录：
// assistant 按她的发言收，user 按存档消息的元数据收（与入站收录取同一份事实）；原来就没收录的不收。
// ════════════════════════════════════════════════════════════

const T = Date.UTC(2026, 0, 1, 12, 0, 0);
const SESSION = 'onebot:10000:group:20001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const embedder: EmbeddingService = {
  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  },
};

interface SetupOptions {
  /** 为假时向量存储没有 deleteByFilter */
  withDelete?: boolean;
  /** 装 message-archive */
  archive?: boolean;
  /** 识图：给了就登记一个媒体服务 */
  describe?: () => Promise<string>;
  /** 向量化：缺省立即回一个定值 */
  embedder?: EmbeddingService;
  /** 向量记忆的索引配置：缺省一次只收一条 */
  indexing?: Record<string, number>;
  /** 为真时向量存储不可用：访问 deleteByFilter 即抛 */
  storeDown?: () => boolean;
  /** 在向量记忆之前登记一个 assistant:message:archived 监听，等这么多毫秒才返回 */
  slowArchivedListener?: number;
}

/** 向量记忆连同内存记忆与只记条目的向量存储 */
async function setup(opts: SetupOptions = {}) {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, contributions, memory });
  await app.plugin(memoryInMemoryPlugin);
  host.provide.use(embedding, opts.embedder ?? embedder);
  const entries: Array<Record<string, unknown>> = [];
  const matches = (entry: Record<string, unknown>, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => entry[key] === value);
  const store: VectorStoreService = {
    async add(_vector, metadata) {
      entries.push(metadata);
    },
    async search() {
      return [];
    },
    async size() {
      return entries.length;
    },
    async clear() {
      entries.length = 0;
    },
    async save() {},
  };
  const deleteByFilter = async (filter: Record<string, unknown>) => {
    const before = entries.length;
    entries.splice(0, entries.length, ...entries.filter(entry => !matches(entry, filter)));
    return before - entries.length;
  };
  const storeDown = opts.storeDown;
  if (storeDown) {
    Object.defineProperty(store, 'deleteByFilter', {
      get() {
        if (storeDown()) throw new Error('向量存储已下线');
        return deleteByFilter;
      },
    });
  } else if (opts.withDelete !== false) store.deleteByFilter = deleteByFilter;
  host.provide.use(vectorstore, store);
  if (opts.describe) {
    const describe = opts.describe;
    host.provide.use(media, { describeImage: describe, describeVideo: describe } as never);
  }
  const slow = opts.slowArchivedListener;
  if (slow !== undefined)
    host.events.use.on('assistant:message:archived', () => new Promise(resolve => setTimeout(resolve, slow)));
  if (opts.archive) await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(memoryVector, { indexing: opts.indexing ?? { concurrency: 1, maxQueueSize: 10 } });
  await app.plugins.idle();
  if (app.plugins.getPlugin(memoryVector.name)?.state !== 'active') throw new Error('向量记忆未激活');
  return { app, host, entries, warns };
}

const herImage = (content: string): Message => ({
  role: 'assistant',
  kind: 'outbound-image',
  content,
  timestamp: T,
  metadata: { source: 'agent', ref: 'https://example.invalid/cat.png' },
});

const userIncoming = {
  content: '看图',
  sessionId: SESSION,
  platform: 'onebot',
  userId: '30001',
  nickname: '阿一',
  groupId: '20001',
  groupName: '测试群',
  sessionType: 'group',
};
const userArchived = (content: string): Message => ({
  role: 'user',
  content,
  timestamp: T + 1,
  metadata: {
    userId: '30001',
    nickname: '阿一',
    platform: 'onebot',
    groupId: '20001',
    groupName: '测试群',
    sessionType: 'group',
  },
});

describe('memory-vector 按改写通知重收录', () => {
  it('她的发言与对方的发言：删掉旧条目、按改写后的正文重收录；user 条目的元数据与入站收录的相同', async () => {
    const { host, entries } = await setup();
    await host.events.use.emit('assistant:message:archived', {
      sessionId: SESSION,
      message: herImage('[图片 | ref:https://example.invalid/cat.png]'),
    });
    await host.events.use.emit('inbound:message:archived', {
      sessionId: SESSION,
      incoming: userIncoming,
      archivedMessage: userArchived('[阿一(30001)]: 看图 [图片 | ref:data:/images/x/onebot/0123456789abcdef.png]'),
    });
    await vi.waitFor(() => expect(entries).toHaveLength(2));
    const inbound = { ...entries[1] };

    await host.events.use.emit('memory:messages-rewritten', {
      sessionId: SESSION,
      messages: [
        herImage('[图片: 一只橘猫 | ref:https://example.invalid/cat.png]'),
        userArchived('[阿一(30001)]: 看图 [图片: 一只狗 | ref:data:/images/x/onebot/0123456789abcdef.png]'),
      ],
    });
    await vi.waitFor(() =>
      expect(entries.map(entry => entry.content)).toEqual([
        '[图片: 一只橘猫 | ref:https://example.invalid/cat.png]',
        '[阿一(30001)]: 看图 [图片: 一只狗 | ref:data:/images/x/onebot/0123456789abcdef.png]',
      ]),
    );
    expect(entries.map(entry => [entry.role, entry.timestamp])).toEqual([
      ['assistant', T],
      ['user', T + 1],
    ]);
    const { content: _was, ...inboundFacts } = inbound;
    const { content: _now, ...rewrittenFacts } = entries[1];
    expect(rewrittenFacts).toEqual(inboundFacts);
  });

  it('同一条接连两次改写、前一次的向量化更慢：按到达的先后落定，向量里留后一次的', async () => {
    const slow = deferred<void>();
    const { host, entries } = await setup({
      indexing: {},
      embedder: {
        async embed(text) {
          if (text.includes('一只橘猫')) await slow.promise;
          return [0.1, 0.2, 0.3];
        },
      },
    });
    await host.events.use.emit('assistant:message:archived', {
      sessionId: SESSION,
      message: herImage('[图片 | ref:https://example.invalid/cat.png]'),
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    for (const desc of ['一只橘猫', '一只狸花猫'])
      await host.events.use.emit('memory:messages-rewritten', {
        sessionId: SESSION,
        messages: [herImage(`[图片: ${desc} | ref:https://example.invalid/cat.png]`)],
      });
    await new Promise(resolve => setTimeout(resolve, 20));
    slow.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(entries.map(entry => entry.content)).toEqual(['[图片: 一只狸花猫 | ref:https://example.invalid/cat.png]']);
  });

  it('删不到旧条目（原来就没收录）的不收录', async () => {
    const { host, entries } = await setup();
    await host.events.use.emit('memory:messages-rewritten', {
      sessionId: SESSION,
      messages: [herImage('[图片: 一只橘猫 | ref:https://example.invalid/cat.png]')],
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(entries).toEqual([]);
  });

  it('重收录时向量化失败：旧条目留着，记一条 warn', async () => {
    let fail = false;
    const { host, entries, warns } = await setup({
      embedder: {
        async embed() {
          if (fail) throw new Error('向量化超时');
          return [0.1, 0.2, 0.3];
        },
      },
    });
    await host.events.use.emit('assistant:message:archived', {
      sessionId: SESSION,
      message: herImage('[图片 | ref:https://example.invalid/cat.png]'),
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    fail = true;
    await host.events.use.emit('memory:messages-rewritten', {
      sessionId: SESSION,
      messages: [herImage('[图片: 一只橘猫 | ref:https://example.invalid/cat.png]')],
    });
    await vi.waitFor(() => expect(warns).toEqual([expect.stringContaining('向量化超时')]));
    expect(entries.map(entry => entry.content)).toEqual(['[图片 | ref:https://example.invalid/cat.png]']);
  });

  it('改写的不是她或对方的发言（如通知）：同一时间戳的条目不动', async () => {
    const { host, entries } = await setup();
    await host.events.use.emit('assistant:message:archived', {
      sessionId: SESSION,
      message: herImage('[图片 | ref:https://example.invalid/cat.png]'),
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    await host.events.use.emit('memory:messages-rewritten', {
      sessionId: SESSION,
      messages: [{ role: 'notice', content: '[图片: 一张图表 | ref:data:/images/x/chart.png]', timestamp: T }],
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(entries.map(entry => entry.content)).toEqual(['[图片 | ref:https://example.invalid/cat.png]']);
  });

  it('向量存储在重收录时不可用：记一条 warn，不留未处理的拒绝', async () => {
    let down = false;
    const { host, entries, warns } = await setup({ storeDown: () => down });
    await host.events.use.emit('assistant:message:archived', {
      sessionId: SESSION,
      message: herImage('[图片 | ref:https://example.invalid/cat.png]'),
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    down = true;
    await host.events.use.emit('memory:messages-rewritten', {
      sessionId: SESSION,
      messages: [herImage('[图片: 一只橘猫 | ref:https://example.invalid/cat.png]')],
    });
    await vi.waitFor(() => expect(warns).toEqual([expect.stringContaining('向量存储已下线')]));
    expect(entries).toHaveLength(1);
  });

  it('向量存储没有 deleteByFilter：记一条 warn，条目不变', async () => {
    const { host, entries, warns } = await setup({ withDelete: false });
    await host.events.use.emit('assistant:message:archived', {
      sessionId: SESSION,
      message: herImage('[图片 | ref:https://example.invalid/cat.png]'),
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    await host.events.use.emit('memory:messages-rewritten', {
      sessionId: SESSION,
      messages: [herImage('[图片: 一只橘猫 | ref:https://example.invalid/cat.png]')],
    });
    await vi.waitFor(() => expect(warns).toHaveLength(1));
    expect(entries.map(entry => entry.content)).toEqual(['[图片 | ref:https://example.invalid/cat.png]']);
  });
});

describe('改写的两个发出方', () => {
  it('她发的网址图片：描述补上之后向量记忆里这一条换成带描述的，同一时间戳只有一条', async () => {
    const description = deferred<string>();
    const { host, entries } = await setup({ archive: true, describe: () => description.promise });
    const url = 'https://example.invalid/cat.png';
    await host.events.use.emit('outbound:delivered', {
      sessionId: SESSION,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: url }],
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    description.resolve('一只橘猫');
    await vi.waitFor(() => expect(entries.map(entry => entry.content)).toEqual([`[图片: 一只橘猫 | ref:${url}]`]));
    const [stored] = await host.memory.use.getHistory(SESSION, 10);
    expect(entries[0].timestamp).toBe(stored.timestamp);
  });

  it('识图立即返回（如命中描述缓存）、索引照默认并发：原来那条还在收录时改写先到，向量里仍换成带描述的那条', async () => {
    // 原来那条（第一次向量化）比改写那条慢：改写不等它落定就删不到旧条目，原来那条随后照旧写进去
    let calls = 0;
    const { host, entries } = await setup({
      archive: true,
      describe: async () => '一只橘猫',
      indexing: {},
      embedder: {
        async embed() {
          if (calls++ === 0) await new Promise(resolve => setTimeout(resolve, 200));
          return [0.1, 0.2, 0.3];
        },
      },
    });
    const url = 'https://example.invalid/cat.png';
    await host.events.use.emit('outbound:delivered', {
      sessionId: SESSION,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: url }],
    });
    await vi.waitFor(async () =>
      expect((await host.memory.use.getHistory(SESSION, 10)).map(m => m.content)).toEqual([
        `[图片: 一只橘猫 | ref:${url}]`,
      ]),
    );
    await vi.waitFor(() => expect(entries.map(entry => entry.content)).toEqual([`[图片: 一只橘猫 | ref:${url}]`]));
  });

  it('识图立即返回、assistant:message:archived 上排在前面的监听很慢：补描述等这一条派发完再开始，向量里仍换成带描述的那条', async () => {
    const { host, entries } = await setup({
      archive: true,
      describe: async () => '一只橘猫',
      slowArchivedListener: 100,
    });
    const url = 'https://example.invalid/cat.png';
    await host.events.use.emit('outbound:delivered', {
      sessionId: SESSION,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: url }],
    });
    await vi.waitFor(() => expect(entries.map(entry => entry.content)).toEqual([`[图片: 一只橘猫 | ref:${url}]`]));
  });

  it('update_image_description 给发过的一张图写回描述：发改写通知带改写后的那条，向量记忆里这条换成带描述的', async () => {
    const { host, entries } = await setup();
    const image = 'data:/images/onebot_10000_group_20001/onebot/0123456789abcdef.png';
    const message = userArchived(`[阿一(30001)]: 看图 [图片 | ref:${image}]`);
    await host.memory.use.saveMessage(SESSION, message);
    await host.events.use.emit('inbound:message:archived', {
      sessionId: SESSION,
      incoming: userIncoming,
      archivedMessage: message,
    });
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    const rewritten: Message[][] = [];
    host.events.use.on('memory:messages-rewritten', ({ messages }) => {
      rewritten.push(messages);
    });

    const handlers: Record<string, (args: Record<string, unknown>, ctx: { sessionId: string }) => Promise<string>> = {};
    registerMediaTools(
      {
        tools: fixedRef(
          stubBoundTools({
            onRegister: tool => {
              handlers[tool.definition.function.name] = tool.handler as (typeof handlers)[string];
            },
          }),
        ),
        memory: host.memory,
        events: host.events,
        sessionManager: ref(),
        authority: ref(),
      },
      {} as MediaServiceImpl,
    );
    expect(
      await handlers.update_image_description({ image_ref: image, description: '一只狗' }, { sessionId: SESSION }),
    ).toBe('已更新 1 条消息中的图片描述');
    const after = `[阿一(30001)]: 看图 [图片: 一只狗 | ref:${image}]`;
    expect(rewritten).toEqual([[{ ...message, content: after }]]);
    await vi.waitFor(() => expect(entries.map(entry => entry.content)).toEqual([after]));
  });
});
