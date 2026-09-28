import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import whisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';
import embeddingOpenai from '../../packages/plugin-embedding-openai/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';
import maimai from '../../packages/plugin-maimai/src/index.js';
import okx from '../../packages/plugin-okx-trading/src/index.js';
import browser from '../../packages/plugin-tool-browser/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import serper from '../../packages/plugin-websearch-serper/src/index.js';

// 实际走 App 激活路径；fetch 与进程服务均由替身接管，不连接外部服务。
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

async function activate(plugin: PluginDefinition, config: Record<string, unknown>, withProcess = false) {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      requests.push(String(url));
      return Response.json({ data: [{ id: 'm' }], embeddings: [[1]], choices: [] });
    }),
  );
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const registry = new ToolRegistry(app.logger);
  const registerTool = vi.spyOn(registry, 'register');
  const registerGroup = vi.spyOn(registry, 'registerGroup');
  app.bind({ provide }).provide(tools, registry);
  const processes: string[] = [];
  if (withProcess) {
    const host = app.bind({ provide });
    host.provide(processService, {
      execFile: async (command: string) => {
        processes.push(command);
        return { stdout: '', stderr: '', code: 0 };
      },
      makeTempDir: async () => ({ path: '/tmp/test', uri: 'tmp:/test', cleanup: async () => {} }),
      spawn: () => {
        throw new Error('unexpected spawn');
      },
      readExternalFile: async () => new Uint8Array(),
    } as never);
    host.provide(storage, { readFile: async () => new Uint8Array(), writeFile: async () => {} } as never);
  }
  await app.plugin(plugin, config);
  await app.plugins.idle();
  return { app, requests, processes, registry, registerTool, registerGroup };
}

describe('批 A：关键配置在副作用前拒绝', () => {
  it.each([
    {
      plugin: deepseek,
      config: { apiKey: 'secret', baseUrl: {}, discoverModels: false, customModels: 'm' },
      field: 'baseUrl',
    },
    { plugin: ollama, config: { baseUrl: [], discoverModels: false, customModels: 'm' }, field: 'baseUrl' },
    { plugin: embeddingOpenai, config: { apiKey: 'secret', baseUrl: {} }, field: 'baseUrl' },
    { plugin: embeddingOllama, config: { baseUrl: {} }, field: 'baseUrl' },
    { plugin: asrOpenai, config: { apiKey: 'secret', baseUrl: 'bad-url' }, field: 'baseUrl' },
    { plugin: serper, config: { apiKey: {} }, field: 'apiKey' },
    { plugin: maimai, config: { developerToken: 'secret', baseUrl: [] }, field: 'baseUrl' },
    { plugin: okx, config: { apiKey: 'k', secretKey: 's', passphrase: 'p', baseUrl: [] }, field: 'baseUrl' },
    { plugin: browser, config: { allowedHosts: ['localhost', {}] }, field: 'allowedHosts' },
  ])('$plugin.name：无效 $field 不发请求', async ({ plugin, config, field }) => {
    const { app, requests } = await activate(plugin, config);
    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(plugin.name)?.error).toContain(field);
    expect(requests).toEqual([]);
  });

  it('whisper 进程参数无效时不调用进程服务', async () => {
    const { app, requests, processes } = await activate(whisper, { modelPath: '/model.bin', threads: 'bad' }, true);
    expect(app.plugins.getPlugin(whisper.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(whisper.name)?.error).toContain('threads');
    expect(requests).toEqual([]);
    expect(processes).toEqual([]);
  });

  it('OKX 实盘安全开关类型错误时不登记工具', async () => {
    const { app, requests, registry, registerTool, registerGroup } = await activate(okx, {
      apiKey: 'k',
      secretKey: 's',
      passphrase: 'p',
      demo: false,
      confirmRealMoney: 'true',
    });
    expect(app.plugins.getPlugin(okx.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(okx.name)?.error).toContain('confirmRealMoney');
    expect(requests).toEqual([]);
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
    expect(registry.getAll()).toEqual([]);
    expect(registry.getGroups()).toEqual([]);
  });

  it('OKX 合法实盘安全开关会登记工具，注册表对照可观察', async () => {
    const { app, registry } = await activate(okx, {
      apiKey: 'k',
      secretKey: 's',
      passphrase: 'p',
      demo: false,
      confirmRealMoney: true,
    });
    expect(app.plugins.getPlugin(okx.name)?.state).toBe('active');
    expect(registry.getGroups().map(group => group.name)).toContain('okx');
    expect(registry.getAll().some(tool => tool.name.startsWith('okx_'))).toBe(true);
  });

  it('DeepSeek 自定义地址与有限数字密钥保持目标地址', async () => {
    const { app, requests } = await activate(deepseek, { apiKey: 12345, baseUrl: 'https://gateway.invalid/v1' });
    expect(app.plugins.getPlugin(deepseek.name)?.state).toBe('active');
    expect(requests).toEqual(['https://gateway.invalid/v1/models']);
  });

  it('Embedding OpenAI 缺省地址仍使用官方端点', async () => {
    const { app, requests } = await activate(embeddingOpenai, { apiKey: 'key' });
    expect(app.plugins.getPlugin(embeddingOpenai.name)?.state).toBe('active');
    expect(requests).toEqual(['https://api.openai.com/v1/embeddings']);
  });

  it('缺省 maimai token 与 OKX 凭证继续降级为 active', async () => {
    const maimaiStarted = await activate(maimai, {});
    const okxStarted = await activate(okx, {});
    expect(maimaiStarted.app.plugins.getPlugin(maimai.name)?.state).toBe('active');
    expect(okxStarted.app.plugins.getPlugin(okx.name)?.state).toBe('active');
    expect(maimaiStarted.requests).toEqual([]);
    expect(okxStarted.requests).toEqual([]);
  });
});
