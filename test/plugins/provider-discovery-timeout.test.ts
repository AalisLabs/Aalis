import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';
import openai from '../../packages/plugin-llm-openai/src/index.js';
import serper from '../../packages/plugin-websearch-serper/src/index.js';

// ════════════════════════════════════════════════════════════
// 「接连接但不回包」的端点必须有 AbortSignal 兜底。
//
// 三个 provider 的模型发现都在 apply() 里被 await：没有超时，插件激活按拓扑序
// 串行停摆到 undici 的 headersTimeout（约 5 分钟）。serper 的 search_images 更糟——
// 挂起期间限流槽不释放，3 次就把图片搜索与网页搜索一起锁死。
//
// 这里守的是「请求带了 signal」这个不变量（数值本身不是契约，见各处注释）。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

/** 记录每次 fetch 的 URL 与 signal，响应按 URL 造最小可用体 */
function captureFetch(): { signalFor: (match: string) => AbortSignal | undefined } {
  const seen: Array<{ url: string; signal?: AbortSignal }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { signal?: AbortSignal }) => {
      const u = String(url);
      seen.push({ url: u, signal: init?.signal });
      const body = u.includes('/api/tags')
        ? { models: [{ name: 'qwen3:8b' }] }
        : u.includes('/models')
          ? { data: [{ id: 'gpt-4o' }] }
          : u.includes('/api/show')
            ? { capabilities: ['completion'] }
            : { images: [{ title: 't', imageUrl: 'https://x.invalid/a.png' }] };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
  return { signalFor: match => seen.find(s => s.url.includes(match))?.signal };
}

/**
 * 装一个插件并等激活落定。激活闸会把依赖不全的插件停在 pending 而不报错，
 * 那时插件压根没发请求——这里当场点名，免得后面的"没带 signal"把原因指错地方。
 */
async function load(app: App, plugin: PluginDefinition, config: Record<string, unknown>): Promise<void> {
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`${plugin.name} 未激活（state=${state}）`);
}

function expectLiveSignal(signal: AbortSignal | undefined, label: string): void {
  expect(signal, `${label} 未带 AbortSignal`).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted, `${label} 的 signal 不该一开始就 aborted`).toBe(false);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('模型发现请求带超时', () => {
  it('Ollama /api/tags', async () => {
    const cap = captureFetch();
    const app = new App({ name: 'T', logLevel: 'error' });
    await load(app, ollama, { baseUrl: 'http://127.0.0.1:11434' });
    expectLiveSignal(cap.signalFor('/api/tags'), 'Ollama /api/tags');
    await app.stop();
  });

  it('OpenAI /models', async () => {
    const cap = captureFetch();
    const app = new App({ name: 'T', logLevel: 'error' });
    await load(app, openai, { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' });
    expectLiveSignal(cap.signalFor('/models'), 'OpenAI /models');
    await app.stop();
  });

  it('DeepSeek /models', async () => {
    const cap = captureFetch();
    const app = new App({ name: 'T', logLevel: 'error' });
    await load(app, deepseek, { apiKey: 'k', baseUrl: 'https://gw.invalid' });
    expectLiveSignal(cap.signalFor('/models'), 'DeepSeek /models');
    await app.stop();
  });
});

describe('serper search_images 带超时（挂起时不占死限流槽）', () => {
  it('图片搜索请求带 signal', async () => {
    const cap = captureFetch();
    const app = new App({ name: 'T', logLevel: 'error' });
    const handlers: Record<string, Handler> = {};
    app.bind({ provide }).provide(tools, {
      register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
        handlers[t.definition.function.name] = t.handler;
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    await load(app, serper, { apiKey: 'k' });
    const out = JSON.parse((await handlers.search_images({ query: '猫' }, { sessionId: 's' })) as string);
    expect(out.error).toBeUndefined();
    expectLiveSignal(cap.signalFor('serper.dev/images'), 'serper /images');
    await app.stop();
  });
});
