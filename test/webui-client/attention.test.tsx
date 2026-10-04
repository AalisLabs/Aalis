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

const PLUGINS = [
  plugin('zz-model', { displayName: '模型服务', state: 'error', error: '缺少 API 密钥' }),
  plugin('zz-agent', {
    displayName: '对话代理',
    state: 'pending',
    requiredServices: ['zz-model'],
    missing: ['zz-model'],
  }),
  plugin('zz-jobs:night', { displayName: '计划任务', reusable: true }),
  plugin('zz-auth', { displayName: '权限' }),
];

const ITEMS: AttentionItem[] = [
  { kind: 'approval', id: 'ap-1', sessionId: 's1', session: '整理周报', tool: 'exec' },
  { kind: 'plugin', instance: 'zz-model', state: 'error', error: '缺少 API 密钥', missing: [] },
  { kind: 'plugin', instance: 'zz-agent', state: 'pending', missing: ['zz-model'] },
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
      { text: '对话代理缺服务：zz-model', tone: '需要处理', action: ['去处理', '/plugins/zz-agent'] },
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
