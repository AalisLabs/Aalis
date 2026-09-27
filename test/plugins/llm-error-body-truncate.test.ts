import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub, type PluginDefinition, services } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 非 2xx 响应体进错误信息或日志前要截断：网关或反向代理的 HTML 错误页可达数十 KB。模型发现失败的原因带响应体摘录，
// 会进日志与 WebUI 的报错；对话出错时错误信息会作为「[错误] …」发回会话，只带状态码与提示（见
// llm-chat-error-message），响应体摘录只进 warn。响应体里的换行与缩进折叠成一个空格，错误信息与日志保持一行；
// 模型发现失败时，可操作的提示写在响应体之前。判断仍看完整响应体：内容审查关键词、Ollama 音频路径的 unknown
// format 诊断。
// fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

/** 约 20KB、多行的 HTML 错误页 */
const HTML_PAGE = `<!DOCTYPE html>\r\n<html>\r\n<body>\r\n${'  <p>502 Bad Gateway</p>\r\n'.repeat(900)}</body>\r\n</html>\r\n`;
const MAX_LEN = 600;
const LINE_BREAK = /[\r\n]/;

/**
 * 发现端点（/models、/api/tags）按 state.discovery 应答：ok 答一个模型，404 答 HTML 错误页；Ollama 能力探测答
 * 最小可用体；对话端点一律答 state.chatStatus 与 state.chatBody
 */
function stubFetch() {
  const state = { discovery: 'ok' as 'ok' | '404', chatStatus: 502, chatBody: HTML_PAGE };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
      if (u.endsWith('/models') || u.endsWith('/api/tags')) {
        if (state.discovery === '404') return new Response(HTML_PAGE, { status: 404, statusText: 'Not Found' });
        return Response.json(u.endsWith('/api/tags') ? { models: [{ name: 'qwen3:8b' }] } : { data: [{ id: 'm' }] });
      }
      return new Response(state.chatBody, { status: state.chatStatus });
    }),
  );
  return state;
}

async function start(plugin: PluginDefinition, config: Record<string, unknown>) {
  const hub = new LogHub();
  const warns: string[] = [];
  const errors: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
    if (entry.level === 'error') errors.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'info', logHub: hub });
  apps.push(app);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const entries = app.bind({ services }).services.all(llm);
  return { app, warns, errors, model: (): LLMModel | undefined => entries[0]?.instance };
}

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('预期抛错，实际成功');
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* 读完即可 */
  }
}

const OLLAMA = { baseUrl: 'http://127.0.0.1:11434' };
const GATEWAY = { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' };
const cases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown>; provider: string }> = [
  { name: 'llm-ollama', plugin: llmOllama, config: OLLAMA, provider: 'Ollama' },
  { name: 'llm-openai', plugin: llmOpenai, config: GATEWAY, provider: 'LLM' },
  { name: 'llm-deepseek', plugin: deepseek, config: GATEWAY, provider: 'DeepSeek' },
];
const REQUEST: ChatModelRequest = { messages: [{ role: 'user', content: '在吗' }] };

describe('模型发现遇到非 2xx：原因里的响应体截断成一行，提示在前', () => {
  it.each(cases)('$name / 启动时的 warn', async ({ plugin, config }) => {
    const state = stubFetch();
    state.discovery = '404';
    const { warns } = await start(plugin, { ...config, customModels: 'mine' });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('HTTP 404');
    expect(warns[0]).toContain('…');
    expect(warns[0].length, `warn 带着整页 HTML，长 ${warns[0].length}`).toBeLessThanOrEqual(MAX_LEN);
    expect(warns[0], 'warn 带着响应体里的换行').not.toMatch(LINE_BREAK);
    expect(warns[0], '响应体里的缩进没有折叠成一个空格').not.toMatch(/\s{2}/);
    expect(warns[0].indexOf('启动时只注册 customModels'), '提示没有写在响应体之前').toBe(0);
  });

  it.each(cases)('$name / 没有 customModels 时实例的错误信息与激活失败日志', async ({ plugin, config }) => {
    const state = stubFetch();
    state.discovery = '404';
    const { app, errors } = await start(plugin, config);

    const error = app.plugins.getPlugin(plugin.name)?.error ?? '';
    expect(error).toContain('HTTP 404');
    expect(error.length, `错误信息带着整页 HTML，长 ${error.length}`).toBeLessThanOrEqual(MAX_LEN);
    expect(error, '错误信息带着响应体里的换行').not.toMatch(LINE_BREAK);
    expect(error.indexOf('未配置 customModels，没有可注册的模型'), '提示没有写在响应体之前').toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0], '激活失败日志带着响应体里的换行').not.toMatch(LINE_BREAK);
  });

  it.each(cases.filter(c => c.name !== 'llm-deepseek'))('$name / 刷新的报错', async ({ plugin, config }) => {
    const state = stubFetch();
    const { model } = await start(plugin, config);
    const refresh = model()?.refresh;
    if (!refresh) throw new Error(`${plugin.name} 未登记可刷新的条目`);

    state.discovery = '404';
    const message = await errorOf(refresh);
    expect(message).toContain('HTTP 404');
    expect(message.endsWith('…')).toBe(true);
    expect(message.length, `报错带着整页 HTML，长 ${message.length}`).toBeLessThanOrEqual(MAX_LEN);
    expect(message, '报错带着响应体里的换行').not.toMatch(LINE_BREAK);
  });
});

describe('对话遇到非 2xx：错误信息不带响应体，响应体截断成一行记 warn', () => {
  it.each(cases)('$name / chat 与 chatStream', async ({ plugin, config, provider }) => {
    stubFetch();
    const { model, warns } = await start(plugin, config);
    const handle = model();
    if (!handle?.chatStream) throw new Error(`${plugin.name} 未登记支持流式的模型`);
    const stream = handle.chatStream(REQUEST);

    for (const message of [await errorOf(() => handle.chat(REQUEST)), await errorOf(() => drain(stream))]) {
      expect(message).toBe(`${provider} API 错误 (502)：上游服务故障；详情见日志`);
    }
    expect(warns, `两次请求各记一条带响应体的 warn: ${JSON.stringify(warns)}`).toHaveLength(2);
    for (const warn of warns) {
      expect(warn).toContain('502 Bad Gateway');
      expect(warn.endsWith('…'), 'warn 里的响应体没有截断').toBe(true);
      expect(warn.length, `warn 带着整页 HTML，长 ${warn.length}`).toBeLessThanOrEqual(MAX_LEN);
      expect(warn, 'warn 带着响应体里的换行').not.toMatch(LINE_BREAK);
    }
  });

  it('llm-ollama / 带音频的请求', async () => {
    stubFetch();
    const { model, warns } = await start(llmOllama, OLLAMA);
    const handle = model();
    if (!handle) throw new Error('ollama 未登记模型');
    const request: ChatModelRequest = {
      messages: [{ role: 'user', content: '听听', audios: ['data:audio/wav;base64,AAAA'] }],
    };

    expect(await errorOf(() => handle.chat(request))).toBe('Ollama API 错误 (502)：上游服务故障；详情见日志');
    const failed = warns.filter(w => w.includes('[ollama-audio]'));
    expect(failed).toHaveLength(1);
    expect(failed[0].length, `warn 带着整页 HTML，长 ${failed[0].length}`).toBeLessThanOrEqual(MAX_LEN);
    expect(failed[0], 'warn 带着响应体里的换行').not.toMatch(LINE_BREAK);
  });

  it('llm-ollama / 音频路径的 unknown format 诊断按完整响应体判断', async () => {
    const state = stubFetch();
    state.chatStatus = 500;
    state.chatBody = `${HTML_PAGE} image: unknown format`;
    const { model } = await start(llmOllama, OLLAMA);
    const handle = model();
    if (!handle) throw new Error('ollama 未登记模型');

    const message = await errorOf(() =>
      handle.chat({ messages: [{ role: 'user', content: '听听', audios: ['data:audio/wav;base64,AAAA'] }] }),
    );
    expect(message, '关键字在截断位置之后，诊断丢了').toContain('[诊断]');
    expect(message.length).toBeLessThan(1_000);
  });
});

describe('内容审查关键词按完整响应体判断', () => {
  it.each(cases.filter(c => c.name !== 'llm-ollama'))('$name', async ({ plugin, config }) => {
    const state = stubFetch();
    state.chatStatus = 400;
    // 关键词落在截断位置之后
    state.chatBody = `${'x'.repeat(2_000)} content_filter`;
    const { model } = await start(plugin, config);
    const handle = model();
    if (!handle) throw new Error(`${plugin.name} 未登记模型`);

    expect(await errorOf(() => handle.chat(REQUEST))).toContain('拒绝了此次请求（内容安全策略）');
  });
});
