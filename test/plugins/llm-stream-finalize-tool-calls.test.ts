import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatStreamChunk, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { App, type LogEntry, LogHub, type PluginDefinition } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 流式收尾组装 toolCalls 的两条路径（收到终帧 / 流意外结束）行为一致。
//
// - ollama：EOF 兜底此前造的 id 是 `call_${i}`，与终帧、非流式的 `call_ollama_<时间戳>_<i>`
//   不同格式，跨回合必撞；下游按 id 配对调用与结果（tool-search、memory-summary）。
// - deepseek：DSML 泄漏本地解析失败时，[DONE] 分支告警、EOF 分支静默。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const a of apps.splice(0)) await a.stop().catch(() => {});
});

function streamResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  } as unknown as Response;
}

/** 按 URL 路由的 fetch 桩：模型发现给一个模型，对话请求回 chatBody 流 */
function stubProvider(chatBody: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/chat') || u.endsWith('/chat/completions')) return streamResponse(chatBody);
      const json = u.includes('/api/tags')
        ? { models: [{ name: 'm:1' }] }
        : u.includes('/api/show')
          ? { capabilities: ['completion', 'tools'] }
          : { data: [{ id: 'm' }] };
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }),
  );
}

async function loadModel(plugin: PluginDefinition, config: Record<string, unknown>, hub?: LogHub): Promise<LLMModel> {
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  const host = app.bind({ llm });
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`${plugin.name} 未激活（state=${state}）`);
  const model = host.llm.all()[0]?.instance;
  if (!model) throw new Error('未注册出 llm model entry');
  return model;
}

async function lastChunk(model: LLMModel): Promise<ChatStreamChunk | undefined> {
  let last: ChatStreamChunk | undefined;
  for await (const chunk of model.chatStream!({ messages: [{ role: 'user', content: 'hi' }] })) last = chunk;
  return last;
}

describe('ollama：工具调用 id 在各收尾路径同一格式', () => {
  const toolFrame = `${JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'get_time', arguments: {} } }] }, done: false })}\n`;
  const doneFrame = `${JSON.stringify({ message: { content: '' }, done: true })}\n`;

  it.each([
    ['收到终帧', toolFrame + doneFrame],
    ['流意外结束（无终帧）', toolFrame],
  ])('%s', async (_label, body) => {
    stubProvider(body);
    const model = await loadModel(ollama, { baseUrl: 'http://127.0.0.1:11434' });
    const last = await lastChunk(model);
    expect(last?.done).toBe(true);
    expect(last?.toolCalls?.map(c => c.function.name)).toEqual(['get_time']);
    expect(last?.toolCalls?.[0].id).toMatch(/^call_ollama_\d+_0$/);
  });
});

describe('deepseek：DSML 泄漏本地解析失败时两条收尾路径都告警', () => {
  // 只有 DSML 起始标记、没有完整 invoke 块：本地解析不出任何调用
  const leak = `data: ${JSON.stringify({ choices: [{ delta: { content: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="x">' } }] })}\n`;

  it.each([
    ['收到 [DONE]', `${leak}data: [DONE]\n`],
    ['流意外结束（无 [DONE]）', leak],
  ])('%s', async (_label, body) => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry((e: LogEntry) => {
      if (e.level === 'warn') warns.push(e.message);
    });
    stubProvider(body);
    const model = await loadModel(deepseek, { apiKey: 'k', baseUrl: 'https://gw.invalid' }, hub);
    const last = await lastChunk(model);
    expect(last?.done).toBe(true);
    expect(last?.toolCalls).toBeUndefined();
    expect(warns.some(m => m.includes('DSML 本地解析未识别出完整 invoke 块'))).toBe(true);
  });
});
