import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type PluginModule } from '../../packages/core/src/index.js';
import type { ChatRequest, ChatResponse, LLMService, ModelInfo } from '../../packages/plugin-llm-api/src/index.js';
import { LLMRouter } from '../../packages/plugin-llm-router/src/router.js';

/**
 * Bug D 回归测试：多 provider 同名 model + provider 已下线时的优雅降级。
 */

interface MockProviderOpts {
  contextId: string;
  models: ModelInfo[];
  capabilities?: string[];
  chatFn?: (req: ChatRequest) => Promise<ChatResponse>;
}

function makeProviderPlugin(opts: MockProviderOpts): PluginModule {
  const impl: Partial<LLMService> & { listModels(): Promise<ModelInfo[]>; getDefaultModelId(): string | undefined } = {
    chat: opts.chatFn ?? (async () => ({ content: 'ok' }) as ChatResponse),
    async *chatStream() {
      yield { type: 'text', content: 'ok' };
    },
    listModels: async () => opts.models,
    getDefaultModelId: () => opts.models[0]?.id,
    getTemperature: () => 0.7,
    getMaxTokens: () => 4096,
    getContextLength: () => 8192,
  };
  return {
    name: opts.contextId,
    provides: ['llm'],
    apply(ctx) {
      ctx.provide('llm', impl, { capabilities: opts.capabilities ?? ['chat', 'tool_calling', 'streaming'] });
    },
  };
}

function makeRouterApp(): { app: App; router: LLMRouter } {
  const app = new App({ config: { name: 'RouterTestApp', logLevel: 'error', plugins: {} } });
  const router = new LLMRouter(app.ctx, app.ctx.logger);
  return { app, router };
}

describe('LLMRouter Bug D 回归', () => {
  let env: ReturnType<typeof makeRouterApp>;
  beforeEach(() => {
    env = makeRouterApp();
  });

  it('多 provider 同名 model → 自动选第一个能力满足的 + warn 一次', async () => {
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'prov-a',
        models: [{ id: 'shared-model', capabilities: ['chat', 'streaming'] }],
        capabilities: ['chat', 'streaming'],
      }),
    );
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'prov-b',
        models: [{ id: 'shared-model', capabilities: ['chat', 'streaming'] }],
        capabilities: ['chat', 'streaming'],
      }),
    );

    const warnSpy = vi.spyOn(env.app.ctx.logger, 'warn');
    const res = await env.router.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'shared-model',
    });

    expect(res.content).toBe('ok');
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(msg).toContain('多个 provider');
    expect(msg).toContain('prov-a'); // 自动选第一个
  });

  it('多 provider 同名 model + 工具能力 → 优先选满足能力的 provider', async () => {
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'no-tools',
        models: [{ id: 'shared', capabilities: ['chat'] }],
        capabilities: ['chat'], // 没 tool_calling
      }),
    );
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'has-tools',
        models: [{ id: 'shared', capabilities: ['chat', 'tool_calling'] }],
        capabilities: ['chat', 'tool_calling'],
        chatFn: async () => ({ content: 'from-has-tools' }) as ChatResponse,
      }),
    );

    const res = await env.router.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'shared',
      tools: [{ name: 't', description: 'd', parameters: {} }],
    } as ChatRequest);

    expect(res.content).toBe('from-has-tools');
  });

  it('指定 provider 不存在但 model 在其他 provider 中 → 自动迁移 + warn', async () => {
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'still-here',
        models: [{ id: 'orphan-model', capabilities: ['chat'] }],
        capabilities: ['chat'],
        chatFn: async () => ({ content: 'recovered' }) as ChatResponse,
      }),
    );

    const warnSpy = vi.spyOn(env.app.ctx.logger, 'warn');
    const res = await env.router.chat({
      messages: [{ role: 'user', content: 'hi' }],
      provider: 'gone-provider',
      model: 'orphan-model',
    });

    expect(res.content).toBe('recovered');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('gone-provider'))).toBe(true);
  });

  it('指定 provider 不存在且 model 也找不到 → 抛错并提示 /model.reset', async () => {
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'only-prov',
        models: [{ id: 'only-model', capabilities: ['chat'] }],
        capabilities: ['chat'],
      }),
    );

    await expect(
      env.router.chat({
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'gone',
        model: 'gone-model',
      }),
    ).rejects.toThrow(/model\.reset/);
  });

  it('model 找不到任何 provider → 错误信息含可用 provider 列表 + /model.reset 提示', async () => {
    await env.app.plugin(
      makeProviderPlugin({
        contextId: 'real-prov',
        models: [{ id: 'real-model', capabilities: ['chat'] }],
        capabilities: ['chat'],
      }),
    );

    await expect(
      env.router.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'ghost-model',
      }),
    ).rejects.toThrow(/real-prov.*model\.reset|model\.reset.*real-prov/s);
  });
});
