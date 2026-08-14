import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { LLMCapabilities } from '../../packages/api-llm/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as memorySummary from '../../packages/plugin-memory-summary/src/index.js';

// ════════════════════════════════════════════════════════════
// 自动压缩的触发条件
//
// 探测条数曾被写死为 200：它同时充当阈值判定的样本量，于是 threshold > 200 的
// 配置下 totalCount 恒 ≤200 < threshold，压缩永不触发且零日志（生产 threshold=360
// 实测 37.5 小时零次摘要）。这里用 threshold=240 钉死"探测条数须由配置推导"。
// ════════════════════════════════════════════════════════════

/** 记下最后一次摘要请求的正文，用来数"这次摘要吃进去了多少条消息" */
const lastSummaryInput = { text: '' };

/** 假 LLM：摘要路径只需它能返回一段文本 */
function fakeLLM(): LLMModel {
  return {
    id: 'fake',
    providerId: 'fake',
    contextLength: 8192,
    capabilities: [LLMCapabilities.Chat],
    async chat(req) {
      lastSummaryInput.text = req.messages.map(m => String(m.content ?? '')).join('\n');
      return { content: 'SUMMARY-TEXT' };
    },
  };
}

/** 摘要正文里出现了多少条 seed 消息（seed 内容形如「第 N 条消息」） */
function summarizedCount(): number {
  return (lastSummaryInput.text.match(/第 \d+ 条消息/g) ?? []).length;
}

async function setup(config: Record<string, unknown>) {
  lastSummaryInput.text = '';
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  app.ctx.provide('llm', fakeLLM());
  await app.ctx.useModule(memorySummary, config);
  await app.plugins.idle();
  const memory = app.ctx.getService<MemoryService>('memory');
  if (!memory) throw new Error('memory 服务未就绪');
  return { app, memory };
}

async function seedMessages(memory: MemoryService, sessionId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await memory.saveMessage(sessionId, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 条消息`,
    });
  }
}

describe('plugin-memory-summary: 自动压缩触发', () => {
  it('threshold 大于历史探测条数时仍触发压缩并归档旧消息', async () => {
    const threshold = 240;
    const keepRecent = 40;
    const { app, memory } = await setup({ threshold, keepRecent });

    await seedMessages(memory, 's-1', threshold + 5);
    expect((await memory.getHistory('s-1', 1000)).length).toBe(threshold + 5);

    // 走真实触发路径：agent:turn:after 钩子
    await app.ctx.runHook(
      'agent:turn:after' as never,
      {
        message: { sessionId: 's-1' },
        reply: 'ok',
        outcome: 'replied',
        sessionId: 's-1',
        metadata: {},
      } as never,
    );
    // 摘要是异步触发（不阻塞主流程），等它落地
    await new Promise<void>(r => setTimeout(r, 50));

    const after = await memory.getHistory('s-1', 1000);
    expect(after.length, `压缩后应只剩 keepRecent 条，实际 ${after.length}`).toBeLessThanOrEqual(keepRecent + 5);
    expect(after.length).toBeGreaterThan(0);
    await app.stop();
  });

  it('小 threshold 配置的摘要输入量不因探测条数推导而缩水', async () => {
    // 探测条数兼作单次摘要输入上界。若只按 threshold 推导，默认配置（30/20）
    // 单次只摘 10 条，而 trimHistory 仍按 keepRecent 归档全部活跃历史——
    // 超出探测窗的那批被归档却从未进摘要。
    const { app, memory } = await setup({ threshold: 30, keepRecent: 20 });
    await seedMessages(memory, 's-3', 120);

    await app.ctx.runHook(
      'agent:turn:after' as never,
      {
        message: { sessionId: 's-3' },
        reply: 'ok',
        outcome: 'replied',
        sessionId: 's-3',
        metadata: {},
      } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    // 120 条积压、keepRecent=20 → 应摘约 100 条；只按 threshold 推导时只有 10 条
    expect(
      summarizedCount(),
      `摘要输入过少（实际 ${summarizedCount()} 条），探测窗口被 threshold 卡死了`,
    ).toBeGreaterThan(50);
    await app.stop();
  });

  it('消息数不足 threshold → 不压缩', async () => {
    const { app, memory } = await setup({ threshold: 240, keepRecent: 40 });
    await seedMessages(memory, 's-2', 100);

    await app.ctx.runHook(
      'agent:turn:after' as never,
      {
        message: { sessionId: 's-2' },
        reply: 'ok',
        outcome: 'replied',
        sessionId: 's-2',
        metadata: {},
      } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    expect((await memory.getHistory('s-2', 1000)).length).toBe(100);
    await app.stop();
  });

  it('摘要 LLM 失败 → 降级为纯裁切，不滞留"涨破阈值原样重试"循环', async () => {
    // 失败路径专用装配：LLM 恒抛错（模拟慢模型超时）
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(memoryInMemoryModule);
    app.ctx.provide('llm', {
      id: 'boom',
      providerId: 'boom',
      contextLength: 8192,
      capabilities: [LLMCapabilities.Chat],
      async chat() {
        throw new Error('fake timeout');
      },
    } as unknown as LLMModel);
    await app.ctx.useModule(memorySummary, { threshold: 240, keepRecent: 40 });
    await app.plugins.idle();
    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('memory 服务未就绪');
    await seedMessages(memory, 's-4', 245);

    await app.ctx.runHook(
      'agent:turn:after' as never,
      {
        message: { sessionId: 's-4' },
        reply: 'ok',
        outcome: 'replied',
        sessionId: 's-4',
        metadata: {},
      } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    // 旧行为：失败 → 什么都不动 → 245 条原样滞留，下次触发再烧一遍
    const after = await memory.getHistory('s-4', 1000);
    expect(after.length, `LLM 失败也应裁切到 keepRecent 附近，实际 ${after.length}`).toBeLessThanOrEqual(45);
    // 失败不得产生（空的）摘要记录
    expect(await memory.getMetadata('summary', 's-4')).toBeFalsy();
    await app.stop();
  });

  it('摘要 LLM 返回空串（不抛错）→ 同样降级纯裁切、不写空摘要', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(memoryInMemoryModule);
    app.ctx.provide('llm', {
      id: 'empty',
      providerId: 'empty',
      contextLength: 8192,
      capabilities: [LLMCapabilities.Chat],
      async chat() {
        return { content: '' };
      },
    } as unknown as LLMModel);
    await app.ctx.useModule(memorySummary, { threshold: 240, keepRecent: 40 });
    await app.plugins.idle();
    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('memory 服务未就绪');
    await seedMessages(memory, 's-7', 245);

    await app.ctx.runHook(
      'agent:turn:after' as never,
      { message: { sessionId: 's-7' }, reply: 'ok', outcome: 'replied', sessionId: 's-7', metadata: {} } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    const after = await memory.getHistory('s-7', 1000);
    expect(after.length, `空响应也应裁切到 keepRecent 附近，实际 ${after.length}`).toBeLessThanOrEqual(45);
    expect(await memory.getMetadata('summary', 's-7')).toBeFalsy();
    await app.stop();
  });

  it('session:compress 手动路径：LLM 失败同样降级裁切，事件 start→error，旧摘要保留', async () => {
    // compress handler 是 generateSummary 之外的第二份降级实现，必须单独钉住
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(memoryInMemoryModule);
    app.ctx.provide('llm', {
      id: 'boom2',
      providerId: 'boom2',
      contextLength: 8192,
      capabilities: [LLMCapabilities.Chat],
      async chat() {
        throw new Error('fake timeout');
      },
    } as unknown as LLMModel);
    await app.ctx.useModule(memorySummary, { threshold: 240, keepRecent: 40 });
    await app.plugins.idle();
    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('memory 服务未就绪');
    await memory.saveMetadata('summary', 's-6', {
      summary: 'GOOD-OLD-SUMMARY',
      coveredUpTo: 1,
      messageCount: 2,
      updatedAt: new Date().toISOString(),
    });
    await seedMessages(memory, 's-6', 120);

    const statuses: string[] = [];
    app.ctx.on('session:compressing', info => {
      if (info.sessionId === 's-6') statuses.push(info.status);
    });

    await app.ctx.emit('session:compress', { sessionId: 's-6', reason: 'manual' });
    await new Promise<void>(r => setTimeout(r, 50));

    expect((await memory.getHistory('s-6', 1000)).length, '手动压缩失败也应降级裁切').toBeLessThanOrEqual(45);
    expect((await memory.getMetadata('summary', 's-6'))?.summary, '旧摘要不得被失败覆盖').toBe('GOOD-OLD-SUMMARY');
    expect(statuses[0], '应先报 start').toBe('start');
    expect(statuses[statuses.length - 1], '降级应报 error 而非 done（done 会让前端插假成功分隔线）').toBe('error');
    await app.stop();
  });

  it('流式中途失败：半截输出不得入库为摘要，旧摘要原样保留（降级纯裁切）', async () => {
    // 生产主路径是 chatStream；provider 超时常在吐出部分内容后中断流。
    // 半截文本一旦 upsert，会成为后续增量摘要的权威基底，链条被永久污染。
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(memoryInMemoryModule);
    app.ctx.provide('llm', {
      id: 'partial',
      providerId: 'partial',
      contextLength: 8192,
      capabilities: [LLMCapabilities.Chat],
      async chat() {
        throw new Error('unreachable：本用例应走 chatStream');
      },
      async *chatStream() {
        yield { contentDelta: '【对话概览】前半截…' };
        yield { contentDelta: '还在继续…' };
        throw new Error('fake stream timeout');
      },
    } as unknown as LLMModel);
    await app.ctx.useModule(memorySummary, { threshold: 240, keepRecent: 40 });
    await app.plugins.idle();
    const memory = app.ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('memory 服务未就绪');
    // 预置一份完好的旧摘要：失败路径必须原样保留，不得被半截/空文本覆盖
    await memory.saveMetadata('summary', 's-5', {
      summary: 'GOOD-OLD-SUMMARY',
      coveredUpTo: 100,
      messageCount: 120,
      updatedAt: new Date().toISOString(),
    });
    await seedMessages(memory, 's-5', 245);

    await app.ctx.runHook(
      'agent:turn:after' as never,
      {
        message: { sessionId: 's-5' },
        reply: 'ok',
        outcome: 'replied',
        sessionId: 's-5',
        metadata: {},
      } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    // 降级裁切生效
    const after = await memory.getHistory('s-5', 1000);
    expect(after.length, `流式失败也应裁切，实际 ${after.length}`).toBeLessThanOrEqual(45);
    // 半截输出未入库、旧摘要未被覆盖
    const doc = await memory.getMetadata('summary', 's-5');
    expect(doc?.summary, '半截流式输出不得成为权威摘要').toBe('GOOD-OLD-SUMMARY');
    await app.stop();
  });
});
