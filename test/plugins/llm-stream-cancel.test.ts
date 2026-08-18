import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as ollama from '../../packages/plugin-llm-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 流式请求被提前退出时必须 cancel 响应体，不能只 releaseLock。
//
// 事故背景：主模型切到本地后一轮生成 90+ 秒，忙群里 lane 中止高频发生。
// releaseLock 只是放锁、底层流仍开着——被打断的生成让 undici 挂着半读的响应
// 与套接字，直到请求超时（300s）兜底才释放。cancel 自带放锁，且对已正常结束
// 的流是 no-op，完整读完的路径不受影响。
// ════════════════════════════════════════════════════════════

async function makeModel(): Promise<LLMModel> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(ollama, { baseUrl: 'http://127.0.0.1:11434', customModels: 'teststream' });
  await app.plugins.idle();
  const entries = app.ctx.getAllServices<LLMModel>('llm');
  const model = entries.find(e => e.instance.id.includes('teststream'))?.instance ?? entries[0]?.instance;
  if (!model) throw new Error('未注册出 llm model entry');
  return model;
}

/** 无限 NDJSON 流 + cancel 观测点：模拟一场永远说不完的生成。 */
function stubEndlessStream(): { cancelled: () => boolean } {
  let cancelled = false;
  const chunk = new TextEncoder().encode(`${JSON.stringify({ message: { content: '词' }, done: false })}\n`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    })),
  );
  return { cancelled: () => cancelled };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatStream 提前退出释放响应体', () => {
  it('消费方 break 后底层流被 cancel（不是只放锁）', async () => {
    const model = await makeModel();
    const probe = stubEndlessStream();
    let got = 0;
    for await (const chunk of model.chatStream!({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.contentDelta) got++;
      if (got >= 3) break; // 模拟 lane 中止/提前收工
    }
    expect(got).toBe(3);
    expect(probe.cancelled(), 'break 后必须 cancel 响应体，否则半读的套接字挂到 300s 超时').toBe(true);
  });

  it('正常读完（done:true）不受影响，cancel 是 no-op', async () => {
    const model = await makeModel();
    const ndjson =
      `${JSON.stringify({ message: { content: '完' }, done: false })}\n` +
      `${JSON.stringify({ message: { content: '' }, done: true, eval_count: 1, prompt_eval_count: 1 })}\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(ndjson));
            c.close();
          },
        }),
      })),
    );
    const chunks: string[] = [];
    let done = false;
    for await (const chunk of model.chatStream!({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.contentDelta) chunks.push(chunk.contentDelta);
      if (chunk.done) done = true;
    }
    expect(chunks.join('')).toBe('完');
    expect(done).toBe(true);
  });
});
