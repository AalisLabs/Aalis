import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
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

async function registeredEntries(caps: Record<string, string[] | null>, config: Record<string, unknown> = {}) {
  stubOllama(caps);
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ llm });
  await app.plugin(ollama, { baseUrl: 'http://127.0.0.1:11434', ...config });
  await app.plugins.idle();
  // 插件没激活时 entry 表恒空，`toEqual([...])` 只会红在"少了谁"上；先点名真实原因。
  if (app.plugins.getPlugin('@aalis/plugin-llm-ollama')?.state !== 'active')
    throw new Error('plugin-llm-ollama 未激活');
  const entries = host.llm.all().map(e => ({ id: e.instance.id, capabilities: [...e.instance.capabilities] }));
  await app.stop();
  return entries;
}

async function registeredIds(caps: Record<string, string[] | null>, config: Record<string, unknown> = {}) {
  return (await registeredEntries(caps, config)).map(e => e.id);
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

  it('探测失败时名称明示视觉的模型不被家族前缀抢先匹配（llama3.2-vision / qwen2.5vl 保留 vision）', async () => {
    const entries = await registeredEntries({
      'llama3.2-vision:11b': null,
      'qwen2.5vl:7b': null,
      'qwen3-vl:8b': null,
      'qwen2.5:7b': null,
    });
    const caps = Object.fromEntries(entries.map(e => [e.id, e.capabilities]));
    expect(caps['llama3.2-vision:11b']).toContain('vision');
    expect(caps['qwen2.5vl:7b']).toContain('vision');
    expect(caps['qwen3-vl:8b']).toContain('vision');
    // 普通家族照旧走前缀表，不因名称判定误标 vision
    expect(caps['qwen2.5:7b']).not.toContain('vision');
    expect(caps['qwen2.5:7b']).toContain('tool_calling');
  });
});
