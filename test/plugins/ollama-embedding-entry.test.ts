import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { App } from '../../packages/core/src/index.js';
import ollama from '../../packages/plugin-llm-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// /api/show 说了话就是权威：探测成功但映射不出对话能力（embedding 专用模型报
// ['embedding']）的模型不该注册成 llm entry。
//
// 旧行为：空映射被当「探测失败」，回退家族表 → 兜底 DEFAULT_CAPABILITIES=[Chat]，
// 于是 bge-m3 这类嵌入模型带着 chat 能力进了 /model 与 WebUI 模型列表，
// 无 ref 解析时还可能被列表首个选中。
// ════════════════════════════════════════════════════════════

/** 按 /api/show 的 model 返回对应 capabilities */
function stubOllama(caps: Record<string, string[] | null>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { body?: string }) => {
      const u = String(url);
      const json = async (): Promise<unknown> => {
        if (u.includes('/api/tags')) return { models: Object.keys(caps).map(name => ({ name })) };
        const model = JSON.parse(init?.body ?? '{}').model as string;
        const c = caps[model];
        return c === null ? {} : { capabilities: c };
      };
      return { ok: true, status: 200, json } as unknown as Response;
    }),
  );
}

async function registeredIds(caps: Record<string, string[] | null>, config: Record<string, unknown> = {}) {
  stubOllama(caps);
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(ollama, { baseUrl: 'http://127.0.0.1:11434', ...config });
  await app.plugins.idle();
  const entries = app.ctx.getAllServices<LLMModel>('llm').map(e => e.instance.id);
  await app.stop();
  return entries;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ollama model entry 注册', () => {
  it('embedding 专用模型不注册；对话模型照常', async () => {
    const ids = await registeredIds({ 'qwen3:8b': ['completion', 'tools'], 'bge-m3:latest': ['embedding'] });
    expect(ids).toEqual(['qwen3:8b']);
  });

  it('探测失败（/api/show 无 capabilities）仍按家族表/兜底注册，不误杀', async () => {
    const ids = await registeredIds({ 'qwen3:8b': null, 'some-unknown-model': null });
    expect(ids).toEqual(['qwen3:8b', 'some-unknown-model']);
  });

  it('用户 per-model 覆盖压过探测：显式声明能力即可把嵌入模型拉回列表（逃生舱）', async () => {
    // id 带 tag（Ollama 的常态）：覆盖行按最后一个冒号切分，id 段才是完整的 `bge-m3:latest`
    const ids = await registeredIds(
      { 'bge-m3:latest': ['embedding'] },
      {
        modelCapabilities: 'bge-m3:latest: chat,streaming',
      },
    );
    expect(ids).toEqual(['bge-m3:latest']);
  });
});
