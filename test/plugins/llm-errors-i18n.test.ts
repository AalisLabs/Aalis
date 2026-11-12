import { afterEach, describe, expect, it, vi } from 'vitest';
import { failureText } from '../../packages/api-doctor/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, type PluginDefinition, services } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';
import { isTextError, resolveText } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { provideEvents } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 三个对话模型服务的报错按读者的语言：对话请求非 2xx 与超时抛带文字对象的错误（经 agent 的「[错误] …」进聊天），上游的
// 说明原样在句子里；模型发现失败、没有可注册的模型时的插件失败原因同样，里层「响应不是 JSON」也按读者的语言。
// fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

const HTML = '<html>\r\n  <head><title>portal</title></head>\r\n</html>\r\n';
const EXCERPT = '<html> <head><title>portal</title></head> </html>';

/** 发现端点按 discovery 应答（Ollama 能力探测答最小可用体）；对话端点按 chat 应答 */
function stubFetch(discovery: 'ok' | 'html', chat: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
      if (u.endsWith('/api/tags') || u.endsWith('/models')) {
        if (discovery === 'html') return new Response(HTML, { status: 200 });
        return u.endsWith('/api/tags')
          ? Response.json({ models: [{ name: 'm' }] })
          : Response.json({ data: [{ id: 'm' }] });
      }
      return chat();
    }),
  );
}

async function start(plugin: PluginDefinition, config: Record<string, unknown>): Promise<App> {
  const app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  return app;
}

const cases = [
  {
    name: 'llm-deepseek',
    plugin: deepseek,
    config: { apiKey: 'k', baseUrl: 'https://gw.invalid', timeout: 30 },
    provider: 'DeepSeek',
    url: 'https://gw.invalid/models',
    noModels: {
      en: 'Could not get the model list, so there are no models to register: check apiKey, baseUrl and the network, then reload this plugin, or list the models to use in customModels. Reason: ',
      zh: '取不到模型列表，没有可注册的模型：检查 apiKey、baseUrl 与网络后重载本插件，或在 customModels 里写明要用的模型。原因：',
    },
  },
  {
    name: 'llm-ollama',
    plugin: llmOllama,
    config: { baseUrl: 'http://gw.invalid:11434', timeout: 30 },
    provider: 'Ollama',
    url: 'http://gw.invalid:11434/api/tags',
    noModels: {
      en: 'Could not get the Ollama model list, so there are no models to register: make sure Ollama is running and baseUrl is right, then reload this plugin, or list the models to use in customModels. Reason: ',
      zh: '取不到 Ollama 的模型列表，没有可注册的模型：确认 Ollama 在运行、baseUrl 写对后重载本插件，或在 customModels 里写明要用的模型。原因：',
    },
  },
  {
    name: 'llm-openai',
    plugin: llmOpenai,
    config: { apiKey: 'k', baseUrl: 'https://gw.invalid/v1', timeout: 30 },
    provider: 'LLM',
    url: 'https://gw.invalid/v1/models',
    noModels: {
      en: 'Could not get the model list, so there are no models to register: check apiKey, baseUrl and the network, then reload this plugin, or list the models to use in customModels. Reason: ',
      zh: '取不到模型列表，没有可注册的模型：检查 apiKey、baseUrl 与网络后重载本插件，或在 customModels 里写明要用的模型。原因：',
    },
  },
];

describe('对话请求的报错：带文字对象，en 是英文、zh-CN 是中文，上游说明原样在里面', () => {
  it.each(
    cases.flatMap(c => [
      {
        ...c,
        failure: '401',
        reply: () => Response.json({ error: { message: 'bad key zz' } }, { status: 401 }),
        en: `${c.provider} API error (401): invalid key or no permission; upstream message: bad key zz`,
        zh: `${c.provider} API 错误 (401)：密钥无效或没有权限；上游说明：bad key zz`,
      },
      {
        ...c,
        failure: '超时',
        reply: () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
        en: `${c.provider} request timed out: no new output within 30 s; you can raise timeout in the config`,
        zh: `${c.provider} 请求超时：30 秒内没有收到新的生成内容，可在配置里调大 timeout`,
      },
    ]),
  )('$name / $failure', async ({ plugin, config, reply, en, zh }) => {
    stubFetch('ok', reply);
    const app = await start(plugin, config);
    const handle = app.bind({ services }).services.use.all(llm)[0]?.instance;
    if (!handle) throw new Error(`${plugin.name} 未登记模型`);

    const err = await handle.chat({ messages: [{ role: 'user', content: '在吗' }] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!isTextError(err)) throw new Error(`报错没有文字对象：${String(err)}`);
    expect(resolveText(err.text, ['en'])).toBe(en);
    expect(err.message).toBe(zh);
  });
});

describe('没有可注册的模型：插件失败原因 en 是英文、zh-CN 是中文（发现失败的里层原因同样）', () => {
  it.each(cases)('$name', async ({ plugin, config, url, noModels }) => {
    stubFetch('html', () => Response.json({}));
    const app = await start(plugin, config);
    const entry = app.plugins.getStatus().find(e => e.name === plugin.name);
    expect(entry?.state).toBe('error');

    const reason = entry && failureText(entry);
    expect(renderIn(reason, 'en')).toBe(
      `${noModels.en}Model discovery failed for ${url}: the response is not JSON: ${EXCERPT}`,
    );
    expect(renderIn(reason, 'zh-CN')).toBe(`${noModels.zh}模型发现失败 ${url}: 响应不是 JSON: ${EXCERPT}`);
  });
});
