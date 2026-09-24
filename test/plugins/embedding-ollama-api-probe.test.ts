import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 新旧 API 探测（真 HTTP 服务）：
//   apply 启动时会主动 embed('ping')。若此刻 Ollama 还没起来（网络错误/5xx），
//   旧逻辑 catch 不看错误类型就把结论钉成「旧版 /api/embeddings」且终身不复位
//   ——「Ollama 晚于 Aalis 起来」正好把它钉死在已弃用端点上。
//   现在只有明确的 404/405 才试旧端点，且要等旧端点真答上来才钉结论：模型没 pull
//   时新旧两个端点都答 404，否则同样会把实例终身钉在已弃用端点上。
// ════════════════════════════════════════════════════════════

interface Fake {
  server: Server;
  baseUrl: string;
  /** 收到的请求路径顺序 */
  paths: string[];
  /** /api/embed 的应答模式（bothMissing：新旧端点都 404，即模型没 pull） */
  mode: 'boom5xx' | 'ok' | 'missing' | 'bothMissing';
}

async function startFake(mode: Fake['mode']): Promise<Fake> {
  const state: Fake = { server: undefined as unknown as Server, baseUrl: '', paths: [], mode };
  const server = createServer((req, res) => {
    state.paths.push(req.url ?? '');
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/embed') {
      if (state.mode === 'boom5xx') return reply(503, { error: 'model loading' });
      if (state.mode === 'missing' || state.mode === 'bothMissing') return reply(404, { error: 'not found' });
      return reply(200, { embeddings: [[0.1, 0.2]] });
    }
    if (req.url === '/api/embeddings') {
      if (state.mode === 'bothMissing') return reply(404, { error: 'model not found' });
      return reply(200, { embedding: [0.9, 0.9] });
    }
    reply(404, { error: 'unknown' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  state.server = server;
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

describe('plugin-embedding-ollama: 新旧 API 探测', () => {
  const apps: App[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.stop();
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function load(baseUrl: string): Promise<EmbeddingService> {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugins.register(embeddingOllama, { baseUrl, model: 'm', timeoutMs: 2000, retries: 0 });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(embedding);
    if (!svc) throw new Error('embedding 服务未就绪');
    return svc;
  }

  it('启动探测撞上 5xx（Ollama 还没起来）：不钉死旧端点，恢复后仍走新版 /api/embed', async () => {
    const fake = await startFake('boom5xx');
    servers.push(fake.server);
    const svc = await load(fake.baseUrl); // apply 的 ping 会失败（只是 warn）

    expect(fake.paths, '瞬态失败不该回落到已弃用端点').not.toContain('/api/embeddings');

    fake.mode = 'ok'; // Ollama 起来了
    const vec = await svc.embed('你好');
    expect(vec).toEqual([0.1, 0.2]);
    expect(fake.paths.filter(p => p === '/api/embed').length, '应重探新版端点').toBeGreaterThanOrEqual(2);
    expect(fake.paths).not.toContain('/api/embeddings');
  });

  it('新端点明确 404：判定为旧版并回落 /api/embeddings', async () => {
    const fake = await startFake('missing');
    servers.push(fake.server);
    const svc = await load(fake.baseUrl);

    const vec = await svc.embed('你好');
    expect(vec).toEqual([0.9, 0.9]);
    expect(fake.paths).toContain('/api/embeddings');
  });

  it('两个端点都 404（模型没 pull）：不钉死旧端点，pull 之后仍走新版 /api/embed', async () => {
    const fake = await startFake('bothMissing');
    servers.push(fake.server);
    const svc = await load(fake.baseUrl); // apply 的 ping 两端点都 404（只是 warn）

    await expect(svc.embed('你好'), '旧端点也没答上来，结论不该钉死').rejects.toThrow();

    fake.mode = 'ok'; // 模型 pull 好了
    fake.paths.length = 0;
    const vec = await svc.embed('你好');
    expect(vec).toEqual([0.1, 0.2]);
    expect(fake.paths[0], 'useNewApi 应仍为 null，下次从新版端点重探').toBe('/api/embed');
    expect(fake.paths).not.toContain('/api/embeddings');
  });
});
