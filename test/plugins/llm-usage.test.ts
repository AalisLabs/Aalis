import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatModelRequest,
  type ChatResponse,
  type LLMModel,
  type LLMUsageEvent,
  llm,
  metered,
  resolveLLMModel,
} from '../../packages/api-llm/src/index.js';
import {
  App,
  definePlugin,
  events,
  type PluginDefinition,
  provide,
  type ServiceSelection,
} from '../../packages/core/src/index.js';
import deepseekPlugin from '../../packages/plugin-llm-deepseek/src/index.js';
import ollamaPlugin from '../../packages/plugin-llm-ollama/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 模型调用的记账：服务商登记模型时套上 metered，调用拿到用量就发 llm:usage；调用方插件实例由 llm 的绑定接口按
// 调用方这次激活填上，调用方自己填的不算；用途与会话由调用方在请求里带
// ════════════════════════════════════════════════════════════

const USAGE = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  vi.unstubAllGlobals();
});

/** usage 为 null 时服务商不报用量 */
async function setup(reported: ChatResponse['usage'] | null = USAGE) {
  const usage = reported ?? undefined;
  const seen: ChatModelRequest[] = [];
  const model: LLMModel = {
    id: 'm',
    providerId: 'fake-llm',
    contextLength: 1000,
    capabilities: ['chat', 'streaming'],
    async chat(request) {
      seen.push(request);
      return { content: 'ok', usage };
    },
    async *chatStream(request) {
      seen.push(request);
      yield { contentDelta: 'o' };
      yield { usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      yield { contentDelta: 'k', done: true, usage };
    },
    async refresh() {
      return { added: [], removed: [], total: 1 };
    },
    async balance() {
      return [{ currency: 'CNY', amount: 12.5 }];
    },
  };
  const provider = definePlugin({
    name: 'fake-llm',
    provides: [llm],
    uses: { provide, events },
    apply({ provide, events }) {
      provide.use(llm, metered(model, events.use), { entryId: 'fake-llm/m' });
    },
  });
  let bound: ServiceSelection<LLMModel> | undefined;
  const consumer = definePlugin({
    name: 'consumer',
    uses: { llm },
    apply(caps) {
      bound = caps.llm;
    },
  });
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const usages: LLMUsageEvent[] = [];
  app.bind({ events }).events.use.on('llm:usage', usage => void usages.push(usage));
  await app.plugin(provider, {});
  await app.plugin(consumer, {});
  await app.plugins.idle();
  if (!bound) throw new Error('consumer 没有激活');
  return { bound, seen, usages };
}

describe('模型调用的记账', () => {
  it('chat 拿到用量发一次 llm:usage：服务商与模型取登记的模型，调用方取调用方的实例，用途与会话取请求', async () => {
    const { bound, seen, usages } = await setup();
    await bound.use.chat({ messages: [], purpose: '摘要', sessionId: 's1', caller: '伪造的调用方' });
    expect(seen[0]?.caller).toBe('consumer');
    expect(usages).toEqual([
      {
        provider: 'fake-llm',
        model: 'm',
        caller: 'consumer',
        sessionId: 's1',
        purpose: '摘要',
        inputTokens: 100,
        cachedTokens: 40,
        outputTokens: 20,
      },
    ]);
  });

  it('chatStream 在流结束时按最后一次报的用量发一次；没报用量的调用不记', async () => {
    const { bound, usages } = await setup();
    const model = resolveLLMModel(bound)?.use;
    const chunks: unknown[] = [];
    for await (const chunk of model?.chatStream?.({ messages: [], purpose: '对话' }) ?? []) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(usages).toEqual([expect.objectContaining({ caller: 'consumer', purpose: '对话', inputTokens: 100 })]);

    const silent = await setup(null);
    await silent.bound.use.chat({ messages: [] });
    expect(silent.usages).toEqual([]);
  });

  it('服务商回的用量运行时不可信：输入或输出不是非负有限数的当没报，缓存命中不是时不带、比输入多时截到输入', async () => {
    const cases: Array<[unknown, Partial<LLMUsageEvent> | undefined]> = [
      [{ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: null }, {}],
      [{ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 150 }, { cachedTokens: 100 }],
      [{ completionTokens: 20, totalTokens: 20 }, undefined],
      [{ promptTokens: Number.NaN, completionTokens: 20, totalTokens: 20 }, undefined],
      [{ promptTokens: 100, completionTokens: -1, totalTokens: 99 }, undefined],
      [{ promptTokens: '100', completionTokens: 20, totalTokens: 120 }, undefined],
    ];
    for (const [reported, expected] of cases) {
      const { bound, usages } = await setup(reported as ChatResponse['usage']);
      await bound.use.chat({ messages: [] });
      const event = { provider: 'fake-llm', model: 'm', caller: 'consumer', inputTokens: 100, outputTokens: 20 };
      expect(usages, JSON.stringify(reported)).toEqual(expected ? [{ ...event, ...expected }] : []);
    }
  });

  it('经绑定接口拿到的模型字段与其余方法照原样；句柄每次取到的是同一个', async () => {
    const { bound, usages } = await setup();
    const model = bound.use;
    expect(bound.use).toBe(model);
    const [entry] = bound.list();
    expect(entry?.use).toBe(bound.of(entry?.id ?? ''));
    expect([model.id, model.providerId, model.contextLength, model.capabilities]).toEqual([
      'm',
      'fake-llm',
      1000,
      ['chat', 'streaming'],
    ]);
    expect(await model.refresh?.()).toEqual({ added: [], removed: [], total: 1 });
    expect(await model.balance?.()).toEqual([{ currency: 'CNY', amount: 12.5 }]);
    const followed: string[] = [];
    bound.follow(provider => void followed.push(provider.id));
    expect(followed).toEqual(['m']);
    expect(usages).toEqual([]);
  });
});

describe('第一方服务商登记的模型都记账', () => {
  /** 桩 fetch：模型列表回一个模型，对话回给定的回应（两种协议的字段都带上） */
  function stubFetch(modelId: string) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const json = String(input).endsWith('/models')
        ? { data: [{ id: modelId }] }
        : {
            choices: [{ message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
            message: { role: 'assistant', content: '好的' },
            done: true,
            prompt_eval_count: 30,
            eval_count: 5,
          };
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  it.each([
    ['DeepSeek', deepseekPlugin, { apiKey: 'test-key' }],
    ['OpenAI', openaiPlugin, { apiKey: 'test-key' }],
    ['Ollama', ollamaPlugin, { baseUrl: 'http://127.0.0.1:1', discoverModels: false, customModels: 'm1' }],
  ] as Array<[string, PluginDefinition, Record<string, unknown>]>)('%s', async (_name, plugin, config) => {
    stubFetch('m1');
    let bound: ServiceSelection<LLMModel> | undefined;
    const consumer = definePlugin({
      name: 'consumer',
      uses: { llm },
      apply(caps) {
        bound = caps.llm;
      },
    });
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const usages: LLMUsageEvent[] = [];
    app.bind({ events }).events.use.on('llm:usage', usage => void usages.push(usage));
    await app.plugin(plugin, config);
    await app.plugin(consumer, {});
    await app.plugins.idle();
    await bound?.use.chat({ messages: [{ role: 'user', content: '在吗' }], purpose: '对话', sessionId: 's1' });
    expect(usages).toEqual([
      expect.objectContaining({
        provider: plugin.name,
        model: 'm1',
        caller: 'consumer',
        sessionId: 's1',
        purpose: '对话',
        inputTokens: 30,
        outputTokens: 5,
      }),
    ]);
  });
});
