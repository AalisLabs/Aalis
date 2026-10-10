import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChatModelRequest,
  type LLMModel,
  lightestThinking,
  llm,
  type ThinkingLevels,
} from '../../packages/api-llm/src/index.js';
import { App, type PluginDefinition } from '../../packages/core/src/index.js';
import deepseekPlugin from '../../packages/plugin-llm-deepseek/src/index.js';
import ollamaPlugin from '../../packages/plugin-llm-ollama/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';
import { runTscProbe } from '../helpers/tsc-probe.js';

// ════════════════════════════════════════════════════════════
// 深度思考的档位：能调思考的模型声明它允许的档位（由浅到深、各有 id 与显示名、一个默认档），不能调的不声明；请求按
// 档位 id 指定，各提供者把档位翻成自己的线上字段。这里用桩 fetch 截下真实适配器发出的请求体，逐档核对（对话与流式
// 两条路径各发一遍）。
// ════════════════════════════════════════════════════════════

type Body = Record<string, unknown>;

const realFetch = globalThis.fetch;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  globalThis.fetch = realFetch;
});

/**
 * 桩 fetch：models 是模型 id → Ollama 报告的能力（null 时能力探测回 500）。模型发现与能力探测按它回；对话请求记下路径与
 * 请求体，非流式回一段 JSON，流式回最小的一帧
 */
function stubFetch(models: Record<string, string[] | null>, sent: Array<{ path: string; body: Body }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname.endsWith('/models')) return Response.json({ data: Object.keys(models).map(id => ({ id })) });
    if (pathname === '/api/tags') return Response.json({ models: Object.keys(models).map(name => ({ name })) });
    const body = JSON.parse(String(init?.body)) as Body;
    if (pathname === '/api/show') {
      const capabilities = models[String(body.model)];
      return capabilities ? Response.json({ capabilities }) : new Response('探测失败', { status: 500 });
    }
    sent.push({ path: pathname, body });
    if (pathname === '/api/chat') {
      const done = { message: { role: 'assistant', content: '好的' }, done: true };
      return body.stream ? new Response(`${JSON.stringify(done)}\n`) : Response.json(done);
    }
    if (body.stream) {
      return new Response('data: {"choices":[{"delta":{"content":"好的"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
}

async function start(
  plugin: PluginDefinition,
  config: Record<string, unknown>,
  models: Record<string, string[] | null>,
) {
  const sent: Array<{ path: string; body: Body }> = [];
  stubFetch(models, sent);
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const entries = app.bind({ llm }).llm.list();
  const model = (id: string): LLMModel => {
    const entry = entries.find(e => e.use.id === id);
    if (!entry) throw new Error(`没有登记模型 ${id}`);
    return entry.use;
  };
  /** 对话与流式各发一遍，交出两次的路径与请求体 */
  const send = async (id: string, request: Partial<ChatModelRequest> = {}) => {
    const from = sent.length;
    const full: ChatModelRequest = { messages: [{ role: 'user', content: '在吗' }], ...request };
    await model(id).chat(full);
    for await (const _ of model(id).chatStream?.(full) ?? []) {
      // 消费完整条流
    }
    return sent.slice(from);
  };
  return { model, send, sent };
}

/** 请求体里与思考有关的字段 */
const thinkingFields = (body: Body) => ({
  thinking: body.thinking,
  reasoning_effort: body.reasoning_effort,
  think: body.think,
  temperature: 'temperature' in body,
});

describe('请求的思考字段只收档位 id（编译期）', () => {
  const GOOD = `import type { ChatModelRequest, ThinkingLevels } from '@aalis/api-llm';
const request: ChatModelRequest = { messages: [], think: 'high' };
const levels: ThinkingLevels = { levels: [{ id: 'off', label: '关' }, { id: 'on', label: '开' }], default: 'on' };
export { levels, request };
`;
  const BAD = `${GOOD}export const flag: ChatModelRequest = { messages: [], think: true }; // BAD
`;

  it('档位 id 编得过', () => {
    const errs = runTscProbe(GOOD);
    expect(errs, errs.join('\n')).toEqual([]);
  });

  it('布尔值编不过', () => {
    const errs = runTscProbe(BAD);
    const line = BAD.split('\n').findIndex(l => l.includes('// BAD')) + 1;
    expect(errs, errs.join('\n')).toHaveLength(1);
    expect(errs[0]).toContain(`fixture.ts(${line},`);
  });
});

describe('DeepSeek', () => {
  const MODELS = { 'deepseek-v4-pro': [], 'deepseek-chat': [] };
  const LEVELS: ThinkingLevels['levels'] = [
    { id: 'off', label: '关' },
    { id: 'high', label: '高' },
    { id: 'auto', label: '自动' },
    { id: 'max', label: '最高' },
  ];

  it('能思考的模型声明关、高、自动、最高四档，默认档取实例配置（缺省为自动）；不能思考的模型不声明', async () => {
    const { model } = await start(deepseekPlugin, { apiKey: 'test-key' }, MODELS);
    expect(model('deepseek-v4-pro').thinking).toEqual({ levels: LEVELS, default: 'auto' });
    expect(model('deepseek-chat').thinking).toBeUndefined();
    const configured = await start(deepseekPlugin, { apiKey: 'test-key', thinking: 'max' }, MODELS);
    expect(configured.model('deepseek-v4-pro').thinking?.default).toBe('max');
  });

  for (const [level, fields] of [
    ['off', { thinking: { type: 'disabled' }, reasoning_effort: undefined, think: undefined, temperature: true }],
    ['high', { thinking: { type: 'enabled' }, reasoning_effort: 'high', think: undefined, temperature: false }],
    ['auto', { thinking: { type: 'enabled' }, reasoning_effort: undefined, think: undefined, temperature: false }],
    ['max', { thinking: { type: 'enabled' }, reasoning_effort: 'max', think: undefined, temperature: false }],
  ] as const) {
    it(`档位 ${level} 的线上字段`, async () => {
      const { send } = await start(deepseekPlugin, { apiKey: 'test-key' }, MODELS);
      const sent = await send('deepseek-v4-pro', { think: level });
      expect(sent.map(({ body }) => thinkingFields(body))).toEqual([fields, fields]);
    });
  }

  it('实例配置是默认档：请求没带档位按它，请求带了按请求', async () => {
    const { send } = await start(deepseekPlugin, { apiKey: 'test-key', thinking: 'max' }, MODELS);
    const [byDefault] = await send('deepseek-v4-pro');
    expect(thinkingFields(byDefault.body)).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    const [byRequest] = await send('deepseek-v4-pro', { think: 'off' });
    expect(thinkingFields(byRequest.body)).toMatchObject({ thinking: { type: 'disabled' }, temperature: true });
  });

  it('不能思考的模型按关发；请求带档位被拒', async () => {
    const { send } = await start(deepseekPlugin, { apiKey: 'test-key', thinking: 'max' }, MODELS);
    const sent = await send('deepseek-chat');
    expect(sent.map(({ body }) => thinkingFields(body).thinking)).toEqual([{ type: 'disabled' }, { type: 'disabled' }]);
    await expect(send('deepseek-chat', { think: 'high' })).rejects.toThrow('没有思考档位「high」');
  });

  it('请求带了模型没有的档位被拒，不发请求', async () => {
    const { send, sent } = await start(deepseekPlugin, { apiKey: 'test-key' }, MODELS);
    await expect(send('deepseek-v4-pro', { think: 'on' })).rejects.toThrow('没有思考档位「on」');
    expect(sent).toEqual([]);
  });
});

describe('OpenAI', () => {
  it('缺省写成 reasoning_effort：能思考的模型声明低、中、高三档（默认中），各档原样发；不带档位时不发字段', async () => {
    const { model, send } = await start(openaiPlugin, { apiKey: 'test-key' }, { o3: [], 'gpt-4o': [] });
    expect(model('o3').thinking).toEqual({
      levels: [
        { id: 'low', label: '低' },
        { id: 'medium', label: '中' },
        { id: 'high', label: '高' },
      ],
      default: 'medium',
    });
    expect(model('gpt-4o').thinking).toBeUndefined();
    for (const level of ['low', 'medium', 'high']) {
      const sent = await send('o3', { think: level });
      expect(sent.map(({ body }) => [body.reasoning_effort, 'thinking' in body])).toEqual([
        [level, false],
        [level, false],
      ]);
    }
    const plain = await send('o3');
    expect(plain.every(({ body }) => !('reasoning_effort' in body) && !('thinking' in body))).toBe(true);
    await expect(send('gpt-4o', { think: 'low' })).rejects.toThrow('没有思考档位「low」');
  });

  it('reasoning_effort 的档位按模型族给：gpt-5.1 起多一档关且默认关，gpt-5 最浅是最低，o1-mini 与 o1-preview 不收这个字段，gpt-5-chat 不是推理模型', async () => {
    const LOW_TO_HIGH = [
      { id: 'low', label: '低' },
      { id: 'medium', label: '中' },
      { id: 'high', label: '高' },
    ];
    const families: Array<[string, ThinkingLevels | undefined]> = [
      ['o3', { levels: LOW_TO_HIGH, default: 'medium' }],
      ['o4-mini', { levels: LOW_TO_HIGH, default: 'medium' }],
      ['gpt-5', { levels: [{ id: 'minimal', label: '最低' }, ...LOW_TO_HIGH], default: 'medium' }],
      ['gpt-5-mini', { levels: [{ id: 'minimal', label: '最低' }, ...LOW_TO_HIGH], default: 'medium' }],
      ['gpt-5.1', { levels: [{ id: 'none', label: '关' }, ...LOW_TO_HIGH], default: 'none' }],
      ['gpt-5.2-pro', { levels: [{ id: 'none', label: '关' }, ...LOW_TO_HIGH], default: 'none' }],
      ['o1-mini', undefined],
      ['o1-preview', undefined],
      ['gpt-5-chat-latest', undefined],
    ];
    const { model } = await start(
      openaiPlugin,
      { apiKey: 'test-key' },
      Object.fromEntries(families.map(([id]) => [id, []])),
    );
    for (const [id, levels] of families) expect(model(id).thinking, id).toEqual(levels);
    expect(lightestThinking(model('gpt-5.1'))).toBe('none');
    expect(lightestThinking(model('gpt-5'))).toBe('minimal');
    expect(model('o1-mini').capabilities).toContain('thinking');
    expect(model('gpt-5-chat-latest').capabilities).not.toContain('thinking');
  });

  it('写成 thinking.type：能思考的模型（能力覆盖里写了 thinking 的）声明关、开两档（默认开）', async () => {
    const config = {
      apiKey: 'test-key',
      thinkingParam: 'thinking',
      modelCapabilities: 'relay-v4: chat,tool_calling,streaming,thinking',
    };
    const { model, send } = await start(openaiPlugin, config, { 'relay-v4': [], 'relay-chat': [] });
    expect(model('relay-v4').thinking).toEqual({
      levels: [
        { id: 'off', label: '关' },
        { id: 'on', label: '开' },
      ],
      default: 'on',
    });
    expect(model('relay-chat').thinking).toBeUndefined();
    for (const [level, type] of [
      ['off', 'disabled'],
      ['on', 'enabled'],
    ]) {
      const sent = await send('relay-v4', { think: level });
      expect(sent.map(({ body }) => [body.thinking, 'reasoning_effort' in body])).toEqual([
        [{ type }, false],
        [{ type }, false],
      ]);
    }
    const plain = await send('relay-v4');
    expect(plain.every(({ body }) => !('thinking' in body))).toBe(true);
  });
});

describe('Ollama', () => {
  const MODELS = { 'qwen3:8b': ['completion', 'tools', 'thinking'], 'llama3.1:8b': ['completion', 'tools'] };
  const LEVELS: ThinkingLevels['levels'] = [
    { id: 'off', label: '关' },
    { id: 'on', label: '开' },
  ];
  const AUDIO: Partial<ChatModelRequest> = {
    messages: [{ role: 'user', content: '听听', audios: ['data:audio/wav;base64,UklGRg=='] }],
  };

  it('报告了思考能力的模型声明关、开两档，默认档取实例配置（缺省为开）；没报告的不声明', async () => {
    const { model } = await start(ollamaPlugin, {}, MODELS);
    expect(model('qwen3:8b').thinking).toEqual({ levels: LEVELS, default: 'on' });
    expect(model('llama3.1:8b').thinking).toBeUndefined();
  });

  it('原生接口：档位翻成 think 开关；没带档位按实例配置的默认档，带了按请求', async () => {
    const { send } = await start(ollamaPlugin, { thinking: 'off' }, MODELS);
    for (const [request, think] of [
      [{}, false],
      [{ think: 'on' }, true],
      [{ think: 'off' }, false],
    ] as const) {
      const sent = await send('qwen3:8b', request);
      expect(
        sent.map(({ path, body }) => [path, body.think]),
        JSON.stringify(request),
      ).toEqual([
        ['/api/chat', think],
        ['/api/chat', think],
      ]);
    }
  });

  it('不能调的模型不发 think；请求带档位被拒', async () => {
    const { send } = await start(ollamaPlugin, {}, MODELS);
    const sent = await send('llama3.1:8b');
    expect(sent.every(({ body }) => !('think' in body))).toBe(true);
    await expect(send('llama3.1:8b', { think: 'on' })).rejects.toThrow('没有思考档位「on」');
  });

  it('能力探测失败时按家族表：原生思考的族（qwen3、deepseek-r1、gemma4）照样声明关、开，压低思考时发 think: false；qwen3-coder 不会思考', async () => {
    const { model, send } = await start(
      ollamaPlugin,
      {},
      { 'qwen3:32b': null, 'deepseek-r1:14b': null, 'gemma4:e4b': null, 'qwen3-coder:30b': null },
    );
    for (const id of ['qwen3:32b', 'deepseek-r1:14b', 'gemma4:e4b']) {
      expect(model(id).thinking, id).toEqual({ levels: LEVELS, default: 'on' });
    }
    expect(model('qwen3-coder:30b').thinking).toBeUndefined();
    const sent = await send('qwen3:32b', { think: lightestThinking(model('qwen3:32b')) });
    expect(sent.map(({ body }) => body.think)).toEqual([false, false]);
  });

  it('音频走兼容接口：关是 reasoning_effort none，开不发', async () => {
    const { send } = await start(ollamaPlugin, {}, MODELS);
    for (const [level, effort] of [
      ['off', 'none'],
      ['on', undefined],
    ] as const) {
      const sent = await send('qwen3:8b', { ...AUDIO, think: level });
      expect(sent.map(({ path, body }) => [path, body.reasoning_effort, 'think' in body])).toEqual([
        ['/v1/chat/completions', effort, false],
        ['/v1/chat/completions', effort, false],
      ]);
    }
  });
});

describe('最浅的一档', () => {
  it('压低思考的调用方取模型最浅的一档；不能调的模型没有', async () => {
    const deepseek = await start(
      deepseekPlugin,
      { apiKey: 'test-key' },
      { 'deepseek-v4-pro': [], 'deepseek-chat': [] },
    );
    expect(lightestThinking(deepseek.model('deepseek-v4-pro'))).toBe('off');
    expect(lightestThinking(deepseek.model('deepseek-chat'))).toBeUndefined();
    const openai = await start(openaiPlugin, { apiKey: 'test-key' }, { o3: [] });
    expect(lightestThinking(openai.model('o3'))).toBe('low');
  });
});
