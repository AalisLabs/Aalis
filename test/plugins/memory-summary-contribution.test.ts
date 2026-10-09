import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { LLMCapabilities, llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// 测试从源码路径导入，api-agent 对 '@aalis/api-contributions' 的 declaration merging
// 不在此路径生效，用 never 断言绕过键约束。
const POINT = 'agent:prompt' as never;

/** 摘要落库的 namespace（与插件内 SummaryStore 约定一致，经 memory 服务公开面种入） */
const SUMMARY_NAMESPACE = 'summary';
/** 固定时间戳：摘要记录的 updatedAt 不参与 build，钉死避免时间敏感 */
const FIXED_TS = '2026-01-01T00:00:00.000Z';

/** 只声明 chat 能力的假 LLM model entry：贡献不调模型 */
function fakeLLMModel(contextLength: number): LLMModel {
  return {
    id: 'fake-model',
    providerId: 'fake-provider',
    contextLength,
    capabilities: [LLMCapabilities.Chat],
    async chat() {
      throw new Error('测试不应调用 LLM');
    },
  };
}

/** 不指定窗口时用的窗口 */
const DEFAULT_CONTEXT_LENGTH = 128_000;

const started: App[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
});

/**
 * 摘要插件把 memory 与 llm 都声明为 required：两者缺一它就停在 pending，
 * 贡献根本不会登记。所以这里总是先备齐服务，再装插件并核激活。
 */
async function setup(opts: { contextLength?: number; config?: Record<string, unknown> } = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  started.push(app);
  const host = app.bind({ provide, services });
  /** 组装器只要「枚举贡献」与「记日志」两样能力，从根激活绑定即可 */
  const assembly = app.bind({ contributions, logger });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const store = host.services.get(memory);
  if (!store) throw new Error('memory 服务未就绪');
  host.provide(llm, fakeLLMModel(opts.contextLength ?? DEFAULT_CONTEXT_LENGTH));
  await app.plugin(memorySummary, opts.config ?? {});
  await app.plugins.idle();
  if (app.plugins.getPlugin(memorySummary.name)?.state !== 'active') {
    throw new Error('plugin-memory-summary 未激活');
  }
  return { app, assembly, memory: store };
}

/** 换个身份往 agent:prompt 交一块固定文本的探针插件（登记自动归属这次激活，键前缀即插件名） */
function anchorProbe(name: string, id: string, anchor: string, text: string) {
  return definePlugin({
    name,
    uses: { contributions },
    apply({ contributions }) {
      contributions.contribute(POINT, { id, anchor, build: () => text } as never);
    },
  });
}

async function seedSummary(store: MemoryService, sessionId: string, summary: string): Promise<void> {
  await store.saveMetadata(SUMMARY_NAMESPACE, sessionId, {
    summary,
    coveredUpTo: 10,
    messageCount: 30,
    updatedAt: FIXED_TS,
  });
}

function baseMessages(): Message[] {
  return [
    { role: 'system', content: 'persona' },
    { role: 'system', content: '其它 system' },
    { role: 'user', content: '旧问' },
    { role: 'assistant', content: '旧答' },
    { role: 'user', content: '现在' },
  ];
}

function findSummaryBlock(messages: Message[]): Message | undefined {
  return messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-summary'));
}

function summaryBlocks(messages: Message[]): Message[] {
  return messages.filter(m => String(m.metadata?.injector ?? '').endsWith('/memory-summary'));
}

describe('plugin-memory-summary: agent:prompt 贡献', () => {
  it('无 sessionId → 不注入', async () => {
    const { assembly, memory } = await setup();
    // 库里存着别的会话的摘要，但本轮没有 sessionId
    await seedSummary(memory, 's-a', '不该出现的摘要');

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages });

    expect(findSummaryBlock(messages)).toBeUndefined();
    expect(messages).toHaveLength(5);
  });

  it('无摘要记录 → 不注入', async () => {
    const { assembly } = await setup();
    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });

    expect(findSummaryBlock(messages)).toBeUndefined();
    expect(messages).toHaveLength(5);
  });

  it('摘要为空串 → 不注入', async () => {
    const { assembly, memory } = await setup();
    await seedSummary(memory, 's-a', '');

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });

    expect(findSummaryBlock(messages)).toBeUndefined();
    expect(messages).toHaveLength(5);
  });

  it('有摘要 → 注入含摘要文本的 system 块，落点在 context 槽', async () => {
    const { app, assembly, memory } = await setup();
    await seedSummary(memory, 's-a', 'SUM-BODY 用户偏好夜间工作');

    // 同槽区对照：identity 落首条 system 后，knowledge 落头部 system 区末尾并先于 context。
    // knowledge 探针的插件名必须**码元序排在被测插件全局键之后**：被测键是
    // `@aalis/plugin-memory-summary/memory-summary`，首字符 '@'(0x40) 排在字母之前，
    // 故 `zz-` 前缀稳压其后。否则被测块错标成 knowledge 时两者仍按同样次序落位，
    // 断言恒真、变异测不出。
    await app.plugin(anchorProbe('probe-identity', 'idn', 'identity', 'IDN'));
    await app.plugin(anchorProbe('zz-probe-knowledge', 'kn', 'knowledge', 'KN'));
    await app.plugins.idle();

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });

    const contents = messages.map(m => String(m.content));
    const idx = messages.findIndex(m => String(m.metadata?.injector ?? '').endsWith('/memory-summary'));

    // persona → IDN → 其它 system → KN → 摘要 → 历史（turn-hint 会落在最后一条 user 前，此处无）
    expect(contents[1]).toBe('IDN');
    expect(contents[3]).toBe('KN');
    expect(idx).toBe(4);
    expect(messages[idx].role).toBe('system');
    expect(messages[idx + 1]).toMatchObject({ role: 'user', content: '旧问' });
    expect(contents[idx]).toContain('SUM-BODY 用户偏好夜间工作');
    expect(contents[idx]).toContain('以下是之前对话的摘要');
  });

  it('会话隔离：只注入当前 sessionId 的摘要', async () => {
    const { assembly, memory } = await setup();
    await seedSummary(memory, 's-a', 'A 会话摘要');

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-b' });
    expect(findSummaryBlock(messages)).toBeUndefined();

    const messagesA = baseMessages();
    await assemblePromptContributions(assembly, { messages: messagesA, sessionId: 's-a' });
    expect(String(findSummaryBlock(messagesA)?.content)).toContain('A 会话摘要');
  });

  it('长摘要全文注入，不按预算截断：生成时的输出上限已经限住它', async () => {
    const { assembly, memory } = await setup({ contextLength: 30000, config: { summaryTokenRatio: 0.02 } });
    const longSummary = `HEAD-MARKER${'x'.repeat(2000)}TAIL-MARKER`;
    await seedSummary(memory, 's-a', longSummary);

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });

    expect(String(findSummaryBlock(messages)?.content).endsWith(longSummary)).toBe(true);
  });

  // 与下一条幂等用例互补：这里验"键未物化 → 下一轮补跑"，下面验"键已物化 → 不重跑"。
  it('首轮无摘要不物化，摘要迟到后同一 messages 再组装即补上', async () => {
    const { assembly, memory } = await setup();

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });
    expect(findSummaryBlock(messages)).toBeUndefined();

    // 模拟摘要在 agent:turn:after 异步落库：首轮之后、次轮之前才就绪
    await seedSummary(memory, 's-a', 'SUM-LATE 迟到的摘要');
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });

    expect(summaryBlocks(messages)).toHaveLength(1);
    expect(String(findSummaryBlock(messages)?.content)).toContain('SUM-LATE 迟到的摘要');
  });

  it('连跑两次组装：幂等，不重复物化', async () => {
    const { assembly, memory } = await setup();
    await seedSummary(memory, 's-a', 'SUM-BODY');

    const messages = baseMessages();
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });
    const lenAfterFirst = messages.length;
    await assemblePromptContributions(assembly, { messages, sessionId: 's-a' });

    expect(summaryBlocks(messages)).toHaveLength(1);
    expect(messages).toHaveLength(lenAfterFirst);
  });
});
