import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import type {} from '../../packages/api-webui/src/index.js';
import { App, type PluginDefinition } from '../../packages/core/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';
import embeddingOpenai from '../../packages/plugin-embedding-openai/src/index.js';
import type { ConfigSchema, SchemaField } from '../../packages/schema-config/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 两个向量化提供者各经贡献点 webui:options 交自己的可选项来源，配置里「Embedding 模型」的下拉指向它：来源只列本实例连着的
// 那一家的模型。两家都装时各自的下拉只列自己的模型，不按服务名把别家的混进来。插件在 baseUrl 后面拼路径，带查询串或片段的
// baseUrl 读配置时就报错，不发请求。
// ════════════════════════════════════════════════════════════

/** 本地假服务：Ollama 的 /api/tags 与 OpenAI 的 /models 各答一份模型名，嵌入请求一律答一个向量 */
async function fakeServer(models: { ollama?: string[]; openai?: string[] }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/tags')
      return res.end(JSON.stringify({ models: (models.ollama ?? []).map(name => ({ name })) }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: (models.openai ?? []).map(id => ({ id })) }));
    if (req.url === '/api/embed') return res.end(JSON.stringify({ embeddings: [[0.1]] }));
    res.end(JSON.stringify({ data: [{ embedding: [0.1] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const apps: App[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const modelField = (plugin: PluginDefinition) => (plugin.configSchema as ConfigSchema).model as SchemaField;

describe('向量化提供者的模型下拉', () => {
  it('两家都装：各自的模型字段指向自己的来源，来源只列本实例那一家的模型', async () => {
    const ollama = await fakeServer({ ollama: ['zz-ollama-a', 'zz-ollama-b'] });
    const openai = await fakeServer({ openai: ['zz-openai-a'] });
    servers.push(ollama.server, openai.server);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugins.register(embeddingOllama, { baseUrl: ollama.url, model: 'zz-ollama-a', retries: 0 });
    await app.plugins.register(embeddingOpenai, {
      apiKey: 'zz-placeholder-key',
      baseUrl: `${openai.url}/v1`,
      model: 'zz-openai-a',
    });
    await app.plugins.idle();

    expect(modelField(embeddingOllama).dynamicOptions).toBe('embedding-ollama');
    expect(modelField(embeddingOpenai).dynamicOptions).toBe('embedding-openai');
    const sources = app.bind({ contributions }).contributions.use.collect('webui:options');
    const list = async (id: string) => {
      const source = sources.find(({ spec }) => spec.id === id);
      if (!source) throw new Error(`没有来源 ${id}`);
      return (await source.spec.list()).map(({ value, label }) => ({ value, label }));
    };
    expect(await list('embedding-ollama')).toEqual([
      { value: 'zz-ollama-a', label: 'zz-ollama-a' },
      { value: 'zz-ollama-b', label: 'zz-ollama-b' },
    ]);
    expect(await list('embedding-openai')).toEqual([{ value: 'zz-openai-a', label: 'zz-openai-a' }]);
  });
});

describe('向量化提供者的 baseUrl 带查询串或片段：读配置时报错，不发请求', () => {
  const plugins = [
    { name: 'embedding-openai', plugin: embeddingOpenai, extra: { apiKey: 'zz-placeholder-key' } },
    { name: 'embedding-ollama', plugin: embeddingOllama, extra: { retries: 0 } },
  ];
  // 按原文判：末尾单个问号与片段解析后查询串为空，拼出来的地址照样是坏的
  const forms = [
    { form: '带查询串', baseUrl: 'https://example.test/v1?key=zz-placeholder-secret' },
    { form: '末尾单个问号', baseUrl: 'https://example.test/v1?' },
    { form: '带片段', baseUrl: 'https://example.test/v1#frag' },
  ];
  it.each(plugins.flatMap(p => forms.map(f => ({ ...p, ...f }))))('$name / $form', async ({
    plugin,
    extra,
    baseUrl,
  }) => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        requested.push(String(url));
        return Response.json({ data: [{ embedding: [0.1] }], embeddings: [[0.1]] });
      }),
    );
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugins.register(plugin, { ...extra, baseUrl });
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(plugin.name);
    expect(instance?.state).toBe('error');
    expect(instance?.error).toContain('baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径');
    expect(requested, '不该发出请求').toEqual([]);
  });
});
