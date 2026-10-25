import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatModelRequest, llm } from '../../packages/api-llm/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import serper from '../../packages/plugin-websearch-serper/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 网页搜索的结果压缩：输出上限只防失控，模型在上限处停下（模型插件报 finishReason 'length'）时，交给 agent 的结果末尾标出
// 截断，不重试。搜索接口与压缩模型都是替身
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

/** 起搜索插件（开压缩），压缩模型按 finishReason 回给定的正文；返回调一次 web_search 的函数与模型收到的请求 */
async function setup(finishReason: 'stop' | 'length') {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ organic: [{ title: '<标题>', link: 'https://example.com', snippet: '<摘要>' }] }),
        ),
    ),
  );
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  host.provide.use(tools, {
    register(tool: {
      definition: { function: { name: string } };
      handler: (args: Record<string, unknown>) => Promise<string>;
    }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  const requests: ChatModelRequest[] = [];
  const chat = async (request: ChatModelRequest) => {
    requests.push(request);
    return { content: '<压缩后的结果>', finishReason };
  };
  host.provide.use(llm, { id: 'chat', contextLength: 8192, capabilities: ['chat'], chat } as never);
  await app.plugin(serper, { apiKey: '<密钥>', enableCompression: true });
  await app.plugins.idle();
  return { search: () => handlers.get('web_search')!({ query: '<关键词>' }), requests };
}

describe('网页搜索的结果压缩：上限只防失控，截断处标出', () => {
  it('模型在上限处停下：结果末尾标出截断；请求的输出上限是 2048', async () => {
    const { search, requests } = await setup('length');
    expect(await search()).toBe('<压缩后的结果>（已在长度上限处截断）');
    expect(requests.map(r => r.maxTokens)).toEqual([2048]);
  });

  it('正常结束：结果原样，不带标记', async () => {
    const { search } = await setup('stop');
    expect(await search()).toBe('<压缩后的结果>');
  });
});
