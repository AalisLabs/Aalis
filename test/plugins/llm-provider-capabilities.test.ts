import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, type PluginDefinition } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import openai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// OpenAI 兼容 provider 的能力推断。
//
// - modelCapabilities 每行按最后一个冒号切分：兼容端点的模型 id 可能自带冒号
//   （Ollama /v1 的 qwen3:8b、OpenRouter 的 xxx:free）。按首个冒号切会把 id 截成
//   qwen3，这行覆盖对真正的 qwen3:8b 静默失效。ollama 插件早已按末位冒号切，
//   openai 与 deepseek 此前没跟上。
// - openai 家族表：常见视觉族要带 vision，media 的视觉路由与 auto 交付才认得它们；
//   gpt-4.1 不能被更短的 gpt-4 前缀抢先命中。
// ════════════════════════════════════════════════════════════

/** /models 返回给定 id 列表，其余请求不该发生 */
function stubModels(ids: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (!String(url).endsWith('/models')) throw new Error(`意外请求 ${url}`);
      return { ok: true, status: 200, json: async () => ({ data: ids.map(id => ({ id })) }) } as unknown as Response;
    }),
  );
}

/** 装载 provider，返回 modelId → capabilities */
async function capabilitiesOf(
  plugin: PluginDefinition,
  ids: string[],
  config: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  stubModels(ids);
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ llm });
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`${plugin.name} 未激活（state=${state}）`);
  const out = Object.fromEntries(host.llm.all().map(e => [e.instance.id, [...e.instance.capabilities]]));
  await app.stop();
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modelCapabilities 按最后一个冒号切分', () => {
  const override = { modelCapabilities: 'qwen3:8b: chat,vision' };

  it('openai：带冒号的模型 id 覆盖行生效', async () => {
    const caps = await capabilitiesOf(openai, ['qwen3:8b'], {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:11434/v1',
      ...override,
    });
    expect(caps['qwen3:8b']).toEqual(['chat', 'vision']);
  });

  it('deepseek：带冒号的模型 id 覆盖行生效', async () => {
    const caps = await capabilitiesOf(deepseek, ['qwen3:8b'], {
      apiKey: 'k',
      baseUrl: 'https://gw.invalid',
      ...override,
    });
    expect(caps['qwen3:8b']).toEqual(['chat', 'vision']);
  });
});

describe('openai 家族表的视觉族', () => {
  it('gpt-4.1 / gpt-5 / qwen-vl / glm-4v 各族带 vision；gpt-4 与 qwen 纯文本不带', async () => {
    const vision = [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-5',
      'gpt-5-mini',
      'qwen-vl-max',
      'qwen2.5-vl-72b-instruct',
      'qwen3-vl-plus',
      'glm-4v-plus',
      'glm-4.1v-thinking-flash',
      'glm-4.5v',
    ];
    const plain = ['gpt-4', 'gpt-4-0613', 'qwen-max', 'glm-4-plus'];
    const caps = await capabilitiesOf(openai, [...vision, ...plain], { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' });
    for (const id of vision) expect(caps[id], id).toContain('vision');
    for (const id of plain) expect(caps[id], id).not.toContain('vision');
  });
});
