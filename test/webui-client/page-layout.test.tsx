// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRest,
  type Harness,
  installDialog,
  lists,
  panelClosers,
  renderApp,
  restCalls,
  summary,
} from './harness.js';
import { snapshot } from './items.js';
import {
  actionPath,
  data,
  dataPath,
  FILES,
  GRAPH,
  hostTab,
  hostTabs,
  JOBS,
  layoutStore,
  NOTES,
  pagePath,
  pageTab,
  refOf,
  SETTINGS_PAGE,
} from './pages.js';

// ════════════════════════════════════════════════════════════
// 页面在外壳里的位置：位置为插件详情的页面可以从标题栏固定到图标栏（记录跟着 owner 存在服务端，layout.changed 推来后重取），
// 图标栏按记录的顺序列出登记着的页面，所属插件停用时图标不出现、记录保留；手机上没有图标栏，固定的页面列在第一层。
// 会话面板：宿主标签与插件标签同一张表，按表的顺序排；开着的在标签栏里，关着的与适用、还没进表的插件页面在「+」里，
// 关闭按钮只关当前标签；记录在所有适用的会话里生效。适用与否按会话从服务端取，插件启停、相关的 page.invalidate 与重连后重取
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

const admin = () => FakeWebSocket.at('/admin');
const rail = () => within(screen.getByRole('navigation', { name: '图标栏' }));
const railLinks = () =>
  rail()
    .getAllByRole('link')
    .map(link => link.getAttribute('aria-label'));
const posts = (path: string) => restCalls().filter(call => call.method === 'POST' && call.path === path);
const gets = (path: string) => restCalls().filter(call => call.method === 'GET' && call.path === path).length;
const header = (title: string) => within(screen.getByRole('heading', { name: title }).closest('header') as HTMLElement);

function pageRest(layout: ReturnType<typeof layoutStore>, extra: FakeRest = {}): FakeRest {
  return {
    '/api/pages': { pages: [JOBS, GRAPH, SETTINGS_PAGE, NOTES, FILES] },
    '/api/layout': layout.route,
    [dataPath(JOBS, 'summary')]: data([]),
    [dataPath(JOBS, 'list')]: data([]),
    [dataPath(GRAPH, 'about')]: data('说明'),
    ...extra,
  };
}

describe('固定到图标栏', () => {
  it('从标题栏固定与取消：按操作写入，图标栏跟着出现与消失；在固定的页面上它是当前项', async () => {
    const layout = layoutStore();
    app = await renderApp(pagePath(JOBS), {}, pageRest(layout));
    const pin = await header('计划').findByRole('button', { name: '固定到图标栏' });
    expect(railLinks()).toEqual(['会话', '运行状况', '插件', '设置']);
    expect(rail().getByRole('link', { name: '会话' }).getAttribute('aria-current')).toBeNull();

    fireEvent.click(pin);
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '计划 · night', '运行状况', '插件', '设置']));
    expect(posts('/api/layout').map(call => call.body)).toEqual([{ op: 'pin', page: refOf(JOBS) }]);
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(rail().getByRole('link', { name: '计划 · night' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(pin);
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '运行状况', '插件', '设置']));
    expect(posts('/api/layout').at(-1)?.body).toEqual({ op: 'unpin', page: refOf(JOBS) });
  });

  it('写不进去时出错 Toast 写原因，固定的样子不变', async () => {
    const layout = layoutStore();
    app = await renderApp(
      pagePath(JOBS),
      {},
      pageRest(layout, {
        '/api/layout': (request: Parameters<typeof layout.route>[0]) =>
          request.method === 'POST'
            ? Response.json({ error: '最多 50 条，先取消一些' }, { status: 409 })
            : layout.route(request),
      }),
    );
    const pin = await header('计划').findByRole('button', { name: '固定到图标栏' });
    fireEvent.click(pin);
    expect((await screen.findByRole('alert')).textContent).toContain('固定失败：最多 50 条，先取消一些');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(railLinks()).toEqual(['会话', '运行状况', '插件', '设置']);
  });

  it('图标栏按记录的顺序列出登记着、位置为插件详情的页面；页面不在时图标不出现、记录保留，回来后出现', async () => {
    const layout = layoutStore({ pinned: [refOf(GRAPH), refOf(SETTINGS_PAGE), refOf(JOBS)] });
    let pages = [JOBS, GRAPH, SETTINGS_PAGE];
    app = await renderApp('/', {}, pageRest(layout, { '/api/pages': () => ({ pages }) }));
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '关系', '计划 · night', '运行状况', '插件', '设置']));
    expect(rail().getByRole('link', { name: '关系' }).getAttribute('href')).toBe(pagePath(GRAPH));

    pages = [JOBS];
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '计划 · night', '运行状况', '插件', '设置']));
    pages = [JOBS, GRAPH];
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '关系', '计划 · night', '运行状况', '插件', '设置']));
  });

  it('不认识的图标名用通用图标', async () => {
    const layout = layoutStore({ pinned: [refOf(GRAPH), refOf(JOBS)] });
    app = await renderApp('/', {}, pageRest(layout));
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '关系', '计划 · night', '运行状况', '插件', '设置']));
    await vi.waitFor(() =>
      expect(rail().getByRole('link', { name: '计划 · night' }).querySelector('svg')?.classList).toContain(
        'lucide-clock',
      ),
    );
    expect(rail().getByRole('link', { name: '关系' }).querySelector('svg')?.classList).toContain('lucide-layout-grid');
  });

  it('layout.changed：别的设备改了记录，这里重取', async () => {
    const layout = layoutStore();
    app = await renderApp('/', {}, pageRest(layout));
    await vi.waitFor(() => expect(gets('/api/layout')).toBe(1));
    layout.records.pinned.push(refOf(GRAPH));
    act(() => admin().push({ type: 'layout.changed' }));
    await vi.waitFor(() => expect(railLinks()).toEqual(['会话', '关系', '运行状况', '插件', '设置']));
  });

  it('点「会话」回到刚才的会话地址；只有位置为插件详情的页面有「固定」', async () => {
    const layout = layoutStore({ pinned: [refOf(GRAPH)] });
    app = await renderApp(
      '/s/a',
      { 'sessions/list': lists(() => [summary('a')]), 'session/subscribe': () => snapshot([]) },
      pageRest(layout),
    );
    fireEvent.click(await rail().findByRole('link', { name: '关系' }));
    expect(app.where()).toBe(pagePath(GRAPH));
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull();
    fireEvent.click(rail().getByRole('link', { name: '会话' }));
    expect(app.where()).toBe('/s/a');
    expect(rail().getByRole('link', { name: '会话' }).getAttribute('aria-current')).toBe('page');
  });

  it('布局记录没取到：「固定」写明原因，点它重试', async () => {
    let fail = true;
    const layout = layoutStore();
    app = await renderApp(
      pagePath(JOBS),
      {},
      pageRest(layout, {
        '/api/layout': (request: Parameters<typeof layout.route>[0]) =>
          fail ? Response.json({ error: '存储服务不在，布局记录读写不了' }, { status: 503 }) : layout.route(request),
      }),
    );
    const retry = await header('计划').findByRole('button', { name: /布局记录没取到：存储服务不在/ });
    fail = false;
    fireEvent.click(retry);
    expect(await header('计划').findByRole('button', { name: '固定到图标栏' })).toBeTruthy();
  });

  /** 布局记录先读不了、改成能读：首页的固定区写明原因、可以重试 */
  function failingLayout() {
    const state = { fail: true };
    const layout = layoutStore({ pinned: [refOf(JOBS)] });
    const rest = pageRest(layout, {
      '/api/layout': (request: Parameters<typeof layout.route>[0]) =>
        state.fail
          ? Response.json({ error: '存储服务不在，布局记录读写不了' }, { status: 503 })
          : layout.route(request),
    });
    return { state, rest };
  }

  it('布局记录没取到：首页的图标栏写明原因，点它重试', async () => {
    const { state, rest } = failingLayout();
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, rest);
    const retry = await rail().findByRole('button', { name: /固定的页面没取到：存储服务不在/ });
    state.fail = false;
    fireEvent.click(retry);
    expect(await rail().findByRole('link', { name: '计划 · night' })).toBeTruthy();
    expect(rail().queryByRole('button', { name: /没取到/ })).toBeNull();
  });

  it('布局记录没取到：手机第一层的固定区写出原因，带「重试」', async () => {
    stubViewport(390);
    const { state, rest } = failingLayout();
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, rest);
    const pinned = within(await screen.findByRole('region', { name: '固定的页面' }));
    expect((await pinned.findByRole('alert')).textContent).toContain('存储服务不在，布局记录读写不了');
    state.fail = false;
    fireEvent.click(pinned.getByRole('button', { name: '重试' }));
    expect(await pinned.findByRole('link', { name: /计划 · night/ })).toBeTruthy();
    expect(pinned.queryByRole('alert')).toBeNull();
  });

  it('页面表重取失败：打开着的页面与对话框里填了一半的表单不丢，图标栏照旧并写明没取到', async () => {
    let fail = false;
    const layout = layoutStore({ pinned: [refOf(JOBS)] });
    app = await renderApp(
      pagePath(JOBS),
      {},
      pageRest(layout, {
        '/api/pages': () =>
          fail ? Response.json({ error: '页面表读不了' }, { status: 500 }) : { pages: [JOBS, GRAPH] },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: '新建' }));
    fireEvent.change(within(screen.getByRole('dialog', { name: '新建' })).getByLabelText('名称'), {
      target: { value: '晨报' },
    });
    fail = true;
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await rail().findByRole('button', { name: /固定的页面没取到：页面表读不了/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '计划' }), '一次重取失败把打开着的页面卸掉了').toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('晨报');
    expect(railLinks()).toEqual(['会话', '计划 · night', '运行状况', '插件', '设置']);
  });

  it('布局记录重取失败：图标栏留着上一次的固定项，并写明没取到', async () => {
    const { state, rest } = failingLayout();
    state.fail = false;
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, rest);
    await rail().findByRole('link', { name: '计划 · night' });
    state.fail = true;
    act(() => admin().push({ type: 'layout.changed' }));
    expect(await rail().findByRole('button', { name: /固定的页面没取到：存储服务不在/ })).toBeTruthy();
    expect(railLinks()).toEqual(['会话', '计划 · night', '运行状况', '插件', '设置']);
  });

  it('实例与页面键拼起来一样的两个页面之间切换：进行中的动作不带到另一页', async () => {
    const pageOf = (instance: string, key: string, title: string): typeof JOBS => ({
      instance,
      key,
      title,
      placement: 'plugin',
      actions: { run: { label: '执行', effect: 'write', row: true } },
      content: [
        {
          type: 'table',
          id: 'list',
          rowKey: 'id',
          columns: [{ key: 'id', label: '编号', primary: true }],
          rowActions: [{ action: 'run' }],
        },
      ],
    });
    const first = pageOf('zz-a', 'bc', '甲');
    const second = pageOf('zz-ab', 'c', '乙');
    const layout = layoutStore({ pinned: [refOf(first), refOf(second)] });
    app = await renderApp(
      pagePath(first),
      {},
      {
        '/api/pages': { pages: [first, second] },
        '/api/layout': layout.route,
        [dataPath(first, 'list')]: data([{ id: 'r1' }]),
        [dataPath(second, 'list')]: data([{ id: 'r1' }]),
        [actionPath(first, 'run')]: () => new Promise(() => {}),
      },
    );
    const region = (name: string) => within(screen.getByRole('region', { name }));
    fireEvent.click(await region('甲').findByRole('button', { name: '执行' }));
    expect(region('甲').getByRole('status', { name: '进行中' })).toBeTruthy();
    fireEvent.click(rail().getByRole('link', { name: '乙' }));
    expect(await region('乙').findByRole('button', { name: '执行' })).toBeTruthy();
  });

  it('手机：没有图标栏，固定的页面列在第一层的会话列表上面，点进去占满一屏的是主区', async () => {
    stubViewport(390);
    const layout = layoutStore({ pinned: [refOf(JOBS)] });
    app = await renderApp('/', { 'sessions/list': lists(() => []) }, pageRest(layout));
    const pinned = within(await screen.findByRole('region', { name: '固定的页面' }));
    fireEvent.click(await pinned.findByRole('link', { name: /计划 · night/ }));
    expect(app.where()).toBe(pagePath(JOBS));
    expect((document.querySelector('[data-phone]') as HTMLElement).dataset.phone).toBe('main');
  });
});

describe('会话面板', () => {
  const sessions = [summary('a', { title: '整理周报' }), summary('b', { title: '读书笔记' })];
  const handlers = {
    'sessions/list': lists(() => sessions),
    'session/subscribe': ({ sessionId }: { sessionId: string }) =>
      snapshot([], { session: summary(sessionId, { title: sessionId === 'a' ? '整理周报' : '读书笔记' }) }),
    'session/config/get': () => ({ items: [] }),
  };
  const panel = () => within(screen.getByRole('complementary', { name: '会话面板' }));
  const tabs = () =>
    panel()
      .queryAllByRole('tab')
      .map(tab => tab.textContent);
  /** 点开「+」，回菜单里的各项 */
  const addMenu = async () => {
    fireEvent.click(await panel().findByRole('button', { name: '打开标签' }));
    return screen.getAllByRole('menuitem').map(item => item.textContent);
  };
  const notesPath = `/s/a/p/${NOTES.instance}/${NOTES.key}`;

  function panelRest(
    layout: ReturnType<typeof layoutStore>,
    applicable: Record<string, unknown[]>,
    extra: FakeRest = {},
  ) {
    return pageRest(layout, {
      '/api/session-pages?sessionId=a': () => ({ pages: applicable.a }),
      '/api/session-pages?sessionId=b': () => ({ pages: applicable.b }),
      [dataPath(NOTES, 'notes', { sessionId: 'a' })]: data([{ id: 'n1', text: '周一交' }]),
      [dataPath(NOTES, 'notes', { sessionId: 'b' })]: data([{ id: 'n2', text: '第三章' }]),
      [actionPath(NOTES, 'drop')]: {},
      ...extra,
    });
  }

  it('「+」里没东西时不出现：宿主标签都开着，也没有适用的插件页面', async () => {
    app = await renderApp('/s/a', handlers, panelRest(layoutStore(), { a: [] }));
    await vi.waitFor(() => expect(gets('/api/session-pages?sessionId=a')).toBe(1));
    expect(tabs()).toEqual(['设置']);
    expect(panel().queryByRole('button', { name: '打开标签' })).toBeNull();
  });

  it('插件标签默认不在表里：「+」按页面的先后列出适用的；打开后追加在末尾并切过去，数据源拿到当前会话；别的适用会话里也出现，不适用的会话里没有', async () => {
    const layout = layoutStore();
    app = await renderApp('/s/a', handlers, panelRest(layout, { a: [refOf(NOTES), refOf(FILES)], b: [refOf(NOTES)] }));
    expect(await addMenu()).toEqual(['笔记', '上传的文件']);
    fireEvent.click(screen.getByRole('menuitem', { name: '笔记' }));
    await vi.waitFor(() => expect(tabs()).toEqual(['设置', '笔记']));
    expect(posts('/api/layout').map(call => call.body)).toEqual([{ op: 'open-tab', tab: refOf(NOTES) }]);
    await vi.waitFor(() => expect(app?.where()).toBe(notesPath));
    expect(await panel().findByText('周一交')).toBeTruthy();
    expect(panel().queryByRole('button', { name: '固定到图标栏' })).toBeNull();
    expect(panel().getByRole('button', { name: '刷新' })).toBeTruthy();

    expect(await addMenu()).toEqual(['上传的文件']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('link', { name: /读书笔记/ }));
    await vi.waitFor(() => expect(tabs()).toEqual(['设置', '笔记']));
    fireEvent.click(panel().getByRole('tab', { name: '笔记' }));
    expect(await panel().findByText('第三章')).toBeTruthy();
    expect(panel().queryByRole('button', { name: '打开标签' })).toBeNull();
  });

  it('宿主标签与插件标签同一套：按表的顺序排，关着的进「+」，表里关着的在前、没进过表的按页面的先后在后；标签都关了时只剩「+」', async () => {
    const layout = layoutStore({
      panelTabs: [pageTab(FILES, false), hostTab('settings', false), hostTab('plan'), hostTab('usage')],
    });
    app = await renderApp('/s/a', handlers, panelRest(layout, { a: [refOf(NOTES), refOf(FILES)] }));
    expect(await addMenu()).toEqual(['上传的文件', '设置', '笔记']);
    expect(tabs()).toEqual([]);
    expect(panel().queryByRole('tabpanel')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));
    await vi.waitFor(() => expect(tabs()).toEqual(['设置']));
    expect(posts('/api/layout').map(call => call.body)).toEqual([{ op: 'open-tab', tab: { host: 'settings' } }]);
    await vi.waitFor(() => expect(app?.where()).toBe('/s/a/settings'));
    expect(await panel().findByText('这个会话没有可以设置的项')).toBeTruthy();
  });

  it('「+」里与宿主标签同名的插件页面各是一项：不报重复，点哪项开哪个', async () => {
    const twin = { ...NOTES, title: '设置' };
    const errors = vi.spyOn(console, 'error');
    const layout = layoutStore({ panelTabs: [hostTab('plan'), hostTab('settings', false), hostTab('usage')] });
    app = await renderApp('/s/a', handlers, {
      ...panelRest(layout, { a: [refOf(twin)] }),
      '/api/pages': { pages: [twin] },
    });
    expect(await addMenu()).toEqual(['设置', '设置']);
    expect(errors.mock.calls.flat().join('\n')).not.toMatch(/same key/);
    fireEvent.click(screen.getAllByRole('menuitem')[1]);
    await vi.waitFor(() => expect(app?.where()).toBe(notesPath));
    expect(tabs()).toEqual(['设置']);
  });

  it('写不进去时出错 Toast 写原因，不切过去，标签栏不变', async () => {
    const layout = layoutStore();
    app = await renderApp(
      '/s/a',
      handlers,
      panelRest(
        layout,
        { a: [refOf(NOTES)] },
        {
          '/api/layout': (request: Parameters<typeof layout.route>[0]) =>
            request.method === 'POST'
              ? Response.json({ error: '会话面板最多记 50 个标签' }, { status: 409 })
              : layout.route(request),
        },
      ),
    );
    await addMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '笔记' }));
    expect((await screen.findByRole('alert')).textContent).toContain('打开标签失败：会话面板最多记 50 个标签');
    expect(app.where()).toBe('/s/a');
    expect(tabs()).toEqual(['设置']);
  });

  it('写入还没回来就切到别的会话：回来后不把人拉回原来的会话', async () => {
    const layout = layoutStore();
    let release: () => void = () => {};
    app = await renderApp(
      '/s/a',
      handlers,
      panelRest(
        layout,
        { a: [refOf(NOTES)], b: [] },
        {
          '/api/layout': (request: Parameters<typeof layout.route>[0]) =>
            request.method === 'GET'
              ? layout.route(request)
              : new Promise(resolve => {
                  release = () => resolve(layout.route(request));
                }),
        },
      ),
    );
    await addMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '笔记' }));
    await vi.waitFor(() => expect(posts('/api/layout')).toHaveLength(1));
    fireEvent.click(screen.getByRole('link', { name: /读书笔记/ }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/b'));
    await act(async () => release());
    await vi.waitFor(() => expect(gets('/api/session-pages?sessionId=b')).toBeGreaterThan(0));
    expect(app.where()).toBe('/s/b');
    app.back();
    expect(app.where(), '切换会话那一条历史被替换掉了').toBe('/s/a');
  });

  it('面板所属的插件停用：标签栏末尾留着「已停用」，内容是占位并链到插件详情，关掉回会话；插件回来后回到原位', async () => {
    let pages = [JOBS, GRAPH, SETTINGS_PAGE, NOTES, FILES];
    const layout = layoutStore({ panelTabs: [...hostTabs(), pageTab(NOTES)] });
    app = await renderApp(
      notesPath,
      handlers,
      panelRest(layout, { a: [refOf(NOTES)] }, { '/api/pages': () => ({ pages }) }),
    );
    await panel().findByText('周一交');
    pages = pages.filter(page => page !== NOTES);
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await panel().findByText('这个页面所属的插件已停用')).toBeTruthy();
    expect(tabs()).toEqual(['设置', '已停用']);
    expect(panel().getByRole('tab', { name: '已停用' }).getAttribute('aria-selected')).toBe('true');
    expect(panel().getByRole('link', { name: '去插件详情' }).getAttribute('href')).toBe(`/plugins/${NOTES.instance}`);
    expect(app.where()).toBe(notesPath);

    pages = [...pages, NOTES];
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await panel().findByText('周一交')).toBeTruthy();
    expect(tabs()).toEqual(['设置', '笔记']);

    pages = pages.filter(page => page !== NOTES);
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() =>
      expect(panelClosers().map(button => button.getAttribute('aria-label'))).toEqual(['关闭「已停用」']),
    );
    fireEvent.click(panelClosers()[0] as HTMLElement);
    await vi.waitFor(() => expect(app?.where()).toBe('/s/a'));
    expect(posts('/api/layout').map(call => call.body)).toEqual([{ op: 'close-tab', tab: refOf(NOTES) }]);
  });

  it('会话面板里的页面：刷新在标签栏里，不另占一行，按了整页重取；宿主自己的标签没有刷新', async () => {
    const layout = layoutStore({ panelTabs: [...hostTabs(), pageTab(NOTES)] });
    app = await renderApp(notesPath, handlers, panelRest(layout, { a: [refOf(NOTES)] }));
    await panel().findByText('周一交');
    const count = () => gets(dataPath(NOTES, 'notes', { sessionId: 'a' }));
    expect(within(panel().getByRole('tabpanel')).queryByRole('button', { name: '刷新' })).toBeNull();
    fireEvent.click(panel().getByRole('button', { name: '刷新' }));
    await vi.waitFor(() => expect(count()).toBe(2));

    fireEvent.click(panel().getByRole('tab', { name: '设置' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/a/settings'));
    expect(panel().queryByRole('button', { name: '刷新' })).toBeNull();
  });

  it('行动作带上当前会话；关闭按钮只关当前标签，关了留在表里标为关、进「+」，回到第一个标签；再打开回到原位', async () => {
    const layout = layoutStore({ panelTabs: [hostTab('plan'), pageTab(NOTES), hostTab('settings'), hostTab('usage')] });
    app = await renderApp(notesPath, handlers, panelRest(layout, { a: [refOf(NOTES), refOf(FILES)] }));
    await panel().findByText('周一交');
    expect(tabs()).toEqual(['笔记', '设置']);
    const closeButtons = () => panelClosers().map(button => button.getAttribute('aria-label'));
    expect(closeButtons()).toEqual(['关闭「笔记」']);
    fireEvent.click(panel().getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除？' })).getByRole('button', { name: '删除' }));
    await vi.waitFor(() => expect(posts(actionPath(NOTES, 'drop'))).toHaveLength(1));
    expect(posts(actionPath(NOTES, 'drop'))[0].body).toEqual({ sessionId: 'a', rowKey: 'n1' });

    fireEvent.keyDown(panel().getByRole('tab', { name: '笔记' }), { key: 'Delete' });
    await vi.waitFor(() => expect(tabs()).toEqual(['设置']));
    expect(posts('/api/layout').map(call => call.body)).toEqual([{ op: 'close-tab', tab: refOf(NOTES) }]);
    await vi.waitFor(() => expect(app?.where()).toBe('/s/a'));
    expect(closeButtons()).toEqual(['关闭「设置」']);
    expect(await addMenu()).toEqual(['笔记', '上传的文件']);
    fireEvent.click(screen.getByRole('menuitem', { name: '笔记' }));
    await vi.waitFor(() => expect(tabs()).toEqual(['笔记', '设置']));
    expect(posts('/api/layout').at(-1)?.body).toEqual({ op: 'open-tab', tab: refOf(NOTES) });
    await vi.waitFor(() => expect(app?.where()).toBe(notesPath));
  });

  it('适用的页面没取到：「+」旁写明原因、点按重试，关着的宿主标签照样能从「+」打开', async () => {
    let fail = true;
    const layout = layoutStore({ panelTabs: [hostTab('plan'), hostTab('settings', false), hostTab('usage')] });
    app = await renderApp(
      '/s/a',
      handlers,
      panelRest(
        layout,
        { a: [refOf(NOTES)] },
        {
          '/api/session-pages?sessionId=a': () =>
            fail ? Response.json({ error: '会话服务不在' }, { status: 503 }) : { pages: [refOf(NOTES)] },
        },
      ),
    );
    const retry = await panel().findByRole('button', { name: '面板的标签没取全：会话服务不在（点按重试）' });
    expect(await addMenu()).toEqual(['设置']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fail = false;
    fireEvent.click(retry);
    await vi.waitFor(() => expect(panel().queryByRole('button', { name: /没取全/ })).toBeNull());
    expect(await addMenu()).toEqual(['设置', '笔记']);
  });

  it('布局记录没取到：宿主的标签按都开着显示，「+」旁写明原因、点按重试', async () => {
    let fail = true;
    const layout = layoutStore({ panelTabs: [hostTab('plan'), hostTab('settings', false), hostTab('usage')] });
    app = await renderApp(
      '/s/a',
      handlers,
      panelRest(
        layout,
        { a: [] },
        {
          '/api/layout': (request: Parameters<typeof layout.route>[0]) =>
            fail ? Response.json({ error: '存储服务不在，布局记录读写不了' }, { status: 503 }) : layout.route(request),
        },
      ),
    );
    const retry = await panel().findByRole('button', { name: /面板的标签没取全：存储服务不在/ });
    expect(tabs()).toEqual(['设置']);
    fail = false;
    fireEvent.click(retry);
    await vi.waitFor(() => expect(tabs()).toEqual([]));
    expect(await addMenu()).toEqual(['设置']);
  });

  it('适用与否重取：插件启停、不带会话或带本会话的会话面板页 invalidate、重连；别的会话的不重取', async () => {
    const layout = layoutStore({ panelTabs: [...hostTabs(), pageTab(NOTES)] });
    const applicable: Record<string, unknown[]> = { a: [] };
    app = await renderApp('/s/a', handlers, panelRest(layout, applicable));
    const count = () => gets('/api/session-pages?sessionId=a');
    await vi.waitFor(() => expect(count()).toBe(1));
    expect(tabs()).toEqual(['设置']);

    applicable.a = [refOf(NOTES)];
    act(() => admin().push({ type: 'page.invalidate', instance: NOTES.instance, pageKey: NOTES.key, sessionId: 'b' }));
    act(() => admin().push({ type: 'page.invalidate', instance: JOBS.instance, pageKey: JOBS.key }));
    act(() => admin().push({ type: 'page.invalidate', instance: NOTES.instance, pageKey: NOTES.key, sessionId: 'a' }));
    await vi.waitFor(() => expect(tabs()).toEqual(['设置', '笔记']));
    expect(count()).toBe(2);

    act(() => admin().push({ type: 'page.invalidate', instance: FILES.instance, pageKey: FILES.key }));
    await vi.waitFor(() => expect(count()).toBe(3));
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(count()).toBe(4));
    act(() => admin().drop());
    act(() => FakeWebSocket.at('/admin').open());
    await vi.waitFor(() => expect(count()).toBe(5));
  });

  it('带会话的 page.invalidate 只让打开着这个会话的面板重取', async () => {
    const layout = layoutStore({ panelTabs: [...hostTabs(), pageTab(NOTES)] });
    app = await renderApp(notesPath, handlers, panelRest(layout, { a: [refOf(NOTES)] }));
    await panel().findByText('周一交');
    const count = () => gets(dataPath(NOTES, 'notes', { sessionId: 'a' }));
    expect(count()).toBe(1);
    act(() => admin().push({ type: 'page.invalidate', instance: NOTES.instance, pageKey: NOTES.key, sessionId: 'b' }));
    act(() => admin().push({ type: 'page.invalidate', instance: NOTES.instance, pageKey: NOTES.key, sessionId: 'a' }));
    await vi.waitFor(() => expect(count()).toBe(2));
  });
});
