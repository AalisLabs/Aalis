import { afterEach, expect, it } from 'vitest';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { type App, definePlugin, type Logger, lifecycle, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { freePort } from '../helpers/net.js';

// 模型选择框旁的「刷新」按 provider（插件实例 id）找它名下带 refresh 的模型条目。每个模型条目以
// `<实例 id>/<模型 id>` 登记，按条目 contextId 等于实例 id 去找，永远找不到。
// 找不到时如实说明：provider 名下有模型但都不提供 refresh（如关闭了 discoverModels），与名下一个模型都没有，是两回事。

const TOKEN = 'zz-refresh-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 按 llm-openai 的形状登记模型条目：entryId 为 `<实例 id>/<模型 id>`，refreshable 时每个条目共享同一个 refresh */
function provider(name: string, models: string[], refreshable: boolean) {
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

it('按 provider 刷新：有 refresh 的调它；名下模型都不提供 refresh、名下没有模型，分别如实说明', async () => {
  const port = await freePort();
  const { app } = hostedApp({ name: 'N' }, { logger: silent });
  apps.push(app);
  await app.plugin(provider('zz-dynamic', ['m1', 'm2'], true), {});
  await app.plugin(provider('zz-static', ['s1'], false), {});
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  for (let i = 0; ; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      break;
    } catch (err) {
      if (i >= 100) throw err;
      await new Promise(r => setTimeout(r, 20)); // 还没开始监听
    }
  }

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
