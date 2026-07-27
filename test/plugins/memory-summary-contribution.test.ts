import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import type { LLMModel } from '../../packages/plugin-llm-api/src/index.js';
import { LLMCapabilities } from '../../packages/plugin-llm-api/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import type { Message } from '../../packages/plugin-message-api/src/index.js';

// 测试直接从 core 源码路径导入，agent-api 对 '@aalis/core' 的 declaration
// merging 不在此路径生效——vitest 不做类型检查，用 never 断言绕过键约束。
const POINT = 'agent:prompt' as never;

/** 摘要落库的 namespace（与插件内 SummaryStore 约定一致，经 memory 服务公开面种入） */
const SUMMARY_NAMESPACE = 'summary';
/** 固定时间戳：摘要记录的 updatedAt 不参与 build，钉死避免时间敏感 */
const FIXED_TS = '2026-01-01T00:00:00.000Z';
/** 截断后缀（插件内硬编码） */
const TRUNCATED_SUFFIX = '\n... [摘要已截断]';

/** 只声明 chat 能力的假 LLM model entry：build 路径只读 contextLength，不发请求 */
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

async function setup(opts: { contextLength?: number; config?: Record<string, unknown> } = {}) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  const memory = app.ctx.getService<MemoryService>('memory');
  if (!memory) throw new Error('memory 服务未就绪');
  // contextLength 未给 = 完全不注册 llm，走插件内 4096 兜底预算
  if (opts.contextLength !== undefined) {
    app.ctx.provide('llm', fakeLLMModel(opts.contextLength));
  }
  await app.ctx.useModule(memorySummary, opts.config ?? {});
  await app.plugins.idle();
  return { app, memory };
}

async function seedSummary(memory: MemoryService, sessionId: string, summary: string): Promise<void> {
  if (!memory.saveMetadata) throw new Error('memory 实现缺少 saveMetadata');
  await memory.saveMetadata(SUMMARY_NAMESPACE, sessionId, {
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
    const { app, memory } = await setup();
    // 库里存着别的会话的摘要，但本轮没有 sessionId
    await seedSummary(memory, 's-a', '不该出现的摘要');

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages });

    expect(findSummaryBlock(messages)).toBeUndefined();
    expect(messages).toHaveLength(5);
  });

  it('无摘要记录 → 不注入', async () => {
    const { app } = await setup();
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    expect(findSummaryBlock(messages)).toBeUndefined();
    expect(messages).toHaveLength(5);
  });

  it('摘要为空串 → 不注入', async () => {
    const { app, memory } = await setup();
    await seedSummary(memory, 's-a', '');

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    expect(findSummaryBlock(messages)).toBeUndefined();
    expect(messages).toHaveLength(5);
  });

  it('有摘要 → 注入含摘要文本的 system 块，落点在 context 槽', async () => {
    const { app, memory } = await setup();
    await seedSummary(memory, 's-a', 'SUM-BODY 用户偏好夜间工作');

    // 同槽区对照：identity 落首条 system 后，knowledge 落头部 system 区末尾并先于 context。
    // knowledge 探针的 ctx id 必须**码元序排在被测插件全局键之后**（插件经 useModule
    // 加载，键形如 `root#@aalis/plugin-...`，故用 zz- 前缀）——否则被测块错标成
    // knowledge 时两者仍按同样次序落位，断言恒真、变异测不出。
    app.ctx.fork('probe-identity').contribute(POINT, { id: 'idn', anchor: 'identity', build: () => 'IDN' } as never);
    app.ctx.fork('zz-probe-knowledge').contribute(POINT, { id: 'kn', anchor: 'knowledge', build: () => 'KN' } as never);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

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
    const { app, memory } = await setup();
    await seedSummary(memory, 's-a', 'A 会话摘要');

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-b' });
    expect(findSummaryBlock(messages)).toBeUndefined();

    const messagesA = baseMessages();
    await assemblePromptContributions(app.ctx, { messages: messagesA, sessionId: 's-a' });
    expect(String(findSummaryBlock(messagesA)?.content)).toContain('A 会话摘要');
  });

  it('超预算 → 按 contextLength×ratio 截断并带截断后缀', async () => {
    // budget = floor(30000 × 0.02) = 600 → maxChars = 1800
    const { app, memory } = await setup({ contextLength: 30000, config: { summaryTokenRatio: 0.02 } });
    const longSummary = `HEAD-MARKER${'x'.repeat(2000)}TAIL-MARKER`; // 2022 字符 → 674 tokens > 600
    await seedSummary(memory, 's-a', longSummary);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    const content = String(findSummaryBlock(messages)?.content);
    expect(content).toContain('HEAD-MARKER');
    expect(content).not.toContain('TAIL-MARKER');
    expect(content.endsWith(longSummary.slice(0, 1800) + TRUNCATED_SUFFIX)).toBe(true);
  });

  it('无 LLM 时按 4096 兜底 contextLength 计算预算（下限 512 tokens）', async () => {
    // 无 llm entry → contextLength 兜底 4096；floor(4096 × 0.05)=204 被下限抬到 512 → maxChars = 1536
    const { app, memory } = await setup();
    const longSummary = `HEAD-MARKER${'x'.repeat(2000)}TAIL-MARKER`;
    await seedSummary(memory, 's-a', longSummary);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    const content = String(findSummaryBlock(messages)?.content);
    expect(content.endsWith(longSummary.slice(0, 1536) + TRUNCATED_SUFFIX)).toBe(true);
  });

  it('预算充足 → 全文注入，不加截断后缀', async () => {
    // budget = floor(300000 × 0.02) = 6000 → maxChars = 18000，远超摘要长度
    const { app, memory } = await setup({ contextLength: 300000, config: { summaryTokenRatio: 0.02 } });
    const longSummary = `HEAD-MARKER${'x'.repeat(2000)}TAIL-MARKER`;
    await seedSummary(memory, 's-a', longSummary);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    const content = String(findSummaryBlock(messages)?.content);
    expect(content).toContain('TAIL-MARKER');
    expect(content).not.toContain('摘要已截断');
    expect(content.endsWith(longSummary)).toBe(true);
  });

  // 与下一条幂等用例互补：这里验"键未物化 → 下一轮补跑"，下面验"键已物化 → 不重跑"。
  it('首轮无摘要不物化，摘要迟到后同一 messages 再组装即补上', async () => {
    const { app, memory } = await setup();

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });
    expect(findSummaryBlock(messages)).toBeUndefined();

    // 模拟摘要在 agent:turn:after 异步落库：首轮之后、次轮之前才就绪
    await seedSummary(memory, 's-a', 'SUM-LATE 迟到的摘要');
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    expect(summaryBlocks(messages)).toHaveLength(1);
    expect(String(findSummaryBlock(messages)?.content)).toContain('SUM-LATE 迟到的摘要');
  });

  it('连跑两次组装：幂等，不重复物化', async () => {
    const { app, memory } = await setup();
    await seedSummary(memory, 's-a', 'SUM-BODY');

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });
    const lenAfterFirst = messages.length;
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-a' });

    expect(summaryBlocks(messages)).toHaveLength(1);
    expect(messages).toHaveLength(lenAfterFirst);
  });
});
