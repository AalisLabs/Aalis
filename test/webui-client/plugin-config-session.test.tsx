// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import type { SessionMethodResult } from '../../packages/api-session-protocol/src/index.js';
import {
  type App,
  appService,
  config,
  definePlugin,
  optional,
  pluginsService,
  services,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import type { ConfigSchema } from '../../packages/schema-config/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { ref } from '../fixtures/service-ref.js';
import { ALL, modelPlugin } from '../fixtures/session-settings.js';
import { captureRoutes } from '../fixtures/webui-routes.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { deferred } from '../helpers/deferred.js';
import { type FakeHandlers, FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRest,
  type Harness,
  INIT,
  installDialog,
  LAYER_ORDER,
  renderApp,
  requests,
  restCalls,
} from './harness.js';

// ════════════════════════════════════════════════════════════
// 插件详情的配置表与可按会话设置的项，接到真实的插件路由与宿主上：
// - 每项写作者默认：等于默认标「默认」，不等写「默认：<值>」与「恢复默认」；没有作者默认的项写不设时的含义或「默认：不设」；
// - 可按会话设置的项标「可按会话设置」，全局之外另有设过的标「另有 N 处设置」，点开逐个列出、能跳到那一层或那个会话；
//   全局层由服务偏好承担的项不在表里，在服务偏好块里带这两个标记；会话设置服务不在时都不出现；
// - 只改了可按会话设置的项时按钮写「保存」；深度思考的可选项按这个实例此刻选中的模型取；
// - 这个实例的配置在别处改了：草稿没改动时静默换上，有改动时提示并可载入新值，别的插件的变化与自己保存在途时推来的不提示。
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

const NAME = 'zz-agent';
const MODEL_TEXT = { validate: () => undefined, fromText: () => undefined, toText: () => '' };
const SCHEMA = {
  llm: {
    type: 'llm-ref',
    label: '模型',
    ...MODEL_TEXT,
    session: { appliesTo: ALL, prominence: 'composer', preference: 'llm', unset: '跟随服务偏好' },
  },
  think: {
    type: 'select',
    label: '深度思考',
    dynamicOptions: 'llm-thinking',
    session: { appliesTo: ALL, prominence: 'common', dependsOn: 'llm', unset: '按模型的默认档' },
  },
  iterations: {
    type: 'number',
    label: '最大工具迭代',
    default: 30,
    session: { appliesTo: ALL, prominence: 'advanced' },
  },
  historyLimit: {
    type: 'number',
    label: '历史条数上限',
    default: 0,
    session: { appliesTo: ALL, prominence: 'advanced' },
  },
  prompt: { type: 'textarea', label: '行为准则', default: `<${'很长的准则'.repeat(20)}>` },
  mode: {
    type: 'select',
    label: '模式',
    default: 'b',
    options: [
      { label: '甲', value: 'a' },
      { label: '乙', value: 'b' },
    ],
  },
  flag: { type: 'boolean', label: '开关', default: true },
  tags: { type: 'list', label: '标签', default: ['x', 'y'] },
  aliases: { type: 'list', label: '别名', default: [] },
  token: { type: 'string', label: '令牌', secret: true, default: '<令牌默认>' },
  entries: {
    type: 'array',
    label: '条目',
    items: { name: { type: 'string', label: '名字' } },
    default: [{ name: 'a' }],
  },
} satisfies ConfigSchema;
const STORED = {
  think: 'high',
  iterations: 50,
  historyLimit: 0,
  prompt: '<改过的准则>',
  mode: 'a',
  flag: false,
  tags: ['z'],
  aliases: ['<别名>'],
  token: '<令牌>',
  entries: [],
};
/** 全局之外写过的各处：平台类型档、群的场所、一个子会话各一处 */
const OVERRIDES: SessionMethodResult<'session/config/overrides'> = {
  items: [
    {
      key: 'iterations',
      entries: [
        { target: { layer: { scope: 'platformType', platform: 'onebot', type: 'group' } }, value: 15 },
        { target: { layer: { scope: 'place', key: 'onebot:group:20001' } }, value: 10 },
        { target: { sessionId: 's2', title: '<子>', parent: { sessionId: 's1', title: '<父>' } }, value: 5 },
      ],
    },
    {
      key: 'llm',
      entries: [{ target: { sessionId: 's1', title: '<父>' }, value: { provider: 'zz-llm', model: 'm2' } }],
    },
  ],
};
const THINKING = `/api/models/llm-thinking?dependency=${encodeURIComponent('zz-llm/m1')}`;

/**
 * 按文档登记插件（它可选地用 llm，模型 zz-llm/m1、m2 各由一个条目提供）、挂上真实路由，在 /plugins/zz-agent 上渲染整个前端；
 * handlers 是会话连接上另给的回应，put 包住保存配置的路由（在途时可以先不回），models 是服务列表里 llm 的提供者
 */
async function boot({
  handlers = {},
  put = run => run(),
  models = ['zz-llm/m1', 'zz-llm/m2'],
}: {
  handlers?: FakeHandlers;
  put?: (run: () => Promise<Response>) => Promise<Response>;
  models?: string[];
} = {}) {
  const { app, store } = hostedApp({ plugins: { [NAME]: structuredClone(STORED) } });
  apps.push(app);
  await app.plugin(modelPlugin('zz-llm', ['m1', 'm2']));
  await registerFromDoc(
    app,
    store,
    definePlugin({ name: NAME, configSchema: SCHEMA, uses: { config, llm: optional(llm) }, apply() {} }),
  );
  await app.plugins.idle();
  const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig, services });
  const { expressApp, invoke } = captureRoutes();
  registerPluginRoutes(
    expressApp,
    {
      app: bound.app,
      source: ref(),
      plugins: bound.plugins,
      hostConfig: bound.hostConfig,
      tools: ref(),
      commands: ref(),
      services: bound.services.use,
      self: 'zz-webui',
      versions: () => () => undefined,
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const list = async () => JSON.parse(JSON.stringify((await invoke('GET /api/plugins')).body));
  const rest: FakeRest = {
    '/api/plugins': list,
    '/api/services': {
      services: {
        llm: {
          providers: models.map(contextId => ({ contextId, priority: 0, exclusive: false })),
          preferred: null,
        },
      },
    },
    [THINKING]: { details: [{ value: 'high', label: '高', default: true }] },
    [`/api/plugins/${NAME}/config`]: ({ body }: { body?: unknown }) =>
      put(async () => {
        const reply = await invoke('PUT /api/plugins/:name/config', { params: { name: NAME }, body, headers: {} });
        return Response.json(reply.body ?? {}, { status: reply.status });
      }),
  };
  ui = await renderApp(
    `/plugins/${NAME}`,
    {
      'session/config/overrides': () => OVERRIDES,
      'session/config/layers': () => ({
        layers: [
          { layer: { scope: 'global' } },
          { layer: { scope: 'platformType', platform: 'onebot', type: 'group' }, label: '群' },
          {
            layer: { scope: 'place', key: 'onebot:group:20001' },
            label: '群「读书会」',
            platform: 'onebot',
            type: 'group',
          },
        ],
        order: LAYER_ORDER,
      }),
      ...handlers,
    },
    rest,
  );
  await screen.findByRole('heading', { name: '配置' });
  return { store };
}

const form = () => within(screen.getByRole('heading', { name: '配置' }).closest('.config-form') as HTMLElement);
/** 标签为 label 的那一行 */
const rowOf = (label: string) =>
  within(
    form()
      .getAllByText(label)
      .find(node => node.closest('.field-row-label'))
      ?.closest('.field-row') as HTMLElement,
  );
const control = (label: string) =>
  document.getElementById((form().getByText(label, { selector: 'label' }) as HTMLLabelElement).htmlFor) as
    | HTMLInputElement
    | HTMLTextAreaElement;
const bar = () => document.querySelector('.config-bar')?.textContent ?? '';
const pushPlugins = () => act(() => FakeWebSocket.at('/admin').push({ type: 'plugins.changed' }));

describe('作者默认', () => {
  it('等于默认标「默认」；不等写「默认：<值>」（选项写标签、开关写开或关、列表按界面语言连接、空列表写「无」、长文字一行写完悬停看全文）并有「恢复默认」；密钥不写默认值；没有作者默认的项设了写「默认：不设」；对象数组写 N 项', async () => {
    await boot();
    await vi.waitFor(() => expect(rowOf('最大工具迭代').getByText('默认：30')).toBeTruthy());
    expect(rowOf('历史条数上限').getByText('默认')).toBeTruthy();
    expect(rowOf('历史条数上限').queryByRole('button', { name: /恢复默认/ })).toBeNull();
    expect(rowOf('模式').getByText('默认：乙')).toBeTruthy();
    expect(rowOf('开关').getByText('默认：开')).toBeTruthy();
    expect(rowOf('标签').getByText('默认：x、y')).toBeTruthy();
    expect(rowOf('别名').getByText('默认：无')).toBeTruthy();
    const long = rowOf('行为准则').getByText(/^默认：<很长的准则/);
    expect(long.getAttribute('title')).toBe(`默认：<${'很长的准则'.repeat(20)}>`);
    expect(long.classList.contains('field-default')).toBe(true);
    expect(rowOf('令牌').queryByText(/默认/)).toBeNull();
    expect(rowOf('深度思考').getByText('默认：不设')).toBeTruthy();
    expect(within(form().getByRole('region', { name: '条目' })).getByText('默认：1 项')).toBeTruthy();

    fireEvent.click(rowOf('最大工具迭代').getByRole('button', { name: '最大工具迭代恢复默认' }));
    expect((control('最大工具迭代') as HTMLInputElement).value).toBe('30');
    expect(rowOf('最大工具迭代').getByText('默认')).toBeTruthy();
    fireEvent.click(rowOf('深度思考').getByRole('button', { name: '深度思考恢复默认' }));
    expect(rowOf('深度思考').getByText('不设时：按模型的默认档')).toBeTruthy();
    expect(bar()).toContain('2 项未保存');
  });
});

describe('可按会话设置的项', () => {
  it('写过的各处没取到：名字旁写原因、点按重取，取到之后照常标「另有 N 处设置」', async () => {
    let fail = true;
    await boot({
      handlers: {
        'session/config/overrides': () => {
          if (fail) throw new Error('<断了>');
          return OVERRIDES;
        },
      },
    });
    const retry = await rowOf('最大工具迭代').findByRole('button', { name: '别处的设置没取到：<断了>（点按重试）' });
    fail = false;
    fireEvent.click(retry);
    expect(await rowOf('最大工具迭代').findByRole('button', { name: '另有 3 处设置' })).toBeTruthy();
    expect(rowOf('最大工具迭代').queryByRole('button', { name: /没取到/ })).toBeNull();
  });

  it('标「可按会话设置」，另有设过的标「另有 N 处设置」，点开逐个列出（场所写称呼与层名、不带平台，子会话带父会话，引号用「」），每处链到那一层或那个会话的设置；模型不在表里，在服务偏好块里带标记', async () => {
    await boot();
    await vi.waitFor(() => expect(rowOf('最大工具迭代').getByText('可按会话设置')).toBeTruthy());
    expect(rowOf('行为准则').queryByText('可按会话设置')).toBeNull();
    expect(requests('session/config/overrides')).toEqual([{ plugin: NAME }]);
    expect(form().queryByText('模型', { selector: 'label' })).toBeNull();
    const toggle = rowOf('最大工具迭代').getByRole('button', { name: '另有 3 处设置' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const places = within(rowOf('最大工具迭代').getByRole('list', { name: '另有 3 处设置' }));
    expect(places.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      '平台类型档「onebot · 群」15',
      '群「读书会」（场所）10',
      '子会话「<子>」（父会话「<父>」）5',
    ]);
    expect(places.getByRole('link', { name: '平台类型档「onebot · 群」' }).getAttribute('href')).toBe(
      '/settings/session-defaults?layer=platformType%3Aonebot%3Agroup',
    );
    expect(places.getByRole('link', { name: '子会话「<子>」（父会话「<父>」）' }).getAttribute('href')).toBe(
      '/s/s2/settings',
    );
    fireEvent.click(toggle);
    expect(rowOf('最大工具迭代').queryByRole('list')).toBeNull();

    const preferences = within(screen.getByRole('region', { name: '服务偏好' }));
    expect(preferences.getByText('可按会话设置')).toBeTruthy();
    expect(preferences.getByRole('button', { name: '另有 1 处设置' })).toBeTruthy();
  });

  it('只有一个模型、本插件也没设偏好时，服务偏好块照样有模型那一行，带两个标记', async () => {
    await boot({ models: ['zz-llm/m1'] });
    const preferences = within(await screen.findByRole('region', { name: '服务偏好' }));
    expect(await preferences.findByText('可按会话设置')).toBeTruthy();
    expect(preferences.getByRole('button', { name: '另有 1 处设置' })).toBeTruthy();
  });

  it('只有一个模型、会话设置服务不在时，服务偏好块没有模型那一行', async () => {
    await boot({
      models: ['zz-llm/m1'],
      handlers: { initialize: () => ({ ...INIT, features: { ...INIT.features, settings: false } }) },
    });
    await vi.waitFor(() => expect(restCalls().map(call => call.path)).toContain('/api/services'));
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(screen.queryByRole('region', { name: '服务偏好' })).toBeNull();
  });

  it('会话设置服务不在（功能位 settings 为假）：两个标记都不出现，也不取写过的各处', async () => {
    await boot({ handlers: { initialize: () => ({ ...INIT, features: { ...INIT.features, settings: false } }) } });
    await vi.waitFor(() => expect(rowOf('最大工具迭代').getByText('默认：30')).toBeTruthy());
    expect(form().queryByText('可按会话设置')).toBeNull();
    expect(requests('session/config/overrides')).toEqual([]);
  });

  it('只改了可按会话设置的项时按钮写「保存」，另改了普通配置写「保存并重载」', async () => {
    await boot();
    fireEvent.change(control('最大工具迭代'), { target: { value: '40' } });
    expect(form().getByRole('button', { name: '保存' })).toBeTruthy();
    expect(form().queryByRole('button', { name: '保存并重载' })).toBeNull();
    fireEvent.change(control('行为准则'), { target: { value: '<新准则>' } });
    expect(form().getByRole('button', { name: '保存并重载' })).toBeTruthy();
  });

  it('深度思考的可选项按这个实例此刻选中的模型（条目 id）取', async () => {
    await boot();
    await vi.waitFor(() => expect(restCalls().map(call => call.path)).toContain(THINKING));
  });
});

describe('配置在别处改了', () => {
  it('别的插件状态变化推来的不提示；这个实例的配置变了而草稿没改动时静默换上', async () => {
    const { store } = await boot();
    await pushPlugins();
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(bar()).not.toContain('配置已在别处改动');
    store.setPluginConfig(NAME, { ...store.getPluginConfig(NAME), iterations: 60 });
    await pushPlugins();
    await vi.waitFor(() => expect((control('最大工具迭代') as HTMLInputElement).value).toBe('60'));
    expect(bar()).not.toContain('配置已在别处改动');
  });

  it('有草稿时提示「配置已在别处改动」，草稿留着；「载入新值」换上别处的值', async () => {
    const { store } = await boot();
    fireEvent.change(control('行为准则'), { target: { value: '<草稿>' } });
    store.setPluginConfig(NAME, { ...store.getPluginConfig(NAME), iterations: 60 });
    await pushPlugins();
    await vi.waitFor(() => expect(bar()).toContain('配置已在别处改动'));
    expect(control('行为准则').value).toBe('<草稿>');
    expect((control('最大工具迭代') as HTMLInputElement).value).toBe('50');
    fireEvent.click(form().getByRole('button', { name: '载入新值' }));
    expect((control('最大工具迭代') as HTMLInputElement).value).toBe('60');
    expect(control('行为准则').value).toBe('<改过的准则>');
    expect(bar()).not.toContain('配置已在别处改动');
  });

  it('自己的保存在途时推来的不提示冲突，保存完成后换上重取的新表单', async () => {
    const held = deferred();
    const { store } = await boot({
      put: async run => {
        await held.promise;
        return run();
      },
    });
    fireEvent.change(control('行为准则'), { target: { value: '<草稿>' } });
    fireEvent.click(form().getByRole('button', { name: '保存并重载' }));
    store.setPluginConfig(NAME, { ...store.getPluginConfig(NAME), iterations: 60 });
    await pushPlugins();
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(bar()).not.toContain('配置已在别处改动');
    held.resolve();
    await vi.waitFor(() => expect(bar()).not.toMatch(/未保存/));
    expect(control('行为准则').value).toBe('<草稿>');
    expect((control('最大工具迭代') as HTMLInputElement).value).toBe('60');
    expect(bar()).not.toContain('配置已在别处改动');
  });
});
