import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import type { EmbeddingService } from '../../packages/plugin-embedding-api/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as memoryVectorModule from '../../packages/plugin-memory-vector/src/index.js';
import type { Message } from '../../packages/plugin-message-api/src/index.js';
import type { VectorSearchResult, VectorStoreService } from '../../packages/plugin-vectorstore-api/src/index.js';

// 直接从 core 源码路径导入，agent-api 对 '@aalis/core' 的 declaration merging 不在
// 该路径生效——vitest 不做类型检查，用 never 断言绕过贡献点键约束（同 prompt-assembly.test.ts）。
const POINT = 'agent:prompt' as never;

/** 固定时间戳基准（2026-01-01 12:00 UTC），避免依赖当前时间 */
const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);

/** 固定向量：假 embedder 恒定返回，假 store 也不真算距离 */
const FIXED_VEC = [0.1, 0.2, 0.3];

function makeEmbedder() {
  const calls: string[] = [];
  const service: EmbeddingService = {
    async embed(text: string): Promise<number[]> {
      calls.push(text);
      return FIXED_VEC;
    },
  };
  return { calls, service };
}

function makeStore(hits: VectorSearchResult[], opts: { searchThrows?: boolean } = {}) {
  const calls = { search: 0, size: 0 };
  /** 记录最近一次 search 的真实入参，供断言「embed 产物确实送进了检索」与候选池放大逻辑 */
  const last: { query?: number[]; topK?: number } = {};
  const service: VectorStoreService = {
    async add(): Promise<void> {
      // 本测试只走检索路径，索引侧不参与
    },
    async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
      calls.search++;
      last.query = queryVector;
      last.topK = topK;
      if (opts.searchThrows) throw new Error('向量库炸了');
      return hits.slice(0, topK);
    },
    async size(): Promise<number> {
      calls.size++;
      return hits.length;
    },
    async clear(): Promise<void> {
      // no-op
    },
    async save(): Promise<void> {
      // no-op
    },
  };
  return {
    calls,
    service,
    get lastQuery() {
      return last.query;
    },
    get lastTopK() {
      return last.topK;
    },
  };
}

function hit(
  score: number,
  meta: {
    sessionId: string;
    timestamp: number;
    content: string;
    userId?: string;
    nickname?: string;
    platform?: string;
  },
): VectorSearchResult {
  return { score, metadata: { ...meta } };
}

interface SetupOptions {
  hits?: VectorSearchResult[];
  searchThrows?: boolean;
  /** 覆盖 search 段配置 */
  search?: Record<string, unknown>;
  /** 覆盖 contextExpand 段配置（默认 window=0，即不做情景扩展） */
  contextExpand?: Record<string, unknown>;
  crossSessionMode?: string;
  /** 是否先挂 memory-inmemory（提供 getMessagesBySessionRange） */
  withMemory?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  if (opts.withMemory) await app.ctx.useModule(memoryInMemoryModule);

  const embedder = makeEmbedder();
  const store = makeStore(opts.hits ?? [], { searchThrows: opts.searchThrows });
  app.ctx.provide('embedding', embedder.service);
  app.ctx.provide('vectorstore', store.service);

  await app.ctx.useModule(memoryVectorModule, {
    // timeWeight=0：排名只看语义分，杜绝「当前时间」渗进断言
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 2, perItemMaxChars: 0, minScore: 0, ...opts.search },
    contextExpand: { window: 0, crossSession: true, ...opts.contextExpand },
    indexing: { concurrency: 1, maxQueueSize: 10 },
    crossSessionMode: opts.crossSessionMode ?? 'all',
  });

  return { app, embedder, store };
}

function baseMessages(userText = '还记得我上次说的吗'): Message[] {
  return [
    { role: 'system', content: '人设' },
    { role: 'user', content: userText },
  ];
}

function injectedBlock(messages: Message[]): Message | undefined {
  return messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'));
}

describe('plugin-memory-vector: agent:prompt 贡献', () => {
  it('dryRun=true → 不注入，且不触发 embedding / 检索', async () => {
    const { app, embedder, store } = await setup({
      hits: [hit(0.9, { sessionId: 's-a', timestamp: BASE_TS, content: '我最喜欢吃火锅' })],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur', dryRun: true });

    expect(messages).toHaveLength(2);
    expect(injectedBlock(messages)).toBeUndefined();
    expect(embedder.calls).toHaveLength(0);
    expect(store.calls.search).toBe(0);
  });

  it('无 user 消息 → 不注入，且不触发 embedding', async () => {
    const { app, embedder, store } = await setup({
      hits: [hit(0.9, { sessionId: 's-a', timestamp: BASE_TS, content: '我最喜欢吃火锅' })],
    });
    const messages: Message[] = [{ role: 'system', content: '人设' }];
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    expect(messages).toHaveLength(1);
    expect(embedder.calls).toHaveLength(0);
    expect(store.calls.search).toBe(0);
  });

  it('向量库为空（size=0）→ 不注入，且不触发 embedding', async () => {
    const { app, embedder, store } = await setup({ hits: [] });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    expect(messages).toHaveLength(2);
    expect(injectedBlock(messages)).toBeUndefined();
    expect(embedder.calls).toHaveLength(0);
    expect(store.calls.search).toBe(0);
  });

  it('检索命中 → context 锚位注入渲染后的记忆条目（按时间升序）', async () => {
    const { app, embedder, store } = await setup({
      hits: [
        hit(0.88, {
          sessionId: 'onebot:g1',
          timestamp: BASE_TS + 60_000,
          content: '我最喜欢吃火锅',
          userId: 'u1',
          nickname: 'Alice',
          platform: 'onebot',
        }),
        hit(0.72, {
          sessionId: 'onebot:g1',
          timestamp: BASE_TS,
          content: '周末去爬山了',
          userId: 'u1',
          nickname: 'Alice',
          platform: 'onebot',
        }),
      ],
    });

    // knowledge 侧对照探针：ctx id 必须**码元序排在被测插件全局键之后**（插件经
    // useModule 加载，键形如 `root#@aalis/plugin-memory-vector`，故用 zz- 前缀）。
    // 否则 anchor 错标成 knowledge 时两块仍按同样次序落位，锚位断言恒真。
    app.ctx.fork('zz-probe-knowledge').contribute(POINT, { id: 'kn', anchor: 'knowledge', build: () => 'KN' } as never);

    // 前缀时间标签（agent 注入的 "(刚刚) "）应在 embed 前被剥掉。
    // fixture 带一轮历史：没有它时"第一条非 system"与"最后一条 user"重合，
    // context 与 turn-hint 落点相同、锚位断言对 turn-hint 恒真。
    const messages: Message[] = [
      { role: 'system', content: '人设' },
      { role: 'user', content: '旧问' },
      { role: 'assistant', content: '旧答' },
      { role: 'user', content: '(刚刚) 还记得我上次说的吗' },
    ];
    await assemblePromptContributions(app.ctx, { messages, sessionId: 'onebot:g1', platform: 'onebot' });

    expect(messages).toHaveLength(6);
    // context 锚位落在头部 system 区末尾（原 system 之后、首条非 system 之前），
    // 且在 knowledge 槽之后、历史之前——四种锚位错标均可判伪
    expect(messages[0].content).toBe('人设');
    expect(messages[1].content, 'knowledge 槽须先于 context 槽').toBe('KN');
    expect(messages[2].role).toBe('system');
    expect(String(messages[2].metadata?.injector ?? '').endsWith('/memory-vector')).toBe(true);
    expect(messages[3], 'context 槽须在历史之前（turn-hint 会落到最后一条 user 前）').toMatchObject({
      role: 'user',
      content: '旧问',
    });

    const block = String(messages[2].content);
    expect(block).toContain('以下是从长期记忆中检索到的相关聊天记录片段');
    expect(block).toContain('我最喜欢吃火锅');
    expect(block).toContain('周末去爬山了');
    // 渲染带来源标签：平台 / 昵称(ID)
    expect(block).toContain('onebot/');
    expect(block).toContain('Alice(u1)');
    // 时间升序：旧的在前
    expect(block.indexOf('周末去爬山了')).toBeLessThan(block.indexOf('我最喜欢吃火锅'));

    expect(embedder.calls).toEqual(['还记得我上次说的吗']);
    // embed 产物必须原样送进 store.search（引用级一致，非仅内容相等）
    expect(store.lastQuery).toBe(FIXED_VEC);
  });

  it('候选池放大：store.search 收到的 topK = min(配置 topK*4, size)', async () => {
    const { app, store } = await setup({
      search: { topK: 1 },
      hits: Array.from({ length: 6 }, (_, i) =>
        hit(0.9 - i * 0.1, { sessionId: 's-a', timestamp: BASE_TS + i * 1000, content: `候选记忆${i}` }),
      ),
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    // topK=1、库中 6 条 → 候选池取 1*4=4
    expect(store.lastTopK).toBe(4);
  });

  it('minScore 阈值过滤低分命中', async () => {
    const { app } = await setup({
      search: { minScore: 0.5 },
      hits: [
        hit(0.9, { sessionId: 's-a', timestamp: BASE_TS, content: '高分记忆内容' }),
        hit(0.2, { sessionId: 's-a', timestamp: BASE_TS + 1000, content: '低分记忆内容' }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('高分记忆内容');
    expect(block).not.toContain('低分记忆内容');
  });

  it('全部命中低于 minScore → 不注入', async () => {
    const { app } = await setup({
      search: { minScore: 0.95 },
      hits: [hit(0.3, { sessionId: 's-a', timestamp: BASE_TS, content: '够不着阈值' })],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    expect(messages).toHaveLength(2);
    expect(injectedBlock(messages)).toBeUndefined();
  });

  it('store.search 抛错 → 本贡献缺席，不影响同轮其它贡献物化', async () => {
    const { app } = await setup({
      searchThrows: true,
      hits: [hit(0.9, { sessionId: 's-a', timestamp: BASE_TS, content: '拿不到的记忆' })],
    });
    app.ctx.fork('probe').contribute(POINT, {
      id: 'probe',
      anchor: 'context',
      build: () => 'PROBE-OK',
    } as never);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    expect(injectedBlock(messages)).toBeUndefined();
    expect(messages.some(m => String(m.content) === 'PROBE-OK')).toBe(true);
    expect(messages.some(m => String(m.content).includes('拿不到的记忆'))).toBe(false);
  });

  it('命中内容与当轮对话重复 → 该条被去重，其余照常呈现', async () => {
    const { app } = await setup({
      hits: [
        hit(0.9, { sessionId: 's-a', timestamp: BASE_TS, content: '完全一样的一句话' }),
        hit(0.8, { sessionId: 's-a', timestamp: BASE_TS + 1000, content: '另一段旧记忆' }),
      ],
    });
    const messages = baseMessages('完全一样的一句话');
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('另一段旧记忆');
    expect(block).not.toContain('完全一样的一句话');
  });

  it('crossSessionMode=isolated → 只保留当前会话的命中', async () => {
    const { app } = await setup({
      crossSessionMode: 'isolated',
      hits: [
        hit(0.9, { sessionId: 'onebot:g1', timestamp: BASE_TS, content: '本会话旧消息' }),
        hit(0.85, { sessionId: 'onebot:g2', timestamp: BASE_TS + 1000, content: '别的会话消息' }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 'onebot:g1', platform: 'onebot' });

    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('本会话旧消息');
    expect(block).not.toContain('别的会话消息');
  });

  it('crossSessionMode=platform → metadata.platform 或 sessionId 前缀命中同平台均保留，异平台被滤除', async () => {
    const { app } = await setup({
      crossSessionMode: 'platform',
      hits: [
        // (a) sessionId 前缀不匹配（legacy-a），仅靠 metadata.platform 命中
        hit(0.9, { sessionId: 'legacy-a', timestamp: BASE_TS, content: '平台字段命中的记忆', platform: 'onebot' }),
        // (b) metadata.platform 缺失，仅靠 sessionId 前缀兜底命中
        hit(0.85, { sessionId: 'onebot:g9', timestamp: BASE_TS + 1000, content: '会话前缀命中的记忆' }),
        // (c) 异平台：两个条件都不中
        hit(0.8, { sessionId: 'discord:z', timestamp: BASE_TS + 2000, content: '异平台的记忆', platform: 'discord' }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 'onebot:g1', platform: 'onebot' });

    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('平台字段命中的记忆');
    expect(block).toContain('会话前缀命中的记忆');
    expect(block).not.toContain('异平台的记忆');
  });

  it('contextExpand: memory 支持范围查询时，命中点带出前后各 N 条邻居', async () => {
    const { app } = await setup({
      withMemory: true,
      contextExpand: { window: 1 },
      hits: [hit(0.9, { sessionId: 's-old', timestamp: BASE_TS, content: 'PIVOT-Q', userId: 'u1' })],
    });

    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('no memory');
    // 存入归档真形态（含 [昵称(ID)]: 前缀）；向量 metadata.content 仍是裸文本——
    // 两条路径的文本从此可区分，若 messageKey 退化为含 content 的 key，双入将被抓到
    await memory.saveMessage('s-old', { role: 'assistant', content: 'PREV-A', timestamp: BASE_TS - 60_000 });
    await memory.saveMessage('s-old', { role: 'user', content: '[Alice(u1)]: PIVOT-Q', timestamp: BASE_TS });
    await memory.saveMessage('s-old', { role: 'assistant', content: 'NEXT-A', timestamp: BASE_TS + 60_000 });
    await memory.saveMessage('s-old', { role: 'user', content: 'FAR-Q', timestamp: BASE_TS + 120_000 });

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('PREV-A');
    expect(block).toContain('NEXT-A');
    expect(block).not.toContain('FAR-Q');
    // 命中点本身只出现一次（扩展路径与 metadata 兜底共用同一 messageKey 去重）
    expect((block.match(/PIVOT-Q/g) ?? []).length).toBe(1);
    // 渲染层剥掉归档 sender 前缀（来源标签已表达身份，不双重前缀）
    expect(block).not.toContain('[Alice(u1)]:');
  });

  it('重复组装不重复注入（全局键幂等）', async () => {
    const { app, embedder } = await setup({
      hits: [hit(0.9, { sessionId: 's-a', timestamp: BASE_TS, content: '只该出现一次的记忆' })],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });

    expect(messages.filter(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'))).toHaveLength(1);
    expect(embedder.calls).toHaveLength(1);
  });
});
