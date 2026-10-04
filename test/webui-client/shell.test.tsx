// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { type Harness, installDialog, lists, pluginRow as plugin, renderApp, summary } from './harness.js';
import { snapshot } from './items.js';
import { JOBS, NOTES, SETTINGS_PAGE } from './pages.js';

// ════════════════════════════════════════════════════════════
// 外壳：图标栏、左栏、主区、右侧面板。地址决定手机上的层级；常驻宽度下收起状态与栏宽存本浏览器，覆盖式宽度下是抽屉；
// 两侧的分隔条可以拖动、按方向键调宽，双击恢复默认，拖到下限以下松手即收起；快捷键按平台取键；
// 连接断开、重连中、刚恢复时顶部有横条；Cmd/Ctrl+K 搜索会话、页面与插件
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

const shell = () => document.querySelector('[data-phone]') as HTMLElement;
/** 存在本浏览器的两侧状态 */
const stored = () => JSON.parse(localStorage.getItem('aalis.panels') ?? 'null');
/** 一侧此刻的栏宽变量：拖动中写在那一栏上，平时写在外壳上（jsdom 不排版，栏宽只看它） */
const width = (side: 'left' | 'right') =>
  document.querySelector<HTMLElement>(`.shell-${side}`)?.style.getPropertyValue(`--${side}-w`) ||
  shell().style.getPropertyValue(`--${side}-w`);
const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event;
};

describe('布局与层级', () => {
  it.each([
    ['/', 'left'],
    ['/new', 'main'],
    ['/s/a', 'main'],
    ['/rooms?instance=im-a', 'main'],
    ['/s/a/settings', 'right'],
    ['/s/a/usage', 'main'],
    ['/p/zz-jobs/jobs', 'main'],
    ['/s/a/p/zz-notes/notes', 'right'],
    ['/plugins', 'left'],
    ['/market', 'main'],
    ['/plugins/zz-jobs', 'main'],
    ['/health', 'main'],
    ['/health/logs?level=error', 'main'],
  ])('手机上 %s 占满一屏的是 %s 那一栏', async (url, column) => {
    stubViewport(390);
    app = await renderApp(url, handlers);
    expect(shell().dataset.phone).toBe(column);
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

  it('图标栏上方是「会话」、底部是「运行状况」「插件」「设置」；所在的一区是当前项，从别处点回来回到这一区刚才的地址', async () => {
    stubViewport(1440);
    app = await renderApp('/s/a', handlers);
    const rail = within(screen.getByRole('navigation', { name: '图标栏' }));
    expect(rail.getAllByRole('link').map(link => link.getAttribute('aria-label'))).toEqual([
      '会话',
      '运行状况',
      '插件',
      '设置',
    ]);
    const current = () => rail.getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page');
    expect(current().map(link => link.getAttribute('aria-label'))).toEqual(['会话']);

    fireEvent.click(rail.getByRole('link', { name: '插件' }));
    expect(app.where()).toBe('/plugins');
    expect(current().map(link => link.getAttribute('aria-label'))).toEqual(['插件']);
    fireEvent.click(rail.getByRole('link', { name: '会话' }));
    expect(app.where()).toBe('/s/a');
    expect(rail.getByRole('link', { name: '设置' }).getAttribute('href')).toBe('/settings');
  });

  it('已在会话区时点「会话」收起或展开左栏，收起状态存本浏览器；插件区里点「插件」同样', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    const rail = screen.getByRole('navigation', { name: '图标栏' });
    const sessions = within(rail).getByRole('link', { name: '会话' });
    expect(sessions.getAttribute('aria-current')).toBe('page');
    fireEvent.click(sessions);
    expect(shell().dataset.left).toBe('collapsed');
    expect(app.where()).toBe('/');
    expect(stored()).toEqual({ left: { open: false }, right: { open: true } });
    app.close();

    app = await renderApp('/', handlers);
    expect(shell().dataset.left).toBe('collapsed');
    fireEvent.click(within(screen.getByRole('navigation', { name: '图标栏' })).getByRole('link', { name: '会话' }));
    expect(shell().dataset.left).toBeUndefined();
    app.close();

    app = await renderApp('/plugins', handlers);
    fireEvent.click(within(screen.getByRole('navigation', { name: '图标栏' })).getByRole('link', { name: '插件' }));
    expect(shell().dataset.left).toBe('collapsed');
    expect(app.where()).toBe('/plugins');
  });

  it('手机第一层在会话列表上面列出「运行状况」「插件」「设置」三个入口，点「插件」进插件树', async () => {
    stubViewport(390);
    app = await renderApp('/', handlers);
    const entries = within(await screen.findByRole('list', { name: '入口' }));
    expect(entries.getAllByRole('link').map(link => link.textContent)).toEqual(['运行状况', '插件', '设置']);
    fireEvent.click(entries.getByRole('link', { name: '插件' }));
    expect(app.where()).toBe('/plugins');
    expect(shell().dataset.phone).toBe('left');
    expect(screen.getByRole('navigation', { name: '插件' })).toBeTruthy();
  });

  it('存坏了的记录按默认：两侧都展开、默认宽度；超出上下限的宽度按上下限', async () => {
    stubViewport(1440);
    localStorage.setItem('aalis.panels', JSON.stringify({ left: 'no' }));
    app = await renderApp('/', handlers);
    expect(shell().dataset.left).toBeUndefined();
    expect(shell().dataset.right).toBeUndefined();
    expect(width('left')).toBe('16.5rem');
    expect(width('right')).toBe('22.5rem');
    app.close();

    localStorage.setItem(
      'aalis.panels',
      JSON.stringify({ left: { open: false, width: 99 }, right: { open: 'no', width: 'wide' } }),
    );
    app = await renderApp('/', handlers);
    expect(shell().dataset.left).toBe('collapsed');
    expect(width('left')).toBe('25rem');
    expect(shell().dataset.right).toBeUndefined();
    expect(width('right')).toBe('22.5rem');
    app.close();

    localStorage.setItem('aalis.panels', JSON.stringify({ left: { open: true, width: 1 }, right: { width: null } }));
    app = await renderApp('/', handlers);
    expect(width('left')).toBe('13.75rem');
    expect(width('right')).toBe('22.5rem');
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
    expect(stored()).toEqual({ left: { open: true }, right: { open: false } });
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

describe('两侧栏宽', () => {
  // 根字号 16px；jsdom 没有 PointerEvent，指针事件用 MouseEvent 发
  const LEFT = '调整左栏宽度';
  const RIGHT = '调整右侧面板宽度';
  const sessionHandlers = {
    ...handlers,
    'session/subscribe': () => snapshot([]),
    'session/config/get': () => ({ items: [] }),
  };
  const separator = (name: string) => screen.getByRole('separator', { name });
  const values = (target: HTMLElement) =>
    ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(name => Number(target.getAttribute(name)));
  const pointer = (target: Element, type: string, clientX: number) =>
    fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }));
  /** 在 from 处按住分隔条，依次移到 moves 的各处，在最后一处松手 */
  const drag = (target: Element, from: number, ...moves: number[]) => {
    pointer(target, 'pointerdown', from);
    for (const x of moves) pointer(target, 'pointermove', x);
    pointer(target, 'pointerup', moves.at(-1) ?? from);
  };

  beforeEach(() => {
    stubViewport(1440);
    document.documentElement.style.fontSize = '16px';
    Element.prototype.setPointerCapture = () => {};
  });

  afterEach(() => {
    document.documentElement.style.fontSize = '';
    delete (Element.prototype as Partial<Element>).setPointerCapture;
  });

  it('方向键按步长调宽、到上下限为止，Home、End 到上下限；调过的宽度与收起状态存在同一条记录里', async () => {
    app = await renderApp('/', handlers);
    const left = separator(LEFT);
    expect(left.getAttribute('aria-orientation')).toBe('vertical');
    expect(left.tabIndex).toBe(0);
    expect(values(left)).toEqual([16.5, 13.75, 25]);
    expect(width('left')).toBe('16.5rem');

    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(values(left)[0]).toBe(17.5);
    expect(width('left')).toBe('17.5rem');
    expect(stored()).toEqual({ left: { open: true, width: 17.5 }, right: { open: true } });

    fireEvent.keyDown(left, { key: 'ArrowLeft' });
    fireEvent.keyDown(left, { key: 'ArrowLeft' });
    expect(width('left')).toBe('15.5rem');
    fireEvent.keyDown(left, { key: 'ArrowLeft' });
    fireEvent.keyDown(left, { key: 'ArrowLeft' });
    expect(width('left')).toBe('13.75rem');
    expect(shell().dataset.left).toBeUndefined();
    fireEvent.keyDown(left, { key: 'End' });
    expect(width('left')).toBe('25rem');
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(width('left')).toBe('25rem');
    fireEvent.keyDown(left, { key: 'Home' });
    expect(values(left)[0]).toBe(13.75);
    expect(stored()).toEqual({ left: { open: true, width: 13.75 }, right: { open: true } });
  });

  it('右侧面板的分隔条往左是加宽：方向键与拖动都一样', async () => {
    app = await renderApp('/s/s1', sessionHandlers);
    const right = separator(RIGHT);
    expect(values(right)).toEqual([22.5, 18.75, 37.5]);
    fireEvent.keyDown(right, { key: 'ArrowLeft' });
    expect(width('right')).toBe('23.5rem');
    drag(right, 1000, 960, 920);
    expect(width('right')).toBe('28.5rem');
    expect(stored()).toEqual({ left: { open: true }, right: { open: true, width: 28.5 } });
  });

  it('双击分隔条恢复默认宽度，记录里不再带宽度', async () => {
    localStorage.setItem('aalis.panels', JSON.stringify({ left: { open: true, width: 20 }, right: { open: true } }));
    app = await renderApp('/', handlers);
    expect(width('left')).toBe('20rem');
    fireEvent.doubleClick(separator(LEFT));
    expect(width('left')).toBe('16.5rem');
    expect(values(separator(LEFT))[0]).toBe(16.5);
    expect(stored()).toEqual({ left: { open: true }, right: { open: true } });
  });

  it('拖动：栏宽跟着指针变、到上限为止，松手才记下；没有移动的点按与被打断的拖动都不改', async () => {
    app = await renderApp('/', handlers);
    const left = separator(LEFT);
    pointer(left, 'pointerdown', 300);
    pointer(left, 'pointermove', 340);
    expect(width('left')).toBe('19rem');
    expect(stored()).toBeNull();
    pointer(left, 'pointerup', 340);
    expect(values(left)[0]).toBe(19);
    expect(stored()).toEqual({ left: { open: true, width: 19 }, right: { open: true } });

    drag(left, 300, 900);
    expect(width('left')).toBe('25rem');
    expect(stored().left).toEqual({ open: true, width: 25 });

    fireEvent.doubleClick(left);
    drag(left, 300);
    expect(stored().left).toEqual({ open: true });

    pointer(left, 'pointerdown', 300);
    pointer(left, 'pointermove', 360);
    expect(width('left')).toBe('20.25rem');
    pointer(left, 'pointercancel', 360);
    expect(width('left')).toBe('16.5rem');
    pointer(left, 'pointermove', 400);
    expect(width('left')).toBe('16.5rem');
    expect(stored().left).toEqual({ open: true });
  });

  it('拖到下限以下松手即收起，与快捷键收起是同一个状态；再展开回到拖动前的宽度；恰好拖到下限不收起', async () => {
    localStorage.setItem('aalis.panels', JSON.stringify({ left: { open: true, width: 20 }, right: { open: true } }));
    app = await renderApp('/s/s1', sessionHandlers);
    const left = separator(LEFT);
    pointer(left, 'pointerdown', 300);
    pointer(left, 'pointermove', 100);
    expect(width('left')).toBe('13.75rem');
    expect(shell().dataset.left).toBeUndefined();
    pointer(left, 'pointerup', 100);
    expect(shell().dataset.left).toBe('collapsed');
    expect(stored()).toEqual({ left: { open: false, width: 20 }, right: { open: true } });

    press({ key: 'b', code: 'KeyB', metaKey: true });
    expect(shell().dataset.left).toBeUndefined();
    expect(width('left')).toBe('20rem');

    drag(left, 300, 200);
    expect(shell().dataset.left).toBeUndefined();
    expect(width('left')).toBe('13.75rem');

    drag(separator(RIGHT), 1000, 1400);
    expect(shell().dataset.right).toBe('collapsed');
    expect(stored().right).toEqual({ open: false });
  });
});

describe('搜索', () => {
  const REST = {
    '/api/plugins': {
      plugins: [
        plugin('zz-jobs:night', { displayName: '计划任务' }),
        plugin('zz-auth', { displayName: '权限' }),
        plugin('zz-notes', { displayName: '笔记本', state: 'error', error: '坏了' }),
      ],
    },
    '/api/pages': { pages: [JOBS, SETTINGS_PAGE, NOTES] },
  };
  const found = {
    'sessions/list': lists(params => mine.filter(session => !params.query || session.title.includes(params.query))),
  };
  const dialog = () => screen.getByRole('dialog', { name: '搜索' });
  const input = () => within(dialog()).getByRole('combobox', { name: '搜索会话、页面与插件' });
  /** 结果按组：组名与各项的名字（不含后面那句出处） */
  const groups = () =>
    within(dialog())
      .queryAllByRole('group')
      .map(group => [
        group.getAttribute('aria-label'),
        within(group)
          .getAllByRole('option')
          .map(option => option.firstElementChild?.textContent),
      ]);
  const type = (value: string) => fireEvent.change(input(), { target: { value } });

  it('⌘K 打开；按输入搜索，方向键选、回车打开，输入法组字的回车不算', async () => {
    stubViewport(1440);
    app = await renderApp('/', handlers);
    press({ key: 'k', code: 'KeyK', metaKey: true });
    const input = within(dialog()).getByRole('combobox');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '周报' } });
    await vi.waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(2));
    const server = FakeWebSocket.at('/session');
    expect(server.request('sessions/list').params).toMatchObject({ query: '周报' });
    const options = within(dialog()).getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(app.where()).toBe('/');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(app.where()).toBe('/s/b');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('会话、页面与插件分组列出：页面按名字找、插件按显示名与 id 找，不分大小写，会话面板的页面不列；方向键跨组选，回车打开', async () => {
    stubViewport(1440);
    app = await renderApp('/', found, REST);
    press({ key: 'k', code: 'KeyK', metaKey: true });
    type('笔记');
    await vi.waitFor(() =>
      expect(groups()).toEqual([
        ['会话', ['读书笔记']],
        ['插件', ['笔记本']],
      ]),
    );
    expect(within(dialog()).getByRole('option', { name: /笔记本/ }).textContent).toBe('笔记本失败');
    type('ZZ-AUTH');
    await vi.waitFor(() => expect(groups()).toEqual([['插件', ['权限']]]));
    type('计划');
    await vi.waitFor(() =>
      expect(groups()).toEqual([
        ['页面', ['计划 · night']],
        ['插件', ['计划任务 · night']],
      ]),
    );
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    expect(app.where()).toBe('/plugins/zz-jobs%3Anight');
    expect(screen.queryByRole('dialog')).toBeNull();

    press({ key: 'k', code: 'KeyK', metaKey: true });
    type('权限');
    await vi.waitFor(() =>
      expect(groups()).toEqual([
        ['页面', ['权限']],
        ['插件', ['权限']],
      ]),
    );
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    expect(app.where()).toBe('/settings/p/zz-auth/auth');
  });

  it('空的输入只列会话；会话服务不在时照样找页面与插件，什么都没找到时写明', async () => {
    stubViewport(1440);
    app = await renderApp('/', found, REST);
    press({ key: 'k', code: 'KeyK', metaKey: true });
    await vi.waitFor(() => expect(groups()).toEqual([['会话', ['整理周报', '读书笔记']]]));
    act(() => {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => FakeWebSocket.at('/session').drop(1013, '会话服务不在'));
    press({ key: 'k', code: 'KeyK', metaKey: true });
    type('计划');
    expect(groups()).toEqual([
      ['页面', ['计划 · night']],
      ['插件', ['计划任务 · night']],
    ]);
    type('没有这个');
    expect(within(dialog()).getByText('没有找到')).toBeTruthy();
  });

  it('页面表与插件列表没取到时写明原因', async () => {
    stubViewport(1440);
    const broken = (error: string) => () => Response.json({ error }, { status: 500 });
    app = await renderApp('/', found, { '/api/pages': broken('页面表坏了'), '/api/plugins': broken('插件列表坏了') });
    press({ key: 'k', code: 'KeyK', metaKey: true });
    type('计划');
    expect(await within(dialog()).findByText('页面表没取到：页面表坏了')).toBeTruthy();
    expect(within(dialog()).getByText('插件列表没取到：插件列表坏了')).toBeTruthy();
  });

  it('左栏顶部的搜索按钮打开同一个框；没有结果时写明', async () => {
    stubViewport(1440);
    app = await renderApp('/', { 'sessions/list': lists(params => (params.query ? [] : mine)) });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    type('没有');
    expect(await within(dialog()).findByText('没有找到')).toBeTruthy();
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

  it('一次也没连上就断开、页面的请求却正常（升级被来源校验拒绝）连着两回：横条提示检查反向代理是否转发了原始的 Host；请求也不通时照旧写断线', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubViewport(1440);
    let restUp = true;
    app = await renderApp('/', handlers, {
      '/api/auth/status': () => (restUp ? { authed: true } : Response.error()),
    });
    const refuse = async (delay: number) => {
      await act(() => vi.advanceTimersByTimeAsync(delay));
      act(() => FakeWebSocket.at('/session').drop());
      await act(() => vi.advanceTimersByTimeAsync(0));
    };
    act(() => FakeWebSocket.at('/session').drop());
    expect(bar().textContent).toBe('连接断开，正在重连…');
    await refuse(1_000);
    expect(bar().textContent, '只被拒了一回').toBe('连接断开，正在重连…');
    await refuse(2_000);
    await vi.waitFor(() =>
      expect(bar().textContent).toBe(
        '连接一直被服务端拒绝，页面的其他请求却正常：经反向代理访问时，检查代理是否转发了原始的 Host 请求头',
      ),
    );
    restUp = false;
    await refuse(5_000);
    await vi.waitFor(() => expect(bar().textContent).toBe('连接断开，正在重连…'));
    restUp = true;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await app.reconnect();
    expect(bar().textContent).toBe('已恢复');
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
