import { afterEach, expect, it } from 'vitest';
import { type LLMModel, llm, resolveLLMModel, type ThinkingLevels } from '../../packages/api-llm/src/index.js';
import { type App, definePlugin, type Logger, lifecycle, provide, services } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { freePort, waitListening } from '../helpers/net.js';

// 模型选择框的可选项与旁边的「刷新」都按 provider（插件实例 id）认模型。每个模型条目以 `<实例 id>/<模型 id>` 登记：
// 可选项给的 contextId 要是实例 id，界面拼出的 { provider, model } 才解析得到；刷新按实例 id 找名下带 refresh 的条目，
// 按条目 contextId 等于实例 id 去找永远找不到。
// 找不到时如实说明：provider 名下有模型但都不提供 refresh（如关闭了模型发现 discoverModels），与名下一个模型都没有，是两回事。
// 深度思考的可选项：`/api/models/llm-thinking` 按依赖的模型（llm-ref 的取值，经 dependency 查询参数带来）取它声明的
// 档位，默认档在名字后注明并标 default；没带时按服务偏好解析，与对话时的解析一致；模型不能调时没有可选项；dependency 不是模型引用时
// 回 400。

const TOKEN = 'zz-refresh-token-placeholder-0000';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const DEEP: ThinkingLevels = {
  levels: [
    { id: 'off', label: '关' },
    { id: 'high', label: '高' },
    { id: 'max', label: '最高' },
  ],
  default: 'high',
};

/**
 * 按 llm-openai 的形状登记模型条目：entryId 为 `<实例 id>/<模型 id>`，refreshable 时每个条目共享同一个 refresh；
 * thinking 给出能调思考的模型的档位
 */
function provider(name: string, models: string[], refreshable: boolean, thinking: Record<string, ThinkingLevels> = {}) {
  return definePlugin({
    name,
    uses: { provide, lifecycle },
    apply(caps) {
      const refresh = async () => ({ added: [], removed: [], total: models.length });
      for (const id of models) {
        const handle = {
          id,
          providerId: caps.lifecycle.id,
          contextLength: 8192,
          capabilities: ['chat'],
          chat: async () => ({ content: '' }),
          ...(refreshable ? { refresh } : {}),
          ...(thinking[id] ? { thinking: thinking[id] } : {}),
        } as unknown as LLMModel;
        caps.provide(llm, handle, { entryId: `${caps.lifecycle.id}/${id}` });
      }
    },
  });
}

async function refresh(port: number, providerId: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/llm-providers/${encodeURIComponent(providerId)}/refresh`, {
    method: 'POST',
    headers: { Cookie: `aalis_webui_token=${TOKEN}` },
  });
  return { status: res.status, body: await res.json() };
}

async function thinkingOptions(port: number, dependency?: string): Promise<{ status: number; body: unknown }> {
  const query = dependency === undefined ? '' : `?dependency=${encodeURIComponent(dependency)}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/models/llm-thinking${query}`, {
    headers: { Cookie: `aalis_webui_token=${TOKEN}` },
  });
  return { status: res.status, body: await res.json() };
}

/** 起 webui-server 与两个模型提供者：zz-dynamic 带 refresh、m1 能调思考，zz-static 不带 refresh、不能调思考 */
async function boot(): Promise<{ app: App; port: number }> {
  const port = await freePort();
  const { app } = hostedApp({ name: 'N' }, { logger: silent });
  apps.push(app);
  await app.plugin(provider('zz-dynamic', ['m1', 'm2'], true, { m1: DEEP }), {});
  await app.plugin(provider('zz-static', ['s1'], false), {});
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  return { app, port };
}

it('模型的可选项按 provider 给出：contextId 是提供者的实例 id，拼成的引用解析得到这个模型', async () => {
  const { app, port } = await boot();
  const res = await fetch(`http://127.0.0.1:${port}/api/models/llm`, {
    headers: { Cookie: `aalis_webui_token=${TOKEN}` },
  });
  const { providers } = (await res.json()) as { providers: Array<{ contextId: string; model: string }> };
  expect(providers.map(({ contextId, model }) => [contextId, model])).toEqual([
    ['zz-dynamic', 'm1'],
    ['zz-dynamic', 'm2'],
    ['zz-static', 's1'],
  ]);
  const source = app.bind({ llm }).llm;
  for (const { contextId, model } of providers) {
    expect(resolveLLMModel(source, { provider: contextId, model })?.contextId).toBe(`${contextId}/${model}`);
  }
});

it('按 provider 刷新：有 refresh 的调它；名下模型都不提供 refresh、名下没有模型，分别如实说明', async () => {
  const { port } = await boot();

  expect(await refresh(port, 'zz-dynamic')).toEqual({
    status: 200,
    body: { ok: true, added: [], removed: [], total: 2 },
  });
  expect(await refresh(port, 'zz-static')).toEqual({
    status: 404,
    body: { error: '提供者 zz-static 不支持运行时刷新模型列表（例如关闭了模型发现 discoverModels）' },
  });
  expect(await refresh(port, 'zz-absent')).toEqual({
    status: 404,
    body: { error: '提供者 zz-absent 当前没有已注册的模型，无法刷新' },
  });
});

it('深度思考的可选项按依赖的模型给出它的档位，默认档注明；不能调的模型没有可选项', async () => {
  const { port } = await boot();
  expect(await thinkingOptions(port, JSON.stringify({ provider: 'zz-dynamic', model: 'm1' }))).toEqual({
    status: 200,
    body: {
      models: ['off', 'high', 'max'],
      details: [
        { value: 'off', label: '关' },
        { value: 'high', label: '高（默认）', default: true },
        { value: 'max', label: '最高' },
      ],
    },
  });
  expect(await thinkingOptions(port, JSON.stringify({ provider: 'zz-static', model: 's1' }))).toEqual({
    status: 200,
    body: { models: [], details: [] },
  });
});

it('深度思考的可选项没带依赖的值时按服务偏好解析', async () => {
  const { app, port } = await boot();
  expect((await thinkingOptions(port)).body).toMatchObject({ models: ['off', 'high', 'max'] });
  app.bind({ services }).services.prefer(llm, 'zz-static/s1');
  expect((await thinkingOptions(port)).body).toEqual({ models: [], details: [] });
});

it('深度思考的可选项依赖的值不是模型引用时回 400', async () => {
  const { port } = await boot();
  for (const dependency of ['{', '"m1"', '[1]', JSON.stringify({ provider: 1 })]) {
    const { status, body } = await thinkingOptions(port, dependency);
    expect([status, body], dependency).toEqual([400, { error: 'dependency 要是模型引用 { provider, model } 的 JSON' }]);
  }
});
