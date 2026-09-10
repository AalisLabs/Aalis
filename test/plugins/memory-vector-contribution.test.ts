import { describe, expect, it } from 'vitest';
import type { EmbeddingService } from '../../packages/api-embedding/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { MessageArchiveService } from '../../packages/api-message-archive/src/index.js';
import type { VectorSearchResult, VectorStoreService } from '../../packages/api-vectorstore/src/index.js';
import { App } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as memoryVectorModule from '../../packages/plugin-memory-vector/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

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
  /** 索引侧写入记录（供「proactive 伪 incoming 不入库」等断言） */
  const added: Array<Record<string, unknown>> = [];
  const service: VectorStoreService = {
    async add(_vector: number[], metadata: Record<string, unknown>): Promise<void> {
      added.push(metadata);
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
    added,
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
    role?: string;
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
  recallRoles?: string;
  /** 是否先挂 memory-inmemory（提供 getMessagesBySessionRange） */
  withMemory?: boolean;
  /** 是否挂真 message-archive（钉 assistant:message:archived 发射端） */
  withArchive?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  if (opts.withMemory) await app.ctx.useModule(memoryInMemoryModule);
  if (opts.withArchive) await app.ctx.useModule(messageArchiveModule, { debugLogs: false });

  const embedder = makeEmbedder();
  const store = makeStore(opts.hits ?? [], { searchThrows: opts.searchThrows });
  app.ctx.provide('embedding', embedder.service);
  app.ctx.provide('vectorstore', store.service);
  // 假 tools 服务：捕获 memory_recall 注册（该管线与被动注入零共享，需独立钉住）
  const toolHandlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => Promise<string>>();
  app.ctx.provide('tools', {
    register: (tool: { definition: { function: { name: string } }; handler: never }) => {
      toolHandlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);

  await app.ctx.useModule(memoryVectorModule, {
    // timeWeight=0：排名只看语义分，杜绝「当前时间」渗进断言
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 2, perItemMaxChars: 0, minScore: 0, ...opts.search },
    contextExpand: { window: 0, crossSession: true, ...opts.contextExpand },
    indexing: { concurrency: 1, maxQueueSize: 10 },
    crossSessionMode: opts.crossSessionMode ?? 'all',
    recallRoles: opts.recallRoles ?? 'all',
  });

  return { app, embedder, store, toolHandlers };
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

  it('检索命中 → turn-context 锚位注入渲染后的记忆条目（按时间升序）', async () => {
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
    // turn-context 锚位落在历史**之后**、最后一条 user 之前——这是缓存命中的
    // 前提：检索片段按当前消息取材、每轮必变，放历史前会让 append-only 的
    // 历史永远命不中前缀缓存（实测 12.7%）。knowledge 探针留在头部区可判伪
    // 「错标回 context/knowledge」的回归。
    expect(messages[0].content).toBe('人设');
    expect(messages[1].content, 'knowledge 槽仍在头部区').toBe('KN');
    expect(messages[2], 'turn-context 槽必须在历史之后').toMatchObject({ role: 'user', content: '旧问' });
    expect(messages[3].content).toBe('旧答');
    expect(messages[4].role).toBe('system');
    expect(String(messages[4].metadata?.injector ?? '').endsWith('/memory-vector')).toBe(true);
    expect(messages[5], '检索块须在最后一条 user 之前').toMatchObject({ role: 'user' });

    const block = String(messages[4].content);
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
    // 角色标注（2026-08-27）：assistant 邻居必须标成「你自己的回复」，不得渲染成
    // 与真人发言同构的形态——那是「戳戳月卡」自我强化事故的入口。同时补角色说明句。
    expect((block.match(/Assistant·你自己/g) ?? []).length).toBe(3); // PREV-A、NEXT-A 各一 + 角色说明句一
    expect(block).toContain('标注 Assistant·你自己 的条目是你自己当时的回复');
    // user 命中本身不受影响（只标注不过滤：邻居集合与命中集合都不变）
    expect(block).toContain('PIVOT-Q');
  });

  it('角色标注只在片段含非 user 角色时出现；纯 user 片段渲染不变', async () => {
    const { app } = await setup({
      hits: [
        hit(0.9, { sessionId: 's-old', timestamp: BASE_TS, content: '纯用户记忆', userId: 'u1', nickname: 'Alice' }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('纯用户记忆');
    expect(block).toContain('Alice(u1)');
    expect(block).not.toContain('Assistant·你自己');
    expect(block).not.toContain('标注 Assistant·你自己');
  });

  it('contextExpand: tool/notice 邻居分别标注为 Tool/Notice，不冒充人形发言', async () => {
    const { app } = await setup({
      withMemory: true,
      contextExpand: { window: 2 },
      hits: [hit(0.9, { sessionId: 's-old', timestamp: BASE_TS, content: 'PIVOT-Q', userId: 'u1' })],
    });
    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('no memory');
    await memory.saveMessage('s-old', {
      role: 'tool',
      content: '{"ok":true,"data":"工具输出"}',
      timestamp: BASE_TS - 60_000,
    });
    await memory.saveMessage('s-old', { role: 'user', content: 'PIVOT-Q', timestamp: BASE_TS });
    await memory.saveMessage('s-old', { role: 'notice', content: '[系统通知] 某某事件', timestamp: BASE_TS + 60_000 });

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    // 锚定完整标签形态（含 @ 前缀）：裸词 'Notice'/'Tool' 会被标题行说明句满足，
    // 对 renderMessage 是否真有该分支零敏感（2026-08-27 审计变异实测）。
    expect(block).toContain('[Tool·工具结果 @');
    expect(block).toContain('[Notice @');
    expect(block).toContain('标注 Assistant·你自己');
  });

  it('索引侧：triggerType=proactive 的伪 incoming（委派/工作流派发的 AI 文本）不入向量库', async () => {
    const { app, store } = await setup({});
    // 事件键经 declaration merging 声明，测试从源码路径导入拿不到增广——
    // 以宽签名断言 emit（同文件 POINT 常量的 never 技法对双参 emit 会把实参也打成 never）
    const emitLoose = app.ctx.emit.bind(app.ctx) as (event: string, data: unknown) => Promise<void>;
    const emitArchived = (incoming: Record<string, unknown>) =>
      emitLoose('inbound:message:archived', {
        sessionId: incoming.sessionId,
        incoming,
        archivedMessage: { role: 'user', content: incoming.content, timestamp: BASE_TS },
      });

    // 顺序关键：proactive 先入队。索引队列 concurrency=1 FIFO——若守卫失效，
    // META 会先于真人发言落库，下方全等断言即红。此前「先真人后 META + 轮询
    // length===0 即退出」的写法对守卫零敏感（2026-08-27 审计变异实测存活）。
    await emitArchived({
      content: '[跨会话委派 META]\nAI 撰写的任务文本',
      sessionId: 's2',
      platform: 'onebot',
      source: 'proactive:from:s0',
      triggerType: 'proactive',
    });
    // 三漏路径（2026-08-28 用户裁定全堵）：scheduler / workflow send_message / subtask 派发
    // 同为 AI/系统撰写文本，不带 triggerType，按 source/userId 判据堵。全部先于真人入队，
    // FIFO 下任何一条漏堵都会先于真人落库、被下方全等断言抓红。
    await emitArchived({ content: '定时任务内容', sessionId: 's3', platform: 'onebot', source: 'scheduler' });
    await emitArchived({ content: 'workflow 派发文本', sessionId: 's4', platform: 'onebot', source: 'workflow:wf1' });
    await emitArchived({ content: '子任务追问', sessionId: 's5', platform: 'internal', userId: 'parent:p1' });
    await emitArchived({ content: '真人发言', sessionId: 's1', platform: 'onebot', userId: 'u1' });
    // 索引走异步队列，轮询等待首条落库（FIFO 保证此时前面全部伪 incoming 已被处理过）
    for (let i = 0; i < 50 && store.added.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(store.added.map(m => m.content)).toEqual(['真人发言']);
  });

  it('存量委派 META 命中在检索期整体剔除（不注入、不占位）', async () => {
    const { app } = await setup({
      hits: [
        hit(0.95, { sessionId: 's-old', timestamp: BASE_TS, content: '[跨会话委派 META]\n· 来源会话：xx\n任务文本' }),
        hit(0.8, { sessionId: 's-old', timestamp: BASE_TS + 1, content: '真实记忆', userId: 'u1' }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('真实记忆');
    expect(block).not.toContain('跨会话委派 META');
  });

  it('兜底路径不给已按真实角色收录的 (sid,ts) 造 user 拷贝——同一逻辑消息只注入一份', async () => {
    // 事故形态（2026-08-27 审计 blocker）：向量命中的 pivot 在 SQLite 里是 notice 角色，
    // 扩窗以 [Notice] 收录后，兜底路径曾因 messageKey 含 role 而再造一份匿名 user 行。
    const { app } = await setup({
      withMemory: true,
      contextExpand: { window: 1 },
      hits: [hit(0.9, { sessionId: 's-old', timestamp: BASE_TS, content: 'X事件文本' })],
    });
    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('no memory');
    await memory.saveMessage('s-old', { role: 'notice', content: 'X事件文本', timestamp: BASE_TS });

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    expect((block.match(/X事件文本/g) ?? []).length).toBe(1);
    expect(block).toContain('[Notice @');
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

describe('索引文本 = 归档文本', () => {
  it('图片消息：embed 与兜底 content 取归档文本（含识别描述），不取 incoming 占位符', async () => {
    // 断链形态（2026-09 核实）：lancedb 中 15995 条裸 [图片] 占位符 vs 20 条带描述——
    // 索引侧 embed 的是 incoming.content，plugin-media 识别出的描述只进了归档，从未进向量空间。
    const { app, store, embedder } = await setup({});
    const emitLoose = app.ctx.emit.bind(app.ctx) as (event: string, data: unknown) => Promise<void>;
    const archivedText = '[小明(u1)]: 看这个\n[图片 | ref:abc123]\n[图片描述] 一只橘猫趴在键盘上';
    await emitLoose('inbound:message:archived', {
      sessionId: 's1',
      incoming: {
        content: '看这个\n[图片 | ref:abc123]',
        sessionId: 's1',
        platform: 'onebot',
        userId: 'u1',
        nickname: '小明',
      },
      archivedMessage: { role: 'user', content: archivedText, timestamp: BASE_TS + 7 },
    });
    for (let i = 0; i < 50 && store.added.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    // embed 文本就是归档文本：不二次加前缀（archive 已加），描述必须在向量空间里
    expect(embedder.calls).toEqual([archivedText]);
    expect(store.added).toHaveLength(1);
    expect(store.added[0].content).toBe(archivedText);
    // 时间戳以归档为准（按时间戳精确删除的对齐前提）
    expect(store.added[0].timestamp).toBe(BASE_TS + 7);
  });
});

describe('索引文本长度上限', () => {
  it('文件正文整段烘进归档的超长消息：按上限截断后仍入库（而非整条静默索引失败），且不切坏 emoji', async () => {
    // 对抗审计（2026-09）：改取归档文本后，file-reader 烘进的 `--- 文件内容 ---` 块可达数万字，
    // embedder 超限抛错 → 只留一条 warn，消息从此不可召回。
    const { app, store, embedder } = await setup({});
    const emitLoose = app.ctx.emit.bind(app.ctx) as (event: string, data: unknown) => Promise<void>;
    const body = `[u1]: 看下这个配置\n--- 文件内容 ---\n${'配置行；'.repeat(3000)}`;
    // 让上限边界恰好落在一个代理对中间：前 3999 个 UTF-16 单元后接一个 emoji
    const boundaryBody = `${'x'.repeat(3999)}😀${'y'.repeat(50)}`;
    await emitLoose('inbound:message:archived', {
      sessionId: 's1',
      incoming: { content: '看下这个配置', sessionId: 's1', platform: 'onebot', userId: 'u1' },
      archivedMessage: { role: 'user', content: body, timestamp: BASE_TS },
    });
    await emitLoose('inbound:message:archived', {
      sessionId: 's1',
      incoming: { content: 'x', sessionId: 's1', platform: 'onebot', userId: 'u1' },
      archivedMessage: { role: 'user', content: boundaryBody, timestamp: BASE_TS + 1 },
    });
    for (let i = 0; i < 50 && store.added.length < 2; i++) await new Promise(r => setTimeout(r, 20));
    expect(store.added).toHaveLength(2);
    expect(embedder.calls[0].length).toBe(4000);
    expect(embedder.calls[0].startsWith('[u1]: 看下这个配置')).toBe(true);
    expect(store.added[0].content).toBe(embedder.calls[0]);
    // 代理对安全：截断点回退一位，末尾不留孤代理
    expect(embedder.calls[1].length).toBe(3999);
    expect(embedder.calls[1]).toBe('x'.repeat(3999));
  });
});

describe('recallRoles 双模式（存储侧 + 检索侧）', () => {
  it('索引侧：assistant 落库事件入库带 role=assistant，user 入库带 role=user', async () => {
    const { app, store } = await setup({});
    const emitLoose = app.ctx.emit.bind(app.ctx) as (event: string, data: unknown) => Promise<void>;
    await emitLoose('inbound:message:archived', {
      sessionId: 's1',
      incoming: { content: '对方的话', sessionId: 's1', platform: 'onebot', userId: 'u1' },
      archivedMessage: { role: 'user', content: '对方的话', timestamp: BASE_TS },
    });
    await emitLoose('assistant:message:archived', {
      sessionId: 'onebot:1:group:2',
      message: {
        role: 'assistant',
        content: '我自己的回复',
        timestamp: BASE_TS + 1,
        // 生产形态（buildAssistantMetadata）：自身标识在 userId，无 selfId 键
        metadata: { userId: 'bot1', nickname: 'Aalis', groupName: '测试群', groupId: '2', sessionType: 'group' },
      },
    });
    for (let i = 0; i < 50 && store.added.length < 2; i++) await new Promise(r => setTimeout(r, 20));
    expect(store.added.map(m => [m.role, m.content])).toEqual([
      ['user', '对方的话'],
      ['assistant', '我自己的回复'],
    ]);
    // 身份与位置透传（audit：曾读错成 meta.selfId——全仓无人写该键，恒空串）
    expect(store.added[1].userId).toBe('bot1');
    expect(store.added[1].groupName).toBe('测试群');
    expect(store.added[1].sessionType).toBe('group');
  });

  it('发射端全链：archive.saveMessage(assistant) 真的触发向量入库；tool 角色不发事件', async () => {
    const { app, store } = await setup({ withMemory: true, withArchive: true });
    const archive = app.ctx.getService<MessageArchiveService>('message-archive');
    if (!archive) throw new Error('no archive');
    // 顺序关键：不该发事件的先存（若发射门失守，它们会先于合法条目入库，全等断言即红）
    await archive.saveMessage('s1', { role: 'tool', content: '{"x":1}', timestamp: BASE_TS });
    // 工具调用回合的内部前言（带 toolCalls）从未对外发出，不进语义记忆
    await archive.saveMessage('s1', {
      role: 'assistant',
      content: '我来查一下天气',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      timestamp: BASE_TS + 1,
    });
    await archive.saveMessage('s1', {
      role: 'assistant',
      content: '承诺明天提醒你',
      timestamp: BASE_TS + 2,
      metadata: { userId: 'bot1', nickname: 'Aalis' },
    });
    for (let i = 0; i < 50 && store.added.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(store.added.map(m => [m.role, m.content])).toEqual([['assistant', '承诺明天提醒你']]);
  });

  it('others-only：assistant 命中被过滤；无 role 的存量旧向量按对方保留', async () => {
    const { app } = await setup({
      recallRoles: 'others-only',
      hits: [
        hit(0.95, { sessionId: 's-old', timestamp: BASE_TS, content: '我自己说过的话', role: 'assistant' }),
        hit(0.8, { sessionId: 's-old', timestamp: BASE_TS + 1, content: '旧数据无角色', userId: 'u1' }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('旧数据无角色');
    expect(block).not.toContain('我自己说过的话');
  });

  it('memory_recall 工具：others-only 过滤命中且 role 还原生效（该管线与被动注入零共享）', async () => {
    const { toolHandlers } = await setup({
      recallRoles: 'others-only',
      hits: [
        hit(0.95, { sessionId: 's-old', timestamp: BASE_TS, content: '我自己说过的话', role: 'assistant' }),
        hit(0.8, { sessionId: 's-old', timestamp: BASE_TS + 1, content: '对方的记忆', userId: 'u1' }),
      ],
    });
    const recall = toolHandlers.get('memory_recall');
    expect(recall, 'memory_recall 未注册').toBeDefined();
    const out = JSON.parse(await recall!({ query: '记忆' }, { sessionId: 's-cur', platform: 'onebot' }));
    const texts = (out.results ?? []).map((r: { text: string }) => r.text).join('\n');
    expect(texts).toContain('对方的记忆');
    expect(texts).not.toContain('我自己说过的话');
  });

  it('memory_recall 工具：默认 all 下 assistant 命中带 Assistant·你自己 标注（role 还原）', async () => {
    const { toolHandlers } = await setup({
      hits: [
        hit(0.95, {
          sessionId: 's-old',
          timestamp: BASE_TS,
          content: '我承诺过的事',
          role: 'assistant',
          nickname: 'Aalis',
        }),
      ],
    });
    const recall = toolHandlers.get('memory_recall')!;
    const out = JSON.parse(await recall({ query: '承诺' }, { sessionId: 's-cur', platform: 'onebot' }));
    expect(out.results?.[0]?.text).toContain('[Assistant·你自己(Aalis) @');
  });

  it('扩窗未命中兜底（消息表已老化）：assistant 命中仍按 metadata.role 标注，不落匿名人形', async () => {
    // memory 在场但为空 → pivot 定位失败 → 走「向量 metadata 兜底插入」分支（M3b 路径）
    const { app } = await setup({
      withMemory: true,
      contextExpand: { window: 2 },
      hits: [
        hit(0.9, {
          sessionId: 's-aged',
          timestamp: BASE_TS,
          content: '老化后的自我发言',
          role: 'assistant',
          nickname: 'Aalis',
        }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('老化后的自我发言');
    expect(block).toContain('[Assistant·你自己(Aalis) @');
  });

  it('默认 all：assistant 命中注入且带 Assistant·你自己 标注与标题自指说明', async () => {
    const { app } = await setup({
      hits: [
        hit(0.95, {
          sessionId: 's-old',
          timestamp: BASE_TS,
          content: '我承诺过明天提醒',
          role: 'assistant',
          nickname: 'Aalis',
        }),
      ],
    });
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-cur' });
    const block = String(injectedBlock(messages)?.content ?? '');
    expect(block).toContain('我承诺过明天提醒');
    expect(block).toContain('[Assistant·你自己(Aalis) @');
    expect(block).toContain('标注 Assistant·你自己 的条目是你自己当时的回复');
  });
});
