// @vitest-environment jsdom
import type { ConfigSchema } from '@aalis/schema-config';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type App, appService, config, definePlugin, pluginsService } from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// secret: true 的字段在配置文档里是引用 { $secret: 键 }，原值在宿主的密钥存储里。GET /api/plugins 给文档形态，
// 插件配置页查看时显示「已设置」与键名，编辑时密钥框从空开始：留空即把引用原样发回（保持），输入即替换（顶层与分组
// 写进原来的键，数组元素里另建新键）。页面的请求在这里接到真实路由与宿主（host-config + 密钥存储）上，列表、草稿、
// 保存、拆出密钥、解析整条走一遍。

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
import type { PluginListResponse } from '../../packages/plugin-webui-client/src/types.js';

const apps: App[] = [];
afterEach(async () => {
  cleanup();
  server.invoke = undefined;
  server.puts.length = 0;
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/**
 * 按文档登记插件（引用经密钥存储解析）、挂上真实路由，取 GET /api/plugins（经 JSON 往返，与浏览器拿到的一致）渲染配置页。
 * `others` 是文档里别的实例的配置段（只用来共用密钥键，不登记）；不给 `secrets` 时宿主没有密钥存储
 */
async function boot(
  name: string,
  configSchema: ConfigSchema,
  stored: Record<string, unknown>,
  options: { others?: Record<string, Record<string, unknown>>; secrets?: Record<string, unknown> } = {},
) {
  const secretSaves: Array<Record<string, unknown>> = [];
  const { app, store } = hostedApp(
    { plugins: { [name]: structuredClone(stored), ...structuredClone(options.others ?? {}) } },
    options.secrets
      ? {
          secrets: {
            values: structuredClone(options.secrets),
            provider: { save: values => void secretSaves.push(structuredClone(values)) },
          },
        }
      : {},
  );
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
  const list = JSON.parse(JSON.stringify((await invoke('GET /api/plugins')).body)) as PluginListResponse;
  const row = list.plugins.find(p => p.instanceId === name);
  if (!row) throw new Error(`列表里没有 ${name}`);
  const { container } = render(
    <PluginConfigPage
      plugins={[row]}
      secretRefCounts={list.secretRefCounts}
      config={null}
      onRefresh={() => {}}
      onConfigSaved={() => {}}
      onRestart={() => {}}
    />,
  );
  fireEvent.click(screen.getByText(name));
  return { app, store, container, list, secretSaves };
}

/** 查看态里字段名为 key 的那一行显示的值（顶层、分组内、数组元素内都按字段名找） */
function viewValue(key: string): string | null | undefined {
  return screen.getByText(key, { selector: 'code' }).closest('.config-item')?.querySelector('.val')?.textContent;
}

/** 编辑表单里字段名为 key 的那一行（顶层、分组内、数组元素内都按字段名找；同名有多个时取第 nth 个） */
function editRow(key: string, nth = 0): HTMLElement {
  const row = screen.getAllByText(key, { selector: 'code' })[nth]?.closest<HTMLElement>('.config-edit-row');
  if (!row) throw new Error(`找不到字段 ${key} 的编辑行`);
  return row;
}

/** 编辑行里的输入控件 */
function editControl(key: string, nth = 0): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const control = editRow(key, nth).querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    'input, select, textarea',
  );
  if (!control) throw new Error(`找不到字段 ${key} 的输入控件`);
  return control;
}

/** 点保存并等到回执（已更新或无改动） */
async function save(name: string) {
  fireEvent.click(screen.getByText('保存'));
  expect(await screen.findByText(new RegExp(`^插件 ${name} 配置`))).toBeTruthy();
}

describe('插件配置页的密钥：文档里是引用，页面不见原值', () => {
  // 字段名刻意避开按名字判断的正则（apiKey / password / secret / token），这里的处理只能来自 schema.secret
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
        env: { type: 'map', label: '环境变量', secret: true },
      },
    },
    timeoutMs: { type: 'number', label: '超时', default: 30 },
  };
  const ref = (key: string) => ({ $secret: key });
  const DOC = {
    signingKey: ref('vault.signingKey'),
    auth: { user: 'placeholder-user', credential: ref('shared.credential') },
    connections: [
      { url: 'ws://127.0.0.1:0', passphrase: ref('vault.connections.passphrase'), env: ref('vault.connections.env') },
    ],
    timeoutMs: 30,
  };
  // 别的实例共用两个键：分组里 credential 的与数组元素里 passphrase 的
  const OTHERS = { other: { credential: ref('shared.credential'), passphrase: ref('vault.connections.passphrase') } };
  const SECRETS = {
    'vault.signingKey': 'sign-PLACEHOLDER-TOP',
    'shared.credential': 'cred-PLACEHOLDER-GROUP',
    'vault.connections.passphrase': 'pass-PLACEHOLDER-ITEM',
    'vault.connections.env': { PLACEHOLDER_VAR: 'env-PLACEHOLDER-MAP' },
  };
  const PLAIN = ['sign-PLACEHOLDER-TOP', 'cred-PLACEHOLDER-GROUP', 'pass-PLACEHOLDER-ITEM', 'env-PLACEHOLDER-MAP'];
  const RESOLVED = {
    signingKey: 'sign-PLACEHOLDER-TOP',
    auth: { user: 'placeholder-user', credential: 'cred-PLACEHOLDER-GROUP' },
    connections: [
      { url: 'ws://127.0.0.1:0', passphrase: 'pass-PLACEHOLDER-ITEM', env: { PLACEHOLDER_VAR: 'env-PLACEHOLDER-MAP' } },
    ],
    timeoutMs: 30,
  };
  const bootVault = () => boot('vault', SCHEMA, DOC, { others: OTHERS, secrets: SECRETS });

  it('列表给引用与引用计数、不给原值；查看态顶层、分组内、数组元素内的密钥显示「已设置」与键名', async () => {
    const { app, container, list } = await bootVault();
    expect(app.plugins.getPlugin('vault')?.config, '插件拿到的是解析后的原值').toEqual(RESOLVED);
    expect(list.plugins[0].config).toEqual(DOC);
    expect(list.secretRefCounts).toEqual({
      'vault.signingKey': 1,
      'shared.credential': 2,
      'vault.connections.passphrase': 2,
      'vault.connections.env': 1,
    });
    for (const secret of PLAIN) expect(JSON.stringify(list), '接口回复不得含原值').not.toContain(secret);

    fireEvent.click(screen.getByText('#1'));
    expect(viewValue('signingKey')).toBe('已设置（键 vault.signingKey）');
    expect(viewValue('credential')).toBe('已设置（键 shared.credential）');
    expect(viewValue('passphrase')).toBe('已设置（键 vault.connections.passphrase）');
    expect(viewValue('env')).toBe('已设置（键 vault.connections.env）');
    expect(viewValue('user')).toBe('placeholder-user');
    expect(viewValue('url')).toBe('ws://127.0.0.1:0');
    expect(container.innerHTML).not.toContain('[object Object]');
    expect(container.innerHTML).not.toContain('$secret');
  });

  it('编辑：有引用的密钥框是空的密码框，map 密钥只写、编辑框从空开始；共用的键在顶层与分组里提示替换会改到别处', async () => {
    const { container } = await bootVault();
    fireEvent.click(screen.getByText('编辑配置'));

    const texts = ['signingKey', 'credential', 'passphrase'].map(k => editControl(k) as HTMLInputElement);
    expect(texts.map(i => [i.type, i.value, i.placeholder])).toEqual([
      ['password', '', '已设置（不显示）'],
      ['password', '', '已设置（不显示）'],
      ['password', '', '已设置（不显示）'],
    ]);
    expect(editControl('env').tagName).toBe('TEXTAREA');
    expect(editControl('env').value).toBe('');
    expect(within(editRow('env')).getByText('已设置（只写，改时整份重填）')).toBeTruthy();
    expect(editRow('signingKey').textContent).toContain('键 vault.signingKey');

    expect(editRow('credential').textContent).toContain('此密钥被 2 处引用，替换会同时改到另外 1 处');
    expect(editRow('signingKey').textContent, '只被引用一处的键不提示').not.toContain('处引用');
    // 数组元素里的字段替换时另建新键，不会改到共用这个键的地方
    expect(editRow('passphrase').textContent).not.toContain('处引用');

    for (const control of container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      expect(control.value, '引用不得进输入框').not.toContain('$secret');
    }
    for (const secret of PLAIN) expect(container.innerHTML).not.toContain(secret);
    expect(container.innerHTML).not.toContain('[object Object]');
  });

  it('不动密钥只改别的字段：引用原样发回，配置文档与密钥存储都不变，插件照旧拿到原值', async () => {
    const { app, store, secretSaves } = await bootVault();
    fireEvent.click(screen.getByText('编辑配置'));
    fireEvent.change(editControl('timeoutMs'), { target: { value: '60' } });
    await save('vault');

    expect(server.puts).toEqual([{ ...DOC, timeoutMs: 60 }]);
    expect(store.getPluginConfig('vault')).toEqual({ ...DOC, timeoutMs: 60 });
    expect(secretSaves, '密钥存储没有写入').toEqual([]);
    expect(store.resolvePluginConfig('vault', SCHEMA).config).toEqual({ ...RESOLVED, timeoutMs: 60 });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('vault')?.config).toEqual({ ...RESOLVED, timeoutMs: 60 });
  });

  it('有默认值的密钥字段在文档里没有值：草稿不填默认值（框里提示默认值），输入过再删空也算没填；保存不写密钥、文档不变、插件不重建', async () => {
    const schema = {
      uri: { type: 'string', label: 'URI', secret: true, default: 'mongodb://localhost:27017' },
      token: { type: 'string', label: 'Token', secret: true, default: '' },
      timeoutMs: { type: 'number', label: '超时', default: 30 },
    } satisfies ConfigSchema;
    const { app, store, secretSaves } = await boot('mongo', schema, { timeoutMs: 30 }, { secrets: {} });
    fireEvent.click(screen.getByText('编辑配置'));
    const uri = editControl('uri') as HTMLInputElement;
    expect(uri.value).toBe('');
    expect(uri.placeholder).toBe('留空使用默认值 mongodb://localhost:27017');
    // 输入过再删空：仍是没填，不把空串写进文档
    fireEvent.change(editControl('token'), { target: { value: 'typed' } });
    fireEvent.change(editControl('token'), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存'));
    expect(await screen.findByText(/^插件 mongo 配置无改动/)).toBeTruthy();
    expect(secretSaves).toEqual([]);
    expect(store.getPluginConfig('mongo')).toEqual({ timeoutMs: 30 });
    expect(app.plugins.getPlugin('mongo')?.config).toEqual({ timeoutMs: 30 });
  });

  it('输入过再删空、点「清除」后又「撤销」：都回到保持，发回的仍是引用', async () => {
    await bootVault();
    fireEvent.click(screen.getByText('编辑配置'));
    fireEvent.change(editControl('signingKey'), { target: { value: 'typed' } });
    fireEvent.change(editControl('signingKey'), { target: { value: '' } });
    fireEvent.change(editControl('env'), { target: { value: 'A=1' } });
    fireEvent.change(editControl('env'), { target: { value: '' } });
    fireEvent.click(within(editRow('credential')).getByText('清除'));
    fireEvent.click(within(editRow('credential')).getByText('撤销'));
    expect((editControl('signingKey') as HTMLInputElement).placeholder).toBe('已设置（不显示）');
    await save('vault');
    expect(server.puts).toEqual([DOC]);
  });

  it('输入新值即替换：顶层与分组写进原来的键（共用处一并改），数组元素里另建新键；文档仍是引用，插件拿到新值', async () => {
    const { app, store, secretSaves } = await bootVault();
    fireEvent.click(screen.getByText('编辑配置'));
    fireEvent.change(editControl('signingKey'), { target: { value: 'sign-NEW-PLACEHOLDER' } });
    fireEvent.change(editControl('credential'), { target: { value: 'cred-NEW-PLACEHOLDER' } });
    fireEvent.change(editControl('passphrase'), { target: { value: 'pass-NEW-PLACEHOLDER' } });
    fireEvent.change(editControl('env'), { target: { value: 'NEW_VAR=env-NEW-PLACEHOLDER' } });
    expect(editRow('signingKey').textContent).toContain('保存后替换这个键的值');
    await save('vault');

    const replaced = {
      signingKey: 'sign-NEW-PLACEHOLDER',
      auth: { user: 'placeholder-user', credential: 'cred-NEW-PLACEHOLDER' },
      connections: [
        { url: 'ws://127.0.0.1:0', passphrase: 'pass-NEW-PLACEHOLDER', env: { NEW_VAR: 'env-NEW-PLACEHOLDER' } },
      ],
    };
    expect(server.puts).toEqual([{ ...DOC, ...replaced }]);

    const doc = store.getPluginConfig<typeof DOC>('vault');
    expect(doc.signingKey, '顶层写进原来的键').toEqual(ref('vault.signingKey'));
    expect(doc.auth.credential, '分组写进原来的键').toEqual(ref('shared.credential'));
    const [item] = doc.connections;
    expect(Object.keys(item.passphrase)).toEqual(['$secret']);
    expect(Object.keys(item.env)).toEqual(['$secret']);
    expect(item.passphrase.$secret, '数组元素里另建新键').not.toBe('vault.connections.passphrase');
    expect(item.env.$secret).not.toBe('vault.connections.env');
    expect(JSON.stringify(store.getAll()), '原值不进配置文档').not.toContain('NEW-PLACEHOLDER');

    const saved = secretSaves.at(-1);
    expect(saved?.['vault.signingKey']).toBe('sign-NEW-PLACEHOLDER');
    expect(saved?.['shared.credential'], '共用的键一并改到').toBe('cred-NEW-PLACEHOLDER');
    expect(saved?.[item.passphrase.$secret]).toBe('pass-NEW-PLACEHOLDER');
    expect(saved?.[item.env.$secret]).toEqual({ NEW_VAR: 'env-NEW-PLACEHOLDER' });
    expect(saved?.['vault.connections.passphrase'], '别处共用的旧键不受影响').toBe('pass-PLACEHOLDER-ITEM');

    await app.plugins.idle();
    expect(app.plugins.getPlugin('vault')?.config).toEqual({ ...RESOLVED, ...replaced });
  });

  it('「清除」发空串，保存后文档里不再有这个引用', async () => {
    const { store } = await bootVault();
    fireEvent.click(screen.getByText('编辑配置'));
    fireEvent.click(within(editRow('signingKey')).getByText('清除'));
    expect(editRow('signingKey').textContent).toContain('保存后清除');
    await save('vault');
    expect(server.puts[0].signingKey).toBe('');
    expect(store.getPluginConfig('vault').signingKey).toBe('');
  });

  it('「恢复默认」不清掉已存的密钥：顶层与分组的引用原样留在草稿里', async () => {
    await bootVault();
    fireEvent.click(screen.getByText('编辑配置'));
    fireEvent.change(editControl('signingKey'), { target: { value: 'typed' } });
    fireEvent.click(screen.getByText('恢复默认'));
    await save('vault');
    expect(server.puts[0].signingKey).toEqual(ref('vault.signingKey'));
    expect((server.puts[0].auth as Record<string, unknown>).credential).toEqual(ref('shared.credential'));
  });

  it('删掉前面的数组条目后，后面条目记住的仍是它自己的引用', async () => {
    const second = { url: 'ws://127.0.0.1:1', passphrase: ref('vault.second.passphrase') };
    await boot(
      'vault',
      SCHEMA,
      { ...DOC, connections: [...DOC.connections, second] },
      { secrets: { ...SECRETS, 'vault.second.passphrase': 'pass-PLACEHOLDER-SECOND' } },
    );
    fireEvent.click(screen.getByText('编辑配置'));
    fireEvent.change(editControl('passphrase', 1), { target: { value: 'typed' } });
    const first = editRow('passphrase', 0).closest<HTMLElement>('.config-edit-array-item');
    if (!first) throw new Error('找不到第一个数组条目');
    fireEvent.click(within(first).getByText('删除'));
    fireEvent.change(editControl('passphrase', 0), { target: { value: '' } });
    await save('vault');
    expect(server.puts[0].connections).toEqual([second]);
  });
});

describe('宿主没有密钥存储：文档里是明文，页面照旧遮蔽', () => {
  const SCHEMA: ConfigSchema = {
    signingKey: { type: 'string', label: '签名密钥', secret: true },
    auth: {
      label: '认证',
      fields: { credential: { type: 'string', label: '凭据', secret: true } },
    },
    connections: {
      type: 'array',
      label: '连接',
      items: { passphrase: { type: 'string', label: '口令', secret: true } },
    },
    // 名字像凭据：没写 secret 时按名字遮蔽，写了 false 表示插件作者判断过不是凭据
    sessionToken: { type: 'string', label: '会话标记' },
    pageToken: { type: 'string', label: '分页标记', secret: false },
  };

  it('查看时整段固定掩码（短值也一个字符不露），secret: false 的不遮蔽；编辑是密码框', async () => {
    await boot('vault', SCHEMA, {
      signingKey: 'k9x2',
      auth: { credential: 'q7' },
      connections: [{ passphrase: 'z' }],
      sessionToken: 'session-PLACEHOLDER',
      pageToken: 'page-PLACEHOLDER',
    });
    fireEvent.click(screen.getByText('#1'));
    expect(['signingKey', 'credential', 'passphrase', 'sessionToken'].map(viewValue)).toEqual([
      '••••••',
      '••••••',
      '••••••',
      '••••••',
    ]);
    expect(viewValue('pageToken')).toBe('page-PLACEHOLDER');

    fireEvent.click(screen.getByText('编辑配置'));
    const types = ['signingKey', 'credential', 'passphrase', 'sessionToken', 'pageToken'].map(
      k => (editControl(k) as HTMLInputElement).type,
    );
    expect(types).toEqual(['password', 'password', 'password', 'password', 'text']);
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
