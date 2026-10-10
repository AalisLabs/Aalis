import type { AppService, PluginManagerService, ServiceSelection } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { HostConfig } from '../../packages/api-host-config/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// ════════════════════════════════════════════════════════════
// PUT /api/plugins/:name/config 曾以裸 defaults 打底：`{...defaultsFrom(schema), ...body}`。
// 而 defaultsFrom 只收录**声明了 default** 的键，apiKey / accessToken 这类 secret 多数没有
// （deepseek、embedding-openai、llm-openai、serper、onebot 皆是）。于是请求里不带 apiKey 时
// merged 里根本没有该键，而配置交给运行态（updateConfig → bounce）是整体替换——用户的密钥
// 从内存态与 yaml 一起消失，且接口回 ok。
// 修法是基线改用「默认值叠已存值」，语义才是真正的部分更新。
// ════════════════════════════════════════════════════════════

/** 只有一家的选择层桩 */
function stub<T>(instance: unknown): ServiceSelection<T> {
  return fixedRef(instance as T);
}

/** schema 刻意复刻真实形态：apiKey 无 default（真实仓里多数 secret 如此），baseUrl 有 */
const SCHEMA = {
  apiKey: { type: 'string', label: 'API Key', secret: true },
  baseUrl: { type: 'string', label: 'Base URL', default: 'https://api.example.com' },
  timeoutMs: { type: 'number', label: '超时', default: 30000 },
};

function setup() {
  const pluginConfig: Record<string, unknown> = {
    apiKey: 'sk-REAL-SECRET',
    baseUrl: 'https://api.example.com',
    timeoutMs: 30000,
  };
  let received: Record<string, unknown> | undefined;
  const { expressApp, invoke } = captureRoutes();
  const hostConfig = {
    set: () => {},
    getAll: () => ({}),
    getPluginConfig: () => ({ ...pluginConfig }),
    // 宿主一步完成运行态与文档：路由只把合并后的这一份交给 applyPluginConfig
    applyPluginConfig: async (_n: string, cfg: Record<string, unknown>) => {
      received = cfg;
      return { status: 'applied' as const, reloaded: true };
    },
    save: async () => {},
  };
  registerPluginRoutes(
    expressApp,
    {
      app: stub<AppService>({ restart: () => {} }),
      source: ref(),
      plugins: stub<PluginManagerService>({
        getPlugin: () => ({
          definition: { configSchema: SCHEMA },
          // 诱饵：生产若误读 module，defaultsFrom 会打上 FROM_MODULE，下面用例会红
          module: { configSchema: { ...SCHEMA, trap: { type: 'string', default: 'FROM_MODULE' } } },
        }),
        idle: async () => {},
      }),
      hostConfig: stub<HostConfig>(hostConfig),
      tools: ref(),
      commands: ref(),
      services: { names: () => [], preferred: () => undefined },
      self: 'zz-webui',
      versions: () => () => undefined,
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const put = (body: unknown) =>
    invoke('PUT /api/plugins/:name/config', {
      params: { name: '@aalis/plugin-x' },
      body: { config: body },
      headers: {},
    });
  return { put, got: () => received };
}

describe('PUT 插件配置：部分更新不得抹掉无 default 的密钥', () => {
  it('请求只改 timeoutMs 时，已存的 apiKey 必须原样保留', async () => {
    const { put, got } = setup();
    const out = await put({ timeoutMs: 60000 });

    expect(out.status).toBe(200);
    expect(got()?.timeoutMs, '本次提交的字段照常生效').toBe(60000);
    expect(
      got()?.apiKey,
      '裸 defaults 打底时该键整条消失——updateConfig 是整体替换，密钥就此从内存与 yaml 一起没了',
    ).toBe('sk-REAL-SECRET');
    expect(got()?.trap, '打底必须读 definition.configSchema，不得读 module').toBeUndefined();
  });

  it('显式传空串仍可清空（部分更新不等于改不掉）', async () => {
    const { put, got } = setup();
    await put({ apiKey: '' });
    expect(got()?.apiKey).toBe('');
  });

  it('有 default 的字段未提交时保持已存值，而不是回退默认值', async () => {
    const { put, got } = setup();
    await put({ apiKey: 'sk-NEW' });
    expect(got()?.baseUrl).toBe('https://api.example.com');
    expect(got()?.timeoutMs).toBe(30000);
  });
});
