import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { endTurn, fakeSummaryLLM, setupSummary } from '../fixtures/memory-summary.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 会话摘要停用时，收尾段等本插件自己发起的后台压缩落定再撤回：已经开始的落定（写摘要、归档、写分隔标记）写完，停用落定之后
// 不再有写入。摘要模型替身在信号断开时才回（恰在这时回来，照常落定）；写摘要卡在一道闸上，用例放行；order 记下写入开始、
// 写完与停用落定的先后。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

describe('会话摘要停用时等在途的后台压缩', () => {
  it('后台压缩的摘要模型调用途中停用：模型这时回来、开始落定，停用等写完才落定，之后不再有写入', async () => {
    const llm = fakeSummaryLLM({
      reply: request =>
        new Promise<string>(resolve =>
          request.signal?.addEventListener('abort', () => resolve('SUMMARY-TEXT'), { once: true }),
        ),
    });
    const { app, host, memory } = await setupSummary({}, llm.model);
    apps.push(app);
    for (let i = 0; i < 6; i++) {
      await memory.saveMessage('s', { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条消息` });
    }
    // 写摘要卡在闸上
    const order: string[] = [];
    const gate = deferred<void>();
    let reached = false;
    const save = memory.saveMetadata.bind(memory);
    vi.spyOn(memory as MemoryService, 'saveMetadata').mockImplementation(async (namespace, key, doc) => {
      order.push('写入开始');
      if (!reached && namespace === 'summary') {
        reached = true;
        await gate.promise;
      }
      await save(namespace, key, doc);
      order.push('写完');
    });
    await endTurn(host, 's', { used: 990, compressible: 900 });
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    const disabled = app.plugins.disable('@aalis/plugin-memory-summary').then(() => {
      order.push('停用落定');
    });
    await vi.waitFor(() => expect(reached).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });
});
