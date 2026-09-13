import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckResult, CheckSpec, DoctorReport, DoctorService } from '../../packages/api-doctor/src/index.js';
import type { EmbeddingService } from '../../packages/api-embedding/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 「服务注册成功 != 模型可用」：连通性检查失败只 warn、服务照常注册（刻意，Ollama 可能
// 晚于 Aalis 起来）。代价是模型没 pull 时——/status 只判服务存在性、插件状态是 active、
// 向量记忆每条消息静默失败——用户除了启动时一条 warn 之外拿不到任何信号。
// 现在健康状况经 doctor registerCheck 上报，且错误里带上 Ollama 的响应体
// （「模型没 pull」与「端点不存在」都是 404，只有响应体能区分）。
// ════════════════════════════════════════════════════════════

type Mode = 'ok' | 'modelMissing' | 'hang';

interface Fake {
  server: Server;
  baseUrl: string;
  mode: Mode;
  tags: string[];
}

async function startFake(mode: Mode, tags: string[] = ['nomic-embed-text']): Promise<Fake> {
  const state: Fake = { server: undefined as unknown as Server, baseUrl: '', mode, tags };
  const server = createServer((req, res) => {
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/tags') {
      return reply(200, { models: state.tags.map(name => ({ name })) });
    }
    if (req.url === '/api/embed' || req.url === '/api/embeddings') {
      // 收下请求但永不应答：模拟 Ollama 装大模型时连得上、不回包
      if (state.mode === 'hang') return;
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
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    const doctor = makeDoctor();
    app.ctx.provide('doctor', doctor);
    await app.ctx.useModule(embeddingOllama as never, {
      baseUrl: fake.baseUrl,
      model,
      timeoutMs: 2000,
      retries: 0,
      ...over,
    });
    return { app, doctor };
  }

  it('模型没 pull：doctor 报 error，detail 带上 Ollama 的原话', async () => {
    const fake = await startFake('modelMissing');
    servers.push(fake.server);
    const { doctor, app } = await boot(fake);

    const spec = doctor.specs.get('embedding.ollama');
    expect(spec, '插件应注册一条自我诊断检查项').toBeDefined();

    const r = (await spec!.run(app.ctx)) as CheckResult;
    expect(r.level).toBe('error');
    expect(r.message).toContain('不可用');
    expect(r.detail, '只报 404 会把人引向端点/网络方向；要带上「模型没 pull」这句原话').toContain(
      'try pulling it first',
    );
  });

  it('模型可用：doctor 报 ok', async () => {
    const fake = await startFake('ok');
    servers.push(fake.server);
    const { doctor, app } = await boot(fake);

    const r = (await doctor.specs.get('embedding.ollama')!.run(app.ctx)) as CheckResult;
    expect(r.level).toBe('ok');
  });

  // 政策守卫，不是本批修复的回归钉子：连通性失败只 warn、服务照常注册是刻意设计
  // （Ollama 可能晚于 Aalis 起来），这条用来防止有人把它改成 fail-closed。
  it('政策守卫：连通性失败不阻塞服务注册', async () => {
    const fake = await startFake('modelMissing');
    servers.push(fake.server);
    const { app } = await boot(fake);
    expect(app.ctx.getService<EmbeddingService>('embedding')).toBeDefined();
  });

  it(
    'Ollama 无响应时探测自带上限，不把 /doctor 拖到服务超时',
    async () => {
      // 先以正常模式起实例：apply() 的启动连通性检查同样会等满 timeoutMs，
      // 若一开始就挂起，用例超时先到，根本走不到 doctor 探测这一步。
      const fake = await startFake('ok');
      servers.push(fake.server);
      // 服务自身超时（30s）远大于探测上限（5s），于是「按时返回」只可能来自探测的 race
      const { doctor, app } = await boot(fake, 'nomic-embed-text', { timeoutMs: 30_000, retries: 0 });
      fake.mode = 'hang'; // 实例已就绪，此刻让 Ollama 不再应答

      const t0 = Date.now();
      const r = (await doctor.specs.get('embedding.ollama')!.run(app.ctx)) as CheckResult;
      const elapsed = Date.now() - t0;

      expect(r.level).toBe('error');
      expect(r.detail, '必须由探测自己的上限掐断，而不是等服务超时').toContain('探测超时');
      expect(elapsed, `应在 5s 上限附近返回，实际 ${elapsed}ms`).toBeLessThan(15_000);
    },
    { timeout: 25_000 },
  );

  // 特征化用例（非回归钉子）：按名筛 embedding 已判否——混合场景会把 bge-m3 这类
  // 合法嵌入模型从下拉里剔掉，而 select 没有自由输入。这条钉住「不筛」这个决定。
  it('listModels 原样返回本机全部模型，不按名字筛', async () => {
    const fake = await startFake('ok', ['gemma4:12b', 'qwen3-embedding:8b', 'bge-m3:latest']);
    servers.push(fake.server);
    const { app } = await boot(fake);
    const svc = app.ctx.getService<EmbeddingService & { listModels(): Promise<string[]> }>('embedding');
    expect(await svc!.listModels(), '名字不含 embed 的合法嵌入模型也必须留在候选里').toEqual([
      'gemma4:12b',
      'qwen3-embedding:8b',
      'bge-m3:latest',
    ]);
  });
});
