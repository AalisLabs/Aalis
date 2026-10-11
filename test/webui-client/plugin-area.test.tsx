// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_MANAGER, SESSION_PROTOCOL } from '../../packages/plugin-webui-client/src/plugins/list.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  choose,
  type FakeRequest,
  type FakeRest,
  type Harness,
  installDialog,
  lists,
  pluginRow as plugin,
  renderApp,
  restCalls,
} from './harness.js';
import { BOARD, NOTES, ROSTER, SETTINGS_PAGE } from './pages.js';

// ════════════════════════════════════════════════════════════
// 插件区：左栏是实例树（按子系统分组到插件、再到实例，组名与顺序取子系统目录，顶上是市场与「只看有问题的」）；
// 详情由宿主拼装：头部（包名、版本、状态与原因，启停、重载、卸载）、依赖与贡献（缺的服务写链与根：根停用可以一键启用，
// 根失败去处理它，没有提供者写说明，在等写等待谁启动）、页面（全部页面与位置，插件前端另列申请的宿主数据能力）、实例；
// 界面所在的插件停不掉、卸不了。会话服务不在时写提供会话协议的插件的链与根、去根插件，没装时链到市场；
// 市场装完跳到这个插件详情的配置区。
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
const PLUGINS = [
  plugin('zz-mongo', { displayName: '文档库', subsystem: 'memory', version: '1.2.3', provides: ['zz-store'] }),
  plugin('zz-agent', {
    displayName: '对话代理',
    subsystem: 'agent',
    state: 'pending',
    requiredServices: ['events', 'zz-store', 'zz-model'],
    optionalServices: ['zz-vision'],
    // 两个实例都提供 zz-model：各自追到自己的根
    lacking: [
      { service: 'zz-model', chain: ['zz-model'], root: { kind: 'disabled', instance: 'zz-model' } },
      {
        service: 'zz-model',
        chain: ['zz-model:backup'],
        root: { kind: 'error', instance: 'zz-model:backup', error: '连不上上游' },
      },
    ],
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
  plugin('zz-sessions', { displayName: '会话服务', subsystem: 'session', provides: [SESSION_PROTOCOL] }),
];

/** 提供包管理服务的插件：市场的装卸更新由它做，失败的原因记在它的日志里 */
const PACKAGES_PLUGIN = plugin('zz-packages', { displayName: '包管理', provides: [PACKAGE_MANAGER] });

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
/** 管理动作做完后还要等回执、重取插件列表、几轮渲染才跳转，全量并行时这一串会超过 waitFor 默认的 1 秒；只等跳转，不计时 */
const AFTER_ACTION = { timeout: 5_000 };
const posts = (path: string) => restCalls().filter(call => call.method === 'POST' && call.path === path);
/** 依赖块里每个依赖一行：各段文字与按钮（链接）；已满足的只有一段文字 */
const needs = (relations: ReturnType<typeof within>) =>
  relations
    .getAllByRole('listitem')
    .map((item: HTMLElement) =>
      item.children.length > 0 ? [...item.children].map(child => child.textContent) : [item.textContent],
    );

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

  it('只在等别的插件启动的：写「等待启动」，不带标记；「只看有问题的」不留它', async () => {
    const patient = plugin('zz-patient', {
      displayName: '耐心',
      subsystem: 'agent',
      state: 'pending',
      waiting: [{ service: 'zz-store', chain: ['zz-mongo'], root: { kind: 'starting', instance: 'zz-mongo' } }],
    });
    app = await renderApp('/plugins', {}, pluginRest([...PLUGINS, patient]));
    expect((await tree().findByRole('link', { name: /耐心/ })).textContent).toBe('耐心等待启动');
    // 详情头部的原因写在等的根插件
    fireEvent.click(tree().getByRole('link', { name: /耐心/ }));
    expect(await detail().findByText('文档库', { selector: '.plugin-summary-reason' })).toBeTruthy();
    fireEvent.click(tree().getByRole('switch', { name: '只看有问题的' }));
    expect(tree().queryByRole('link', { name: /耐心/ })).toBeNull();
  });

  it('自己的旧实例还没停下的：写「等待启动」，详情头部的原因写在等它的旧实例停下', async () => {
    const lingering = plugin('zz-slowstop', {
      displayName: '慢停',
      subsystem: 'agent',
      state: 'pending',
      lingering: true,
    });
    app = await renderApp('/plugins', {}, pluginRest([...PLUGINS, lingering]));
    expect((await tree().findByRole('link', { name: /慢停/ })).textContent).toBe('慢停等待启动');
    fireEvent.click(tree().getByRole('link', { name: /慢停/ }));
    expect(await detail().findByText('等待 慢停 的旧实例停下', { selector: '.plugin-summary-reason' })).toBeTruthy();
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

  it('树的头部可以重新扫描插件目录：扫完重取插件列表，Toast 写服务端的回执；扫不了时写原因', async () => {
    let listed = 0;
    let scan = (): unknown => ({ ok: true, loaded: ['zz-new'], message: '新加载 1 个插件' });
    app = await renderApp(
      '/plugins',
      {},
      pluginRest(PLUGINS, {
        '/api/plugins': () => {
          listed++;
          return { plugins: PLUGINS, secretRefCounts: {} };
        },
        '/api/plugins/scan': () => scan(),
      }),
    );
    await tree().findByRole('link', { name: '文档库' });
    const before = listed;
    fireEvent.click(tree().getByRole('button', { name: '重新扫描插件目录' }));
    expect(await screen.findByText('新加载 1 个插件')).toBeTruthy();
    expect(posts('/api/plugins/scan')).toHaveLength(1);
    expect(listed).toBeGreaterThan(before);

    scan = () => Response.json({ error: '宿主未提供插件来源，无法扫描' }, { status: 503 });
    fireEvent.click(tree().getByRole('button', { name: '重新扫描插件目录' }));
    const failed = (await screen.findByText('重新扫描插件目录失败：宿主未提供插件来源，无法扫描')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(
      within(failed).getByRole('link', { name: '查看日志' }).getAttribute('href'),
      '插件区的出错 Toast 链到提供界面的实例',
    ).toBe('/health/logs?plugin=zz-ui');
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
    const alert = await tree().findByRole('alert');
    expect(alert.textContent).toContain('插件管理服务不可用');
    expect(within(alert).queryByRole('link', { name: '查看日志' }), '插件列表没取到就指不出来源').toBeNull();
    fail = false;
    fireEvent.click(tree().getByRole('button', { name: '重试' }));
    expect(await tree().findByRole('link', { name: '文档库' })).toBeTruthy();
  });
});

describe('详情', () => {
  it('服务端比客户端新时认不出的根：照收，写「原因见日志」，状态与标记照旧；认得的根缺字段时整张列表不认', async () => {
    const withRoot = (root: Record<string, unknown>) =>
      PLUGINS.map(row =>
        row.instanceId === 'zz-agent' ? { ...row, lacking: [{ service: 'zz-model', chain: ['zz-model'], root }] } : row,
      );
    app = await renderApp('/plugins/zz-agent', {}, pluginRest(withRoot({ kind: 'zz-future', instance: 'zz-model' })));
    expect((await tree().findByRole('link', { name: /对话代理/ })).textContent).toBe('需要处理对话代理缺服务');
    expect(await detail().findAllByText('模型服务（原因见日志）')).toHaveLength(2);
    app.close();

    app = await renderApp('/plugins/zz-agent', {}, pluginRest(withRoot({ kind: 'cycle' })));
    expect((await tree().findByRole('alert')).textContent).toContain('插件 zz-agent 缺的服务认不出');
  });

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
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('重载失败：插件 zz-mongo 当前不接受重载');
    expect(
      within(failed).getByRole('link', { name: '查看日志' }).getAttribute('href'),
      '插件详情里的出错 Toast 链到这个插件的日志',
    ).toBe('/health/logs?plugin=zz-mongo');
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

  it('依赖与贡献：宿主自己提供的服务不列；缺的服务写链与根，根停用一键启用、根失败去处理它；另写提供的服务、工具、指令', async () => {
    app = await renderApp(
      '/plugins/zz-agent',
      {},
      pluginRest(undefined, { '/api/plugins/zz-model/enable': { ok: true } }),
    );
    const relations = within(
      (await detail().findByRole('heading', { name: '依赖与贡献' })).closest('section') as HTMLElement,
    );
    expect(relations.getByText('zz-store（文档库）')).toBeTruthy();
    expect(relations.queryByText(/events/)).toBeNull();
    expect(relations.getByText('zz_read、zz_write')).toBeTruthy();
    expect(relations.getByText('/zz-reset')).toBeTruthy();
    // 两个实例都提供它，各自追到自己的根：停用的一键启用，失败的去它的详情处理（启用只是重试，配置错了还会失败）
    expect(needs(relations)).toEqual([
      ['zz-model：缺', '模型服务（已停用）', '启用 模型服务'],
      ['zz-model：缺', '模型服务 · backup（失败：连不上上游）', '去处理 模型服务 · backup'],
      ['zz-store（文档库）'],
    ]);
    expect(relations.getByRole('link', { name: '去处理 模型服务 · backup' }).getAttribute('href')).toBe(
      '/plugins/zz-model%3Abackup',
    );
    fireEvent.click(relations.getByRole('button', { name: '启用 模型服务' }));
    await vi.waitFor(() => expect(posts('/api/plugins/zz-model/enable')).toHaveLength(1));
    expect(detail().getByText('缺服务')).toBeTruthy();
    expect(
      detail().getByText('模型服务（已停用）；模型服务 · backup（失败：连不上上游）', {
        selector: '.plugin-summary-reason',
      }),
    ).toBeTruthy();
  });

  it('依赖块里启用根插件没成：Toast 写启用的是谁，「查看日志」去被启用的插件', async () => {
    app = await renderApp(
      '/plugins/zz-agent',
      {},
      pluginRest(undefined, {
        '/api/plugins/zz-model/enable': () => Response.json({ error: '配置文件写不进去' }, { status: 409 }),
      }),
    );
    const relations = within(
      (await detail().findByRole('heading', { name: '依赖与贡献' })).closest('section') as HTMLElement,
    );
    fireEvent.click(relations.getByRole('button', { name: '启用 模型服务' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('启用 模型服务失败：配置文件写不进去');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-model',
    );
  });

  it.each([
    {
      name: '根待配置：去配置根插件',
      lacking: [
        {
          service: 'zz-x',
          chain: ['zz-keyless'],
          root: { kind: 'error', instance: 'zz-keyless', error: '缺少配置项 apiKey' },
        },
      ],
      need: ['zz-x：缺', '没钥匙（待配置：apiKey）', '去配置 没钥匙'],
      href: '/plugins/zz-keyless#config',
    },
    {
      name: '根在运行却没在提供：写它没提供的服务，去根插件的详情',
      lacking: [
        {
          service: 'zz-x',
          chain: ['zz-keyless'],
          root: { kind: 'withdrawn', instance: 'zz-keyless', service: 'zz-x' },
        },
      ],
      need: ['zz-x：缺', '没钥匙（在运行但没有提供 zz-x）', '去处理 没钥匙'],
      href: '/plugins/zz-keyless',
    },
    {
      name: '没有提供者：只写说明，不加按钮',
      lacking: [{ service: 'zz-x', chain: [], root: { kind: 'unprovided', service: 'zz-x' } }],
      need: ['zz-x：缺', '没有已装的插件提供 zz-x，可以在插件市场按服务搜 zz-x'],
    },
    {
      name: '成环：点名环上的插件',
      lacking: [
        { service: 'zz-x', chain: ['zz-keyless'], root: { kind: 'cycle', instances: ['zz-probe', 'zz-keyless'] } },
      ],
      need: ['zz-x：缺', '没钥匙（互相等待成环：探针、没钥匙）'],
    },
    {
      name: '在等：写等待谁启动',
      waiting: [{ service: 'zz-x', chain: ['zz-keyless'], root: { kind: 'starting', instance: 'zz-keyless' } }],
      need: ['zz-x：等待 没钥匙 启动'],
    },
  ])('依赖块里每种根的写法：$name', async ({ lacking = [], waiting = [], need, href }) => {
    const rows = [
      ...PLUGINS,
      plugin('zz-probe', { displayName: '探针', state: 'pending', requiredServices: ['zz-x'], lacking, waiting }),
      plugin('zz-keyless', {
        displayName: '没钥匙',
        state: 'error',
        error: '缺少配置项 apiKey',
        provides: ['zz-x'],
        unconfigured: ['apiKey'],
      }),
    ];
    app = await renderApp('/plugins/zz-probe', {}, pluginRest(rows));
    const relations = within(
      (await detail().findByRole('heading', { name: '依赖与贡献' })).closest('section') as HTMLElement,
    );
    expect(needs(relations)).toEqual([need]);
    if (href) expect(relations.getByRole('link').getAttribute('href')).toBe(href);
  });

  it('服务偏好：它声明的、有几个提供者的服务各一行，写本插件偏好或跟随全局与此刻用的那一家及依据；改选与「跟随全局」按实例发，所选的不在时写明', async () => {
    const provider = (contextId: string, displayName: string) => ({
      contextId,
      displayName,
      priority: 0,
      exclusive: false,
    });
    const services = {
      services: {
        'zz-store': { providers: [provider('zz-mongo', '文档库'), provider('zz-lite', '本地库')], preferred: null },
        'zz-vision': { providers: [provider('zz-eye', '看图'), provider('zz-eye2', '看图二')], preferred: 'zz-eye' },
        'zz-model': { providers: [provider('zz-model', '模型服务')], preferred: null },
        'zz-other': { providers: [provider('zz-x', '甲'), provider('zz-y', '乙')], preferred: null },
      },
    };
    const agent = plugin('zz-agent', {
      requiredServices: ['events', 'zz-store', 'zz-model'],
      optionalServices: ['zz-vision'],
      servicePreferences: { 'zz-vision': 'zz-eye2' },
      serviceSelections: {
        'zz-store': { contextId: 'zz-mongo', basis: 'rank' },
        'zz-vision': { contextId: 'zz-eye2', basis: 'plugin' },
      },
    });
    const own = (service: string) => `/api/plugins/zz-agent/services/${service}/prefer`;
    app = await renderApp(
      '/plugins/zz-agent',
      {},
      pluginRest([agent], {
        '/api/services': services,
        [own('zz-store')]: { ok: true },
        [own('zz-vision')]: { ok: true },
      }),
    );
    const block = within(
      (await detail().findByRole('heading', { name: '服务偏好' })).closest('section') as HTMLElement,
    );
    expect(block.getByText(/不需要让这个插件改用别家、也不需要它固定用某一家时，别设/)).toBeTruthy();
    const row = (label: string) => within(block.getByRole('group', { name: label }));
    expect(block.queryByRole('group', { name: 'zz-model' })).toBeNull();
    expect(block.queryByRole('group', { name: 'zz-other' })).toBeNull();
    expect(row('zz-store').getByText('跟随全局偏好')).toBeTruthy();
    expect(row('zz-store').queryByText('本插件偏好')).toBeNull();
    expect(row('zz-vision').getByText('看图二')).toBeTruthy();
    expect(row('zz-vision').getByText('本插件偏好')).toBeTruthy();
    expect(row('zz-store').getByText('现在用：文档库（没有偏好，按优先级）')).toBeTruthy();
    expect(row('zz-vision').getByText('现在用：看图二（本插件偏好）')).toBeTruthy();

    fireEvent.click(row('zz-store').getByRole('button', { name: /zz-store/ }));
    choose(row('zz-store').getByRole('combobox', { name: 'zz-store' }), '本地库');
    await vi.waitFor(() => expect(posts(own('zz-store')).map(call => call.body)).toEqual([{ contextId: 'zz-lite' }]));
    fireEvent.click(row('zz-vision').getByRole('button', { name: '跟随全局' }));
    await vi.waitFor(() =>
      expect(restCalls().filter(call => call.method === 'DELETE' && call.path === own('zz-vision'))).toHaveLength(1),
    );
    app.close();

    const gone = plugin('zz-agent', {
      optionalServices: ['zz-vision'],
      servicePreferences: { 'zz-vision': 'zz-eye3' },
      serviceSelections: { 'zz-vision': { contextId: 'zz-eye', basis: 'global' } },
    });
    app = await renderApp('/plugins/zz-agent', {}, pluginRest([gone], { '/api/services': services }));
    expect(await detail().findByText('这一家现在不在，现在用：看图（全局偏好）')).toBeTruthy();
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
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model%3Avision'), AFTER_ACTION);
    expect(created).toEqual([{ suffix: 'bad name' }, { suffix: 'vision' }]);
  });

  it('在主实例页面移除其余实例、新建实例失败：出错 Toast 的「查看日志」分别链到被移除的实例与提供界面的实例', async () => {
    app = await renderApp(
      '/plugins/zz-model',
      {},
      pluginRest(
        PLUGINS.map(row => (row.name === 'zz-model' ? { ...row, reusable: true } : row)),
        {
          '/api/plugins/zz-model/instances': () => Response.json({ error: '配置文件写不进去' }, { status: 500 }),
          '/api/plugins/zz-model%3Abackup/instance': () => Response.json({ error: '实例停不下来' }, { status: 500 }),
        },
      ),
    );
    const block = within((await detail().findByRole('heading', { name: '实例' })).closest('section') as HTMLElement);
    fireEvent.click(
      within(block.getByRole('link', { name: /backup/ }).closest('li') as HTMLElement).getByRole('button', {
        name: '更多',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: '移除' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '移除实例「backup」？' })).getByRole('button', { name: '移除' }),
    );
    const removed = await screen.findByRole('alert');
    expect(removed.textContent).toContain('移除实例失败：实例停不下来');
    expect(within(removed).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-model%3Abackup',
    );
    fireEvent.click(within(removed).getByRole('button', { name: '关闭' }));

    fireEvent.change(block.getByLabelText('新实例的名字'), { target: { value: 'vision' } });
    fireEvent.click(block.getByRole('button', { name: '新建实例' }));
    const created = await screen.findByRole('alert');
    expect(created.textContent).toContain('新建实例失败：配置文件写不进去');
    expect(within(created).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-ui',
    );
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
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model'), AFTER_ACTION);
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
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model'), AFTER_ACTION);
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
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/zz-model%3Avision'), AFTER_ACTION);
    expect(detail().queryByText('没有这个插件')).toBeNull();
    expect(await detail().findByText('backup', { exact: false })).toBeTruthy();
  });

  it('卸载先确认（列出依赖它的），卸掉后回到插件区；没卸成时 Toast 写服务层给的原因、链到包管理的日志；勾上才同时删除配置', async () => {
    let refuse = true;
    const rows = [
      ...PLUGINS.map(row =>
        row.instanceId === 'zz-mongo'
          ? { ...row, configSection: true, config: { uri: { $secret: 'zz-mongo.uri' } } }
          : row,
      ),
      PACKAGES_PLUGIN,
    ];
    app = await renderApp(
      '/plugins/zz-mongo',
      {},
      pluginRest(undefined, {
        '/api/plugins': () => ({ plugins: rows, secretRefCounts: { 'zz-mongo.uri': 1 } }),
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
    const refused = await screen.findByRole('alert');
    expect(refused.textContent).toContain('卸载失败：卸载会破坏依赖');
    expect(within(refused).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-packages',
    );
    refuse = false;
    fireEvent.click(dialog.getByRole('checkbox', { name: '同时删除配置（含 1 个密钥）' }));
    fireEvent.click(dialog.getByRole('button', { name: '卸载' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins'), AFTER_ACTION);
    expect(posts('/api/marketplace/uninstall').map(call => call.body)).toEqual([
      { name: 'zz-mongo', removeConfig: false },
      { name: 'zz-mongo', removeConfig: true },
    ]);
  });

  it('「同时删除配置」看配置文件里有没有它的段（configSection）：空段也给删；配置文件里没有段的不给，哪怕运行态配置不空', async () => {
    const rows = [
      ...PLUGINS,
      plugin('zz-blank', { displayName: '空段', configSection: true }),
      plugin('zz-bare', { displayName: '无段', config: { timeoutMs: 30 } }),
    ];
    app = await renderApp('/plugins/zz-blank', {}, pluginRest(rows));
    fireEvent.click(await detail().findByRole('button', { name: '卸载' }));
    const blank = within(screen.getByRole('dialog', { name: '卸载「空段」？' }));
    expect(blank.getByRole('checkbox', { name: '同时删除配置' })).toBeTruthy();
    app.close();

    app = await renderApp('/plugins/zz-bare', {}, pluginRest(rows));
    fireEvent.click(await detail().findByRole('button', { name: '卸载' }));
    const bare = within(screen.getByRole('dialog', { name: '卸载「无段」？' }));
    expect(bare.getByText(/它的代码会删掉/)).toBeTruthy();
    expect(bare.queryByRole('checkbox')).toBeNull();
  });

  it('不在列表里的插件：写明没有这个插件，链到市场', async () => {
    app = await renderApp('/plugins/zz-gone', {}, pluginRest());
    expect(await detail().findByText('没有这个插件')).toBeTruthy();
    expect(detail().getByRole('link', { name: '去市场' }).getAttribute('href')).toBe('/market');
  });
});

describe('会话服务未启用', () => {
  it('提供会话协议的插件缺服务：写它的链与根，按钮去根插件', async () => {
    const rows = PLUGINS.map(row =>
      row.instanceId === 'zz-sessions'
        ? {
            ...row,
            state: 'pending',
            lacking: [
              {
                service: 'zz-store',
                chain: ['zz-mongo'],
                root: { kind: 'error', instance: 'zz-mongo', error: '连不上数据库' },
              },
            ],
          }
        : row.instanceId === 'zz-mongo'
          ? { ...row, state: 'error', error: '连不上数据库' }
          : row,
    );
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, pluginRest(rows));
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    const main = within(screen.getByRole('main'));
    expect(await main.findByText('会话服务 → 文档库（失败：连不上数据库）')).toBeTruthy();
    expect(main.getByRole('link', { name: '去处理 文档库' }).getAttribute('href')).toBe('/plugins/zz-mongo');
  });

  it('提供会话协议的插件只是在等：写「等待启动」与在等的插件，「去处理」去它的详情', async () => {
    const rows = PLUGINS.map(row =>
      row.instanceId === 'zz-sessions'
        ? {
            ...row,
            state: 'pending',
            waiting: [{ service: 'zz-store', chain: ['zz-mongo'], root: { kind: 'starting', instance: 'zz-mongo' } }],
          }
        : row.instanceId === 'zz-mongo'
          ? { ...row, state: 'activating' }
          : row,
    );
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, pluginRest(rows));
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    const main = within(screen.getByRole('main'));
    expect(await main.findByText('等待启动：文档库')).toBeTruthy();
    expect(main.getByRole('link', { name: '去处理' }).getAttribute('href')).toBe('/plugins/zz-sessions');
  });

  it.each([
    [{ error: '缺少配置项 x', unconfigured: ['x'] }, '待配置：x', ['去配置', '/plugins/zz-sessions#config']],
    [{ error: '端口被占用' }, '失败：端口被占用', ['去处理', '/plugins/zz-sessions']],
  ])('提供会话协议的插件自己没起来（%j）：写它的状态与原因，按钮与「需要处理」那一行同一个去处', async (over, text, [
    name,
    href,
  ]) => {
    const rows = PLUGINS.map(row => (row.instanceId === 'zz-sessions' ? { ...row, state: 'error', ...over } : row));
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, pluginRest(rows));
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    const main = within(screen.getByRole('main'));
    expect(await main.findByText(text)).toBeTruthy();
    expect(main.getByRole('link', { name }).getAttribute('href')).toBe(href);
  });

  it('提供会话协议的插件启用着或停用着时写启用后自动连上，「去处理」去它的详情；它没装时链到市场', async () => {
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, pluginRest());
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    const main = within(screen.getByRole('main'));
    expect(await main.findByText('提供会话协议的插件启用后，这里会自动连上。')).toBeTruthy();
    expect(main.getByRole('link', { name: '去处理' }).getAttribute('href')).toBe('/plugins/zz-sessions');
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
      provides: ['zz-memo'],
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
      provides: [],
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
    choose(screen.getByRole('combobox', { name: '类型' }), '全部');
    expect(entries()).toEqual(['@aalis/plugin-zz-notes', 'zz-theme-ui', '@aalis/core']);
    expect(screen.getByRole('link', { name: 'zz-theme-ui' }).getAttribute('rel')).toBe('noopener noreferrer');
    choose(screen.getByRole('combobox', { name: '状态' }), '已安装');
    expect(entries()).toEqual(['zz-theme-ui', '@aalis/core']);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '前端' } });
    expect(entries()).toEqual(['zz-theme-ui']);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '没有这个' } });
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(entries()).toEqual(['@aalis/plugin-zz-notes', 'zz-theme-ui', '@aalis/core']);
  });

  it('卡片写提供的服务，搜索也匹配它；搜不到时写明按服务搜的前提', async () => {
    app = await renderApp('/market', {}, marketRest());
    await screen.findByRole('list', { name: '包' });
    expect(screen.getByText('提供：zz-memo')).toBeTruthy();
    const search = screen.getByLabelText('搜索');
    expect(search.getAttribute('placeholder')).toBe('搜名称、说明、作者或提供的服务');
    choose(screen.getByRole('combobox', { name: '类型' }), '全部');
    fireEvent.change(search, { target: { value: 'ZZ-MEMO' } });
    expect(entries()).toEqual(['@aalis/plugin-zz-notes']);
    fireEvent.change(search, { target: { value: 'embedding' } });
    expect(screen.getByText('没有符合筛选的包')).toBeTruthy();
    expect(screen.getByText('按服务搜只找得到在 package.json 里声明了提供服务的包')).toBeTruthy();
  });

  it('卸载默认留着配置；有配置的插件可以勾上同时删除，框里写明随之删掉几个只有它用的密钥', async () => {
    // 主实例与另一个实例都引用 zz-mongo.uri（只有它用），shared 另有别的插件引用
    const rows = [
      ...PLUGINS.map(row =>
        row.instanceId === 'zz-mongo'
          ? { ...row, configSection: true, config: { uri: { $secret: 'zz-mongo.uri' }, token: { $secret: 'shared' } } }
          : row,
      ),
      plugin('zz-mongo:replica', {
        reusable: true,
        configSection: true,
        config: { uri: { $secret: 'zz-mongo.uri' } },
      }),
    ];
    const mongo = {
      name: 'zz-mongo',
      description: '文档库',
      version: '1.2.3',
      installed: true,
      resolved: '1.2.3',
      origin: 'registry',
      updatable: false,
      official: false,
      category: 'plugin',
      provides: ['zz-store'],
    };
    const empty = (name: string) => ({
      upstream: { name, present: true, children: [] },
      downstream: { name, present: true, children: [] },
      services: { required: [], provides: [] },
      serviceDependents: [],
    });
    app = await renderApp(
      '/market',
      {},
      marketRest({
        '/api/plugins': () => ({ plugins: rows, secretRefCounts: { 'zz-mongo.uri': 2, shared: 2 } }),
        '/api/marketplace?q=': { packages: [mongo, PACKAGES[1]] },
        '/api/marketplace/depgraph?name=zz-mongo': empty('zz-mongo'),
        '/api/marketplace/depgraph?name=zz-theme-ui': empty('zz-theme-ui'),
        '/api/marketplace/uninstall': { ok: true, message: '插件 zz-mongo 已卸载' },
      }),
    );
    const uninstall = async () => {
      fireEvent.click(await screen.findByRole('button', { name: '卸载' }));
      return within(screen.getByRole('dialog', { name: '卸载「zz-mongo」？' }));
    };
    let dialog = await uninstall();
    expect(dialog.getByText(/配置默认留在配置文件里/)).toBeTruthy();
    const box = () => dialog.getByRole('checkbox', { name: '同时删除配置（含 1 个密钥）' }) as HTMLInputElement;
    expect(box().checked).toBe(false);
    fireEvent.click(box());
    fireEvent.click(dialog.getByRole('button', { name: '取消' }));
    dialog = await uninstall();
    expect(box().checked, '每次打开都从不勾开始').toBe(false);
    fireEvent.click(dialog.getByRole('button', { name: '卸载' }));
    await vi.waitFor(() => expect(posts('/api/marketplace/uninstall')).toHaveLength(1));
    dialog = await uninstall();
    fireEvent.click(box());
    fireEvent.click(dialog.getByRole('button', { name: '卸载' }));
    await vi.waitFor(() => expect(posts('/api/marketplace/uninstall')).toHaveLength(2));
    expect(posts('/api/marketplace/uninstall').map(call => call.body)).toEqual([
      { name: 'zz-mongo', removeConfig: false },
      { name: 'zz-mongo', removeConfig: true },
    ]);

    // 前端界面包没有配置段：不给这一项
    choose(screen.getByRole('combobox', { name: '类型' }), '前端界面');
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }));
    const ui = within(screen.getByRole('dialog', { name: '卸载「zz-theme-ui」？' }));
    expect(ui.queryByRole('checkbox')).toBeNull();
  });

  it('安装先确认（列出一并装上的与要用的服务），装上插件后跳到它详情的配置区', async () => {
    // 记下是谁滚进视野
    const scrolled = vi.fn();
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled(this.id);
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
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/%40aalis%2Fplugin-zz-notes#config'), AFTER_ACTION);
    expect(posts('/api/marketplace/install').map(call => call.body)).toEqual([{ name: '@aalis/plugin-zz-notes' }]);
    expect(screen.getByText('已安装并加载: @aalis/plugin-zz-notes')).toBeTruthy();
    await vi.waitFor(() => expect(scrolled).toHaveBeenCalledWith('config'));
    expect(document.getElementById('config')?.textContent).toContain('目录');
  });

  it('装卸更新没成：「查看日志」链到提供包管理服务的插件，失败的原因记在它那里；没有它时链到提供界面的实例', async () => {
    const empty = {
      upstream: { name: 'zz-theme-ui', present: true, children: [] },
      downstream: { name: 'zz-theme-ui', present: true, children: [] },
      services: { required: [], provides: [] },
      serviceDependents: [],
    };
    let rows = [...PLUGINS, PACKAGES_PLUGIN];
    app = await renderApp(
      '/market',
      {},
      marketRest({
        '/api/plugins': () => ({ plugins: rows, secretRefCounts: {} }),
        '/api/marketplace/depgraph?name=zz-theme-ui': empty,
        '/api/marketplace/install': { ok: false, message: '连不上 npm 的源' },
        '/api/marketplace/uninstall': { ok: false, message: '目录没有写入权限' },
        '/api/marketplace/update': { ok: false, message: '连不上 npm 的源', conflicts: [] },
      }),
    );
    const logsOf = (scope: HTMLElement) => within(scope).getByRole('link', { name: '查看日志' }).getAttribute('href');
    const toastOf = async (text: string) => {
      const toast = (await screen.findByText(text)).closest('[role="alert"]') as HTMLElement;
      const href = logsOf(toast);
      fireEvent.click(within(toast).getByRole('button', { name: '关闭' }));
      return href;
    };

    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '安装「@aalis/plugin-zz-notes」？' })).getByRole('button', {
        name: '安装',
      }),
    );
    expect(await toastOf('安装 @aalis/plugin-zz-notes失败：连不上 npm 的源')).toBe('/health/logs?plugin=zz-packages');

    choose(screen.getByRole('combobox', { name: '类型' }), '前端界面');
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '卸载「zz-theme-ui」？' })).getByRole('button', { name: '卸载' }),
    );
    expect(await toastOf('卸载 zz-theme-ui失败：目录没有写入权限')).toBe('/health/logs?plugin=zz-packages');

    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '更新所选（2）' }));
    const result = (await screen.findByText('连不上 npm 的源')).closest('.market-updates-result') as HTMLElement;
    expect(logsOf(result)).toBe('/health/logs?plugin=zz-packages');

    rows = PLUGINS;
    act(() => FakeWebSocket.at('/admin').push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(logsOf(result)).toBe('/health/logs?plugin=zz-ui'));
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
