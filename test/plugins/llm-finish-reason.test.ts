import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChatModelRequest,
  type ChatResponse,
  finishReasonOf,
  type LLMModel,
  llm,
} from '../../packages/api-llm/src/index.js';
import { App, type PluginDefinition } from '../../packages/core/src/index.js';
import deepseekPlugin from '../../packages/plugin-llm-deepseek/src/index.js';
import ollamaPlugin from '../../packages/plugin-llm-ollama/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 回复的结束原因：服务商报了才有，stop、length、tool_calls、content_filter 照原样，别的原样值记 other，没报就不带
// （undefined 表示不可知）。chat 放在回复上，chatStream 放在 done 那一段。消费方据此认截断，不按用量或括号猜。
// 三家都用桩 fetch：OpenAI 与 DeepSeek 读 choices[0].finish_reason，Ollama 的 /api/chat 读 done_reason，
// 带音频走兼容接口时读 finish_reason。不连任何服务
// ════════════════════════════════════════════════════════════

const realFetch = globalThis.fetch;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  globalThis.fetch = realFetch;
});

/** 服务商报的原样值 → 回复上的结束原因；undefined 表示这次回复里没有这个字段 */
const CASES: Array<[string | undefined, ChatResponse['finishReason']]> = [
  ['length', 'length'],
  ['stop', 'stop'],
  ['insufficient_system_resource', 'other'],
  [undefined, undefined],
];

/** SSE 响应；done 为假时不写 data: [DONE]，流在 EOF 处直接结束 */
const sse = (frames: unknown[], done = true) =>
  new Response(`${frames.map(f => `data: ${JSON.stringify(f)}`).join('\n\n')}\n\n${done ? 'data: [DONE]\n\n' : ''}`, {
    headers: { 'content-type': 'text/event-stream' },
  });

/** OpenAI 兼容的桩：模型列表一个模型，对话非流式回 finish_reason，流式的末帧带它 */
function stubOpenAICompatible(modelId: string, reason: string | undefined): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: modelId }] });
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    if (!body.stream) {
      return Response.json({
        choices: [{ message: { role: 'assistant', content: '半截' }, finish_reason: reason }],
      });
    }
    return sse([
      { choices: [{ delta: { content: '半截' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: reason }] },
    ]);
  }) as typeof fetch;
}

/** Ollama 的桩：一个能听音频的模型；/api/chat 回 done_reason，兼容接口回 finish_reason */
function stubOllama(reason: string | undefined): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/tags') return Response.json({ models: [{ name: 'zz-model:1' }] });
    if (pathname === '/api/show') return Response.json({ capabilities: ['completion', 'audio'] });
    if (pathname === '/v1/chat/completions') {
      return Response.json({ choices: [{ message: { content: '半截' }, finish_reason: reason }] });
    }
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    const last = {
      message: { role: 'assistant', content: body.stream ? '' : '半截' },
      done: true,
      done_reason: reason,
    };
    if (!body.stream) return Response.json(last);
    const frames = [{ message: { role: 'assistant', content: '半截' }, done: false }, last];
    return new Response(frames.map(f => `${JSON.stringify(f)}\n`).join(''));
  }) as typeof fetch;
}

async function modelOf(plugin: PluginDefinition, config: Record<string, unknown>): Promise<LLMModel> {
  const app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const model = app.bind({ llm }).llm.list()[0]?.use;
  if (!model) throw new Error('没有登记出模型');
  return model;
}

/** 非流式与流式各发一遍：回复上的与 done 那一段上的结束原因 */
async function reasons(model: LLMModel, request: ChatModelRequest) {
  const response = await model.chat(request);
  const done: Array<ChatResponse['finishReason']> = [];
  for await (const chunk of model.chatStream?.(request) ?? []) if (chunk.done) done.push(chunk.finishReason);
  return { chat: response.finishReason, stream: done };
}

const TEXT: ChatModelRequest = { messages: [{ role: 'user', content: '在吗' }] };
const AUDIO: ChatModelRequest = {
  messages: [{ role: 'user', content: '听听', audios: ['data:audio/wav;base64,AAAA'] }],
};

describe('回复的结束原因', () => {
  it.each(CASES)('OpenAI：finish_reason %s → %s', async (raw, expected) => {
    stubOpenAICompatible('gpt-4o', raw);
    const model = await modelOf(openaiPlugin, { apiKey: 'test-key' });
    expect(await reasons(model, TEXT)).toEqual({ chat: expected, stream: [expected] });
  });

  it.each(CASES)('DeepSeek：finish_reason %s → %s', async (raw, expected) => {
    stubOpenAICompatible('deepseek-chat', raw);
    const model = await modelOf(deepseekPlugin, { apiKey: 'test-key' });
    expect(await reasons(model, TEXT)).toEqual({ chat: expected, stream: [expected] });
  });

  it.each(CASES)('Ollama /api/chat：done_reason %s → %s', async (raw, expected) => {
    stubOllama(raw);
    const model = await modelOf(ollamaPlugin, { baseUrl: 'http://zz-ollama.invalid' });
    expect(await reasons(model, TEXT)).toEqual({ chat: expected, stream: [expected] });
  });

  it.each(CASES)('Ollama 带音频走兼容接口：finish_reason %s → %s', async (raw, expected) => {
    stubOllama(raw);
    const model = await modelOf(ollamaPlugin, { baseUrl: 'http://zz-ollama.invalid' });
    expect(await reasons(model, AUDIO)).toEqual({ chat: expected, stream: [expected] });
  });

  /** 两个 OpenAI 兼容的插件：流式的末帧按给的帧回，模型列表一个模型 */
  const STREAMING = [
    ['OpenAI', openaiPlugin, 'gpt-4o'],
    ['DeepSeek', deepseekPlugin, 'deepseek-chat'],
  ] as const;

  async function streamedReasons(plugin: PluginDefinition, modelId: string, response: () => Response) {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith('/models') ? Response.json({ data: [{ id: modelId }] }) : response()) as typeof fetch;
    const model = await modelOf(plugin, { apiKey: 'test-key' });
    const done: Array<ChatResponse['finishReason']> = [];
    for await (const chunk of model.chatStream?.(TEXT) ?? []) if (chunk.done) done.push(chunk.finishReason);
    return done;
  }

  it.each(STREAMING)('%s：流式的结束原因挂在没有 delta 的末帧上时照样读到', async (_name, plugin, modelId) => {
    const done = await streamedReasons(plugin, modelId, () =>
      sse([{ choices: [{ delta: { content: '半截' } }] }, { choices: [{ finish_reason: 'length' }] }]),
    );
    expect(done).toEqual(['length']);
  });

  it.each(STREAMING)('%s：流没写 [DONE]、在 EOF 处结束时照样带上结束原因', async (_name, plugin, modelId) => {
    const done = await streamedReasons(plugin, modelId, () =>
      sse([{ choices: [{ delta: { content: '半截' }, finish_reason: 'length' }] }], false),
    );
    expect(done).toEqual(['length']);
  });

  it('finishReasonOf：四种照原样，别的值记 other，没报（undefined 或 null）不带', () => {
    expect(['stop', 'length', 'tool_calls', 'content_filter', 'load', 7].map(finishReasonOf)).toEqual([
      'stop',
      'length',
      'tool_calls',
      'content_filter',
      'other',
      'other',
    ]);
    expect(finishReasonOf(undefined)).toBeUndefined();
    expect(finishReasonOf(null)).toBeUndefined();
  });
});
