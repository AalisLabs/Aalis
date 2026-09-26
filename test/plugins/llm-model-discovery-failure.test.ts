import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub, type PluginDefinition, services } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 模型发现失败（不可达、非 2xx）不等于「远端没有模型」：
// - 启动时按未发现远端模型继续（customModels 照常注册），但要记 warn 并带上真实原因。fetch 网络失败的消息
//   固定是「fetch failed」，原因（拒绝连接、DNS、TLS）在 cause 上，只拼 message 就丢了。
// - WebUI 触发的刷新要报错并保留已注册条目。按空列表处理会把自动发现的条目全部注销，路由还回成功。
//
// fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

type Mode = 'ok' | 'http500' | 'refused' | 'refusedBoth';

/**
 * 发现端点按 mode 应答；Ollama 能力探测始终答最小可用体。refused 仿 undici 网络失败：消息固定、原因在 cause。
 * refusedBoth 仿连 localhost 时两个地址族都被拒：cause 是消息为空的 AggregateError，原因在子错误上
 */
function stubFetch(mode: Mode): { mode: Mode } {
  const state = { mode };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
      if (state.mode === 'refused')
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
      if (state.mode === 'refusedBoth')
        throw new TypeError('fetch failed', {
          cause: new AggregateError([
            new Error('connect ECONNREFUSED ::1:9'),
            new Error('connect ECONNREFUSED 127.0.0.1:9'),
          ]),
        });
      if (state.mode === 'http500') return new Response('upstream down', { status: 500 });
      return Response.json(u.endsWith('/api/tags') ? { models: [{ name: 'qwen3:8b' }] } : { data: [{ id: 'gpt-4o' }] });
    }),
  );
  return state;
}

function world() {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  const modelIds = (): string[] =>
    app
      .bind({ services })
      .services.all(llm)
      .map(e => e.instance.id);
  return { app, warns, modelIds };
}

const OLLAMA = { baseUrl: 'http://127.0.0.1:11434' };
const GATEWAY = { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' };
const FAILURES = [
  { mode: 'http500' as const, reason: 'HTTP 500' },
  { mode: 'refused' as const, reason: 'ECONNREFUSED' },
  { mode: 'refusedBoth' as const, reason: 'ECONNREFUSED ::1' },
];

const startupCases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown> }> = [
  { name: 'llm-ollama', plugin: llmOllama, config: { ...OLLAMA, customModels: 'mine' } },
  { name: 'llm-openai', plugin: llmOpenai, config: { ...GATEWAY, customModels: 'mine' } },
  { name: 'llm-deepseek', plugin: deepseek, config: { ...GATEWAY, customModels: 'mine' } },
];

describe('启动时模型发现失败：记 warn 并带上原因，customModels 照常注册', () => {
  it.each(startupCases.flatMap(c => FAILURES.map(f => ({ ...c, ...f }))))('$name / $mode', async ({
    plugin,
    config,
    mode,
    reason,
  }) => {
    stubFetch(mode);
    const { app, warns, modelIds } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('active');
    // 原因只出现一次：消息里内联过的 cause 不再由 logger 按因果链渲染一遍
    expect(
      warns.join('\n').split(reason).length - 1,
      `发现失败没有记下原因，或原因重复记了多遍，warn: ${JSON.stringify(warns)}`,
    ).toBe(1);
    expect(modelIds()).toEqual(['mine']);
  });
});

const refreshCases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown> }> = [
  { name: 'llm-ollama', plugin: llmOllama, config: OLLAMA },
  { name: 'llm-openai', plugin: llmOpenai, config: GATEWAY },
];

describe('刷新时模型发现失败：报错并带上原因，已注册条目保留', () => {
  it.each(refreshCases.flatMap(c => FAILURES.map(f => ({ ...c, ...f }))))('$name / $mode', async ({
    plugin,
    config,
    mode,
    reason,
  }) => {
    const state = stubFetch('ok');
    const { app, modelIds } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();
    const before = modelIds();
    expect(before, '前置：启动时发现了模型').toHaveLength(1);
    const [entry] = app.bind({ services }).services.all(llm);
    if (!entry?.instance.refresh) throw new Error(`${plugin.name} 未登记可刷新的条目`);

    state.mode = mode;
    await expect(entry.instance.refresh()).rejects.toThrow(reason);
    expect(modelIds(), '发现失败被当成远端没有模型，自动发现的条目被注销').toEqual(before);
  });
});
