// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvals } from '../../packages/api-approval/src/index.js';
import type { SessionSummary } from '../../packages/api-session-protocol/src/index.js';
import type { AttentionItem, LogFilter } from '../../packages/api-webui/src/index.js';
import type { LogEntry, LogLevel } from '../../packages/core/src/index.js';
import { SERVICE_ABSENT } from '../../packages/plugin-webui-client/src/connection.js';
import { SESSION_PROTOCOL } from '../../packages/plugin-webui-client/src/plugins/list.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { deferred } from '../helpers/deferred.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  choose,
  type FakeRest,
  type Harness,
  installDialog,
  listRequests,
  lists,
  optionsOf,
  pluginRow as plugin,
  renderApp,
  requests,
  server,
  summary,
} from './harness.js';
import { AT, backgroundTask } from './items.js';

// ════════════════════════════════════════════════════════════
// 运行状况：图标栏下方（手机上第一层）的「运行状况」，角标是「需要处理」的数；页面有两个标签，概况列出「需要处理」、
// 正在运行的后台工作（按会话与会话树，可停）与各适配器的连接（打开时取一次，配手动刷新），日志按级别、插件、文字筛，筛选写进地址，订阅实时日志与取历史都带上它；
// 两个预设：「只看错误」与「审批」（提供审批服务的实例，按插件列表的 provides 找）。插件详情的「查看日志」按插件筛好
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const SESSIONS = plugin('zz-sessions', { displayName: '会话服务', provides: [SESSION_PROTOCOL, approvals.name] });
const PLUGINS = [
  SESSIONS,
  plugin('zz-im', { displayName: '即时通讯', reusable: true }),
  plugin('zz-im:2', { displayName: '即时通讯', reusable: true }),
  plugin('zz-model', { displayName: '模型服务', state: 'error', error: '缺少 API 密钥' }),
];

const ITEMS: AttentionItem[] = [
  { kind: 'approval', id: 'ap-1', sessionId: 's1', session: '整理周报', tool: 'exec' },
  {
    kind: 'plugin',
    instance: 'zz-model',
    state: 'error',
    error: '缺少 API 密钥',
    lacking: [],
    waiting: [],
    unconfigured: [],
  },
];

const PLATFORMS = {
  platforms: [
    {
      adapterName: 'WebUI',
      platform: 'webui',
      contextId: 'zz-webui',
      connections: [{ id: 'webui', platform: 'webui', status: 'online', detail: { clients: 1 } }],
    },
    {
      adapterName: 'QQ',
      platform: 'onebot',
      contextId: 'zz-im:2',
      connections: [
        { id: 'a', platform: 'onebot', selfId: '10001', selfNickname: '小助手', status: 'online' },
        { id: 'b', platform: 'onebot', selfId: '10002', status: 'offline' },
        { id: 'c', platform: 'onebot', status: 'connecting' },
      ],
    },
    { adapterName: '终端', platform: 'cli', contextId: 'zz-cli', connections: [] },
  ],
};

const noSessions = { 'sessions/list': lists(() => []) };

function rest(fields: FakeRest = {}): FakeRest {
  return {
    '/api/plugins': { plugins: PLUGINS, secretRefCounts: {} },
    '/api/attention': { items: ITEMS },
    '/api/platforms': PLATFORMS,
    ...fields,
  };
}

const entry = (seq: number, level: LogLevel, scope: string, message: string): LogEntry => ({
  seq,
  timestamp: `2026-10-04T09:00:0${seq}.000+08:00`,
  level,
  scope,
  message,
});

/** 发往 /admin 的消息，按先后 */
const adminMessages = () => FakeWebSocket.at('/admin').sent.map(frame => JSON.parse(frame) as unknown);
const subscribe = (filter: LogFilter) => ({ type: 'log.subscribe', filter });

const rail = () => within(screen.getByRole('navigation', { name: '图标栏' }));
const shell = () => document.querySelector('[data-phone]') as HTMLElement;

describe('入口与角标', () => {
  it('桌面：运行状况的角标是「需要处理」的数，读屏标签带上它，空了不出现', async () => {
    let items = ITEMS;
    app = await renderApp('/', noSessions, rest({ '/api/attention': () => ({ items }) }));
    const health = await rail().findByRole('link', { name: '运行状况，2 项需要处理' });
    expect(health.getAttribute('href')).toBe('/health');
    expect(within(health).getByText('2')).toBeTruthy();

    items = [];
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    const plain = await rail().findByRole('link', { name: '运行状况' });
    expect(within(plain).queryByText(/\d/)).toBeNull();
  });

  it('运行状况没有左栏：所在时是当前项，再点它不收起别的区的左栏', async () => {
    app = await renderApp('/s/a', noSessions, rest());
    fireEvent.click(await rail().findByRole('link', { name: /^运行状况/ }));
    expect(app.where()).toBe('/health');
    expect(
      rail()
        .getByRole('link', { name: /^运行状况/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull();
    fireEvent.click(rail().getByRole('link', { name: /^运行状况/ }));
    expect(app.where()).toBe('/health');
    expect(shell().dataset.left).toBeUndefined();
    expect(localStorage.getItem('aalis.panels')).toBeNull();
  });

  it('手机：第一层的运行状况带数，读屏名字带上它；「返回」回第一层', async () => {
    stubViewport(390);
    app = await renderApp('/', noSessions, rest());
    const entries = within(await screen.findByRole('list', { name: '入口' }));
    // 读屏名字与桌面图标栏同一写法（两段之间的空白由排版带出）
    const health = await entries.findByRole('link', { name: /^运行状况\s*，2 项需要处理$/ });
    expect(within(health).getByText('2')).toBeTruthy();
    fireEvent.click(health);
    expect(app.where()).toBe('/health');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/');
  });
});

describe('概况', () => {
  it('「需要处理」列出全部；平台连接按适配器实例与连接逐行写状态，离线的标出错，没有连接的写明，行链到适配器的插件详情；打开时取一次，刷新再取', async () => {
    let calls = 0;
    app = await renderApp(
      '/health',
      noSessions,
      rest({
        '/api/platforms': () => {
          calls++;
          return PLATFORMS;
        },
      }),
    );
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('tab', { name: '概况' }).getAttribute('aria-selected')).toBe('true');
    const attention = await main.findByRole('region', { name: '需要处理' });
    await vi.waitFor(() => expect(within(attention).getAllByRole('listitem')).toHaveLength(2));

    const platforms = await main.findByRole('list', { name: '平台连接' });
    const rows = within(platforms)
      .getAllByRole('listitem')
      .map(row => [
        row.querySelector('a')?.getAttribute('href'),
        row.querySelector('.list-item-title')?.textContent,
        row.querySelector('.list-item-detail')?.textContent ?? null,
        row.querySelector('.list-item-meta')?.textContent,
        row.querySelector('[data-marker]')?.getAttribute('data-marker') ?? null,
      ]);
    expect(rows).toEqual([
      ['/plugins/zz-webui', 'WebUI', null, '在线', null],
      ['/plugins/zz-im%3A2', 'QQ · 2', '小助手（10001）', '在线', null],
      ['/plugins/zz-im%3A2', 'QQ · 2', '10002', '离线', 'error'],
      ['/plugins/zz-im%3A2', 'QQ · 2', null, '连接中', null],
      ['/plugins/zz-cli', '终端', null, '没有连接', null],
    ]);
    expect(calls).toBe(1);
    fireEvent.click(main.getByRole('button', { name: '刷新平台连接' }));
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it('「需要处理」空了写明没有；没有适配器时平台连接不出现；没取到时原地写明原因，可以重试', async () => {
    let fail = true;
    app = await renderApp(
      '/health',
      noSessions,
      rest({
        '/api/attention': { items: [] },
        '/api/platforms': () =>
          fail ? Response.json({ error: '平台服务读不出' }, { status: 500 }) : { platforms: [] },
      }),
    );
    const main = within(screen.getByRole('main'));
    await main.findByText('没有需要处理的事');
    const alert = await main.findByRole('alert');
    expect(alert.textContent).toContain('平台服务读不出');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(main.queryByRole('alert')).toBeNull());
    expect(main.queryByRole('region', { name: '平台连接' })).toBeNull();
  });
});

describe('正在运行', () => {
  const ENDED = { outcome: 'replied' as const, endedAt: AT + 60_000 };
  const ROOTS = [
    summary('r1', { title: '整理周报', background: 2, childCount: 2 }),
    summary('r2', { title: '归档的会话', background: 1, archived: true }),
  ];
  const CHILDREN: Record<string, SessionSummary[]> = {
    r1: [
      summary('c1', { title: '子任务一', kind: 'task', parentId: 'r1', running: true, childCount: 1 }),
      summary('c2', { title: '做完的子任务', kind: 'task', parentId: 'r1', lastTurn: ENDED }),
    ],
    c1: [summary('g1', { title: '孙任务', kind: 'task', parentId: 'c1', background: 1, lastTurn: ENDED })],
  };
  const TASKS = [
    backgroundTask('t-root', { sessionId: 'r1', display: { kind: 'command', command: 'npm run dev' } }),
    backgroundTask('t-grand', { sessionId: 'g1', label: 'analyze_image' }),
    backgroundTask('t-archived', { sessionId: 'r2', label: 'http_download' }),
    backgroundTask('t-done', { sessionId: 'r1', label: 'pdf_convert', status: 'completed', endedAt: AT + 1000 }),
  ];
  const handlers = (roots: SessionSummary[] = ROOTS) => ({
    'sessions/list': lists(p => (p.background ? roots : p.parentId ? (CHILDREN[p.parentId] ?? []) : [])),
    'background/list': () => ({ tasks: TASKS }),
    'background/stop': () => ({}),
    'background/stopAll': () => ({}),
    'turn/abort': () => ({}),
  });

  it('按会话列出有后台工作的会话（归档的照样列出），每个会话下按会话树列出在跑的子会话与在跑的后台任务；会话链到它的「后台」标签', async () => {
    app = await renderApp('/health', handlers(), rest());
    const main = within(screen.getByRole('main'));
    const running = await main.findByRole('list', { name: '正在运行' });
    await within(running).findByText('孙任务');
    const sessions = within(running).getAllByRole('link', { name: /整理周报|归档的会话/ });
    expect(sessions.map(link => link.getAttribute('href'))).toEqual(['/s/r1/background', '/s/r2/background']);
    expect(sessions[0].textContent).toContain('后台 2');
    expect(sessions[1].textContent).toContain('已归档');
    expect(listRequests()).toContainEqual({ background: true, limit: 200 });

    const r1 = sessions[0].closest('li') as HTMLElement;
    expect(within(r1).getByText('npm run dev')).toBeTruthy();
    const child = within(r1)
      .getByRole('link', { name: /子任务一/ })
      .closest('li') as HTMLElement;
    expect(within(child).getByRole('link', { name: /孙任务/ })).toBeTruthy();
    expect(within(child).getByText('analyze_image')).toBeTruthy();
    expect(within(r1).queryByText('做完的子任务')).toBeNull();
    expect(within(r1).queryByText('pdf_convert')).toBeNull();
    const r2 = sessions[1].closest('li') as HTMLElement;
    expect(within(r2).getByText('http_download')).toBeTruthy();

    act(() =>
      server().notify('sessions/changed', { upserts: [{ ...ROOTS[1], background: 0 }], removes: [], groups: [] }),
    );
    expect(within(running).queryByRole('link', { name: /归档的会话/ })).toBeNull();
  });

  it('可停：后台任务停这一个，子会话停它的回合并对它全部停止，会话这一行停它下面的全部后台工作；归档的照样能停', async () => {
    app = await renderApp('/health', handlers(), rest());
    const main = within(screen.getByRole('main'));
    fireEvent.click(await main.findByRole('button', { name: '停止「npm run dev」' }));
    await vi.waitFor(() => expect(requests('background/stop')).toEqual([{ taskId: 't-root' }]));
    fireEvent.click(main.getByRole('button', { name: '停止「子任务一」' }));
    await vi.waitFor(() => expect(requests('turn/abort')).toEqual([{ sessionId: 'c1' }]));
    fireEvent.click(main.getByRole('button', { name: '全部停止「归档的会话」' }));
    await vi.waitFor(() => expect(requests('background/stopAll')).toEqual([{ sessionId: 'c1' }, { sessionId: 'r2' }]));
    fireEvent.click(main.getByRole('button', { name: '停止「http_download」' }));
    await vi.waitFor(() =>
      expect(requests('background/stop')).toEqual([{ taskId: 't-root' }, { taskId: 't-archived' }]),
    );
  });

  it('没有在跑的就不出现；会话服务不在时也不出现', async () => {
    app = await renderApp('/health', handlers([]), rest());
    const main = within(screen.getByRole('main'));
    await main.findByRole('region', { name: '需要处理' });
    await vi.waitFor(() => expect(listRequests()).toContainEqual({ background: true, limit: 200 }));
    await act(async () => {});
    expect(main.queryByRole('region', { name: '正在运行' })).toBeNull();
    app.close();

    app = await renderApp('/health', handlers(), rest());
    const again = within(screen.getByRole('main'));
    await again.findByRole('list', { name: '正在运行' });
    act(() => server().drop(SERVICE_ABSENT));
    await vi.waitFor(() => expect(again.queryByRole('region', { name: '正在运行' })).toBeNull());
  });
});

describe('重取失败', () => {
  it('「需要处理」与平台连接留着上一次的，各写一行没刷新成功的原因，「重试」再取', async () => {
    let fail = false;
    const failing = (body: unknown) => () => (fail ? Response.json({ error: '服务读不出' }, { status: 500 }) : body);
    app = await renderApp(
      '/health',
      noSessions,
      rest({ '/api/attention': failing({ items: ITEMS }), '/api/platforms': failing(PLATFORMS) }),
    );
    const main = within(screen.getByRole('main'));
    const attention = await main.findByRole('region', { name: '需要处理' });
    await vi.waitFor(() => expect(within(attention).getAllByRole('listitem')).toHaveLength(2));
    const platforms = await main.findByRole('region', { name: '平台连接' });
    fail = true;
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    fireEvent.click(main.getByRole('button', { name: '刷新平台连接' }));
    expect((await within(attention).findByRole('alert')).textContent).toContain('没刷新成功：服务读不出');
    expect((await within(platforms).findByRole('alert')).textContent).toContain('没刷新成功：服务读不出');
    expect(within(attention).getAllByRole('listitem')).toHaveLength(2);
    expect(within(platforms).getAllByRole('listitem')).toHaveLength(5);
    fail = false;
    fireEvent.click(within(attention).getByRole('button', { name: '重试' }));
    fireEvent.click(within(platforms).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(main.queryByRole('alert')).toBeNull());
  });
});

describe('日志', () => {
  /** 取历史的路径：查询串按级别、插件、文字、limit、before 的顺序 */
  const tail = (query: string) => `/api/logs/tail?${query ? `${query}&` : ''}limit=200`;

  it('地址上的筛选带进订阅与历史，刷新后保持；改级别、插件、文字写进地址，换掉订阅并重取；离开时退订', async () => {
    const url = '/health/logs?level=warn&plugin=zz-im%3A2';
    const history = {
      [tail('level=warn&plugin=zz-im%3A2')]: [entry(3, 'warn', 'aalis:zz-im:2', '心跳超时')],
      [tail('level=error&plugin=zz-im%3A2')]: [],
      [tail('level=error')]: [entry(5, 'error', 'aalis:zz-model', '缺少 API 密钥')],
      [tail('level=error&text=%E5%AF%86%E9%92%A5')]: [entry(5, 'error', 'aalis:zz-model', '缺少 API 密钥')],
    };
    app = await renderApp(url, noSessions, rest(history));
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('tab', { name: '日志' }).getAttribute('aria-selected')).toBe('true');
    const list = await main.findByRole('list', { name: '日志' });
    await within(list).findByText('心跳超时');
    expect(adminMessages()).toEqual([subscribe({ level: 'warn', plugin: 'zz-im:2' })]);
    const level = main.getByRole('combobox', { name: '级别' });
    const owner = main.getByRole('combobox', { name: '插件' });
    expect([level.textContent, owner.textContent]).toEqual(['警告及以上', '即时通讯 · 2']);
    expect(optionsOf(owner)).toEqual(['全部插件', '会话服务', '即时通讯', '即时通讯 · 2', '模型服务']);

    app.close();
    app = await renderApp(url, noSessions, rest(history));
    const again = within(screen.getByRole('main'));
    await within(await again.findByRole('list', { name: '日志' })).findByText('心跳超时');
    expect(again.getByRole('combobox', { name: '级别' }).textContent).toBe('警告及以上');
    expect(adminMessages()).toEqual([subscribe({ level: 'warn', plugin: 'zz-im:2' })]);

    choose(again.getByRole('combobox', { name: '级别' }), '只看错误');
    expect(app.where()).toBe('/health/logs?level=error&plugin=zz-im%3A2');
    await again.findByText('没有符合筛选的日志');
    choose(again.getByRole('combobox', { name: '插件' }), '全部插件');
    expect(app.where()).toBe('/health/logs?level=error');
    await again.findByText('缺少 API 密钥');
    const text = again.getByRole('searchbox', { name: '文字' });
    fireEvent.change(text, { target: { value: '密钥' } });
    fireEvent.submit(text.closest('form') as HTMLFormElement);
    expect(app.where()).toBe(`/health/logs?level=error&text=${encodeURIComponent('密钥')}`);
    await vi.waitFor(() => expect(adminMessages().at(-1)).toEqual(subscribe({ level: 'error', text: '密钥' })));
    expect(adminMessages()).toEqual([
      subscribe({ level: 'warn', plugin: 'zz-im:2' }),
      { type: 'log.unsubscribe' },
      subscribe({ level: 'error', plugin: 'zz-im:2' }),
      { type: 'log.unsubscribe' },
      subscribe({ level: 'error' }),
      { type: 'log.unsubscribe' },
      subscribe({ level: 'error', text: '密钥' }),
    ]);

    fireEvent.click(again.getByRole('tab', { name: '概况' }));
    expect(app.where()).toBe('/health');
    expect(adminMessages().at(-1)).toEqual({ type: 'log.unsubscribe' });
  });

  it('推来的接在历史后面、按序号去重，级别写成字；没有日志、没有符合筛选的分别写明，后者能清除筛选；「更早的日志」往前翻同样带筛选', async () => {
    const full = Array.from({ length: 200 }, (_, i) => entry(i + 101, 'info', 'aalis:zz-im', `第 ${i + 101} 条`));
    app = await renderApp(
      '/health/logs?plugin=zz-im',
      noSessions,
      rest({
        [tail('plugin=zz-im')]: full,
        '/api/logs/range?plugin=zz-im&limit=200&before=101': [entry(7, 'debug', 'aalis:zz-im:worker', '更早的一条')],
        [tail('')]: [],
      }),
    );
    const main = within(screen.getByRole('main'));
    const list = await main.findByRole('list', { name: '日志' });
    await within(list).findByText('第 300 条');
    const admin = FakeWebSocket.at('/admin');
    act(() => {
      admin.push({ type: 'log', entry: entry(300, 'info', 'aalis:zz-im', '第 300 条') });
      admin.push({ type: 'log', entry: entry(301, 'warn', 'aalis:zz-im', '推来的告警') });
    });
    const messages = () => [...list.querySelectorAll('.log-message')].map(element => element.textContent);
    expect(messages().slice(-2)).toEqual(['第 300 条', '推来的告警']);
    expect(list.lastElementChild?.querySelector('.log-level')?.textContent).toBe('警告');
    expect(messages()).toHaveLength(201);

    fireEvent.click(main.getByRole('button', { name: '更早的日志' }));
    await within(list).findByText('更早的一条');
    expect(messages()[0]).toBe('更早的一条');
    expect(list.firstElementChild?.querySelector('.log-level')?.textContent).toBe('调试');
    // 不满一页：没有更早的了
    expect(main.queryByRole('button', { name: '更早的日志' })).toBeNull();

    app.close();
    app = await renderApp('/health/logs?level=error', noSessions, rest({ [tail('level=error')]: [], [tail('')]: [] }));
    const filtered = within(screen.getByRole('main'));
    await filtered.findByText('没有符合筛选的日志');
    fireEvent.click(filtered.getByRole('link', { name: '清除筛选' }));
    expect(app.where()).toBe('/health/logs');
    await filtered.findByText('还没有日志');
  });

  it('地址里的 level=debug 与不筛一样，当没给：订阅与历史不带，选择器写全部级别', async () => {
    app = await renderApp('/health/logs?level=debug', noSessions, rest({ [tail('')]: [] }));
    const main = within(screen.getByRole('main'));
    await main.findByText('还没有日志');
    expect(adminMessages()).toEqual([subscribe({})]);
    expect(main.getByRole('combobox', { name: '级别' }).textContent).toBe('全部级别');
  });

  it('历史取回之前推来的接在历史后面，历史里已有的不重复', async () => {
    const history = deferred<LogEntry[]>();
    app = await renderApp('/health/logs', noSessions, rest({ [tail('')]: () => history.promise }));
    const main = within(screen.getByRole('main'));
    await vi.waitFor(() => expect(adminMessages()).toEqual([subscribe({})]));
    act(() => {
      FakeWebSocket.at('/admin').push({ type: 'log', entry: entry(2, 'info', 'aalis:zz-im', '历史里也有') });
      FakeWebSocket.at('/admin').push({ type: 'log', entry: entry(3, 'info', 'aalis:zz-im', '只在推送里') });
    });
    act(() =>
      history.resolve([entry(1, 'info', 'aalis:zz-im', '第一条'), entry(2, 'info', 'aalis:zz-im', '历史里也有')]),
    );
    const list = await main.findByRole('list', { name: '日志' });
    await within(list).findByText('只在推送里');
    expect([...list.querySelectorAll('.log-message')].map(element => element.textContent)).toEqual([
      '第一条',
      '历史里也有',
      '只在推送里',
    ]);
  });

  it('历史没取到时写明原因可以重试；管理连接重连后重新订阅、重取', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = true;
    app = await renderApp(
      '/health/logs',
      noSessions,
      rest({
        [tail('')]: () =>
          fail
            ? Response.json({ error: '日志文件读不出' }, { status: 500 })
            : [entry(1, 'info', 'aalis:zz-im', '恢复了')],
      }),
    );
    const main = within(screen.getByRole('main'));
    const alert = await main.findByRole('alert');
    expect(alert.textContent).toContain('日志文件读不出');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await main.findByText('恢复了');

    act(() => FakeWebSocket.at('/admin').drop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeWebSocket.at('/admin').open());
    await vi.waitFor(() => expect(adminMessages()).toEqual([subscribe({})]));
  });

  it('预设：「只看错误」筛错误级别；「审批」筛提供审批服务的实例；没有提供审批服务的插件时没有「审批」', async () => {
    app = await renderApp('/health/logs', noSessions, rest({ [tail('')]: [] }));
    const main = within(screen.getByRole('main'));
    expect((await main.findByRole('link', { name: '只看错误' })).getAttribute('href')).toBe('/health/logs?level=error');
    expect((await main.findByRole('link', { name: '审批' })).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-sessions',
    );

    app.close();
    app = await renderApp(
      '/health/logs',
      noSessions,
      rest({
        '/api/plugins': { plugins: [{ ...SESSIONS, provides: [SESSION_PROTOCOL] }], secretRefCounts: {} },
        [tail('')]: [],
      }),
    );
    const without = within(screen.getByRole('main'));
    const owners = without.getByRole('combobox', { name: '插件' });
    await vi.waitFor(() => expect(optionsOf(owners)).toHaveLength(2));
    expect(without.getByRole('link', { name: '只看错误' })).toBeTruthy();
    expect(without.queryByRole('link', { name: '审批' })).toBeNull();
  });
});

describe('插件详情', () => {
  it('头部的「查看日志」链到按这个插件筛好的日志', async () => {
    app = await renderApp('/plugins/zz-im%3A2', noSessions, rest());
    const link = await within(screen.getByRole('main')).findByRole('link', { name: '查看日志' });
    expect(link.getAttribute('href')).toBe('/health/logs?plugin=zz-im%3A2');
  });
});
