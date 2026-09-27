import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub, type PluginDefinition, services } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 对话请求失败时的错误信息会经 agent 以「[错误] …」发回会话（群聊也是），要让人看得懂，又不带出响应体与部署细节：
// - 非 2xx：状态码，常见状态码（401/403、402、404、429、5xx）加一句提示，再加上游 JSON 里的说明（OpenAI 风格的
//   error.message、Ollama 风格的 error 字符串，或顶层 message），折成一行并截断；不是 JSON 或没有说明时写
//   「详情见日志」。响应体截断后只进 warn。
// - 超时与连不上各一句，原始错误连同原因（可能带内网地址）只进 warn。调用方中止时原样抛出、不记 warn，agent
//   按中止收尾；其它错误（如读流时连接被断开的 terminated）同样原样抛出，不冒充连不上。
// - 应答是 200 但不是 JSON 时写明，响应体同样只进 warn。
// 三家同一口径，覆盖 chat、chatStream 与 Ollama 的音频路径。fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

type Reply = (signal: AbortSignal | undefined) => Response | Promise<Response>;

/** 模型发现与 Ollama 能力探测答最小可用体；对话端点（含音频路径）按 state.reply 应答 */
function stubFetch(): { reply: Reply } {
  const state: { reply: Reply } = { reply: () => Response.json({}) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
      if (u.endsWith('/api/tags')) return Response.json({ models: [{ name: 'm' }] });
      if (u.endsWith('/models')) return Response.json({ data: [{ id: 'm' }] });
      return state.reply(init?.signal ?? undefined);
    }),
  );
  return state;
}

/** 响应头照常到达，读响应体时先给一段内容再以 err 出错（读到一半超时或连接被断开） */
function failingBody(err: unknown, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半"}}]}\n'));
        c.error(err);
      },
    }),
    { status },
  );
}

async function start(plugin: PluginDefinition, config: Record<string, unknown>) {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'info', logHub: hub });
  apps.push(app);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const handle = app.bind({ services }).services.all(llm)[0]?.instance;
  if (!handle) throw new Error(`${plugin.name} 未登记模型`);
  return { handle, warns };
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('预期抛错，实际成功');
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  const err = await errorOf(run);
  return err instanceof Error ? err.message : String(err);
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* 读完即可 */
  }
}

const REQUEST: ChatModelRequest = { messages: [{ role: 'user', content: '在吗' }] };
const AUDIO_REQUEST: ChatModelRequest = {
  messages: [{ role: 'user', content: '听听', audios: ['data:audio/wav;base64,AAAA'] }],
};

type Call = { via: string; run: (handle: LLMModel, signal?: AbortSignal) => Promise<unknown> };
const CHAT: Call = { via: 'chat', run: (h, signal) => h.chat({ ...REQUEST, signal }) };
const STREAM: Call = {
  via: 'chatStream',
  run: (h, signal) => {
    if (!h.chatStream) throw new Error('未提供 chatStream');
    return drain(h.chatStream({ ...REQUEST, signal }));
  },
};
const AUDIO: Call = { via: '音频', run: (h, signal) => h.chat({ ...AUDIO_REQUEST, signal }) };

const cases = [
  {
    name: 'llm-ollama',
    plugin: llmOllama,
    config: { baseUrl: 'http://127.0.0.1:11434', timeout: 30 },
    provider: 'Ollama',
    calls: [CHAT, STREAM, AUDIO],
  },
  {
    name: 'llm-openai',
    plugin: llmOpenai,
    config: { apiKey: 'k', baseUrl: 'https://gw.invalid/v1', timeout: 30 },
    provider: 'LLM',
    calls: [CHAT, STREAM],
  },
  {
    name: 'llm-deepseek',
    plugin: deepseek,
    config: { apiKey: 'k', baseUrl: 'https://gw.invalid', timeout: 30 },
    provider: 'DeepSeek',
    calls: [CHAT, STREAM],
  },
];
const everyCall = cases.flatMap(({ calls, ...c }) => calls.map(call => ({ ...c, call, via: call.via })));
/** 按 JSON 解析 2xx 应答体的调用：流式应答里不是 JSON 的行按畸形行跳过，不报错 */
const bodyCalls = everyCall.filter(c => c.call !== STREAM);

describe('非 2xx：状态码与常见状态码的提示，加上游说明', () => {
  it.each(
    everyCall.flatMap(c =>
      [
        { status: 401, hint: '：密钥无效或没有权限' },
        { status: 403, hint: '：密钥无效或没有权限' },
        { status: 402, hint: '：余额不足或需要付费' },
        { status: 404, hint: '：模型或地址不对' },
        { status: 429, hint: '：请求过多或额度不足' },
        { status: 500, hint: '：上游服务故障' },
        { status: 503, hint: '：上游服务故障' },
        { status: 400, hint: '' },
      ].map(s => ({ ...c, ...s })),
    ),
  )('$name / $via / $status', async ({ plugin, config, provider, call, status, hint }) => {
    const state = stubFetch();
    state.reply = () => Response.json({ error: { message: 'upstream says no', type: 'x' } }, { status });
    const { handle } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(
      `${provider} API 错误 (${status})${hint}；上游说明：upstream says no`,
    );
  });
});

describe('非 2xx：上游说明只取 message 一类字段，响应体只进 warn', () => {
  it.each(
    everyCall.flatMap(c => [
      {
        ...c,
        form: 'Ollama 风格的 error 字符串',
        body: { error: 'model "m" not found' },
        shown: 'model "m" not found',
      },
      { ...c, form: '顶层 message', body: { message: 'top level' }, shown: 'top level' },
      {
        ...c,
        form: 'error.message 先于顶层 message',
        body: { error: { message: 'inner' }, message: 'top level' },
        shown: 'inner',
      },
      {
        ...c,
        form: '多行说明折成一行',
        body: { error: { message: '第一行\r\n\r\n    第二行' } },
        shown: '第一行 第二行',
      },
    ]),
  )('$name / $via / $form', async ({ plugin, config, provider, call, body, shown }) => {
    const state = stubFetch();
    state.reply = () => Response.json(body, { status: 400 });
    const { handle } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(`${provider} API 错误 (400)；上游说明：${shown}`);
  });

  it.each(everyCall)('$name / $via / 说明很长时截断', async ({ plugin, config, call }) => {
    const state = stubFetch();
    state.reply = () => Response.json({ error: { message: 'x'.repeat(5_000) } }, { status: 400 });
    const { handle } = await start(plugin, config);

    const message = await messageOf(() => call.run(handle));
    expect(message.endsWith('…'), '说明没有截断').toBe(true);
    expect(message.length, `错误信息长 ${message.length}`).toBeLessThan(600);
  });

  it.each(
    everyCall.flatMap(c => [
      {
        ...c,
        form: 'JSON 但没有说明字段',
        body: JSON.stringify({ error: { code: 'E1' }, detail: 'BODY-MARKER' }),
      },
      { ...c, form: '说明是空白', body: JSON.stringify({ error: { message: '  ' }, detail: 'BODY-MARKER' }) },
      { ...c, form: '不是 JSON', body: '<html>\r\n  <body>BODY-MARKER</body>\r\n</html>' },
    ]),
  )('$name / $via / $form：写「详情见日志」', async ({ plugin, config, provider, call, body }) => {
    const state = stubFetch();
    state.reply = () => new Response(body, { status: 502 });
    const { handle, warns } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(`${provider} API 错误 (502)：上游服务故障；详情见日志`);
    const logged = warns.filter(w => w.includes('BODY-MARKER'));
    expect(logged, `响应体没有进 warn: ${JSON.stringify(warns)}`).toHaveLength(1);
    expect(logged[0], 'warn 带着响应体里的换行').not.toMatch(/[\r\n]/);
  });

  it.each(everyCall)('$name / $via / 响应体的其它字段不进错误信息', async ({ plugin, config, call }) => {
    const state = stubFetch();
    state.reply = () => Response.json({ error: { message: 'denied' }, request_id: 'BODY-MARKER' }, { status: 403 });
    const { handle, warns } = await start(plugin, config);

    const message = await messageOf(() => call.run(handle));
    expect(message).toContain('denied');
    expect(message).not.toContain('BODY-MARKER');
    expect(
      warns.some(w => w.includes('BODY-MARKER')),
      `响应体没有进 warn: ${JSON.stringify(warns)}`,
    ).toBe(true);
  });
});

describe('超时与连不上：各一句，原因只进 warn', () => {
  const TIMEOUT = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  it.each(everyCall)('$name / $via / 等响应头时超时', async ({ plugin, config, provider, call }) => {
    const state = stubFetch();
    state.reply = () => {
      throw TIMEOUT();
    };
    const { handle, warns } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(
      `${provider} 请求超时：30 秒内没有完成，可在配置里调大 timeout`,
    );
    expect(warns.filter(w => w.includes('aborted due to timeout'))).toHaveLength(1);
  });

  it.each(everyCall)('$name / $via / 读响应体时超时', async ({ plugin, config, provider, call }) => {
    const state = stubFetch();
    state.reply = () => failingBody(TIMEOUT());
    const { handle } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(
      `${provider} 请求超时：30 秒内没有完成，可在配置里调大 timeout`,
    );
  });

  it.each(everyCall)('$name / $via / 非 2xx 时读错误响应体超时', async ({ plugin, config, provider, call }) => {
    const state = stubFetch();
    state.reply = () => failingBody(TIMEOUT(), 502);
    const { handle } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(
      `${provider} 请求超时：30 秒内没有完成，可在配置里调大 timeout`,
    );
  });

  it.each(everyCall)('$name / $via / 连不上', async ({ plugin, config, provider, call }) => {
    const state = stubFetch();
    state.reply = () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.5:11434') });
    };
    const { handle, warns } = await start(plugin, config);

    const message = await messageOf(() => call.run(handle));
    expect(message).toBe(`${provider} 连不上服务：检查 baseUrl 与网络，详情见日志`);
    expect(
      warns.filter(w => w.includes('fetch failed ← connect ECONNREFUSED 10.0.0.5:11434')),
      `原因没有进 warn: ${JSON.stringify(warns)}`,
    ).toHaveLength(1);
  });

  it.each(everyCall)('$name / $via / 其它错误原样抛出，不冒充连不上', async ({ plugin, config, call }) => {
    const state = stubFetch();
    state.reply = () => failingBody(new TypeError('terminated', { cause: new Error('other side closed') }));
    const { handle, warns } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe('terminated');
    expect(warns.filter(w => w.includes('terminated ← other side closed'))).toHaveLength(1);
  });

  // 中止原因特意用 TimeoutError：调用方中止时不看错误类型，一律原样抛出
  it.each(everyCall)('$name / $via / 调用方中止时原样抛出、不记 warn', async ({ plugin, config, call }) => {
    const state = stubFetch();
    state.reply = signal => {
      signal?.throwIfAborted();
      return Response.json({});
    };
    const { handle, warns } = await start(plugin, config);
    const controller = new AbortController();
    controller.abort(TIMEOUT());

    expect(await errorOf(() => call.run(handle, controller.signal))).toBe(controller.signal.reason);
    expect(warns).toEqual([]);
  });
});

describe('应答是 200 但不是 JSON：写明，响应体只进 warn', () => {
  it.each(bodyCalls)('$name / $via', async ({ plugin, config, provider, call }) => {
    const state = stubFetch();
    state.reply = () => new Response('<html>\r\n<body>PORTAL-MARKER</body>\r\n</html>', { status: 200 });
    const { handle, warns } = await start(plugin, config);

    expect(await messageOf(() => call.run(handle))).toBe(`${provider} 应答不是 JSON (200)；详情见日志`);
    const logged = warns.filter(w => w.includes('PORTAL-MARKER'));
    expect(logged, `应答体没有进 warn: ${JSON.stringify(warns)}`).toHaveLength(1);
    expect(logged[0], 'warn 带着应答体里的换行').not.toMatch(/[\r\n]/);
  });
});
