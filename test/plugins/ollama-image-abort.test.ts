import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub } from '../../packages/core/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// 消息里的网址图片在发请求前下载成 base64：下载接这次模型调用的中止信号（ChatModelRequest.signal）与本插件这次激活的，与
// 30 秒超时谁先到按谁停；调用方中止的以中止原因拒绝，本插件停用的报中途停下，都不按「下载图片异常」告警、不当成图片取不到。图片网址指向本机一个只收不回的上游桩，
// 中止发生在下载途中，请求不会发到 Ollama。
// ════════════════════════════════════════════════════════════

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 本机只收不回的上游桩、装好的 Ollama 插件与它登记的模型；warns 收告警 */
async function boot() {
  const seen = { requested: false, closed: false };
  const upstream = createServer(req => {
    seen.requested = true;
    req.on('close', () => {
      seen.closed = true;
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；用完复原
  cleanups.push(async () => {
    setNetworkPolicy({ blockPrivate: true });
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });

  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  cleanups.push(() => app.stop());
  // 启动时的模型发现与能力探测答空，不连本机的 Ollama；装好之后换回真的 fetch，图片下载打到上游桩
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ models: [] })),
  );
  await app.plugin(ollama, { baseUrl: 'http://127.0.0.1:11434', customModels: 'testvision' });
  await app.plugins.idle();
  vi.unstubAllGlobals();
  const model = app.bind({ llm }).llm.list()[0]?.use;
  if (!model) throw new Error('未注册出模型');
  warns.length = 0;
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/a.png`;
  /** 带一张网址图片问一次；结果接住，落定为抛出的错误 */
  const ask = (signal?: AbortSignal) =>
    model
      .chat({ messages: [{ role: 'user', content: '描述这张图', images: [url] }], requireImages: true, signal })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
  return { seen, warns, ask, disable: () => app.plugins.disable(ollama.name) };
}

describe('Ollama 发图前的下载随中止停下', () => {
  it('下载途中调用方中止：到上游的请求随之断开，调用以中止原因拒绝，不记下载失败的告警', async () => {
    const t = await boot();
    const ac = new AbortController();
    const failure = t.ask(ac.signal);
    await expect.poll(() => t.seen.requested).toBe(true);
    ac.abort();
    await expect.poll(() => t.seen.closed).toBe(true);
    expect(await failure).toMatchObject({ name: 'AbortError' });
    expect(t.warns).toEqual([]);
  });

  it('下载途中停用插件、调用方没中止：到上游的请求随之断开，报插件中途停下，不记下载失败的告警', async () => {
    const t = await boot();
    const failure = t.ask();
    await expect.poll(() => t.seen.requested).toBe(true);
    await t.disable();
    await expect.poll(() => t.seen.closed).toBe(true);
    expect((await failure) as Error).toMatchObject({ message: 'Ollama 插件已停用或重载，这次请求中途停下' });
    expect(t.warns).toEqual([]);
  });
});
