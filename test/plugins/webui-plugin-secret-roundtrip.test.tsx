// @vitest-environment jsdom
import type { ConfigSchema } from '@aalis/schema-config';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type App, appService, config, definePlugin, pluginsService } from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// 遮蔽只是显示问题，接口不改数据：GET /api/plugins 给原值，插件配置页查看时按 schema.secret 遮蔽（含分组内、
// 数组元素内），编辑用列表数据建草稿、密钥是密码框，整份 PUT 回去密钥原样保留。页面的请求在这里接到真实路由上，
// 列表、草稿、保存与服务端合并整条走一遍。

const server = vi.hoisted(() => ({
  invoke: undefined as undefined | ((key: string, req: unknown) => Promise<{ status: number; body?: unknown }>),
  puts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async (url: string, opts?: RequestInit) => {
    if (url === '/api/llm-providers') {
      return { providers: [{ contextId: 'llm-a', models: [{ id: 'model-a', capabilities: [] }] }] };
    }
    const put = /^\/api\/plugins\/([^/]+)\/config$/.exec(url);
    if (!server.invoke || !put || opts?.method !== 'PUT') throw new Error(`unexpected ${opts?.method ?? 'GET'} ${url}`);
    const body = JSON.parse(String(opts.body)) as { config: Record<string, unknown> };
    server.puts.push(body.config);
    const reply = await server.invoke('PUT /api/plugins/:name/config', {
      params: { name: decodeURIComponent(put[1]) },
      body,
      headers: {},
    });
    const payload = JSON.parse(JSON.stringify(reply.body ?? {})) as { error?: string };
    if (reply.status >= 400) throw new Error(payload.error);
    return payload;
  }),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));

import { PluginConfigPage } from '../../packages/plugin-webui-client/src/pages/PluginConfigPage.js';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

const apps: App[] = [];
afterEach(async () => {
  cleanup();
  server.invoke = undefined;
  server.puts.length = 0;
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** 按文档登记插件、挂上真实路由，取 GET /api/plugins 的这一行（经 JSON 往返，与浏览器拿到的一致）渲染配置页 */
async function boot(name: string, configSchema: ConfigSchema, stored: Record<string, unknown>) {
  const { app, store } = hostedApp({ plugins: { [name]: structuredClone(stored) } });
  apps.push(app);
  await registerFromDoc(app, store, definePlugin({ name, configSchema, uses: { config }, apply() {} }));
  await app.plugins.idle();
  const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
  const { expressApp, invoke } = captureRoutes();
  registerPluginRoutes(
    expressApp,
    {
      app: bound.app,
      source: { current: undefined },
      plugins: bound.plugins,
      hostConfig: bound.hostConfig,
      tools: { current: undefined },
      commands: { current: undefined },
      webui: () => undefined,
    },
    () => ({ platform: 'webui', userId: 'console' }),
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    () => undefined,
  );
  server.invoke = invoke;
  const list = JSON.parse(JSON.stringify((await invoke('GET /api/plugins')).body)) as { plugins: PluginInfo[] };
  const row = list.plugins.find(p => p.instanceId === name);
  if (!row) throw new Error(`列表里没有 ${name}`);
  const { container } = render(
    <PluginConfigPage
      plugins={[row]}
      config={null}
      onRefresh={() => {}}
      onConfigSaved={() => {}}
      onRestart={() => {}}
    />,
  );
  fireEvent.click(screen.getByText(name));
  return { app, store, container };
}

/** 查看态里字段名为 key 的那一行显示的值（顶层、分组内、数组元素内都按字段名找） */
function viewValue(key: string): string | null | undefined {
  return screen.getByText(key, { selector: 'code' }).closest('.config-item')?.querySelector('.val')?.textContent;
}

/** 编辑表单里字段名为 key 的那一行的输入控件（顶层、分组内、数组元素内都按字段名找） */
function editControl(key: string): HTMLInputElement | HTMLSelectElement {
  const row = screen.getByText(key, { selector: 'code' }).closest('.config-edit-row');
  const control = row?.querySelector('input, select');
  if (!control) throw new Error(`找不到字段 ${key} 的输入控件`);
  return control as HTMLInputElement | HTMLSelectElement;
}

describe('插件配置页的密钥：显示遮蔽，保存原值', () => {
  // 字段名刻意避开按名字判断的正则（apiKey / password / secret / token），遮蔽只能来自 schema.secret
  const SCHEMA: ConfigSchema = {
    signingKey: { type: 'string', label: '签名密钥', secret: true },
    auth: {
      label: '认证',
      fields: {
        user: { type: 'string', label: '用户' },
        credential: { type: 'string', label: '凭据', secret: true },
      },
    },
    connections: {
      type: 'array',
      label: '连接',
      items: {
        url: { type: 'string', label: '地址' },
        passphrase: { type: 'string', label: '口令', secret: true },
      },
    },
    timeoutMs: { type: 'number', label: '超时', default: 30 },
  };
  const STORED = {
    signingKey: 'sign-PLACEHOLDER-TOP',
    auth: { user: 'placeholder-user', credential: 'cred-PLACEHOLDER-GROUP' },
    connections: [{ url: 'ws://127.0.0.1:0', passphrase: 'pass-PLACEHOLDER-ITEM' }],
    timeoutMs: 30,
  };
  const SECRETS = ['sign-PLACEHOLDER-TOP', 'cred-PLACEHOLDER-GROUP', 'pass-PLACEHOLDER-ITEM'];

  const SECRET_KEYS = ['signingKey', 'credential', 'passphrase'];

  it('查看时顶层、分组内、数组元素内的 secret 字段都显示固定掩码，其余字段照常显示', async () => {
    const { container } = await boot('vault', SCHEMA, STORED);
    fireEvent.click(screen.getByText('#1'));
    expect(SECRET_KEYS.map(viewValue)).toEqual(['••••••', '••••••', '••••••']);
    expect(viewValue('user')).toBe('placeholder-user');
    expect(viewValue('url')).toBe('ws://127.0.0.1:0');
    for (const secret of SECRETS) expect(container.innerHTML, '明文不得出现在查看态').not.toContain(secret);
  });

  it('4 个字符及以下的短密钥同样整段遮蔽，不露任何字符', async () => {
    await boot('vault', SCHEMA, {
      ...STORED,
      signingKey: 'k9x2',
      auth: { user: 'placeholder-user', credential: 'q7' },
      connections: [{ url: 'ws://127.0.0.1:0', passphrase: 'z' }],
    });
    fireEvent.click(screen.getByText('#1'));
    expect(SECRET_KEYS.map(viewValue)).toEqual(['••••••', '••••••', '••••••']);
  });

  it('编辑用列表数据建草稿：密钥是密码框、值是原值；只改无关字段保存，密钥原样留在配置文档与运行态', async () => {
    const { app, store } = await boot('vault', SCHEMA, STORED);
    fireEvent.click(screen.getByText('编辑配置'));
    const secretInputs = [editControl('signingKey'), editControl('credential'), editControl('passphrase')];
    expect(secretInputs.map(i => (i as HTMLInputElement).type)).toEqual(['password', 'password', 'password']);
    expect(secretInputs.map(i => i.value)).toEqual(SECRETS);

    fireEvent.change(editControl('timeoutMs'), { target: { value: '60' } });
    fireEvent.click(screen.getByText('保存'));
    expect(await screen.findByText('插件 vault 配置已更新')).toBeTruthy();

    const expected = { ...structuredClone(STORED), timeoutMs: 60 };
    expect(store.getPluginConfig('vault')).toEqual(expected);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('vault')?.config).toEqual(expected);
  });
});

describe('插件配置页清空顶层字段', () => {
  const SCHEMA = {
    limit: { type: 'number', label: '上限' },
    timeoutMs: { type: 'number', label: '超时', default: 30 },
    model: { type: 'llm-ref', label: '模型' },
    retry: {
      label: '重试',
      fields: {
        delayMs: { type: 'number', label: '间隔', default: 100 },
        maxTries: { type: 'number', label: '次数' },
      },
    },
  } as unknown as ConfigSchema;

  it('数字留空、llm-ref 选「继承默认」：顶层发 null，服务端删除后按默认值补齐；分组里的随整块替换清掉', async () => {
    const { store } = await boot('knobs', SCHEMA, {
      limit: 5,
      timeoutMs: 99,
      model: { provider: 'llm-a', model: 'model-a' },
      retry: { delayMs: 500, maxTries: 3 },
    });
    fireEvent.click(screen.getByText('编辑配置'));
    for (const key of ['limit', 'timeoutMs', 'delayMs', 'maxTries']) {
      fireEvent.change(editControl(key), { target: { value: '' } });
    }
    fireEvent.change(editControl('model'), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存'));
    expect(await screen.findByText('插件 knobs 配置已更新')).toBeTruthy();

    expect(server.puts).toEqual([{ limit: null, timeoutMs: null, model: null, retry: {} }]);
    expect(store.getPluginConfig('knobs')).toEqual({ timeoutMs: 30, retry: { delayMs: 100 } });
  });
});
