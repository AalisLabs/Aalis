// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '../../packages/api-webui/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRest,
  type Harness,
  INIT,
  installDialog,
  lists,
  pluginRow as plugin,
  renderApp,
  server,
  summary,
} from './harness.js';
import { JOBS, SETTINGS_PAGE } from './pages.js';

// ════════════════════════════════════════════════════════════
// 「需要处理」：GET /api/attention 一个列表（推出未结的审批、插件故障、插件的提示），收到 attention.changed 或管理连接重连后
// 重取。首页（手机上是第一层顶部）的摘要最多五条，标题写总数，「全部」链到运行状况，空了整条不出现；插件详情头部之后
// 是这个插件的提示；标签页标题是这个数加「我的」区完成未读的会话数，都为 0 时只有应用名。跳转按钮由宿主推出
// ════════════════════════════════════════════════════════════

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  stubViewport(1440);
  document.title = 'Aalis';
});

afterEach(() => {
  app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 没起来的原因都为空 */
const clear = { lacking: [], waiting: [], unconfigured: [] };
const MODEL_FAILED = {
  service: 'zz-model',
  chain: ['zz-model'],
  root: { kind: 'error' as const, instance: 'zz-model', error: '缺少 API 密钥' },
};

const PLUGINS = [
  plugin('zz-model', { displayName: '模型服务', state: 'error', error: '缺少 API 密钥' }),
  plugin('zz-agent', {
    displayName: '对话代理',
    state: 'pending',
    requiredServices: ['zz-model'],
    lacking: [MODEL_FAILED],
  }),
  plugin('zz-jobs:night', { displayName: '计划任务', reusable: true }),
  plugin('zz-auth', { displayName: '权限' }),
];

const ITEMS: AttentionItem[] = [
  { kind: 'approval', id: 'ap-1', sessionId: 's1', session: '整理周报', tool: 'exec' },
  { kind: 'plugin', instance: 'zz-model', state: 'error', error: '缺少 API 密钥', ...clear },
  { kind: 'plugin', instance: 'zz-agent', state: 'pending', ...clear, lacking: [MODEL_FAILED] },
  {
    kind: 'notice',
    instance: 'zz-jobs:night',
    id: 'due',
    level: 'action',
    title: '3 个任务没跑',
    open: { page: 'jobs' },
  },
  {
    kind: 'notice',
    instance: 'zz-auth',
    id: 'rules',
    level: 'error',
    title: '规则文件读不出',
    detail: '第 3 行格式不对',
    open: { page: 'auth' },
  },
  { kind: 'notice', instance: 'zz-model', id: 'quota', level: 'action', title: '余额不足', open: 'config' },
  { kind: 'notice', instance: 'zz-model', id: 'ledger', level: 'error', title: '账本读取失败' },
];

/** 插件列表、页面表与「需要处理」；attention 可以换成按请求算的 */
function rest(items: AttentionItem[] | (() => unknown) = ITEMS): FakeRest {
  return {
    '/api/plugins': { plugins: PLUGINS, secretRefCounts: {} },
    '/api/pages': { pages: [JOBS, SETTINGS_PAGE] },
    '/api/attention': typeof items === 'function' ? items : { items },
  };
}

const noSessions = { 'sessions/list': lists(() => []) };

/** 一组「需要处理」的行：读屏标记、标题与说明的文字，以及跳转按钮的名字与地址 */
function rows(region: HTMLElement) {
  return within(region)
    .getAllByRole('listitem')
    .map(row => {
      const link = within(row).queryByRole('link');
      return {
        text: row.querySelector('.attention-text')?.textContent,
        tone: row.querySelector('.visually-hidden')?.textContent,
        action: link && [link.textContent, link.getAttribute('href')],
      };
    });
}

const summaryRegion = () => screen.queryByRole('region', { name: '需要处理' });

describe('首页摘要', () => {
  it('最多五条，标题写总数，「全部」链到运行状况；审批进会话，插件故障进详情，提示的跳转由宿主推出', async () => {
    app = await renderApp('/', noSessions, rest());
    const region = await screen.findByRole('region', { name: '需要处理' });
    expect(within(region).getByRole('heading').textContent).toBe('需要处理 · 7');
    expect(within(region).getByRole('link', { name: '全部' }).getAttribute('href')).toBe('/health');
    await vi.waitFor(() => expect(rows(region)[3].action).not.toBeNull());
    expect(rows(region)).toEqual([
      { text: '整理周报等你批准：exec', tone: '需要处理', action: ['去处理', '/s/s1'] },
      { text: '模型服务失败：缺少 API 密钥', tone: '出错', action: ['去处理', '/plugins/zz-model'] },
      {
        text: '对话代理缺服务：模型服务（失败：缺少 API 密钥）',
        tone: '需要处理',
        action: ['去处理 模型服务', '/plugins/zz-model'],
      },
      { text: '3 个任务没跑计划任务 · night', tone: '需要处理', action: ['打开计划', '/p/zz-jobs%3Anight/jobs'] },
      {
        text: '规则文件读不出权限 · 第 3 行格式不对',
        tone: '出错',
        action: ['打开权限', '/settings/p/zz-auth/auth'],
      },
    ]);
  });

  it('空了整条不出现；收到 attention.changed 后重取，管理连接重连后也重取', async () => {
    let items: AttentionItem[] = [];
    app = await renderApp(
      '/',
      noSessions,
      rest(() => ({ items })),
    );
    await screen.findByRole('heading', { name: '新会话' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(summaryRegion()).toBeNull();

    items = ITEMS.slice(0, 2);
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    const region = await screen.findByRole('region', { name: '需要处理' });
    expect(within(region).getByRole('heading').textContent).toBe('需要处理 · 2');

    items = [];
    act(() => FakeWebSocket.at('/admin').drop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeWebSocket.at('/admin').open());
    await vi.waitFor(() => expect(summaryRegion()).toBeNull());
  });

  it('没取到时原地写明原因，「重试」再取', async () => {
    let fail = true;
    app = await renderApp(
      '/',
      noSessions,
      rest(() => {
        if (fail) return Response.json({ error: '读不出审批服务' }, { status: 500 });
        return { items: ITEMS.slice(0, 1) };
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('读不出审批服务');
    fail = false;
    act(() => within(alert).getByRole('button', { name: '重试' }).click());
    const region = await screen.findByRole('region', { name: '需要处理' });
    expect(within(region).getByRole('heading').textContent).toBe('需要处理 · 1');
  });

  it('重取失败时旧列表留着，另写一行没刷新成功的原因，「重试」再取', async () => {
    let fail = false;
    app = await renderApp(
      '/',
      noSessions,
      rest(() => (fail ? Response.json({ error: '读不出审批服务' }, { status: 500 }) : { items: ITEMS.slice(0, 2) })),
    );
    const region = await screen.findByRole('region', { name: '需要处理' });
    await vi.waitFor(() => expect(rows(region)).toHaveLength(2));
    fail = true;
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('没刷新成功：读不出审批服务');
    expect(rows(region)).toHaveLength(2);
    fail = false;
    act(() => within(alert).getByRole('button', { name: '重试' }).click());
    await vi.waitFor(() => expect(within(region).queryByRole('alert')).toBeNull());
  });

  it('手机上在第一层的顶部，入口与会话列表在它下面；第二层的新会话（/new）里没有', async () => {
    stubViewport(390);
    app = await renderApp('/', noSessions, rest(ITEMS.slice(0, 1)));
    const left = within(screen.getByRole('navigation', { name: '会话' }));
    const region = await left.findByRole('region', { name: '需要处理' });
    const entries = left.getByRole('list', { name: '入口' });
    expect(region.compareDocumentPosition(entries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('region', { name: '需要处理' })).toHaveLength(1);

    app.close();
    app = await renderApp('/new', noSessions, rest(ITEMS.slice(0, 1)));
    const main = within(screen.getByRole('main'));
    await main.findByRole('textbox', { name: '消息' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(main.queryByRole('region', { name: '需要处理' })).toBeNull();
  });
});

describe('插件故障的写法', () => {
  /** 链：会话服务要会话管理提供的，会话管理要 SQLite 记忆提供的 */
  const CHAIN_PLUGINS = [
    plugin('zz-session-server', { displayName: '会话服务', state: 'pending' }),
    plugin('zz-manager', { displayName: '会话管理', state: 'pending' }),
    plugin('zz-sqlite', { displayName: 'SQLite 记忆', state: 'error', error: '打不开数据库' }),
    plugin('zz-embed', {
      displayName: 'OpenAI Embedding',
      state: 'error',
      error: '缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效',
      unconfigured: ['apiKey'],
    }),
    plugin('zz-vector', { displayName: '向量记忆', state: 'pending' }),
    plugin('zz-off', { displayName: '停用的提供者', state: 'disabled' }),
    plugin('zz-ollama', { displayName: 'Ollama 对话' }),
    plugin('zz-a', { displayName: '甲', state: 'pending' }),
    plugin('zz-b', { displayName: '乙', state: 'pending' }),
    plugin('zz-lonely', { displayName: '孤儿', state: 'pending' }),
    plugin('zz-routed', { displayName: '路由', state: 'pending' }),
  ];
  const pending = (instance: string, lacking: unknown[]): AttentionItem =>
    ({ kind: 'plugin', instance, state: 'pending', ...clear, lacking }) as AttentionItem;

  it.each([
    {
      name: '根失败：链与根的失败说明，按钮去根插件',
      item: pending('zz-session-server', [
        {
          service: 'zz-session',
          chain: ['zz-manager', 'zz-sqlite'],
          root: { kind: 'error', instance: 'zz-sqlite', error: '打不开数据库' },
        },
      ]),
      row: {
        text: '会话服务缺服务：会话管理 → SQLite 记忆（失败：打不开数据库）',
        tone: '需要处理',
        action: ['去处理 SQLite 记忆', '/plugins/zz-sqlite'],
      },
    },
    {
      name: '同一个根只写一次：会话服务既要记忆、又要要记忆的会话管理，留最短的那条链',
      item: pending('zz-session-server', [
        {
          service: 'zz-session',
          chain: ['zz-manager', 'zz-sqlite'],
          root: { kind: 'error', instance: 'zz-sqlite', error: '打不开数据库' },
        },
        {
          service: 'memory',
          chain: ['zz-sqlite'],
          root: { kind: 'error', instance: 'zz-sqlite', error: '打不开数据库' },
        },
      ]),
      row: {
        text: '会话服务缺服务：SQLite 记忆（失败：打不开数据库）',
        tone: '需要处理',
        action: ['去处理 SQLite 记忆', '/plugins/zz-sqlite'],
      },
    },
    {
      name: '根待配置：写待配置的键，按钮去根插件的配置区',
      item: pending('zz-vector', [
        {
          service: 'embedding',
          chain: ['zz-embed'],
          root: { kind: 'error', instance: 'zz-embed', error: '缺少配置项 apiKey' },
        },
      ]),
      row: {
        text: '向量记忆缺服务：OpenAI Embedding（待配置：apiKey）',
        tone: '需要处理',
        action: ['去配置 OpenAI Embedding', '/plugins/zz-embed#config'],
      },
    },
    {
      name: '根已停用',
      item: pending('zz-routed', [
        { service: 'zz-x', chain: ['zz-off'], root: { kind: 'disabled', instance: 'zz-off' } },
      ]),
      row: {
        text: '路由缺服务：停用的提供者（已停用）',
        tone: '需要处理',
        action: ['去处理 停用的提供者', '/plugins/zz-off'],
      },
    },
    {
      name: '根在运行却没在提供：写它没提供的服务，按钮去根插件',
      item: pending('zz-routed', [
        { service: 'llm', chain: ['zz-ollama'], root: { kind: 'withdrawn', instance: 'zz-ollama', service: 'llm' } },
      ]),
      row: {
        text: '路由缺服务：Ollama 对话（在运行但没有提供 llm）',
        tone: '需要处理',
        action: ['去处理 Ollama 对话', '/plugins/zz-ollama'],
      },
    },
    {
      name: '没有提供者：写可以在市场按服务搜，按钮进这个插件的详情',
      item: pending('zz-lonely', [{ service: 'llm', chain: [], root: { kind: 'unprovided', service: 'llm' } }]),
      row: {
        text: '孤儿缺服务：没有已装的插件提供 llm，可以在插件市场按服务搜 llm',
        tone: '需要处理',
        action: ['去处理', '/plugins/zz-lonely'],
      },
    },
    {
      name: '成环：点名环上的插件，按钮进这个插件的详情',
      item: pending('zz-a', [
        { service: 'zz-sb', chain: ['zz-b'], root: { kind: 'cycle', instances: ['zz-a', 'zz-b'] } },
      ]),
      row: { text: '甲缺服务：乙（互相等待成环：甲、乙）', tone: '需要处理', action: ['去处理', '/plugins/zz-a'] },
    },
    {
      name: '待配置的插件自己：提醒色，写没填的键，按钮去配置区',
      item: {
        kind: 'plugin',
        instance: 'zz-embed',
        state: 'error',
        error: '缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效',
        ...clear,
        unconfigured: ['apiKey'],
      } as AttentionItem,
      row: { text: 'OpenAI Embedding待配置：apiKey', tone: '需要处理', action: ['去配置', '/plugins/zz-embed#config'] },
    },
  ])('$name', async ({ item, row }) => {
    app = await renderApp('/health', noSessions, {
      '/api/plugins': { plugins: CHAIN_PLUGINS, secretRefCounts: {} },
      '/api/attention': { items: [item] },
    });
    const region = await screen.findByRole('region', { name: '需要处理' });
    await vi.waitFor(() => expect(rows(region)).toEqual([row]));
  });

  it('一个服务两个提供者各自的根：逐个写到根，按钮去第一个根', async () => {
    app = await renderApp('/health', noSessions, {
      '/api/plugins': { plugins: CHAIN_PLUGINS, secretRefCounts: {} },
      '/api/attention': {
        items: [
          pending('zz-routed', [
            {
              service: 'zz-x',
              chain: ['zz-sqlite'],
              root: { kind: 'error', instance: 'zz-sqlite', error: '打不开数据库' },
            },
            { service: 'zz-x', chain: ['zz-off'], root: { kind: 'disabled', instance: 'zz-off' } },
          ]),
        ],
      },
    });
    const region = await screen.findByRole('region', { name: '需要处理' });
    await vi.waitFor(() =>
      expect(rows(region)).toEqual([
        {
          text: '路由缺服务：SQLite 记忆（失败：打不开数据库）；停用的提供者（已停用）',
          tone: '需要处理',
          action: ['去处理 SQLite 记忆', '/plugins/zz-sqlite'],
        },
      ]),
    );
  });
});

describe('插件详情', () => {
  it('头部之后是这个插件的提示，「去配置」落在配置区；故障原因只在头部，不在提示里重复；没有提示的插件没有这一块', async () => {
    app = await renderApp('/plugins/zz-model', noSessions, rest());
    const main = within(screen.getByRole('main'));
    const block = await main.findByRole('region', { name: '需要处理' });
    expect(rows(block)).toEqual([
      { text: '余额不足', tone: '需要处理', action: ['去配置', '/plugins/zz-model#config'] },
      { text: '账本读取失败', tone: '出错', action: null },
    ]);
    const summary = screen.getByText('缺少 API 密钥');
    expect(summary.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.getAllByText(/缺少 API 密钥/)).toHaveLength(1);

    app.close();
    app = await renderApp('/plugins/zz-agent', noSessions, rest());
    const agent = within(screen.getByRole('main'));
    await agent.findByText('缺服务');
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(agent.queryByRole('region', { name: '需要处理' })).toBeNull();
  });
});

describe('标签页标题', () => {
  it('握手给的应用名，前面是「需要处理」的数加「我的」区完成未读的会话数（不在会话区时也算）；都为 0 时只有应用名', async () => {
    let items = ITEMS;
    const mine = [summary('s1', { unread: true }), summary('s2'), summary('s3', { unread: true })];
    app = await renderApp(
      '/plugins',
      {
        initialize: () => ({ ...INIT, appName: '<应用名>' }),
        'sessions/list': lists(p => (p.section === 'owner' ? mine : [])),
      },
      rest(() => ({ items })),
    );
    await vi.waitFor(() => expect(document.title).toBe('(9) <应用名>'));

    items = [];
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    await vi.waitFor(() => expect(document.title).toBe('(2) <应用名>'));

    act(() =>
      server().notify('sessions/changed', {
        upserts: [summary('s1'), summary('s3')],
        removes: [],
        groups: [],
      }),
    );
    expect(document.title).toBe('<应用名>');
  });
});
