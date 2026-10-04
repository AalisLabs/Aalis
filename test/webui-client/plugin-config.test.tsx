// @vitest-environment jsdom
import type { ConfigSchema } from '@aalis/schema-config';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type App, appService, config, definePlugin, pluginsService, services } from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { choose, type Harness, installDialog, renderApp } from './harness.js';

// ════════════════════════════════════════════════════════════
// 插件详情的配置：按 schema 画的整张表，接到真实的插件路由与宿主（host-config 加密钥存储）上，列表、草稿、保存、拆出密钥、
// 解析整条走一遍。secret: true 的字段在配置文档里是引用 { $secret: 键 }：表单只写「已设置」与键名，「更换」后输入的新值替换
// （顶层与分组写进原来的键，数组元素里另建新键），留空保持，「清除」送空值；只送改了的顶层键，清空的顶层键送 null。
// 插件失败时也能改配置，保存即重载；服务端逐项的问题写在对应的行下
// ════════════════════════════════════════════════════════════

let ui: Harness | undefined;
let restoreDialog: () => void;
const apps: App[] = [];

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  stubViewport(1440);
});

afterEach(async () => {
  ui?.close();
  ui = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** 模型字段的可选项：一个服务一个模型 */
const MODELS = { providers: [{ contextId: 'llm-a', model: 'model-a', provider: '服务甲' }] };

/**
 * 按文档登记插件（引用经密钥存储解析）、挂上真实路由，在 /plugins/:name 上渲染整个前端。`others` 是文档里别的实例的
 * 配置段（只用来共用密钥键，不登记）；不给 `secrets` 时宿主没有密钥存储；`apply` 是插件拿到配置后做的事（抛错即激活失败）
 */
async function boot(
  name: string,
  configSchema: ConfigSchema,
  stored: Record<string, unknown>,
  options: {
    others?: Record<string, Record<string, unknown>>;
    secrets?: Record<string, unknown>;
    apply?: (config: Record<string, unknown>) => void;
  } = {},
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
  const apply = options.apply ?? (() => {});
  await registerFromDoc(
    app,
    store,
    definePlugin({
      name,
      configSchema,
      uses: { config },
      apply: caps => apply(caps.config as Record<string, unknown>),
    }),
  );
  await app.plugins.idle();
  const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig, services });
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
      services: bound.services,
      self: 'zz-webui',
      versions: () => () => undefined,
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const puts: Array<Record<string, unknown>> = [];
  const list = async () => JSON.parse(JSON.stringify((await invoke('GET /api/plugins')).body));
  ui = await renderApp(
    `/plugins/${name}`,
    {},
    {
      '/api/plugins': list,
      '/api/models/llm': MODELS,
      [`/api/plugins/${name}/config`]: async ({ body }: { body?: unknown }) => {
        puts.push((body as { config: Record<string, unknown> }).config);
        const reply = await invoke('PUT /api/plugins/:name/config', { params: { name }, body, headers: {} });
        return Response.json(reply.body ?? {}, { status: reply.status });
      },
    },
  );
  await screen.findByRole('heading', { name: '配置' });
  return { app, store, secretSaves, puts, list };
}

const form = () => within(screen.getByRole('heading', { name: '配置' }).closest('.config-form') as HTMLElement);
/** 标签为 label 的那一行（同名的有几个时取第 nth 个） */
const rowOf = (label: string, nth = 0) =>
  form().getAllByText(label, { selector: 'label' })[nth].closest('.field-row') as HTMLElement;
const control = (label: string, nth = 0) =>
  document.getElementById(
    (form().getAllByText(label, { selector: 'label' })[nth] as HTMLLabelElement).htmlFor,
  ) as HTMLInputElement & HTMLTextAreaElement;
const bar = () => document.querySelector('.config-bar');
const press = (name: string, nth = 0) => fireEvent.click(form().getAllByRole('button', { name })[nth]);

/** 点「保存并重载」，等到写进去以后换上新的表单（底部那条写着回执，没有未保存的） */
async function save(puts: unknown[], expected = puts.length + 1) {
  press('保存并重载');
  await vi.waitFor(() => expect(puts).toHaveLength(expected));
  await vi.waitFor(() => expect(bar()?.textContent).not.toMatch(/未保存/));
}

describe('密钥：文档里是引用，页面不见原值', () => {
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

  it('列表给引用与引用计数、不给原值；顶层、分组内、数组元素内的密钥只写「已设置」与键名，页面上没有引用与原值', async () => {
    const { app, list } = await bootVault();
    expect(app.plugins.getPlugin('vault')?.config, '插件拿到的是解析后的原值').toEqual(RESOLVED);
    const body = await list();
    expect(body.plugins.find((p: { instanceId: string }) => p.instanceId === 'vault').config).toEqual(DOC);
    expect(body.secretRefCounts).toEqual({
      'vault.signingKey': 1,
      'shared.credential': 2,
      'vault.connections.passphrase': 2,
      'vault.connections.env': 1,
    });
    for (const secret of PLAIN) expect(JSON.stringify(body), '接口回复不得含原值').not.toContain(secret);

    expect(rowOf('签名密钥').textContent).toContain('已设置（键 vault.signingKey）');
    expect(rowOf('凭据').textContent).toContain('已设置（键 shared.credential）');
    expect(rowOf('口令').textContent).toContain('已设置（键 vault.connections.passphrase）');
    expect(rowOf('环境变量').textContent).toContain('已设置（键 vault.connections.env）');
    expect(control('用户').value).toBe('placeholder-user');
    expect(control('地址').value).toBe('ws://127.0.0.1:0');
    const html = document.body.innerHTML;
    expect(html).not.toContain('$secret');
    expect(html).not.toContain('[object Object]');
    for (const secret of PLAIN) expect(html).not.toContain(secret);
    expect(bar(), '没改动时底部没有那一条').toBeNull();
  });

  it('更换：密码框从空开始，映射整份重填；共用的键在顶层与分组里提示替换会改到别处，数组元素里另建新键不提示', async () => {
    await bootVault();
    for (const label of ['签名密钥', '凭据', '口令']) {
      fireEvent.click(form().getByRole('button', { name: `更换${label}` }));
      expect([control(label).type, control(label).value, control(label).placeholder]).toEqual([
        'password',
        '',
        '输入新值替换；留空保持原值',
      ]);
    }
    fireEvent.click(form().getByRole('button', { name: '更换环境变量' }));
    expect(control('环境变量').tagName).toBe('TEXTAREA');
    expect(control('环境变量').value).toBe('');
    expect(control('环境变量').placeholder).toBe('整份重填；留空保持原值');

    expect(rowOf('凭据').textContent).toContain('此密钥被 2 处引用，替换会同时改到另外 1 处');
    expect(rowOf('签名密钥').textContent, '只被引用一处的键不提示').not.toContain('处引用');
    expect(rowOf('口令').textContent).not.toContain('处引用');
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      expect(input.value, '引用不得进输入框').not.toContain('$secret');
    }
    expect(bar(), '只是打开了「更换」，没有改动').toBeNull();
  });

  it('不动密钥只改别的字段：只送改了的键，配置文档与密钥存储都不动，插件照旧拿到原值', async () => {
    const { app, store, secretSaves, puts } = await bootVault();
    fireEvent.change(control('超时'), { target: { value: '60' } });
    expect(rowOf('超时').dataset.changed).toBe('true');
    expect(bar()?.textContent).toContain('1 项未保存');
    await save(puts);

    expect(puts).toEqual([{ timeoutMs: 60 }]);
    expect(store.getPluginConfig('vault')).toEqual({ ...DOC, timeoutMs: 60 });
    expect(secretSaves, '密钥存储没有写入').toEqual([]);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('vault')?.config).toEqual({ ...RESOLVED, timeoutMs: 60 });
    expect(bar()?.textContent).toBe('插件 vault 配置已更新');
  });

  it('有默认值的密钥字段在文档里没有值：框里提示默认值，输入过再删空也算没改，没有可保存的', async () => {
    const schema = {
      uri: { type: 'string', label: 'URI', secret: true, default: 'mongodb://localhost:27017' },
      token: { type: 'string', label: 'Token', secret: true, default: '' },
      timeoutMs: { type: 'number', label: '超时', default: 30 },
    } satisfies ConfigSchema;
    const { store, secretSaves, puts } = await boot('mongo', schema, { timeoutMs: 30 }, { secrets: {} });
    expect(control('URI').value).toBe('');
    expect(control('URI').placeholder).toBe('留空使用默认值 mongodb://localhost:27017');
    fireEvent.change(control('Token'), { target: { value: 'typed' } });
    expect(bar()?.textContent).toContain('1 项未保存');
    fireEvent.change(control('Token'), { target: { value: '' } });
    expect(bar()).toBeNull();
    expect(puts).toEqual([]);
    expect(secretSaves).toEqual([]);
    expect(store.getPluginConfig('mongo')).toEqual({ timeoutMs: 30 });
  });

  it('更换后输入过再删空、清除后撤销：都回到保持，没有要送的', async () => {
    const { puts } = await bootVault();
    fireEvent.click(form().getByRole('button', { name: '更换签名密钥' }));
    fireEvent.change(control('签名密钥'), { target: { value: 'typed' } });
    expect(rowOf('签名密钥').textContent).toContain('保存后替换这个键的值');
    fireEvent.change(control('签名密钥'), { target: { value: '' } });
    fireEvent.click(form().getByRole('button', { name: '更换环境变量' }));
    fireEvent.change(control('环境变量'), { target: { value: 'A=1' } });
    fireEvent.change(control('环境变量'), { target: { value: '' } });
    expect(bar()).toBeNull();

    fireEvent.click(form().getByRole('button', { name: '清除凭据' }));
    expect(rowOf('凭据').textContent).toContain('保存后清除（键 shared.credential）');
    expect(bar()?.textContent).toContain('1 项未保存');
    fireEvent.click(within(rowOf('凭据')).getByRole('button', { name: '撤销凭据' }));
    expect(rowOf('凭据').textContent).toContain('已设置（键 shared.credential）');
    expect(bar()).toBeNull();
    expect(puts).toEqual([]);
  });

  it('输入新值即替换：顶层与分组写进原来的键（共用处一并改），数组元素里另建新键；文档仍是引用，插件拿到新值', async () => {
    const { app, store, secretSaves, puts } = await bootVault();
    const replace = (label: string, value: string) => {
      fireEvent.click(form().getByRole('button', { name: `更换${label}` }));
      fireEvent.change(control(label), { target: { value } });
    };
    replace('签名密钥', 'sign-NEW-PLACEHOLDER');
    replace('凭据', 'cred-NEW-PLACEHOLDER');
    replace('口令', 'pass-NEW-PLACEHOLDER');
    replace('环境变量', 'NEW_VAR=env-NEW-PLACEHOLDER');
    expect(rowOf('口令').textContent).toContain('保存后存为新键');
    expect(bar()?.textContent).toContain('3 项未保存');
    await save(puts);

    expect(puts).toEqual([
      {
        signingKey: 'sign-NEW-PLACEHOLDER',
        auth: { user: 'placeholder-user', credential: 'cred-NEW-PLACEHOLDER' },
        connections: [
          { url: 'ws://127.0.0.1:0', passphrase: 'pass-NEW-PLACEHOLDER', env: { NEW_VAR: 'env-NEW-PLACEHOLDER' } },
        ],
      },
    ]);
    const doc = store.getPluginConfig<typeof DOC>('vault');
    expect(doc.signingKey, '顶层写进原来的键').toEqual(ref('vault.signingKey'));
    expect(doc.auth.credential, '分组写进原来的键').toEqual(ref('shared.credential'));
    const [item] = doc.connections;
    expect(Object.keys(item.passphrase)).toEqual(['$secret']);
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
    expect(app.plugins.getPlugin('vault')?.config).toMatchObject({
      signingKey: 'sign-NEW-PLACEHOLDER',
      auth: { credential: 'cred-NEW-PLACEHOLDER' },
    });
    expect(rowOf('签名密钥').textContent, '换上的新表单里又只写「已设置」').toContain('已设置（键 vault.signingKey）');
  });

  it('「清除」送空值，保存后文档里不再有这个引用', async () => {
    const { store, puts } = await bootVault();
    press('清除签名密钥');
    await save(puts);
    expect(puts).toEqual([{ signingKey: '' }]);
    expect(store.getPluginConfig('vault').signingKey).toBe('');
  });

  it('清除必填的密钥后保存、插件激活失败：配置已写进文件，表单换成新的，回执写在底部那条上，状态写着失败', async () => {
    const { app, store, puts } = await boot('vault', SCHEMA, DOC, {
      others: OTHERS,
      secrets: SECRETS,
      apply: value => {
        if (!value.signingKey) throw new Error('需要签名密钥');
      },
    });
    press('清除签名密钥');
    await save(puts);
    expect(bar()?.textContent).toMatch(
      /^插件 vault 按新配置重新激活失败，已转为 error 态（.*需要签名密钥.*）；配置已写入配置文件$/,
    );
    expect(app.plugins.getPlugin('vault')?.state).toBe('error');
    expect(store.getPluginConfig('vault').signingKey).toBe('');
    // 写成之后草稿已经过时（清掉的键已从密钥存储删掉），表单里没有可撤销的
    expect(form().queryByRole('button', { name: '撤销签名密钥' })).toBeNull();
    expect(await screen.findByText('需要签名密钥', { exact: false, selector: '.plugin-summary-reason' })).toBeTruthy();
  });

  it('「恢复默认」不清掉已存的密钥：顶层与分组的引用原样留着；没有默认值的回到空，数组换成默认的空数组', async () => {
    const { store, puts } = await bootVault();
    fireEvent.click(form().getByRole('button', { name: '更换签名密钥' }));
    fireEvent.change(control('签名密钥'), { target: { value: 'typed' } });
    fireEvent.change(control('超时'), { target: { value: '99' } });
    press('恢复默认');
    expect(rowOf('签名密钥').textContent).toContain('已设置（键 vault.signingKey）');
    expect(bar()?.textContent).toContain('2 项未保存');
    await save(puts);
    expect(puts).toEqual([{ auth: { credential: ref('shared.credential') }, connections: [] }]);
    expect(store.getPluginConfig('vault')).toEqual({
      signingKey: ref('vault.signingKey'),
      auth: { credential: ref('shared.credential') },
      connections: [],
      timeoutMs: 30,
    });
  });

  it('删掉前面的数组条目后，后面条目记住的仍是它自己的引用', async () => {
    const second = { url: 'ws://127.0.0.1:1', passphrase: ref('vault.second.passphrase') };
    const { puts } = await boot(
      'vault',
      SCHEMA,
      { ...DOC, connections: [...DOC.connections, second] },
      { secrets: { ...SECRETS, 'vault.second.passphrase': 'pass-PLACEHOLDER-SECOND' } },
    );
    fireEvent.click(form().getAllByRole('button', { name: '更换口令' })[1]);
    fireEvent.change(control('口令', 1), { target: { value: 'typed' } });
    press('删除第 1 项');
    fireEvent.change(control('口令', 0), { target: { value: '' } });
    await save(puts);
    expect(puts).toEqual([{ connections: [second] }]);
  });
});

describe('宿主没有密钥存储：文档里是明文，页面照旧遮蔽', () => {
  const SCHEMA: ConfigSchema = {
    signingKey: { type: 'string', label: '签名密钥', secret: true },
    auth: { label: '认证', fields: { credential: { type: 'string', label: '凭据', secret: true } } },
    connections: {
      type: 'array',
      label: '连接',
      items: { passphrase: { type: 'string', label: '口令', secret: true } },
    },
    // 名字像凭据：没写 secret 时按名字遮蔽，写了 false 表示插件作者判断过不是凭据
    sessionToken: { type: 'string', label: '会话标记' },
    pageToken: { type: 'string', label: '分页标记', secret: false },
  };

  it('密钥字段与名字像凭据的字段是密码框，secret: false 的照常显示', async () => {
    await boot('vault', SCHEMA, {
      signingKey: 'k9x2',
      auth: { credential: 'q7' },
      connections: [{ passphrase: 'z' }],
      sessionToken: 'session-PLACEHOLDER',
      pageToken: 'page-PLACEHOLDER',
    });
    expect(['签名密钥', '凭据', '口令', '会话标记', '分页标记'].map(label => control(label).type)).toEqual([
      'password',
      'password',
      'password',
      'password',
      'text',
    ]);
    expect(control('分页标记').value).toBe('page-PLACEHOLDER');
  });
});

describe('清空与校验', () => {
  const SCHEMA = {
    limit: { type: 'number', label: '上限' },
    timeoutMs: { type: 'number', label: '超时', default: 30 },
    port: { type: 'number', label: '端口', min: 1, default: 8080 },
    model: { type: 'llm-ref', label: '模型' },
    retry: {
      label: '重试',
      fields: {
        delayMs: { type: 'number', label: '间隔', default: 100 },
        maxTries: { type: 'number', label: '次数' },
      },
    },
  } as unknown as ConfigSchema;
  const STORED = {
    limit: 5,
    timeoutMs: 99,
    port: 8080,
    model: { provider: 'llm-a', model: 'model-a' },
    retry: { delayMs: 500, maxTries: 3 },
  };

  it('数字留空、模型选「跟随默认」：顶层送 null，服务端删除后按默认值补齐；分组里的随整块替换清掉', async () => {
    const { store, puts } = await boot('knobs', SCHEMA, STORED);
    for (const label of ['上限', '超时', '间隔', '次数']) fireEvent.change(control(label), { target: { value: '' } });
    await vi.waitFor(() => expect(control('模型').textContent).toBe('model-a'));
    choose(control('模型'), '跟随默认');
    expect(bar()?.textContent).toContain('5 项未保存');
    await save(puts);
    expect(puts).toEqual([{ limit: null, timeoutMs: null, model: null, retry: {} }]);
    expect(store.getPluginConfig('knobs')).toEqual({ timeoutMs: 30, port: 8080, retry: { delayMs: 100 } });
  });

  it('写法不对的拦下不送；服务端逐项的问题写在对应的行下，草稿留着；逐项撤销回到存着的值', async () => {
    const { puts } = await boot('knobs', SCHEMA, STORED);
    fireEvent.change(control('上限'), { target: { value: '很多' } });
    expect(rowOf('上限').textContent).toContain('要填一个数');
    press('保存并重载');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(bar()?.textContent).toContain('有写法不对的项');
    expect(puts).toEqual([]);

    fireEvent.click(within(rowOf('上限')).getByRole('button', { name: '撤销上限' }));
    expect(control('上限').value).toBe('5');
    fireEvent.change(control('端口'), { target: { value: '0' } });
    press('保存并重载');
    await vi.waitFor(() => expect(puts).toEqual([{ port: 0 }]));
    await vi.waitFor(() => expect(rowOf('端口').textContent).toContain('小于下限 1'));
    expect(control('端口').getAttribute('aria-invalid')).toBe('true');
    expect(control('端口').value).toBe('0');
    expect(bar()?.textContent).toContain('配置校验未通过');
  });
});

describe('失败的插件', () => {
  it('缺配置起不来：详情写着失败与原因，照样能改配置；保存即重新激活，转为运行中', async () => {
    const schema = { endpoint: { type: 'string', label: '服务地址', required: true } } satisfies ConfigSchema;
    const { app, puts } = await boot(
      'flaky',
      schema,
      {},
      {
        apply: value => {
          if (!value.endpoint) throw new Error('缺少服务地址');
        },
      },
    );
    expect(app.plugins.getPlugin('flaky')?.state).toBe('error');
    const summary = () => within(document.querySelector('.plugin-summary') as HTMLElement);
    expect(summary().getByText('失败')).toBeTruthy();
    expect(summary().getByText('缺少服务地址', { exact: false })).toBeTruthy();
    fireEvent.change(control('服务地址'), { target: { value: 'http://upstream.invalid' } });
    await save(puts);
    expect(app.plugins.getPlugin('flaky')?.state).toBe('active');
    expect(await summary().findByText('运行中')).toBeTruthy();
    expect(summary().queryByText('失败')).toBeNull();
  });
});
