import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatModelRequest, ChatStreamChunk, LLMModel } from '../../packages/api-llm/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, type PluginDefinition, services } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 模型请求的超时按停顿计（本机 HTTP 桩）：三家的 timeout 是「多久收不到新的生成内容算超时」。
// - 流式请求每收到一段正文、思考或工具调用的名字与参数就重新计时：一直在输出时总时长超过 timeout 也照常读完；停住超过
//   timeout 即中止，报「<提供者> 请求超时：<timeout> 秒内没有收到新的生成内容，可在配置里调大 timeout」。DeepSeek 为防
//   DSML 泄漏不交出的正文也算。
// - 保活注释、空行、只有角色或只报用量的帧不算：卡住却还在发心跳的连接照样超时。
// - 计时从发出请求开始：等响应头也受同一个时限约束。
// - 不流式的请求只有整份回复一段：timeout 内没读完就中止，回复体一点点到也一样（含 Ollama 带音频的请求）。
// - timeout 为 0 不限。调用方中止见 llm-chat-error-message。
// 时限取 1 秒、每段间隔 50 毫秒：用例不必真等两分钟，事件循环卡顿不到 0.95 秒也不会误判超时。
// ════════════════════════════════════════════════════════════

const LIMIT = 1;
const STEP = 50;
/** 一直在输出的用例写这么多段，写完比时限久 */
const SEGMENTS = (LIMIT * 1000) / STEP + 4;

type Reply = (res: ServerResponse) => void | Promise<void>;

interface Wire {
  name: string;
  plugin: PluginDefinition;
  provider: string;
  config: (baseUrl: string) => Record<string, unknown>;
  /** 一段正文 */
  text: (s: string) => string;
  /** 一段思考 */
  thinking: (s: string) => string;
  /** 第 i 个工具调用的全部帧：OpenAI 协议先一帧名字，再一段段参数（写完比时限久）；Ollama 一帧给全 */
  toolCall: (i: number) => string[];
  /** 没有生成内容的帧：保活注释、空行、只有角色、只报用量或内容为空的帧 */
  idle: string;
  end: string;
  /** 不流式的调用 */
  wholeCalls: Call[];
}

/** 不流式的调用：whole 是它的整份回复 */
type Call = { via: string; request: ChatModelRequest; whole: (s: string) => unknown };

const ASK: ChatModelRequest = { messages: [{ role: 'user', content: '在吗' }] };
const AUDIO_ASK: ChatModelRequest = {
  messages: [{ role: 'user', content: '听听', audios: ['data:audio/wav;base64,AAAA'] }],
};
const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const ndjson = (data: unknown) => `${JSON.stringify(data)}\n`;

const openaiArgs = (i: number, args: string) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args } }] } }] });
const openaiFrames = {
  text: (s: string) => sse({ choices: [{ delta: { content: s } }] }),
  thinking: (s: string) => sse({ choices: [{ delta: { reasoning_content: s } }] }),
  toolCall: (i: number) => [
    sse({
      choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, type: 'function', function: { name: 'f' } }] } }],
    }),
    openaiArgs(i, '{"a":"'),
    ...Array.from({ length: SEGMENTS }, () => openaiArgs(i, 'x')),
    openaiArgs(i, '"}'),
  ],
  idle:
    `: keepalive\n\n\n${sse({ choices: [{ delta: { role: 'assistant' } }] })}` +
    sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  end: 'data: [DONE]\n\n',
};
const openaiWhole = (s: string) => ({
  id: 'x',
  choices: [{ message: { role: 'assistant', content: s }, finish_reason: 'stop' }],
});
const CHAT: Call = { via: 'chat', request: ASK, whole: openaiWhole };

const openaiWire: Wire = {
  name: 'llm-openai',
  plugin: llmOpenai,
  provider: 'LLM',
  config: baseUrl => ({ apiKey: 'k', baseUrl: `${baseUrl}/v1` }),
  ...openaiFrames,
  wholeCalls: [CHAT],
};
const deepseekWire: Wire = {
  name: 'llm-deepseek',
  plugin: deepseek,
  provider: 'DeepSeek',
  config: baseUrl => ({ apiKey: 'k', baseUrl }),
  ...openaiFrames,
  wholeCalls: [CHAT],
};
const ollamaWire: Wire = {
  name: 'llm-ollama',
  plugin: llmOllama,
  provider: 'Ollama',
  config: baseUrl => ({ baseUrl }),
  text: s => ndjson({ message: { role: 'assistant', content: s }, done: false }),
  thinking: s => ndjson({ message: { role: 'assistant', content: '', thinking: s }, done: false }),
  toolCall: i => [
    ndjson({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: `f${i}`, arguments: {} } }] },
      done: false,
    }),
  ],
  idle: `\n${ndjson({ message: { role: 'assistant', content: '' }, done: false })}`,
  end: ndjson({ message: { role: 'assistant', content: '' }, done: true }),
  wholeCalls: [
    { ...CHAT, whole: s => ({ model: 'm', message: { role: 'assistant', content: s }, done: true }) },
    // 带音频的请求走 OpenAI 兼容端点，回复也是那边的写法；chatStream 带音频时发的是同一个请求
    { via: '音频', request: AUDIO_ASK, whole: openaiWhole },
  ],
};
const wires = [openaiWire, deepseekWire, ollamaWire];
/** 兼容端点把思考写在 reasoning 里，llm-openai 也认 */
const thinkingWires: Wire[] = [
  ...wires,
  {
    ...openaiWire,
    name: 'llm-openai（reasoning 字段）',
    thinking: s => sse({ choices: [{ delta: { reasoning: s } }] }),
  },
];

const wholeCalls = wires.flatMap(wire => wire.wholeCalls.map(call => ({ ...wire, call, via: call.via })));

const apps: App[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

/** 本机桩服务：模型发现与能力探测答最小可用体，对话请求交给 state.reply */
async function stubServer(): Promise<{ baseUrl: string; state: { reply: Reply } }> {
  const state: { reply: Reply } = { reply: res => void res.end() };
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    if (path.endsWith('/models')) return void res.end(JSON.stringify({ data: [{ id: 'm' }] }));
    if (path === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'm' }] }));
    if (path === '/api/show') return void res.end(JSON.stringify({ capabilities: ['completion'] }));
    req.resume();
    void state.reply(res);
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

async function start(wire: Wire, timeout: number): Promise<{ handle: LLMModel; state: { reply: Reply } }> {
  const { baseUrl, state } = await stubServer();
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await app.plugin(wire.plugin, { ...wire.config(baseUrl), timeout });
  await app.plugins.idle();
  const handle = app.bind({ services }).services.use.all(llm)[0]?.instance;
  if (!handle) throw new Error(`${wire.plugin.name} 未登记模型`);
  return { handle, state };
}

/** 写响应头，再按顺序写出各段、段与段之间隔 STEP，写完结束；客户端断开后不再写 */
function stream(frames: string[]): Reply {
  return async res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [i, frame] of frames.entries()) {
      if (i > 0) await sleep(STEP);
      if (res.destroyed) return;
      res.write(frame);
    }
    res.end();
  };
}

/** 不写响应头，连接一直开着 */
const silent: Reply = () => {};

async function read(stream: AsyncIterable<ChatStreamChunk>) {
  let text = '';
  let toolCalls = 0;
  let done = false;
  try {
    for await (const chunk of stream) {
      text += chunk.contentDelta ?? '';
      if (chunk.done) {
        done = true;
        toolCalls = chunk.toolCalls?.length ?? 0;
      }
    }
    return { text, toolCalls, done, error: undefined };
  } catch (error) {
    return { text, toolCalls, done, error };
  }
}

function streamOf(handle: LLMModel, request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
  if (!handle.chatStream) throw new Error('未提供 chatStream');
  return handle.chatStream(request);
}

async function errorOf(task: Promise<unknown>): Promise<unknown> {
  try {
    await task;
  } catch (err) {
    return err;
  }
  throw new Error('预期抛错，实际成功');
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const timeoutMessage = (provider: string) =>
  `${provider} 请求超时：${LIMIT} 秒内没有收到新的生成内容，可在配置里调大 timeout`;
const segments = (n: number) => Array.from({ length: n }, (_, i) => `段${i}`);

describe('流式：一直在输出就不超时', () => {
  it.each(wires)('$name / 每段间隔短于时限、总时长超过时限：完整读完', async wire => {
    const { handle, state } = await start(wire, LIMIT);
    const parts = segments(SEGMENTS);
    state.reply = stream([...parts.map(wire.text), wire.end]);

    const startedAt = Date.now();
    const result = await read(streamOf(handle, ASK));

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ text: parts.join(''), done: true });
    expect(Date.now() - startedAt, '用例的总时长要超过时限才有意义').toBeGreaterThan(LIMIT * 1000);
  });

  it.each(thinkingWires)('$name / 只在思考也算在输出', async wire => {
    const { handle, state } = await start(wire, LIMIT);
    state.reply = stream([...segments(SEGMENTS).map(wire.thinking), wire.end]);

    const result = await read(streamOf(handle, ASK));

    expect(result.error).toBeUndefined();
    expect(result.done).toBe(true);
  });

  it.each(wires)('$name / 只在写工具调用也算在输出', async wire => {
    const { handle, state } = await start(wire, LIMIT);
    const frames: string[] = [];
    let calls = 0;
    while (frames.length < SEGMENTS) frames.push(...wire.toolCall(calls++));
    state.reply = stream([...frames, wire.end]);

    const result = await read(streamOf(handle, ASK));

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ done: true, toolCalls: calls });
  });

  it('llm-deepseek / 为防 DSML 泄漏不交出的正文也算在输出', async () => {
    const { handle, state } = await start(deepseekWire, LIMIT);
    const dsml = [deepseekWire.text('<｜DSML｜tool_calls>'), ...segments(SEGMENTS).map(deepseekWire.text)];
    state.reply = stream([...dsml, deepseekWire.end]);

    const result = await read(streamOf(handle, ASK));

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ text: '', done: true });
  });
});

describe('流式：停住超过时限即中止', () => {
  it.each(wires)('$name / 输出一阵后停住、只发保活注释与空帧：已到的照常交出，再报超时', async wire => {
    const { handle, state } = await start(wire, LIMIT);
    const parts = segments(3);
    const idles = Array.from({ length: (2 * LIMIT * 1000) / STEP }, () => wire.idle);
    state.reply = stream([...parts.map(wire.text), ...idles]);

    const result = await read(streamOf(handle, ASK));

    expect(result.text).toBe(parts.join(''));
    expect(messageOf(result.error)).toBe(timeoutMessage(wire.provider));
  });

  it.each(wires)('$name / 等响应头也受时限约束', async wire => {
    const { handle, state } = await start(wire, LIMIT);
    state.reply = silent;

    const result = await read(streamOf(handle, ASK));

    expect(messageOf(result.error)).toBe(timeoutMessage(wire.provider));
  });
});

describe('不流式：时限内没读完整份回复就中止', () => {
  it.each(wholeCalls)('$name / $via / 回复体一点点到也不算新内容', async ({ call, ...wire }) => {
    const { handle, state } = await start(wire, LIMIT);
    const body = JSON.stringify(call.whole('好的'));
    state.reply = async res => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      for (const char of body) {
        if (res.destroyed) return;
        res.write(char);
        await sleep(STEP);
      }
      res.end();
    };

    expect(messageOf(await errorOf(handle.chat(call.request)))).toBe(timeoutMessage(wire.provider));
  });
});

describe('timeout 为 0：不限', () => {
  it.each(wires)('$name / 流式照常读完', async wire => {
    const { handle, state } = await start(wire, 0);
    state.reply = stream([wire.text('前'), wire.text('后'), wire.end]);

    const result = await read(streamOf(handle, ASK));

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('前后');
  });
});
