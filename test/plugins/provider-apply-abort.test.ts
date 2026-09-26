import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type Logger, type PluginDefinition } from '../../packages/core/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';
import embeddingOpenai from '../../packages/plugin-embedding-openai/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// apply 里 await 的启动探测（连通性检查、模型发现）接 lifecycle.signal：停用、重启、停机时 apply 随 abort 落定。
// 不接的话要等请求自己的超时（10 秒到 60 秒）才落定，超过拆卸宽限（core 默认 5 秒）被记「未在宽限内停止」，
// 停用与重启时条目转 error。
//
// fetch 用替身：命中的请求挂起，只有请求带的 signal abort 才落定（替身不自带超时）。
// 宽限取 1 秒，远小于各插件的请求超时。
// ════════════════════════════════════════════════════════════

const GRACE_MS = 1000;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

/** 挂起 URL 含 hangOn 的请求直到它的 signal abort；其余请求答最小可用体 */
function stubFetch(hangOn: string): string[] {
  const hung: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes(hangOn)) {
        hung.push(u);
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      const body = u.includes('/api/tags') ? { models: [{ name: 'qwen3:8b' }] } : { capabilities: ['completion'] };
      return Promise.resolve(Response.json(body));
    }),
  );
  return hung;
}

function world() {
  const lines: Array<{ level: string; text: string }> = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push({ level, text: args.map(String).join(' ') });
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  const app = new App({ name: 'T', logger, disposeTimeoutMs: GRACE_MS });
  apps.push(app);
  return { app, lines };
}

async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

const OLLAMA = { baseUrl: 'http://127.0.0.1:11434' };
const GATEWAY = { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' };

const cases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown>; hangOn: string }> = [
  { name: 'embedding-ollama 连通性检查', plugin: embeddingOllama, config: OLLAMA, hangOn: '/api/embed' },
  { name: 'embedding-openai 连通性检查', plugin: embeddingOpenai, config: GATEWAY, hangOn: '/embeddings' },
  { name: 'llm-ollama 模型发现', plugin: llmOllama, config: OLLAMA, hangOn: '/api/tags' },
  { name: 'llm-ollama 能力探测', plugin: llmOllama, config: OLLAMA, hangOn: '/api/show' },
  { name: 'llm-openai 模型发现', plugin: llmOpenai, config: GATEWAY, hangOn: '/models' },
  { name: 'llm-deepseek 模型发现', plugin: deepseek, config: GATEWAY, hangOn: '/models' },
];

describe('启动探测随 lifecycle.signal 中止', () => {
  it.each(cases)('$name：停用时 apply 在宽限内落定，不记告警与错误，条目转 disabled', async ({
    plugin,
    config,
    hangOn,
  }) => {
    const hung = stubFetch(hangOn);
    const { app, lines } = world();
    const registering = app.plugin(plugin, config);
    await until(() => hung.length > 0, `请求 ${hangOn}`);

    const started = Date.now();
    expect(await app.plugins.disable(plugin.name)).toBe(true);
    const elapsed = Date.now() - started;
    await registering;
    await app.plugins.idle();

    // 中止后 apply 不再往下走：不报探测失败、不登记服务，宿主也不记「未在宽限内停止」
    expect(lines).toEqual([]);
    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('disabled');
    expect(elapsed, '停用应在宽限内返回').toBeLessThan(GRACE_MS);
  });
});
