import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { App, type PluginDefinition, services } from '../../packages/core/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';
import embeddingOpenai from '../../packages/plugin-embedding-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// EmbeddingService.modelId 是向量空间标识：消费方（user-relation）把它并入向量
// 失效键，换模型后据此重算旧向量。两个第一方提供者都按配置的 model 声明它。
// ════════════════════════════════════════════════════════════

/** 对任何路径都答一条合法向量（同时满足 Ollama /api/embed 与 OpenAI /embeddings 的形状） */
async function startFake(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embeddings: [[0.1, 0.2]], data: [{ embedding: [0.1, 0.2] }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('embedding 提供者声明 modelId', () => {
  const apps: App[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.stop();
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function modelIdOf(plugin: PluginDefinition, config: Record<string, unknown>): Promise<string | undefined> {
    const fake = await startFake();
    servers.push(fake.server);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugins.register(plugin, { ...config, baseUrl: fake.baseUrl });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(embedding);
    if (!svc) throw new Error('embedding 服务未就绪');
    return svc.modelId;
  }

  it('Ollama：ollama:<model>，随配置的 model 变化', async () => {
    expect(await modelIdOf(embeddingOllama, { model: 'nomic-embed-text' })).toBe('ollama:nomic-embed-text');
    expect(await modelIdOf(embeddingOllama, { model: 'qwen3-embedding:8b' })).toBe('ollama:qwen3-embedding:8b');
  });

  it('OpenAI：openai:<model>，随配置的 model 变化', async () => {
    const base = { apiKey: 'sk-test-placeholder' };
    expect(await modelIdOf(embeddingOpenai, { ...base, model: 'text-embedding-3-small' })).toBe(
      'openai:text-embedding-3-small',
    );
    expect(await modelIdOf(embeddingOpenai, { ...base, model: 'text-embedding-3-large' })).toBe(
      'openai:text-embedding-3-large',
    );
  });
});
