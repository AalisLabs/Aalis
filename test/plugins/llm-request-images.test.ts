import { afterEach, describe, expect, it } from 'vitest';
import { type ChatModelRequest, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { App, type PluginDefinition } from '../../packages/core/src/index.js';
import deepseekPlugin from '../../packages/plugin-llm-deepseek/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 带图的请求：交给模型插件的图一律发出去，插件不自己丢。给不给图由上游按能力标记判定；插件丢了图，标错能力时端点不报错，
// 模型只收到文字，回的话却被当成看过图。OpenAI 与 DeepSeek 都走 Chat Completions：图编成 user 消息里文字之后的
// image_url 段；工具结果里的图由 prepareLLMMessages 挪到这段工具应答之后的一条 user 消息上。桩 fetch 记下请求体，不连任何服务
// ════════════════════════════════════════════════════════════

const realFetch = globalThis.fetch;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  globalThis.fetch = realFetch;
});

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'https://example.com/photo.jpg';

const PROVIDERS: Array<[string, PluginDefinition, string]> = [
  ['OpenAI', openaiPlugin, 'gpt-4o'],
  ['DeepSeek', deepseekPlugin, 'deepseek-flash'],
];

/** 桩端点：只列出一个模型；对话请求记下请求体里的 messages，非流式与流式各回一句 */
function stub(modelId: string): unknown[][] {
  const sent: unknown[][] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: modelId }] });
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; messages: unknown[] };
    sent.push(body.messages);
    if (!body.stream) {
      return Response.json({ choices: [{ message: { role: 'assistant', content: '看到了' }, finish_reason: 'stop' }] });
    }
    const frame = { choices: [{ delta: { content: '看到了' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  return sent;
}

async function modelOf(plugin: PluginDefinition): Promise<LLMModel> {
  const app = new App({ logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  await app.plugin(plugin, { apiKey: 'test-key' });
  await app.plugins.idle();
  const model = app.bind({ llm }).llm.list()[0]?.use;
  if (!model) throw new Error('没有登记出模型');
  return model;
}

/** 非流式与流式各发一遍，返回两次请求的最后一条消息 */
async function lastSent(plugin: PluginDefinition, modelId: string, request: ChatModelRequest): Promise<unknown[]> {
  const sent = stub(modelId);
  const model = await modelOf(plugin);
  await model.chat(request);
  const chunks: unknown[] = [];
  for await (const chunk of model.chatStream?.(request) ?? []) chunks.push(chunk);
  expect(sent).toHaveLength(2);
  return sent.map(messages => messages.at(-1));
}

describe('带图的请求', () => {
  it.each(PROVIDERS)('%s：user 消息的图编成文字之后的 image_url 段', async (_, plugin, modelId) => {
    const last = await lastSent(plugin, modelId, {
      messages: [{ role: 'user', content: '这两张是什么', images: [IMAGE, PHOTO] }],
    });
    for (const message of last) {
      expect(message).toMatchObject({
        role: 'user',
        content: [
          { type: 'text', text: '这两张是什么' },
          { type: 'image_url', image_url: { url: IMAGE } },
          { type: 'image_url', image_url: { url: PHOTO } },
        ],
      });
    }
  });

  it.each(PROVIDERS)('%s：工具结果里的图随这段工具应答之后的 user 消息发出', async (_, plugin, modelId) => {
    const last = await lastSent(plugin, modelId, {
      messages: [
        { role: 'user', content: '看看历史里那张图' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'analyze_image', arguments: '{}' } }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1', images: [IMAGE] },
      ],
    });
    for (const message of last) {
      expect(message).toMatchObject({
        role: 'user',
        content: [
          { type: 'text', text: '[以下图片是工具调用 call_1 的返回内容]' },
          { type: 'image_url', image_url: { url: IMAGE } },
        ],
      });
    }
  });
});
