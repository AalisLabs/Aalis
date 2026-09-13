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
});
