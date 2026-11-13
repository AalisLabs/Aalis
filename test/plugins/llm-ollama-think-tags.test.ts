import { afterEach, describe, expect, it } from 'vitest';
import { type ChatModelRequest, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { App } from '../../packages/core/src/index.js';
import ollamaPlugin from '../../packages/plugin-llm-ollama/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// Ollama 正文里的 <think> 标签只在这次没发 think 时解析：发了 think（档位开或关）就是 Ollama 在管思考，思考走原生的
// thinking 字段，正文里字面写出的 <think> 照原样交出（比如讲提示词写法时的回答）。没发 think 的（端点没报告思考能力、
// 也没有覆盖）才把标签之间的内容当思考。带音频的请求走 OpenAI 兼容接口，同一条规则。fetch 用替身，不连本机的 Ollama。
// ════════════════════════════════════════════════════════════

const realFetch = globalThis.fetch;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  globalThis.fetch = realFetch;
});

/** 一个模型的应答：非流式（与兼容接口）的正文与原生思考，流式按 frames 逐帧给（frames 是各帧的正文与原生思考） */
interface Reply {
  content: string;
  thinking?: string;
  frames: Array<{ content: string; thinking?: string }>;
}

/**
 * 桩 fetch：models 是模型 id → Ollama 报告的能力（null 时能力探测回 500）与它的应答。模型发现、能力探测、对话与兼容接口
 * 都按它回
 */
function stubFetch(models: Record<string, { capabilities: string[] | null; reply: Reply }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/tags') return Response.json({ models: Object.keys(models).map(name => ({ name })) });
    const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
    const { capabilities, reply } = models[body.model];
    if (pathname === '/api/show') {
      return capabilities ? Response.json({ capabilities }) : new Response('探测失败', { status: 500 });
    }
    if (pathname === '/v1/chat/completions') {
      return Response.json({ choices: [{ message: { content: reply.content }, finish_reason: 'stop' }] });
    }
    if (!body.stream) {
      return Response.json({
        message: { role: 'assistant', content: reply.content, thinking: reply.thinking },
        done: true,
      });
    }
    const frames = [
      ...reply.frames.map(f => ({ message: { role: 'assistant', ...f }, done: false })),
      { message: { role: 'assistant', content: '' }, done: true },
    ];
    return new Response(frames.map(f => `${JSON.stringify(f)}\n`).join(''));
  }) as typeof fetch;
}

async function start(models: Parameters<typeof stubFetch>[0]): Promise<(id: string) => LLMModel> {
  stubFetch(models);
  const app = new App({ logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  await app.plugin(ollamaPlugin, { baseUrl: 'http://127.0.0.1:11434' });
  await app.plugins.idle();
  const entries = app.bind({ llm }).llm.list();
  return id => {
    const entry = entries.find(e => e.use.id === id);
    if (!entry) throw new Error(`没有登记模型 ${id}`);
    return entry.use;
  };
}

/** 非流式与流式各发一遍，交出两次得到的正文与思考 */
async function both(model: LLMModel, request: Partial<ChatModelRequest> = {}) {
  const full: ChatModelRequest = { messages: [{ role: 'user', content: '在吗' }], ...request };
  const result = await model.chat(full);
  let content = '';
  let reasoning = '';
  for await (const chunk of model.chatStream?.(full) ?? []) {
    content += chunk.contentDelta ?? '';
    reasoning += chunk.reasoningDelta ?? '';
  }
  return [
    { path: 'chat', content: result.content, reasoning: result.reasoningContent },
    { path: 'chatStream', content, reasoning },
  ];
}

const LITERAL = '标签写法：<think>放推理</think>，然后写答案';

describe('Ollama 正文里的 <think> 标签', () => {
  it('报告了思考能力的模型（发了 think）：正文照原样交出，思考只有原生的', async () => {
    const model = await start({
      'zz-think:1': {
        capabilities: ['completion', 'thinking'],
        reply: {
          content: LITERAL,
          thinking: '原生思考',
          frames: [
            { content: '', thinking: '原生思考' },
            { content: '标签写法：<think>放推理' },
            { content: '</think>，然后写答案' },
          ],
        },
      },
    });
    // 档位开与关都是 Ollama 在管思考
    for (const request of [{}, { think: 'off' }]) {
      expect(await both(model('zz-think:1'), request), JSON.stringify(request)).toEqual([
        { path: 'chat', content: LITERAL, reasoning: '原生思考' },
        { path: 'chatStream', content: LITERAL, reasoning: '原生思考' },
      ]);
    }
  });

  it('没有思考能力的模型（没发 think）：标签之间的内容当思考', async () => {
    const model = await start({
      'zz-plain:1': {
        capabilities: null,
        reply: { content: '<think>x</think>答', frames: [{ content: '<think>x</thi' }, { content: 'nk>答' }] },
      },
    });
    expect(model('zz-plain:1').thinking, '前置：探测失败、名字不在家族表里的模型不该有思考档位').toBeUndefined();
    expect(await both(model('zz-plain:1'))).toEqual([
      { path: 'chat', content: '答', reasoning: 'x' },
      { path: 'chatStream', content: '答', reasoning: 'x' },
    ]);
  });

  it('带音频走兼容接口：没发 think 的模型同样解析标签，报告了思考能力的正文照原样', async () => {
    const reply = { content: '<think>x</think>听到了', frames: [] };
    const model = await start({
      'zz-ear:1': { capabilities: ['completion', 'audio'], reply },
      'zz-ear-think:1': { capabilities: ['completion', 'audio', 'thinking'], reply },
    });
    const audio = { messages: [{ role: 'user' as const, content: '听听', audios: ['data:audio/wav;base64,AAAA'] }] };
    expect(await both(model('zz-ear:1'), audio)).toEqual([
      { path: 'chat', content: '听到了', reasoning: 'x' },
      { path: 'chatStream', content: '听到了', reasoning: 'x' },
    ]);
    expect(await both(model('zz-ear-think:1'), audio)).toEqual([
      { path: 'chat', content: '<think>x</think>听到了', reasoning: null },
      { path: 'chatStream', content: '<think>x</think>听到了', reasoning: '' },
    ]);
  });
});
