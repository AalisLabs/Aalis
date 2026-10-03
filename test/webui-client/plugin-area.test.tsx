// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRequest,
  type FakeRest,
  type Harness,
  installDialog,
  lists,
  renderApp,
  restCalls,
} from './harness.js';
import { BOARD, NOTES, ROSTER, SETTINGS_PAGE } from './pages.js';

// ════════════════════════════════════════════════════════════
// 插件区：左栏是实例树（按子系统分组到插件、再到实例，组名与顺序取子系统目录，顶上是市场与「只看有问题的」）；
// 详情由宿主拼装：头部（包名、版本、状态与原因，启停、重载、卸载）、依赖与贡献（缺的服务可以一键启用提供者）、
// 页面（全部页面与位置，插件前端另列申请的宿主数据能力）、实例；界面所在的插件停不掉、卸不了。
// 会话服务不在时链到提供会话协议的插件详情，没装时链到市场；市场装完跳到这个插件详情的配置区。
// 管理动作做完等最新的一次插件列表取回再跳，不闪「没有这个插件」
// ════════════════════════════════════════════════════════════

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  stubViewport(1440);
});

afterEach(() => {
  app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 插件列表的一项 */
function plugin(instanceId: string, fields: Record<string, unknown> = {}) {
  return {
    name: instanceId.split(':')[0],
    instanceId,
    state: 'active',
    reusable: false,
    provides: [],
    requiredServices: [],
    optionalServices: [],
    missing: [],
    tools: [],
    commands: [],
    config: {},
    defaultConfig: {},
    ...fields,
  };
}

const PLUGINS = [
  plugin('zz-mongo', { displayName: '文档库', subsystem: 'memory', version: '1.2.3', provides: ['zz-store'] }),
  plugin('zz-agent', {
    displayName: '对话代理',
    subsystem: 'agent',
    state: 'pending',
    requiredServices: ['events', 'zz-store', 'zz-model'],
    optionalServices: ['zz-vision'],
    missing: ['zz-model'],
    tools: ['zz_read', 'zz_write'],
    commands: ['zz-reset'],
  }),
  plugin('zz-model', { displayName: '模型服务', subsystem: 'llm', state: 'disabled', provides: ['zz-model'] }),
  plugin('zz-model:backup', {
    displayName: '模型服务',
    subsystem: 'llm',
    state: 'error',
    error: '连不上上游',
    reusable: true,
    provides: ['zz-model'],
  }),
  plugin('zz-own', { displayName: '自定义', subsystem: 'zz-group' }),
  plugin('zz-plain', { displayName: '没归类' }),
  plugin('zz-ui', { displayName: '界面服务', subsystem: 'platform', self: true }),
  plugin('zz-sessions', { displayName: '会话服务', subsystem: 'session', provides: ['session-protocol'] }),
];

/** 插件列表与管理动作：动作按请求记下，改了状态再回列表 */
function pluginRest(rows: Array<Record<string, unknown>> = PLUGINS, extra: FakeRest = {}): FakeRest {
  return { '/api/plugins': () => ({ plugins: rows, secretRefCounts: {} }), ...extra };
}

const tree = () => within(screen.getByRole('navigation', { name: '插件' }));
const groups = () =>
  tree()
    .queryAllByRole('heading', { level: 3 })
    .map(heading => heading.textContent);
const detail = () => within(screen.getByRole('main'));
const posts = (path: string) => restCalls().filter(call => call.method === 'POST' && call.path === path);

describe('实例树', () => {
  it('按子系统分组：目录里的按目录顺序，目录外的原样排在后面，没声明的归「其他」；多实例挂在插件下面', async () => {
    app = await renderApp('/plugins', {}, pluginRest());
    await tree().findByRole('link', { name: '文档库' });
    expect(groups()).toEqual(['平台', 'Agent', 'LLM', '记忆', '会话', 'zz-group', '其他']);
    const llm = within(tree().getByRole('list', { name: 'LLM' }));
    expect(llm.getByRole('link', { name: /模型服务/ }).getAttribute('href')).toBe('/plugins/zz-model');
    expect(
      within(llm.getByRole('list', { name: '模型服务的其余实例' })).getByRole('link', { name: /backup/ }),
    ).toBeTruthy();
    expect(detail().getByText('选一个插件')).toBeTruthy();
  });

  it('左栏是抽屉的宽度下，「选一个插件」旁可以打开插件列表', async () => {
    stubViewport(900);
    app = await renderApp('/plugins', {}, pluginRest());
    const shell = document.querySelector('[data-phone]') as HTMLElement;
    expect(shell.dataset.drawer).toBeUndefined();
    fireEvent.click(await detail().findByRole('button', { name: '打开插件列表' }));
    expect(shell.dataset.drawer).toBe('left');
  });

  it('正常运行的行不写状态；缺服务、失败、已停用写短句，前两种行首有标记；「只看有问题的」只留它们', async () => {
    app = await renderApp('/plugins', {}, pluginRest());
    const row = async (name: RegExp | string) => (await tree().findByRole('link', { name })).textContent;
    expect(await row('文档库')).toBe('文档库');
    expect(await row(/对话代理/)).toBe('需要处理对话代理缺服务');
    expect(await row(/^模型服务/)).toBe('模型服务已停用');
    expect(await row(/backup/)).toBe('出错backup失败');

    fireEvent.click(tree().getByRole('switch', { name: '只看有问题的' }));
    expect(groups()).toEqual(['Agent', 'LLM']);
    expect(
      tree()
        .getAllByRole('link')
        .map(link => link.textContent),
    ).toEqual(['市场', '需要处理对话代理缺服务', '模型服务已停用', '出错backup失败']);
  });

  it('市场在树的顶上，打开着时是当前项、图标栏仍在「插件」；当前打开的插件是当前项，定义名是 market 的也一样', async () => {
    app = await renderApp('/plugins/market', {}, pluginRest([...PLUGINS, plugin('market', { displayName: '集市' })]));
    expect((await tree().findByRole('link', { name: '集市' })).getAttribute('aria-current')).toBe('page');
    fireEvent.click(tree().getByRole('link', { name: '市场' }));
    expect(app.where()).toBe('/market');
    expect(tree().getByRole('link', { name: '市场' }).getAttribute('aria-current')).toBe('page');
    const rail = within(screen.getByRole('navigation', { name: '图标栏' }));
    expect(rail.getByRole('link', { name: '插件' }).getAttribute('aria-current')).toBe('page');
  });

  it('插件列表没取到：左栏写明原因，可以重试', async () => {
    let fail = true;
    app = await renderApp(
      '/plugins',
      {},
      {
        '/api/plugins': () =>
          fail
            ? Response.json({ error: '插件管理服务不可用' }, { status: 500 })
            : { plugins: PLUGINS, secretRefCounts: {} },
      },
    );
    expect((await tree().findByRole('alert')).textContent).toContain('插件管理服务不可用');
    fail = false;
    fireEvent.click(tree().getByRole('button', { name: '重试' }));
    expect(await tree().findByRole('link', { name: '文档库' })).toBeTruthy();
  });
});

describe('详情', () => {
  it('头部写包名、版本、状态与原因；停用、重载按实例发，做完重取列表；出错用 Toast 写原因', async () => {
    let state = 'active';
    app = await renderApp(
      '/plugins/zz-mongo',
      {},
      pluginRest(undefined, {
        '/api/plugins': () => ({
          plugins: PLUGINS.map(row => (row.instanceId === 'zz-mongo' ? { ...row, state } : row)),
        }),
        '/api/plugins/zz-mongo/disable': () => {
          state = 'disabled';
          return { ok: true, message: '插件 zz-mongo 已禁用' };
        },
        '/api/plugins/zz-mongo/reload': () => Response.json({ error: '插件 zz-mongo 当前不接受重载' }, { status: 409 }),
        '/api/plugins/zz-mongo/enable': () => {
          state = 'active';
          return { ok: true };
        },
      }),
    );
    const summary = within(
      await detail()
        .findByText('zz-mongo · 版本 1.2.3')
        .then(node => node.parentElement as HTMLElement),
    );
    expect(summary.getByText('运行中')).toBeTruthy();
    fireEvent.click(summary.getByRole('button', { name: '重载' }));
    expect((await screen.findByRole('alert')).textContent).toContain('重载失败：插件 zz-mongo 当前不接受重载');
    fireEvent.click(summary.getByRole('button', { name: '停用' }));
    expect(await summary.findByText('已停用')).toBeTruthy();
    expect(summary.queryByRole('button', { name: '重载' })).toBeNull();
    fireEvent.click(summary.getByRole('button', { name: '启用' }));
    expect(await summary.findByText('运行中')).toBeTruthy();
    expect(posts('/api/plugins/zz-mongo/disable')).toHaveLength(1);
    expect(posts('/api/plugins/zz-mongo/enable')).toHaveLength(1);
  });

  it('界面所在的插件：停用、卸载不可点，写明原因；重载照常', async () => {
    app = await renderApp('/plugins/zz-ui', {}, pluginRest());
    expect(await detail().findByText('这个界面由它提供，不能从界面停用或卸载。')).toBeTruthy();
    for (const name of ['停用', '卸载']) {
      expect((detail().getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    expect((detail().getByRole('button', { name: '重载' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('依赖与贡献：宿主自己提供的服务不列；缺的服务列出已装没启用的提供者，一键启用；另写提供的服务、工具、指令', async () => {
    app = await renderApp(
      '/plugins/zz-agent',
      {},
      pluginRest(undefined, { '/api/plugins/zz-model/enable': { ok: true } }),
    );
    const relations = within(
      (await detail().findByRole('heading', { name: '依赖与贡献' })).closest('section') as HTMLElement,
    );
    expect(relations.getByText('zz-store（文档库）')).toBeTruthy();
    expect(relations.getByText('zz-model：缺')).toBeTruthy();
    expect(relations.queryByText(/events/)).toBeNull();
    expect(relations.getByText('zz_read、zz_write')).toBeTruthy();
    expect(relations.getByText('/zz-reset')).toBeTruthy();
    // 两个实例都提供它：停用的与失败的都能一键启用，按钮上写明是哪个实例
    expect(relations.getAllByRole('button').map(button => button.textContent)).toEqual([
      '启用模型服务',
      '启用模型服务 · backup',
    ]);
    fireEvent.click(relations.getAllByRole('button', { name: '启用模型服务' })[0]);
    await vi.waitFor(() => expect(posts('/api/plugins/zz-model/enable')).toHaveLength(1));
    expect(detail().getByText('缺服务')).toBeTruthy();
    expect(detail().getByText('zz-model', { selector: '.plugin-summary-reason' })).toBeTruthy();
  });

  it('页面：列出全部页面与位置，插件页面与设置里的一节可以点开；插件前端另写申请的宿主数据能力；没有页面时整块不出现', async () => {
    const pages = [
      { ...BOARD, instance: 'zz-mongo' },
      { ...SETTINGS_PAGE, instance: 'zz-mongo' },
      { ...NOTES, instance: 'zz-mongo' },
      { ...ROSTER, instance: 'zz-mongo' },
    ];
    app = await renderApp('/plugins/zz-mongo', {}, pluginRest(undefined, { '/api/pages': { pages } }));
    const block = within((await detail().findByRole('heading', { name: '页面' })).closest('section') as HTMLElement);
    expect(block.getByRole('link', { name: '看板' }).getAttribute('href')).toBe('/p/zz-mongo/board');
    expect(block.getByRole('link', { name: '权限' }).getAttribute('href')).toBe('/settings/p/zz-mongo/auth');
    expect(block.queryByRole('link', { name: '笔记' })).toBeNull();
    const text = (title: string) => block.getByText(title).parentElement?.textContent;
    expect(text('看板')).toBe('看板插件页面，打开后可以固定到图标栏；插件前端，不申请宿主数据');
    expect(text('笔记')).toBe('笔记会话面板，在会话右侧面板的「+」里打开');
    expect(text('子会话')).toBe(
      '子会话会话面板，在会话右侧面板的「+」里打开；插件前端，申请宿主数据：读会话树与状态、停止会话的回合',
    );
    app.close();

    app = await renderApp('/plugins/zz-own', {}, pluginRest(undefined, { '/api/pages': { pages } }));
    await detail().findByText('运行中');
    expect(detail().queryByRole('heading', { name: '页面' })).toBeNull();
    expect(detail().queryByRole('heading', { name: '依赖与贡献' })).toBeNull();
  });

  it('实例：列出全部实例；新建写错了原因写在框下，新建成功跳到新实例；移除先确认', async () => {
    const created: unknown[] = [];
    app = await renderApp(
      '/plugins/zz-model',
      {},
      pluginRest(
        PLUGINS.map(row => (row.name === 'zz-model' ? { ...row, reusable: true } : row)),
        {
          '/api/plugins/zz-model/instances': ({ body }: FakeRequest) => {
            created.push(body);
            const { suffix } = body as { suffix: string };
            return suffix === 'bad name'
              ? Response.json({ error: 'suffix 只能包含字母、数字、下划线和连字符' }, { status: 400 })
              : { ok: true, instanceId: `zz-model:${suffix}`, message: `已创建实例 zz-model:${suffix}` };
          },
          '/api/plugins/zz-model%3Abackup/instance': { ok: true },
        },
      ),
    );
    const block = within((await detail().findByRole('heading', { name: '实例' })).closest('section') as HTMLElement);
    expect(block.getAllByRole('link').map(link => link.textContent)).toEqual(['主实例已停用', '出错backup失败']);
    fireEvent.change(block.getByLabelText('新实例的名字'), { target: { value: 'bad name' } });
    fireEvent.click(block.getByRole('button', { name: '新建实例' }));
    expect(await block.findByText('suffix 只能包含字母、数字、下划线和连字符')).toBeTruthy();
    fireEvent.change(block.getByLabelText('新实例的名字'), { target: { value: 'vision' } });
    fireEvent.click(block.getByRole('button', { name: '新建实例' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model%3Avision'));
    expect(created).toEqual([{ suffix: 'bad name' }, { suffix: 'vision' }]);
  });

  it('移除实例先确认，确认后发 DELETE；移除的是正在看的实例时回到主实例', async () => {
    app = await renderApp(
      '/plugins/zz-model%3Abackup',
      {},
      pluginRest(undefined, { '/api/plugins/zz-model%3Abackup/instance': { ok: true } }),
    );
    const block = within((await detail().findByRole('heading', { name: '实例' })).closest('section') as HTMLElement);
    fireEvent.click(
      within(block.getByRole('link', { name: /backup/ }).closest('li') as HTMLElement).getByRole('button', {
        name: '更多',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: '移除' }));
    const dialog = within(screen.getByRole('dialog', { name: '移除实例「backup」？' }));
    fireEvent.click(dialog.getByRole('button', { name: '移除' }));
    await vi.waitFor(() =>
      expect(
        restCalls()
          .filter(call => call.method === 'DELETE')
          .map(call => call.path),
      ).toEqual(['/api/plugins/zz-model%3Abackup/instance']),
    );
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model'));
  });

  it('其余实例的详情头部有「移除实例」（手机上实例行没有「更多」）：先确认，确认后发 DELETE、回到主实例；主实例没有', async () => {
    stubViewport(390);
    app = await renderApp(
      '/plugins/zz-model%3Abackup',
      {},
      pluginRest(undefined, { '/api/plugins/zz-model%3Abackup/instance': { ok: true } }),
    );
    const summary = () => within(document.querySelector('.plugin-summary') as HTMLElement);
    await vi.waitFor(() => expect(summary().getByRole('button', { name: '移除实例' })).toBeTruthy());
    expect(summary().queryByRole('button', { name: '卸载' })).toBeNull();
    fireEvent.click(summary().getByRole('button', { name: '移除实例' }));
    const dialog = within(screen.getByRole('dialog', { name: '移除实例「backup」？' }));
    fireEvent.click(dialog.getByRole('button', { name: '移除' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model'));
    expect(
      restCalls()
        .filter(call => call.method === 'DELETE')
        .map(call => call.path),
    ).toEqual(['/api/plugins/zz-model%3Abackup/instance']);
    expect(summary().queryByRole('button', { name: '移除实例' })).toBeNull();
    expect(summary().getByRole('button', { name: '卸载' })).toBeTruthy();
  });

  it('新建实例的回执先到、插件列表的变化随后推来：等最新的一次取回再跳，不闪「没有这个插件」', async () => {
    const rows = PLUGINS.map(row => (row.name === 'zz-model' ? { ...row, reusable: true } : row));
    const vision = plugin('zz-model:vision', { displayName: '模型服务', subsystem: 'llm', reusable: true });
    let created = false;
    const answers: Array<() => void> = [];
    app = await renderApp(
      '/plugins/zz-model',
      {},
      pluginRest(rows, {
        '/api/plugins': () =>
          created
            ? new Promise(resolve => answers.push(() => resolve({ plugins: [...rows, vision], secretRefCounts: {} })))
            : { plugins: rows, secretRefCounts: {} },
        '/api/plugins/zz-model/instances': () => {
          created = true;
          return { ok: true, instanceId: 'zz-model:vision', message: '已创建实例 zz-model:vision' };
        },
      }),
    );
    const block = within((await detail().findByRole('heading', { name: '实例' })).closest('section') as HTMLElement);
    fireEvent.change(block.getByLabelText('新实例的名字'), { target: { value: 'vision' } });
    fireEvent.click(block.getByRole('button', { name: '新建实例' }));
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    act(() => FakeWebSocket.at('/admin').push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => {});
    expect(app.where()).toBe('/plugins/zz-model');
    act(() => answers[1]());
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model%3Avision'));
    expect(detail().queryByText('没有这个插件')).toBeNull();
    expect(await detail().findByText('backup', { exact: false })).toBeTruthy();
  });

  it('卸载先确认（列出依赖它的），卸掉后回到插件区；没卸成时 Toast 写服务层给的原因', async () => {
    let refuse = true;
    app = await renderApp(
      '/plugins/zz-mongo',
      {},
      pluginRest(undefined, {
        '/api/marketplace/depgraph?name=zz-mongo': {
          upstream: { name: 'zz-mongo', present: true, children: [] },
          downstream: {
            name: 'zz-mongo',
            present: true,
            children: [{ name: 'zz-agent', present: true, children: [] }],
          },
          services: { required: [], provides: ['zz-store'] },
          serviceDependents: ['zz-agent'],
        },
        '/api/marketplace/uninstall': () =>
          refuse
            ? { ok: false, message: '卸载会破坏依赖：zz-agent 依赖此插件提供的服务' }
            : { ok: true, message: '插件 zz-mongo 已卸载' },
      }),
    );
    fireEvent.click(await detail().findByRole('button', { name: '卸载' }));
    const dialog = within(screen.getByRole('dialog', { name: '卸载「文档库」？' }));
    expect(await dialog.findByText('依赖它提供的服务（卸载会被拒）')).toBeTruthy();
    expect(dialog.getAllByText('zz-agent')).toHaveLength(2);
    expect(document.activeElement?.textContent).toBe('取消');
    fireEvent.click(dialog.getByRole('button', { name: '卸载' }));
    expect((await screen.findByRole('alert')).textContent).toContain('卸载失败：卸载会破坏依赖');
    refuse = false;
    fireEvent.click(dialog.getByRole('button', { name: '卸载' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins'));
    expect(posts('/api/marketplace/uninstall').map(call => call.body)).toEqual([
      { name: 'zz-mongo' },
      { name: 'zz-mongo' },
    ]);
  });

  it('不在列表里的插件：写明没有这个插件，链到市场', async () => {
    app = await renderApp('/plugins/zz-gone', {}, pluginRest());
    expect(await detail().findByText('没有这个插件')).toBeTruthy();
    expect(detail().getByRole('link', { name: '去市场' }).getAttribute('href')).toBe('/market');
  });
});

describe('会话服务未启用', () => {
  it('链到提供会话协议的插件详情；它没装时链到市场', async () => {
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, pluginRest());
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    const left = within(screen.getByRole('navigation', { name: '会话' }));
    expect((await left.findByRole('link', { name: '去插件详情' })).getAttribute('href')).toBe('/plugins/zz-sessions');
    expect(within(screen.getByRole('main')).getByRole('link', { name: '去插件详情' })).toBeTruthy();
    app.close();

    app = await renderApp(
      '/',
      { 'sessions/list': lists(() => []) },
      pluginRest(PLUGINS.filter(row => row.instanceId !== 'zz-sessions')),
    );
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    expect((await within(screen.getByRole('main')).findByRole('link', { name: '去市场' })).getAttribute('href')).toBe(
      '/market',
    );
  });
});

describe('市场', () => {
  const PACKAGES = [
    {
      name: '@aalis/plugin-zz-notes',
      description: '记笔记',
      version: '0.3.0',
      installed: false,
      updatable: false,
      official: true,
      category: 'plugin',
      downloads: 1234,
      license: 'MIT',
      links: { homepage: 'javascript:alert(1)' },
    },
    {
      name: 'zz-theme-ui',
      description: '换一套前端',
      version: '1.0.0',
      installed: true,
      resolved: '0.9.0',
      origin: 'registry',
      updatable: true,
      official: false,
      category: 'interface',
      links: { homepage: 'https://example.invalid/ui' },
    },
  ];
  const SYSTEM = [
    { name: '@aalis/core', version: '0.19.0', latest: '0.20.0', kind: 'core', origin: 'registry', updatable: true },
  ];
  const GRAPH = {
    upstream: {
      name: '@aalis/plugin-zz-notes',
      present: false,
      children: [{ name: '@aalis/api-zz-notes', present: false, children: [] }],
    },
    downstream: { name: '@aalis/plugin-zz-notes', present: false, children: [] },
    services: { required: [{ service: 'zz-store', providedBy: 'zz-mongo' }], provides: ['zz-notes'] },
    serviceDependents: [],
  };

  function marketRest(extra: FakeRest = {}): FakeRest {
    return pluginRest(undefined, {
      '/api/marketplace?q=': { packages: PACKAGES, warning: '安装源查不到最新版' },
      '/api/system-components': { components: SYSTEM },
      '/api/marketplace/depgraph?name=%40aalis%2Fplugin-zz-notes': GRAPH,
      ...extra,
    });
  }
  const entries = () =>
    within(screen.getByRole('list', { name: '包' }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('.market-entry-title span, .market-entry-title a')?.textContent);

  it('默认只列插件；类型、状态与搜索在本页筛；不安全的链接不当链接；服务端的说明写在头部下面', async () => {
    app = await renderApp('/market', {}, marketRest());
    await screen.findByRole('list', { name: '包' });
    expect(entries()).toEqual(['@aalis/plugin-zz-notes']);
    expect(screen.queryByRole('link', { name: '@aalis/plugin-zz-notes' })).toBeNull();
    expect(screen.getByText('安装源查不到最新版')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'all' } });
    expect(entries()).toEqual(['@aalis/plugin-zz-notes', 'zz-theme-ui', '@aalis/core']);
    expect(screen.getByRole('link', { name: 'zz-theme-ui' }).getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'installed' } });
    expect(entries()).toEqual(['zz-theme-ui', '@aalis/core']);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '前端' } });
    expect(entries()).toEqual(['zz-theme-ui']);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '没有这个' } });
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(entries()).toEqual(['@aalis/plugin-zz-notes', 'zz-theme-ui', '@aalis/core']);
  });

  it('安装先确认（列出一并装上的与要用的服务），装上插件后跳到它详情的配置区', async () => {
    // jsdom 没有 scrollIntoView：记下是谁滚进视野，用完拿掉
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled(this.id);
    };
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });
    const notes = plugin('@aalis/plugin-zz-notes', {
      displayName: '笔记',
      configSchema: { folder: { type: 'string', label: '目录' } },
    });
    let installed = false;
    app = await renderApp(
      '/market',
      {},
      marketRest({
        '/api/plugins': () => ({ plugins: installed ? [...PLUGINS, notes] : PLUGINS, secretRefCounts: {} }),
        '/api/marketplace/install': () => {
          installed = true;
          return { ok: true, message: '已安装并加载: @aalis/plugin-zz-notes', plugin: '@aalis/plugin-zz-notes' };
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    const dialog = within(screen.getByRole('dialog', { name: '安装「@aalis/plugin-zz-notes」？' }));
    expect(await dialog.findByText('@aalis/api-zz-notes')).toBeTruthy();
    expect(dialog.getByText('zz-store（由 zz-mongo 提供）')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: '安装' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/%40aalis%2Fplugin-zz-notes#config'));
    expect(posts('/api/marketplace/install').map(call => call.body)).toEqual([{ name: '@aalis/plugin-zz-notes' }]);
    expect(screen.getByText('已安装并加载: @aalis/plugin-zz-notes')).toBeTruthy();
    await vi.waitFor(() => expect(scrolled).toHaveBeenCalledWith('config'));
    expect(document.getElementById('config')?.textContent).toContain('目录');
  });

  it('更新所选：可更新的勾上一起提交；选了内核写明会整个重启；没过预检时逐条列出冲突', async () => {
    app = await renderApp(
      '/market',
      {},
      marketRest({
        '/api/marketplace/update': {
          ok: false,
          message: '依赖预检没过，什么都没改',
          conflicts: ['zz-theme-ui@1.0.0 需要 @aalis/core@^0.21.0'],
        },
      }),
    );
    expect(await screen.findByText('可更新 2 项，选了 0 项')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByText('所选含内核或宿主：更新后整个应用重启，新版本起不来会自动回滚。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更新所选（2）' }));
    expect(await screen.findByText('zz-theme-ui@1.0.0 需要 @aalis/core@^0.21.0')).toBeTruthy();
    expect(posts('/api/marketplace/update').map(call => call.body)).toEqual([
      {
        targets: [
          { name: 'zz-theme-ui', version: '1.0.0' },
          { name: '@aalis/core', version: '0.20.0' },
        ],
      },
    ]);
  });
});
