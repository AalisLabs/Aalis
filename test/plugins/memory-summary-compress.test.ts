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
});
