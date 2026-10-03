// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { type Harness, installDialog, lists, renderApp, summary } from './harness.js';

// ════════════════════════════════════════════════════════════
// 外壳：图标栏、左栏、主区、右侧面板。地址决定手机上的层级；常驻宽度下收起状态存本浏览器，覆盖式宽度下是抽屉；
// 快捷键按平台取键；连接断开、重连中、刚恢复时主区顶部有横条；Cmd/Ctrl+K 搜索会话
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
});

afterEach(() => {
  app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const mine = [summary('a', { title: '整理周报' }), summary('b', { title: '读书笔记' })];
const handlers = {
  'sessions/list': lists(params => (params.section === 'owner' || params.query !== undefined ? mine : [])),
};

const shell = () => document.querySelector('[data-level]') as HTMLElement;
const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event;
};

describe('布局与层级', () => {
  it.each([
    ['/', '1'],
    ['/new', '2'],
    ['/s/a', '2'],
    ['/rooms?instance=im-a', '2'],
    ['/s/a/settings', '3'],
    ['/s/a/usage', '2'],
    ['/p/zz-jobs/jobs', '2'],
    ['/s/a/p/zz-notes/notes', '3'],
  ])('手机上 %s 是第 %s 层', async (url, level) => {
    stubViewport(390);
    app = await renderApp(url, handlers);
    expect(shell().dataset.level).toBe(level);
    expect(app.where()).toBe(url);
  });

  it('桌面上 /new 重定向到首页；认不出的地址回首页', async () => {
    stubViewport(1440);
    app = await renderApp('/new', handlers);
    expect(app.where()).toBe('/');
    app.close();
    app = await renderApp('/no/such/page', handlers);
    expect(app.where()).toBe('/');
  });

  it('图标栏只有「会话」一项，是当前项；常驻宽度下点它收起或展开左栏，收起状态存本浏览器', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    const rail = screen.getByRole('navigation', { name: '图标栏' });
    const sessions = within(rail).getByRole('link', { name: '会话' });
    expect(within(rail).getAllByRole('link')).toHaveLength(1);
    expect(sessions.getAttribute('aria-current')).toBe('page');
    fireEvent.click(sessions);
    expect(shell().dataset.left).toBe('collapsed');
    expect(app.where()).toBe('/');
    expect(JSON.parse(localStorage.getItem('aalis.panels') ?? '')).toEqual({ left: false, right: true });
    app.close();

    app = await renderApp('/', handlers);
    expect(shell().dataset.left).toBe('collapsed');
    fireEvent.click(within(screen.getByRole('navigation', { name: '图标栏' })).getByRole('link', { name: '会话' }));
    expect(shell().dataset.left).toBeUndefined();
  });

  it('存坏了的收起状态按默认（两侧都展开）', async () => {
    stubViewport(1440);
    localStorage.setItem('aalis.panels', JSON.stringify({ left: 'no' }));
    app = await renderApp('/', handlers);
    expect(shell().dataset.left).toBeUndefined();
    expect(shell().dataset.right).toBeUndefined();
  });

  it('平板宽度下左栏是覆盖式抽屉：打开时焦点进抽屉；Esc、点遮罩、点了里面的链接都会关上，收起状态不变', async () => {
    stubViewport(900);
    app = await renderApp('/', handlers);
    const toggle = () =>
      fireEvent.click(within(screen.getByRole('navigation', { name: '图标栏' })).getByRole('link', { name: '会话' }));
    const left = screen.getByRole('navigation', { name: '会话' });

    toggle();
    expect(shell().dataset.drawer).toBe('left');
    expect(document.activeElement).toBe(left);
    fireEvent.keyDown(left, { key: 'Escape' });
    expect(shell().dataset.drawer).toBeUndefined();

    toggle();
    fireEvent.click(document.querySelector('.shell-scrim') as Element);
    expect(shell().dataset.drawer).toBeUndefined();

    toggle();
    fireEvent.click(await within(left).findByRole('link', { name: /读书笔记/ }));
    expect(app.where()).toBe('/s/b');
    expect(shell().dataset.drawer).toBeUndefined();
    expect(shell().dataset.left).toBeUndefined();
    expect(localStorage.getItem('aalis.panels')).toBeNull();
  });

  it('⌘B 收起左栏、⌥⌘B 在 64em 到 80em 之间开关右侧面板的抽屉；Windows 上是 Ctrl', async () => {
    stubViewport(1100);
    app = await renderApp('/s/a', handlers);
    expect(press({ key: 'b', code: 'KeyB', metaKey: true }).defaultPrevented).toBe(true);
    expect(shell().dataset.left).toBe('collapsed');
    press({ key: '∫', code: 'KeyB', metaKey: true, altKey: true });
    expect(shell().dataset.drawer).toBe('right');
    press({ key: '∫', code: 'KeyB', metaKey: true, altKey: true });
    expect(shell().dataset.drawer).toBeUndefined();

    stubPlatform('Win32');
    expect(press({ key: 'b', code: 'KeyB', metaKey: true }).defaultPrevented).toBe(false);
    press({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(shell().dataset.left).toBeUndefined();
  });

  it('手机上界面里的「返回」回上一层：上一条历史就是上一层时退回去（与系统返回一样，之后能再前进），不多留历史', async () => {
    stubViewport(390);
    app = await renderApp('/', handlers);
    fireEvent.click(await screen.findByRole('link', { name: /整理周报/ }));
    expect(app.where()).toBe('/s/a');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/');
    app.forward();
    expect(app.where()).toBe('/s/a');
    app.back();
    expect(app.where()).toBe('/');

    // 系统返回之后另进一个会话：上一层仍认得
    fireEvent.click(screen.getByRole('link', { name: /读书笔记/ }));
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/');
    app.forward();
    expect(app.where()).toBe('/s/b');
  });

  it('手机上退到打开页面之前的历史：分不清前后，「返回」换掉这一条去上一层，不会退出页面', async () => {
    stubViewport(390);
    app = await renderApp(['/s/a', '/'], handlers);
    app.back();
    expect(app.where()).toBe('/s/a');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/');
  });

  it('手机上直接打开的第二层：「返回」换掉这一条去上一层，系统返回不会再回来', async () => {
    stubViewport(390);
    app = await renderApp('/s/a', handlers);
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/');
    app.back();
    expect(app.where()).toBe('/');
  });

  it('宽屏上 ⌥⌘B 收起右侧面板并记住', async () => {
    stubViewport(1440);
    app = await renderApp('/s/a', handlers);
    press({ key: '∫', code: 'KeyB', metaKey: true, altKey: true });
    expect(shell().dataset.right).toBe('collapsed');
    expect(JSON.parse(localStorage.getItem('aalis.panels') ?? '')).toEqual({ left: true, right: false });
  });

  it('⇧⌘O 去新会话；浏览器保留的键不拦', async () => {
    stubViewport(390);
    app = await renderApp('/s/a', handlers);
    press({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true });
    expect(app.where()).toBe('/new');
    for (const letter of ['n', 't', 'w']) {
      expect(press({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true }).defaultPrevented).toBe(false);
    }
  });
});

describe('搜索会话', () => {
  it('⌘K 打开；按输入搜索，方向键选、回车打开，输入法组字的回车不算', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    press({ key: 'k', code: 'KeyK', metaKey: true });
    const dialog = screen.getByRole('dialog', { name: '搜索会话' });
    const input = within(dialog).getByRole('combobox');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '周报' } });
    await vi.waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    const server = FakeWebSocket.at('/session');
    expect(server.request('sessions/list').params).toMatchObject({ query: '周报' });
    const options = within(dialog).getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(app.where()).toBe('/');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(app.where()).toBe('/s/b');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('左栏顶部的搜索按钮打开同一个框；没有结果时写明', async () => {
    stubViewport(1440);
    app = await renderApp('/', { 'sessions/list': lists(params => (params.query ? [] : mine)) });
    fireEvent.click(screen.getByRole('button', { name: '搜索会话' }));
    const dialog = screen.getByRole('dialog', { name: '搜索会话' });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: '没有' } });
    expect(await within(dialog).findByText('没有找到会话')).toBeTruthy();
  });
});

describe('连接状态', () => {
  const bar = () => screen.getByRole('status', { name: '连接状态' });

  it('断线时出现横条，重连上写「已恢复」，两秒后收起', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubViewport(1440);
    app = await renderApp('/', handlers);
    expect(bar().textContent).toBe('');
    act(() => FakeWebSocket.at('/session').drop());
    expect(bar().textContent).toBe('连接断开，正在重连…');
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await app.reconnect();
    expect(bar().textContent).toBe('已恢复');
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(bar().textContent).toBe('');
  });

  it('在场上报跟着会话连接：页面上有键盘或指针活动时报在场', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    fireEvent.pointerDown(document.body);
    expect(
      FakeWebSocket.at('/session')
        .frames.filter(f => f.method === 'presence/update')
        .map(f => f.params),
    ).toEqual([{ active: true }]);
  });

  it('管理连接断开同样报断线', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    act(() => FakeWebSocket.at('/admin').drop());
    expect(bar().textContent).toBe('连接断开，正在重连…');
  });

  it('会话服务不在（关闭码 1013）不算断线，会话列表与主区都写「会话服务未启用」', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    expect(bar().textContent).toBe('');
    expect(within(screen.getByRole('navigation', { name: '会话' })).getByText('会话服务未启用')).toBeTruthy();
    expect(within(screen.getByRole('main')).getByText('会话服务未启用')).toBeTruthy();
  });

  it('应用重启：横条写明，管理连接重连上以后整页重新加载；client.reload 立即重新加载', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubViewport(1440);
    // jsdom 不支持整页加载，调用 location.reload() 时报「Not implemented: navigation」
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloads = () => errors.mock.calls.filter(call => String(call[0]).includes('navigation')).length;
    app = await renderApp('/', handlers);
    const admin = FakeWebSocket.at('/admin');
    act(() => admin.push({ type: 'app.restarting' }));
    expect(bar().textContent).toBe('正在重启，连上后自动刷新页面');
    act(() => admin.drop());
    expect(bar().textContent).toBe('正在重启，连上后自动刷新页面');
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(reloads()).toBe(0);
    act(() => FakeWebSocket.at('/admin').open());
    await vi.waitFor(() => expect(reloads()).toBe(1));
    act(() => FakeWebSocket.at('/admin').push({ type: 'client.reload' }));
    expect(reloads()).toBe(2);
  });
});
