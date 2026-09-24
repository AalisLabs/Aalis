import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CheckResult,
  type CheckSpec,
  type DoctorReport,
  type DoctorService,
  doctor as doctorService,
} from '../../packages/api-doctor/src/index.js';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 「服务注册成功 != 模型可用」：连通性检查失败只 warn、服务照常注册（刻意，Ollama 可能
// 晚于 Aalis 起来）。代价是模型没 pull 时——/status 只判服务存在性、插件状态是 active、
// 向量记忆每条消息静默失败——用户除了启动时一条 warn 之外拿不到任何信号。
// 现在健康状况经 doctor registerCheck 上报，且错误里带上 Ollama 的响应体
// （「模型没 pull」与「端点不存在」都是 404，只有响应体能区分）。
// ════════════════════════════════════════════════════════════

type Mode = 'ok' | 'modelMissing' | 'hang' | 'stallBody' | 'tagsHang';

/** 本插件的 embedding 实现始终带 listModels，而契约里它是可选方法 */
type OllamaEmbedding = EmbeddingService & { listModels(): Promise<string[]> };

interface Fake {
  server: Server;
  baseUrl: string;
  mode: Mode;
  tags: string[];
  embeddingRequests: number;
  abortedEmbeddingRequests: number;
}

async function startFake(mode: Mode, tags: string[] = ['nomic-embed-text']): Promise<Fake> {
  const state: Fake = {
    server: undefined as unknown as Server,
    baseUrl: '',
    mode,
    tags,
    embeddingRequests: 0,
    abortedEmbeddingRequests: 0,
  };
  const server = createServer((req, res) => {
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/tags') {
      if (state.mode === 'tagsHang') return;
      return reply(200, { models: state.tags.map(name => ({ name })) });
    }
    if (req.url === '/api/embed' || req.url === '/api/embeddings') {
      state.embeddingRequests++;
      // `res.close` also fires after a normal end, so only count a connection closed
      // before the hanging response completed. This proves the caller cancellation
      // reaches the actual HTTP request rather than merely racing its Promise.
      res.on('close', () => {
        if (!res.writableEnded) state.abortedEmbeddingRequests++;
      });
      // 收下请求但永不应答：模拟 Ollama 装大模型时连得上、不回包
      if (state.mode === 'hang') return;
      // 头发完、体只发一半就停住：反代半死 / 模型正加载进显存
      if (state.mode === 'stallBody') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"embeddings":');
        return; // 永不 end
      }
      // Ollama 对「模型不存在」答的就是 404 + 这句话（实测）
      if (state.mode === 'modelMissing') {
        return reply(404, { error: 'model "nomic-embed-text" not found, try pulling it first' });
      }
      return reply(200, req.url === '/api/embed' ? { embeddings: [[0.1, 0.2]] } : { embedding: [0.1, 0.2] });
    }
    reply(404, { error: 'unknown endpoint' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  state.server = server;
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function makeDoctor(): DoctorService & { specs: Map<string, CheckSpec> } {
  const specs = new Map<string, CheckSpec>();
  const empty: DoctorReport = { generatedAt: '', summary: { ok: 0, warn: 0, error: 0 }, checks: [] };
  return {
    specs,
    runChecks: async () => empty,
    getLastReport: () => undefined,
    registerCheck(spec: CheckSpec) {
      specs.set(spec.id, spec);
      return () => {
        specs.delete(spec.id);
      };
    },
    listChecks: () => [...specs.values()].map(s => ({ id: s.id, category: s.category, pluginName: s.pluginName })),
  };
}

describe('plugin-embedding-ollama: 健康状况对用户可见', () => {
  const apps: App[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    try {
      for (const a of apps.splice(0)) {
        try {
          await a.stop();
        } catch {
          /* 停不掉也要继续停下一个 */
        }
      }
    } finally {
      for (const s of servers.splice(0)) {
        s.closeAllConnections?.(); // 挂起的探测连接会让 close 一直等，先掐断
        await new Promise<void>(r => s.close(() => r()));
      }
    }
  });

  async function boot(fake: Fake, model = 'nomic-embed-text', over: Record<string, unknown> = {}) {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const doctor = makeDoctor();
    const host = app.bind({ provide, services });
    host.provide(doctorService, doctor);
    await app.plugins.register(embeddingOllama, {
      baseUrl: fake.baseUrl,
      model,
      timeoutMs: 2000,
      retries: 0,
      ...over,
    });
    await app.plugins.idle();
    return { host, doctor };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  it('模型没 pull：doctor 报 error，detail 带上 Ollama 的原话', async () => {
    const fake = await startFake('modelMissing');
    servers.push(fake.server);
    const { doctor } = await boot(fake);

    const spec = doctor.specs.get('embedding.ollama');
    expect(spec, '插件应注册一条自我诊断检查项').toBeDefined();

    const r = (await spec!.run()) as CheckResult;
    expect(r.level).toBe('error');
    expect(r.message).toContain('不可用');
    expect(r.detail, '只报 404 会把人引向端点/网络方向；要带上「模型没 pull」这句原话').toContain(
      'try pulling it first',
    );
  });

  it('模型可用：doctor 报 ok', async () => {
    const fake = await startFake('ok');
    servers.push(fake.server);
    const { doctor } = await boot(fake);

    const r = (await doctor.specs.get('embedding.ollama')!.run()) as CheckResult;
    expect(r.level).toBe('ok');
  });

  // 政策守卫，不是本批修复的回归钉子：连通性失败只 warn、服务照常注册是刻意设计
  // （Ollama 可能晚于 Aalis 起来），这条用来防止有人把它改成 fail-closed。
  it('政策守卫：连通性失败不阻塞服务注册', async () => {
    const fake = await startFake('modelMissing');
    servers.push(fake.server);
    const { host } = await boot(fake);
    expect(host.services.get(embedding)).toBeDefined();
  });

  it(
    '发完响应头却不发体时，由配置的 timeoutMs 掐断，而不是等 undici 的 bodyTimeout',
    async () => {
      const fake = await startFake('ok');
      servers.push(fake.server);
      const { host } = await boot(fake, 'nomic-embed-text', { timeoutMs: 800, retries: 0 });
      fake.mode = 'stallBody';
      const svc = host.services.get(embedding);

      const t0 = Date.now();
      await expect(svc!.embed('你好'), '体读取若落在超时窗口之外就会一直挂着').rejects.toThrow();
      const elapsed = Date.now() - t0;
      expect(elapsed, `应在 timeoutMs(800ms) 附近失败，实际 ${elapsed}ms`).toBeLessThan(8_000);
    },
    { timeout: 20_000 },
  );

  it(
    'Ollama 无响应时探测自带上限，不把 /doctor 拖到服务超时',
    async () => {
      // 先以正常模式起实例：apply() 的启动连通性检查同样会等满 timeoutMs，
      // 若一开始就挂起，用例超时先到，根本走不到 doctor 探测这一步。
      const fake = await startFake('ok');
      servers.push(fake.server);
      // 服务自身超时（30s）远大于探测上限（5s），于是「按时返回」只可能来自探测的 race
      const { doctor } = await boot(fake, 'nomic-embed-text', { timeoutMs: 30_000, retries: 2 });
      fake.mode = 'hang'; // 实例已就绪，此刻让 Ollama 不再应答
      fake.embeddingRequests = 0;
      fake.abortedEmbeddingRequests = 0;

      const t0 = Date.now();
      const r = (await doctor.specs.get('embedding.ollama')!.run()) as CheckResult;
      const elapsed = Date.now() - t0;
      await waitFor(() => fake.abortedEmbeddingRequests > 0); // 等服务端真正观察到 close

      expect(r.level).toBe('error');
      expect(r.detail, '必须由探测自己的上限掐断，而不是等服务超时').toContain('探测超时');
      expect(elapsed, `应在 5s 上限附近返回，实际 ${elapsed}ms`).toBeLessThan(15_000);
      expect(fake.embeddingRequests, '外部中止不得触发 provider retry').toBe(1);
      expect(fake.abortedEmbeddingRequests, '探测超时必须关闭实际 HTTP embedding 请求').toBeGreaterThan(0);
    },
    { timeout: 25_000 },
  );

  it(
    '调用方取消会中止真实 embedding HTTP，且 retries 不会重发',
    async () => {
      const fake = await startFake('ok');
      servers.push(fake.server);
      const { host } = await boot(fake, 'nomic-embed-text', { timeoutMs: 30_000, retries: 1 });
      const svc = host.services.get(embedding)!;
      fake.mode = 'hang';
      fake.embeddingRequests = 0;
      fake.abortedEmbeddingRequests = 0;

      const controller = new AbortController();
      const t0 = Date.now();
      const pending = svc.embed('cancel this request', { signal: controller.signal });
      await waitFor(() => fake.embeddingRequests === 1); // 确保中止的是实际已发出的请求
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const elapsed = Date.now() - t0;
      await waitFor(() => fake.abortedEmbeddingRequests > 0);

      expect(elapsed, '调用方取消不得等到 provider 自身 30s timeout').toBeLessThan(1_000);
      expect(fake.embeddingRequests, '调用方取消不得进入 retry').toBe(1);
      expect(fake.abortedEmbeddingRequests).toBeGreaterThan(0);

      const preAborted = new AbortController();
      preAborted.abort();
      await expect(svc.embed('must not be sent', { signal: preAborted.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(fake.embeddingRequests, '预中止不得发送 HTTP 请求').toBe(1);
    },
    { timeout: 5_000 },
  );

  it(
    'provider 自身 timeout 仍按 retries 重试',
    async () => {
      const fake = await startFake('ok');
      servers.push(fake.server);
      const { host } = await boot(fake, 'nomic-embed-text', { timeoutMs: 1_000, retries: 1 });
      const svc = host.services.get(embedding)!;
      fake.mode = 'hang';
      fake.embeddingRequests = 0;

      await expect(svc.embed('provider timeout retry')).rejects.toThrow();
      expect(fake.embeddingRequests, '自身 timeout 与调用方取消不同，仍应按 retries 再试一次').toBe(2);
    },
    { timeout: 5_000 },
  );

  // 特征化用例（非回归钉子）：按名筛 embedding 已判否——混合场景会把 bge-m3 这类
  // 合法嵌入模型从下拉里剔掉，而 select 没有自由输入。这条钉住「不筛」这个决定。
  it('listModels 原样返回本机全部模型，不按名字筛', async () => {
    const fake = await startFake('ok', ['gemma4:12b', 'qwen3-embedding:8b', 'bge-m3:latest']);
    servers.push(fake.server);
    const { host } = await boot(fake);
    const svc = host.services.get(embedding) as OllamaEmbedding | undefined;
    expect(await svc!.listModels(), '名字不含 embed 的合法嵌入模型也必须留在候选里').toEqual([
      'gemma4:12b',
      'qwen3-embedding:8b',
      'bge-m3:latest',
    ]);
  });

  it(
    'listModels 的 /api/tags 无响应时在配置超时内返回空列表',
    async () => {
      // 先正常启动，避免 apply 的 embed 连通性探测占用本例的时间窗。
      const fake = await startFake('ok');
      servers.push(fake.server);
      const { host } = await boot(fake, 'nomic-embed-text', { timeoutMs: 1_000 });
      const svc = host.services.get(embedding) as OllamaEmbedding;
      fake.mode = 'tagsHang';

      const t0 = Date.now();
      await expect(svc.listModels()).resolves.toEqual([]);
      const elapsed = Date.now() - t0;
      expect(elapsed, '动态模型列表不能因挂起的 Ollama 请求无限等待').toBeLessThan(5_000);
    },
    { timeout: 10_000 },
  );
});
