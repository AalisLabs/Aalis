import { afterEach, describe, expect, it, vi } from 'vitest';
import { asr } from '../../packages/api-asr/src/index.js';
import { App } from '../../packages/core/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// transcribe 的 fetch 此前不带 signal。调用方（plugin-media）与工具执行面都没有外层超时：
// 对端不应答即整轮语音回合永久挂住——与已修的 embedding-openai / whisper-cpp 同形状。
// 两条用例：卡死的对端在 timeoutMs 内被掐断；正常对端照常返回（防「把挂死换成功能坏」）。
// ════════════════════════════════════════════════════════════

/** 只有收到 abort 才拒绝；没有 signal 就永远挂着——正是要抓的形状 */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
}

const AUDIO = { kind: 'audio', data: 'data:audio/wav;base64,AAAA' } as const;

describe('plugin-asr-openai: 请求必须带超时', () => {
  const apps: App[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const a of apps.splice(0)) await a.stop().catch(() => {});
  });

  /** 装载插件并捞出它 provide 的 asr 服务；激活闸会把没激活的插件静静留在 pending，故先核状态 */
  async function bootOpenai(config: Record<string, unknown>): Promise<App> {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugin(asrOpenai, config);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(asrOpenai.name)?.state, '插件必须真的激活').toBe('active');
    return app;
  }

  it('对端不应答时在 timeoutMs 内被掐断，而不是永久挂住', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    // 实现有 1000ms 地板（与 embedding-openai 同），故取 1000
    const app = await bootOpenai({ apiKey: 'k', timeoutMs: 1000 });
    const service = app.bind({ asr }).asr.current;
    expect(service).toBeDefined();

    const outcome = await Promise.race([
      service!.transcribe({ attachment: AUDIO }).then(
        () => 'resolved',
        (e: Error) => `rejected:${e.name}`,
      ),
      new Promise<string>(r => setTimeout(() => r('still-hanging'), 2500)),
    ]);
    expect(outcome, '没有 signal 就会一直挂着；有则在超时时以 TimeoutError 拒绝').toBe('rejected:TimeoutError');
  });

  it('正常对端照常返回', async () => {
    vi.stubGlobal(
      'fetch',
      (async () => new Response(JSON.stringify({ text: '你好' }), { status: 200 })) as unknown as typeof fetch,
    );
    const app = await bootOpenai({ apiKey: 'k' });
    const r = await app.bind({ asr }).asr.require().transcribe({ attachment: AUDIO });
    expect(r.text).toBe('你好');
  });
});
