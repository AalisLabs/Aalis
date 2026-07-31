import { describe, expect, it } from 'vitest';
import type { AgentService, PromptContributionView } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest, ChatResponse, ChatStreamChunk, LLMModel } from '../../packages/api-llm/src/index.js';
import { LLMCapabilities } from '../../packages/api-llm/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App, type Context } from '../../packages/core/src/index.js';
import * as agentModule from '../../packages/plugin-agent/src/index.js';
import * as memoryHistoryModule from '../../packages/plugin-memory-history/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as memorySummaryModule from '../../packages/plugin-memory-summary/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import type { IncomingMessage, Message, OutgoingMessage, ToolCall } from '../../packages/schema-message/src/index.js';

/**
 * 提示词管线端到端集成测试
 *
 * 走真实主管线：agent.handleMessage → buildMessages（persona）→
 * assemblePromptContributions（四锚位物化）→ agent:llm:before → trimMessages →
 * LLM.chatStream。两路观测：**假 LLM 实际收到的 messages**（管线终点），以及
 * **agent:llm:before 进链时的布局**（探针中间件录制，断言"组装先于链"的时序）。
 *
 * 拓扑（全部 useModule，无网络 / 无真实 LLM / 无真实文件系统）：
 * - 探针 LLM（本文件内定义）：录下每次 chatStream 收到的 messages 快照
 * - memory-inmemory：memory 服务
 * - message-archive：入站消息烘焙（与真实部署一致）
 * - memory-history（真实贡献插件，context 锚位）
 * - memory-summary（真实贡献插件，context 锚位；摘要经 memory.metadata 播种）
 * - 探针贡献插件（本文件内定义）：identity / knowledge / turn-hint 三锚位贡献 +
 *   agent:llm:before 进链布局录制 + agent:tool:after 中场贡献（midturn-probe）
 * - plugin-agent：被测主管线
 */

// 测试从 core 源码路径导入，agent-api 对 '@aalis/core' 的 declaration merging
// 不在此路径生效——vitest 不做类型检查，用 never 断言绕过键约束（与
// test/plugins/prompt-assembly.test.ts 同一惯例）。
const POINT = 'agent:prompt' as never;

const SESSION = 'sess-main';
const CROSS_SESSION = 'sess-other';
/** 固定时间戳：跨会话历史种子（maxAgeMinutes=0 不做时间过滤，仅求可复现） */
const SEED_TS = Date.UTC(2026, 0, 1, 4, 0, 0);

// ---------- 探针 LLM ----------

interface ProbeReply {
  content: string;
  toolCalls?: ToolCall[];
}

function createProbeLLMPlugin(opts: { replies: ProbeReply[]; recorder: Message[][] }) {
  let cursor = 0;
  const nextReply = (): ProbeReply => {
    const reply = opts.replies[Math.min(cursor, opts.replies.length - 1)];
    cursor++;
    return reply;
  };
  // agent 在工具循环里会继续往同一个 messages 数组 push，故录制时做数组浅快照
  const record = (request: ChatModelRequest) => opts.recorder.push([...request.messages]);

  const model: LLMModel = {
    id: 'probe-model',
    providerId: '@aalis/test-fixture-probe-llm',
    contextLength: 32000,
    maxOutputTokens: 1024,
    capabilities: [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming],
    async chat(request: ChatModelRequest): Promise<ChatResponse> {
      record(request);
      const reply = nextReply();
      return { content: reply.content, toolCalls: reply.toolCalls };
    },
    async *chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
      record(request);
      const reply = nextReply();
      if (reply.content) yield { contentDelta: reply.content };
      yield {
        done: true,
        toolCalls: reply.toolCalls,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      };
    },
  };

  return {
    name: '@aalis/test-fixture-probe-llm',
    apply(ctx: Context) {
      ctx.provide('llm', model, {
        capabilities: [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming],
      });
    },
  };
}

// ---------- 探针贡献插件（三锚位贡献 + 进链布局录制 + 中场贡献）----------

function createProbeContributionPlugin(views: PromptContributionView[], hookLayouts: string[][]) {
  return {
    name: '@aalis/test-fixture-prompt-probe',
    apply(ctx: Context) {
      ctx.contribute(POINT, {
        id: 'identity-probe',
        anchor: 'identity',
        build(view: PromptContributionView) {
          views.push(view);
          return 'IDENTITY-PROBE-BLOCK';
        },
      } as never);
      ctx.contribute(POINT, {
        id: 'knowledge-probe',
        anchor: 'knowledge',
        build: () => 'KNOWLEDGE-PROBE-BLOCK',
      } as never);
      ctx.contribute(POINT, {
        id: 'turn-hint-probe',
        anchor: 'turn-hint',
        build: () => 'TURN-HINT-PROBE-BLOCK',
      } as never);
      // 进链探针：录下 agent:llm:before 链看到的布局。组装先于链是核心时序保证——
      // 进链时全部贡献块应已物化，拦截者审的是完整成品。
      ctx.middleware('agent:llm:before' as never, async (data: { messages: Message[] }, next: () => Promise<void>) => {
        hookLayouts.push(layoutOf(data.messages));
        await next();
      });
      // 中场贡献探针：工具执行后（工具循环的二次组装之前）注册新贡献。
      // MIDTURN 块只能由二次 assemblePromptContributions 物化——该调用被删则测试必挂。
      ctx.middleware('agent:tool:after' as never, async (_data: unknown, next: () => Promise<void>) => {
        ctx.contribute(POINT, {
          id: 'midturn-probe',
          anchor: 'knowledge',
          build: () => 'MIDTURN',
        } as never);
        await next();
      });
    },
  };
}

// ---------- 装栈 ----------

interface Stack {
  app: App;
  agent: AgentService;
  memory: MemoryService;
  /** 每次 LLM 调用收到的 messages 快照（按调用顺序） */
  recorder: Message[][];
  /** identity 贡献 build 收到的 view（按调用顺序） */
  views: PromptContributionView[];
  /** 每次 agent:llm:before 进链时的布局快照（探针中间件录制，按调用顺序） */
  hookLayouts: string[][];
  outbound: OutgoingMessage[];
  dispose: () => Promise<void>;
}

async function loadStack(replies: ProbeReply[]): Promise<Stack> {
  const app = new App({ config: { name: 'PP', logLevel: 'error', plugins: {} } });
  const recorder: Message[][] = [];
  const views: PromptContributionView[] = [];
  const hookLayouts: string[][] = [];
  const outbound: OutgoingMessage[] = [];

  await app.ctx.useModule(createProbeLLMPlugin({ replies, recorder }));
  await app.ctx.useModule(memoryInMemoryModule);
  const memory = app.ctx.getService<MemoryService>('memory');
  if (!memory) throw new Error('memory 服务未就绪');
  if (!memory.saveMetadata) throw new Error('memory 实现缺少 metadata 能力');

  // 种子一：另一会话的消息 → memory-history 的 context 贡献料
  await memory.saveMessage(CROSS_SESSION, {
    role: 'user',
    content: 'CROSS-SESSION-SEED',
    timestamp: SEED_TS,
    metadata: { platform: 'test' },
  });
  // 种子二：当前会话的摘要 → memory-summary 的 context 贡献料
  await memory.saveMetadata('summary', SESSION, {
    summary: 'SUMMARY-SEED',
    coveredUpTo: SEED_TS,
    messageCount: 1,
  });

  await app.ctx.useModule(messageArchiveModule, { debugLogs: false });
  await app.ctx.useModule(memoryHistoryModule, {
    injectEnabled: true,
    scope: 'cross-platform',
    maxAgeMinutes: 0,
    excludeCurrentSession: true,
    headerText: '[HISTORY-HEADER]',
    toolEnabled: false,
  });
  await app.ctx.useModule(memorySummaryModule, {
    // 阈值拉高 + 关自动压缩：本测试内不触发任何后台摘要 LLM 调用
    threshold: 9999,
    autoCompressThreshold: 0,
  });
  await app.ctx.useModule(createProbeContributionPlugin(views, hookLayouts));
  await app.ctx.useModule(agentModule, {
    systemPrompt: 'PERSONA-BASE-PROMPT',
    historyLimit: 50,
    memoryTokenBudget: 4096,
    maxToolIterations: 5,
    toolResultMaxRatio: 0.15,
    trimThresholdRatio: 1.0,
  });

  app.ctx.on('outbound:message', (m: OutgoingMessage) => {
    outbound.push(m);
  });

  // 插件变更 API 可能排队，等尘埃落定再发消息
  await app.plugins.idle();

  const agent = app.ctx.getService<AgentService>('agent');
  if (!agent) throw new Error('agent 服务未就绪');

  return {
    app,
    agent,
    memory,
    recorder,
    views,
    hookLayouts,
    outbound,
    dispose: async () => {
      try {
        await app.stop();
      } catch {
        /* 停机失败不影响断言结论 */
      }
    },
  };
}

const incoming = (content: string): IncomingMessage => ({
  content,
  sessionId: SESSION,
  platform: 'test',
  userId: 'u1',
  sessionType: 'private',
  triggerType: 'direct',
});

/** 把 messages 压成可逐位比对的布局标签：system 取 injector 末段，其余取 role */
function layoutOf(messages: readonly Message[]): string[] {
  return messages.map(m => {
    const injector = m.metadata?.injector;
    if (m.role === 'system' && typeof injector === 'string') {
      return injector.slice(injector.lastIndexOf('/') + 1);
    }
    return m.role;
  });
}

/** 按局部 id 找贡献块（全局键前缀依装载方式变化，只认末段） */
function injectedBy(messages: readonly Message[], localId: string): Message[] {
  return messages.filter(m => String(m.metadata?.injector ?? '').endsWith(`/${localId}`));
}

const CONTRIBUTION_IDS = ['identity-probe', 'knowledge-probe', 'memory-history', 'memory-summary', 'turn-hint-probe'];

describe('提示词管线端到端（真实 agent.handleMessage + 探针 LLM）', () => {
  it('单轮：persona 首位，四锚位贡献块各就各位，injector 全局键末段正确', async () => {
    const stack = await loadStack([{ content: 'REPLY-1' }]);
    try {
      await stack.agent.handleMessage(incoming('你好'));

      // 主管线确实跑完：LLM 被调一次，回复经 outbound 出站
      expect(stack.recorder).toHaveLength(1);
      expect(stack.outbound.map(m => m.content)).toEqual(['REPLY-1']);

      const sent = stack.recorder[0];

      // persona 在首位（agent 自建，injector 是字面量 'persona' 而非贡献全局键）
      expect(sent[0].role).toBe('system');
      expect(sent[0].metadata?.injector).toBe('persona');
      expect(String(sent[0].content)).toContain('PERSONA-BASE-PROMPT');

      // 逐位布局：persona → identity → knowledge → context（键码元序）→ turn-hint → user
      expect(layoutOf(sent)).toEqual([
        'persona',
        'identity-probe',
        'knowledge-probe',
        'memory-history',
        'memory-summary',
        'turn-hint-probe',
        'user',
      ]);

      // 组装先于链：agent:llm:before 进链时全部贡献块已物化，链上看到的就是送入 LLM 的成品布局
      expect(stack.hookLayouts).toEqual([layoutOf(sent)]);

      // 各贡献块的 injector 是全局键（含贡献方 ctx.id 前缀），且各只有一份
      for (const id of CONTRIBUTION_IDS) {
        const blocks = injectedBy(sent, id);
        expect(blocks).toHaveLength(1);
        const key = String(blocks[0].metadata?.injector);
        expect(key.endsWith(`/${id}`)).toBe(true);
        expect(key.length).toBeGreaterThan(id.length + 1);
      }

      // 真实插件确实交了真料
      expect(String(injectedBy(sent, 'memory-history')[0].content)).toContain('[HISTORY-HEADER]');
      expect(String(injectedBy(sent, 'memory-history')[0].content)).toContain('CROSS-SESSION-SEED');
      expect(String(injectedBy(sent, 'memory-summary')[0].content)).toContain('SUMMARY-SEED');

      // 最后一条是本轮用户消息，turn-hint 紧贴其前
      expect(sent[sent.length - 1].role).toBe('user');
      expect(String(sent[sent.length - 1].content)).toContain('你好');
      expect(String(sent[sent.length - 2].metadata?.injector).endsWith('/turn-hint-probe')).toBe(true);
    } finally {
      await stack.dispose();
    }
  });

  it('单轮：view 由真实管线透传（sessionId / userId / platform / triggerType / dryRun=false）', async () => {
    const stack = await loadStack([{ content: 'REPLY-1' }]);
    try {
      await stack.agent.handleMessage(incoming('你好'));
      expect(stack.views).toHaveLength(1);
      const view = stack.views[0];
      expect(view.sessionId).toBe(SESSION);
      expect(view.userId).toBe('u1');
      expect(view.platform).toBe('test');
      expect(view.triggerType).toBe('direct');
      expect(view.dryRun).toBe(false);
      // view.messages 是快照，且已含 persona
      expect(view.messages[0].metadata?.injector).toBe('persona');
    } finally {
      await stack.dispose();
    }
  });

  it('工具循环第二次 LLM 调用：二次组装真跑（中场贡献落位），已物化块按全局键幂等', async () => {
    const toolCall: ToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'no_such_tool', arguments: '{}' },
    };
    const stack = await loadStack([{ content: '', toolCalls: [toolCall] }, { content: 'REPLY-2' }]);
    try {
      await stack.agent.handleMessage(incoming('用一下工具'));

      // 工具循环确实转了一圈：两次 LLM 调用
      expect(stack.recorder).toHaveLength(2);
      expect(stack.outbound.map(m => m.content)).toEqual(['REPLY-2']);

      const first = stack.recorder[0];
      const second = stack.recorder[1];

      // 中场贡献（agent:tool:after 里注册）只该出现在第二次请求——二次组装被删则此处必挂
      expect(injectedBy(first, 'midturn-probe')).toHaveLength(0);
      const midturn = injectedBy(second, 'midturn-probe');
      expect(midturn).toHaveLength(1);
      expect(String(midturn[0].content)).toBe('MIDTURN');

      // 第二轮逐位布局：第一轮头部原样保留 + 中场块增量落于头部 system 区末尾 +
      // 工具回合追加的 assistant/tool
      expect(layoutOf(second)).toEqual([
        'persona',
        'identity-probe',
        'knowledge-probe',
        'memory-history',
        'memory-summary',
        'turn-hint-probe',
        'midturn-probe',
        'user',
        'assistant',
        'tool',
      ]);
      // 已物化的贡献按全局键跳过，一份不多
      for (const id of CONTRIBUTION_IDS) {
        expect(injectedBy(second, id)).toHaveLength(1);
      }
      // 贡献 build 也没被重跑（identity 探针只被调一次）
      expect(stack.views).toHaveLength(1);
      // 两次进链时组装均已完成：链上布局 = 送入 LLM 的布局（含第二次的中场块）
      expect(stack.hookLayouts).toEqual([layoutOf(first), layoutOf(second)]);
    } finally {
      await stack.dispose();
    }
  });

  it('第二轮对话：贡献块重新物化于新 messages，落在 persona 之后、历史之前', async () => {
    const stack = await loadStack([{ content: 'REPLY-1' }, { content: 'REPLY-2' }]);
    try {
      await stack.agent.handleMessage(incoming('第一句'));
      await stack.agent.handleMessage(incoming('第二句'));

      expect(stack.recorder).toHaveLength(2);
      const sent = stack.recorder[1];

      // 第二轮是全新 messages（buildMessages 重建），贡献块须重新物化：
      // persona → identity → knowledge → context ×2 → 上轮历史 → turn-hint → 本轮 user
      expect(layoutOf(sent)).toEqual([
        'persona',
        'identity-probe',
        'knowledge-probe',
        'memory-history',
        'memory-summary',
        'user',
        'assistant',
        'turn-hint-probe',
        'user',
      ]);
      for (const id of CONTRIBUTION_IDS) {
        expect(injectedBy(sent, id)).toHaveLength(1);
      }
      // 头部 system 区在第一条非 system 之前闭合
      const firstNonSystem = sent.findIndex(m => m.role !== 'system');
      expect(firstNonSystem).toBe(5);
      expect(String(sent[5].content)).toContain('第一句');
      expect(String(sent[6].content)).toContain('REPLY-1');
      expect(String(sent[8].content)).toContain('第二句');
      // 每轮组装一次 → identity 探针共两次
      expect(stack.views).toHaveLength(2);
    } finally {
      await stack.dispose();
    }
  });
});
