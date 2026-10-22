import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';
import openai from '../../packages/plugin-llm-openai/src/index.js';
import media from '../../packages/plugin-media/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// maxTokens 须为正整数：三家模型插件的 maxTokens，以及 plugin-media 交给识别模型的 vision.maxTokens、audio.maxTokens。
// 0 或负数在 Ollama 那里是不封顶（按停顿计的超时截不住一直在输出的生成），另两家原样发给端点；小数会被端点以参数错误拒收。
// 填了这样的值（以及不是数的值），实例按配置校验失败进 error 态并点名 maxTokens，不回落默认值悄悄跑下去。
// fetch 用替身，不发真实请求；plugin-media 要的进程与存储服务给空替身（激活时不用）。
// ════════════════════════════════════════════════════════════

const CASES: Array<[string, PluginDefinition, (maxTokens: number) => Record<string, unknown>]> = [
  [
    'llm-openai',
    openai,
    maxTokens => ({
      apiKey: 'k',
      baseUrl: 'https://gw.invalid/v1',
      discoverModels: false,
      customModels: 'm',
      maxTokens,
    }),
  ],
  [
    'llm-deepseek',
    deepseek,
    maxTokens => ({ apiKey: 'k', baseUrl: 'https://gw.invalid', discoverModels: false, customModels: 'm', maxTokens }),
  ],
  [
    'llm-ollama',
    ollama,
    maxTokens => ({ baseUrl: 'http://gw.invalid', discoverModels: false, customModels: 'm', maxTokens }),
  ],
  ['media 的 vision', media, maxTokens => ({ vision: { maxTokens } })],
  ['media 的 audio', media, maxTokens => ({ audio: { maxTokens } })],
];

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

async function start(plugin: PluginDefinition, config: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({})),
  );
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  host.provide.use(processService, {} as never);
  host.provide.use(storage, {} as never);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  return app.plugins.getPlugin(plugin.name);
}

describe('maxTokens 须为正整数', () => {
  it.each(CASES)('%s 填 0 或 1.5：实例进 error 态并点名 maxTokens', async (_name, plugin, config) => {
    for (const maxTokens of [0, 1.5]) {
      const state = await start(plugin, config(maxTokens));
      expect(state?.state, `maxTokens=${maxTokens}`).toBe('error');
      expect(state?.error).toContain('maxTokens');
    }
  });

  it.each(CASES)('%s 填 1 照常激活', async (_name, plugin, config) => {
    const state = await start(plugin, config(1));
    expect(state?.state).toBe('active');
  });
});
