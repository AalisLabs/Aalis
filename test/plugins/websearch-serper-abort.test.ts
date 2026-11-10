import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatModelRequest, llm } from '../../packages/api-llm/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import serper, { webSearch } from '../../packages/plugin-websearch-serper/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 搜索请求接中止信号，与 15 秒超时谁先到按谁停：web_search、search_images 接这次工具调用的（回合中止时停下），web-search
// 服务的契约不带信号，接本插件这次激活的（停用、停机时停下）。中止时以中止原因拒绝，不记「搜索失败」。web_search 开着压缩时，
// 压缩结果的模型调用同样接这次调用的信号，中止时不按「压缩失败」退回原始结果。搜索接口与压缩模型是替身：卡住的那一步只在
// 收到中止时拒绝，记下每次请求收到的信号。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;

/**
 * 启动搜索插件；errors 收 warn 以上的日志。compress 为假时搜索接口一直不回、中止时以中止原因拒绝；为真时搜索照常回一条结果，
 * 开着压缩，压缩模型一直不回、中止时以中止原因拒绝（chats 记下它收到的请求）
 */
async function boot(compress = false) {
  const sent: AbortSignal[] = [];
  const untilAborted = (signal: AbortSignal | undefined) =>
    new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push(init.signal as AbortSignal);
      if (compress)
        return Response.json({ organic: [{ title: '<标题>', link: 'https://example.com', snippet: '<摘要>' }] });
      return untilAborted(init.signal as AbortSignal);
    }),
  );
  const chats: ChatModelRequest[] = [];
  const hub = new LogHub();
  const errors: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn' || entry.level === 'error') errors.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, webSearch });
  const handlers = new Map<string, Handler>();
  host.provide.use(tools, {
    register(tool: { definition: { function: { name: string } }; handler: Handler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  if (compress) {
    const chat = (request: ChatModelRequest) => {
      chats.push(request);
      return untilAborted(request.signal);
    };
    host.provide.use(llm, { id: 'chat', contextLength: 8192, capabilities: ['chat'], chat } as never);
  }
  await app.plugin(serper, { apiKey: '<密钥>', enableCompression: compress });
  await app.plugins.idle();
  if (!host.webSearch.present) throw new Error('搜索插件没有激活');
  return {
    sent,
    chats,
    errors,
    service: host.webSearch.use,
    call: (name: string, signal: AbortSignal) =>
      handlers.get(name)!({ query: '<关键词>' }, { ...toolContext({ sessionId: 's' }), signal }),
    disable: () => app.plugins.disable(serper.name),
  };
}

describe('Serper 搜索随中止停下', () => {
  it.each([
    'web_search',
    'search_images',
  ])('%s 请求途中中止：交给 fetch 的信号随之断开，以中止原因拒绝、不记失败', async name => {
    const t = await boot();
    const ac = new AbortController();
    const pending = t.call(name, ac.signal);
    await expect.poll(() => t.sent.length).toBe(1);
    ac.abort();
    expect(t.sent[0].aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.errors).toEqual([]);
  });

  it('web_search 压缩结果途中中止：交给压缩模型的信号随之断开，以中止原因拒绝、不按压缩失败退回原始结果', async () => {
    const t = await boot(true);
    const ac = new AbortController();
    const pending = t.call('web_search', ac.signal);
    await expect.poll(() => t.chats.length).toBe(1);
    ac.abort();
    expect(t.chats[0].signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.errors).toEqual([]);
  });

  it('web-search 服务的搜索途中停用：交给 fetch 的信号随之断开，以中止原因拒绝', async () => {
    const t = await boot();
    const pending = t.service.search({ query: '<关键词>' });
    const settled = pending.then(
      () => undefined,
      (err: unknown) => err,
    );
    await expect.poll(() => t.sent.length).toBe(1);
    await t.disable();
    expect(t.sent[0].aborted).toBe(true);
    expect(await settled).toMatchObject({ name: 'AbortError' });
  });
});
