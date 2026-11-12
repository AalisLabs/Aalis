import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatStreamChunk, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { App, type LogEntry, LogHub, type PluginDefinition } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';
import openai from '../../packages/plugin-llm-openai/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 流式收尾组装 toolCalls 的两条路径（收到终帧 / 流意外结束）行为一致。
//
// - ollama：EOF 兜底此前造的 id 是 `call_${i}`，与终帧、非流式的 `call_ollama_<时间戳>_<i>`
//   不同格式，跨回合必撞；下游按 id 配对调用与结果（tool-search、memory-summary）。
// - deepseek：服务端没给 tool_calls、正文里漏出工具调用标记时，两条收尾路径（与非流式）都只剥离标记、不当调用执行。
// - openai 与 deepseek：一帧里带几个工具调用时每个都报生成进度（只报最后一个时，界面按序号配的工具卡会串位）。
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
      return Response.json(json);
    }),
  );
}

async function loadModel(plugin: PluginDefinition, config: Record<string, unknown>, hub?: LogHub): Promise<LLMModel> {
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  provideEvents(app);
  apps.push(app);
  const host = app.bind({ llm });
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`${plugin.name} 未激活（state=${state}）`);
  const model = host.llm.list()[0]?.use;
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

describe('deepseek：服务端没给 tool_calls 时，正文里漏出的工具调用标记只剥离、不当调用执行', () => {
  const BLOCK =
    '<｜DSML｜tool_calls><｜DSML｜invoke name="get_time"><｜DSML｜parameter name="tz" string="true">UTC</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const DEEPSEEK = { apiKey: 'k', baseUrl: 'https://gw.invalid' };

  function warnHub(): { hub: LogHub; warns: string[] } {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry((e: LogEntry) => {
      if (e.level === 'warn') warns.push(e.message);
    });
    return { hub, warns };
  }

  const leak = `data: ${JSON.stringify({ choices: [{ delta: { content: `先查一下${BLOCK}` } }] })}\n`;
  it.each([
    ['收到 [DONE]', `${leak}data: [DONE]\n`],
    ['流意外结束（无 [DONE]）', leak],
  ])('流式 / %s：标记之前的正文照交，标记不交出，收尾没有工具调用', async (_label, body) => {
    const { hub, warns } = warnHub();
    stubProvider(body);
    const model = await loadModel(deepseek, DEEPSEEK, hub);
    const deltas: string[] = [];
    let last: ChatStreamChunk | undefined;
    for await (const chunk of model.chatStream!({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.contentDelta) deltas.push(chunk.contentDelta);
      last = chunk;
    }
    expect(last?.done).toBe(true);
    expect(last?.toolCalls, '正文里的标记被当成调用').toBeUndefined();
    expect(deltas.join('')).toBe('先查一下');
    expect(
      warns.some(m => m.includes('DSML')),
      `没有记 warn: ${JSON.stringify(warns)}`,
    ).toBe(true);
  });

  /** 按 parts 逐帧交出正文、以 [DONE] 收尾的流，交出模型给出的全部正文增量 */
  const streamed = async (parts: string[]): Promise<string> => {
    const frame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
    stubProvider(`${parts.map(frame).join('')}data: [DONE]\n`);
    const model = await loadModel(deepseek, DEEPSEEK);
    let text = '';
    for await (const chunk of model.chatStream!({ messages: [{ role: 'user', content: 'hi' }] })) {
      text += chunk.contentDelta ?? '';
    }
    return text;
  };
  const LEAKED = `先查一下${BLOCK}`;
  const START = LEAKED.indexOf('<');

  // 可能是标记开头的尾巴留到下一帧再判：标记从哪里断开都不漏出半截
  it.each([0, 1, 2, 4])('流式 / 标记跨帧（在起始标记的第 %i 个字处断开）：只交出标记之前的正文', async offset => {
    const cut = START + offset;
    expect(await streamed([LEAKED.slice(0, cut), LEAKED.slice(cut)])).toBe('先查一下');
  });

  it('流式 / 不是标记的「<」跨帧：留到下一帧再判，正文照原样交出', async () => {
    expect(await streamed(['a <', '｜不是标记', ' 好'])).toBe('a <｜不是标记 好');
  });

  it('非流式：去掉标记块，其余正文照留，没有工具调用', async () => {
    const { hub, warns } = warnHub();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).endsWith('/chat/completions')
          ? Response.json({
              choices: [
                {
                  message: { role: 'assistant', content: `先查一下\n${BLOCK}`, tool_calls: [] },
                  finish_reason: 'stop',
                },
              ],
            })
          : Response.json({ data: [{ id: 'm' }] }),
      ),
    );
    const model = await loadModel(deepseek, DEEPSEEK, hub);
    const result = await model.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.toolCalls, '正文里的标记被当成调用').toBeUndefined();
    expect(result.content).toBe('先查一下');
    expect(
      warns.some(m => m.includes('DSML')),
      `没有记 warn: ${JSON.stringify(warns)}`,
    ).toBe(true);
  });
});

describe.each([
  ['openai', openai],
  ['deepseek', deepseek],
] as const)('%s：一帧里有几个工具调用时每个都报生成进度', (_label, plugin) => {
  it('两个调用同在一帧', async () => {
    const frame = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'a', function: { name: 'file_write', arguments: '{"p":1}' } },
              { index: 1, id: 'b', function: { name: 'exec', arguments: '{}' } },
            ],
          },
        },
      ],
    };
    stubProvider(`data: ${JSON.stringify(frame)}\ndata: [DONE]\n`);
    const model = await loadModel(plugin, { apiKey: 'k', baseUrl: 'https://gw.invalid' });
    const progress: Array<[number, string, number]> = [];
    let last: ChatStreamChunk | undefined;
    for await (const chunk of model.chatStream!({ messages: [{ role: 'user', content: 'hi' }] })) {
      const p = chunk.toolCallProgress;
      if (p) progress.push([p.index, p.name, p.charsAccumulated]);
      last = chunk;
    }
    expect(progress).toEqual([
      [0, 'file_write', 7],
      [1, 'exec', 2],
    ]);
    expect(last?.toolCalls?.map(c => c.function.name)).toEqual(['file_write', 'exec']);
  });
});
