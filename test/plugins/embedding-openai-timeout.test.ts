import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingService } from '../../packages/api-embedding/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as embeddingOpenai from '../../packages/plugin-embedding-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// embed()/listModels() 原先两处 fetch 都不带 signal、构造函数也不接超时参数：请求永不
// 自行了结。apply 的启动探测 await 它，而插件激活是串行的（PluginManager.recompute 逐个
// await activatePlugin），一个卡住的 apply 会把整条引导链钉住；索引路径上则是
// memory-vector 的一个并发槽被无限期占用。
// ════════════════════════════════════════════════════════════

async function startStalling(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_req, res) => {
    // 收下请求，永不应答
    void res;
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

interface ControlledFake {
  server: Server;
  baseUrl: string;
  mode: 'ok' | 'hang';
  requests: number;
  aborted: number;
}

async function startControlled(): Promise<ControlledFake> {
  const fake: ControlledFake = {
    server: undefined as unknown as Server,
    baseUrl: '',
    mode: 'ok',
    requests: 0,
    aborted: 0,
  };
  const server = createServer((_req, res) => {
    fake.requests++;
    res.on('close', () => {
      if (!res.writableEnded) fake.aborted++;
    });
    if (fake.mode === 'hang') return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.server = server;
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

describe('plugin-embedding-openai: 请求自带超时', () => {
  const apps: App[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    try {
      for (const a of apps.splice(0)) {
        try {
          await a.stop();
        } catch {
          /* 停不掉也要继续 */
        }
      }
    } finally {
      for (const s of servers.splice(0)) {
        s.closeAllConnections?.();
        await new Promise<void>(r => s.close(() => r()));
      }
    }
  });

  it(
    '对端不应答时 apply 不会把激活链钉住，embed 按 timeoutMs 失败',
    async () => {
      const fake = await startStalling();
      servers.push(fake.server);

      const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
      apps.push(app);

      const t0 = Date.now();
      await app.ctx.useModule(embeddingOpenai as never, {
        apiKey: 'sk-test-placeholder',
        baseUrl: fake.baseUrl,
        model: 'text-embedding-3-small',
        timeoutMs: 1000,
      });
      const applyElapsed = Date.now() - t0;

      expect(applyElapsed, `apply 应被 timeoutMs 掐断，实际 ${applyElapsed}ms`).toBeLessThan(15_000);
      expect(app.ctx.getService<EmbeddingService>('embedding'), '连通性失败不阻塞注册').toBeDefined();

      const t1 = Date.now();
      await expect(app.ctx.getService<EmbeddingService>('embedding')!.embed('x')).rejects.toThrow();
      const embedElapsed = Date.now() - t1;
      expect(embedElapsed, `embed 应按 timeoutMs 失败，实际 ${embedElapsed}ms`).toBeLessThan(15_000);
    },
    { timeout: 40_000 },
  );

  it('调用方 signal 会关闭在飞请求，且同一实例随后仍能正常 embed', async () => {
    const fake = await startControlled();
    servers.push(fake.server);
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    await app.ctx.useModule(embeddingOpenai as never, {
      apiKey: 'sk-test-placeholder',
      baseUrl: fake.baseUrl,
      model: 'text-embedding-3-small',
      timeoutMs: 30_000,
    });
    const svc = app.ctx.getService<EmbeddingService>('embedding')!;

    fake.mode = 'hang';
    fake.requests = 0;
    fake.aborted = 0;
    const controller = new AbortController();
    const pending = svc.embed('cancel this request', { signal: controller.signal });
    await waitFor(() => fake.requests === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => fake.aborted > 0);

    fake.mode = 'ok';
    await expect(svc.embed('normal request after abort')).resolves.toEqual([0.1, 0.2]);
    expect(fake.requests).toBe(2);
  });
});
