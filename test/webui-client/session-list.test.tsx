// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL } from '../../packages/plugin-webui-client/src/plugins/list.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  group,
  type Harness,
  installDialog,
  listRequests,
  lists,
  pluginRow,
  renderApp,
  room,
  summary,
} from './harness.js';

// ════════════════════════════════════════════════════════════
// 会话列表：「我的」在上，房间按适配器实例分组；状态与排序、行首标记；组默认折叠、有需要处理的自动展开，
// 组内只露出需要处理、出错、运行中、有后台工作与近 7 天她开过口的房间；归档区；只列根会话，行上写「后台 N」与出错原因；
// 行的「更多」；推送即时更新；断线重连后重取；翻页取全
// ════════════════════════════════════════════════════════════

const DAY = 24 * 60 * 60_000;
const NOW = new Date(2026, 9, 3, 15, 0).getTime();

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
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

const left = () => screen.getByRole('navigation', { name: '会话' });
const section = (name: string) => within(left()).getByRole('region', { name });
const titles = (list: HTMLElement) =>
  within(list)
    .queryAllByRole('link')
    .map(link => link.querySelector('.list-item-title')?.firstChild?.textContent);

describe('会话列表', () => {
  it('「我的」按需要处理、出错、完成未读、运行中排前，其余按最后活动；行首标记与状态句', async () => {
    const mine = [
      summary('idle-old', { title: '旧会话', updatedAt: NOW - 3 * DAY }),
      summary('running', { title: '在跑', running: true, updatedAt: NOW - DAY }),
      summary('idle-new', { title: '新会话一', updatedAt: NOW - 60_000 }),
      summary('unread', { title: '有回复', unread: true, updatedAt: NOW - 2 * DAY }),
      summary('error', { title: '出了错', error: true, updatedAt: NOW - 5 * DAY }),
      summary('attention', { title: '要批准', attention: true, updatedAt: NOW - 6 * DAY }),
    ];
    app = await renderApp('/s/idle-new', { 'sessions/list': lists(p => (p.section === 'owner' ? mine : [])) });
    const list = await within(section('我的')).findByRole('list');
    expect(titles(list)).toEqual(['要批准', '出了错', '有回复', '在跑', '新会话一', '旧会话']);
    const row = (title: string) => within(list).getByRole('link', { name: new RegExp(title) });
    expect(row('要批准').textContent).toContain('需要处理');
    expect(row('要批准').textContent).toContain('等你批准');
    expect(row('出了错').textContent).toContain('出错');
    expect(row('有回复').textContent).toContain('未读');
    expect(row('在跑').textContent).toContain('运行中');
    expect(row('新会话一').getAttribute('aria-current')).toBe('page');
    expect(row('新会话一').textContent).toContain('14:59');
    expect(row('旧会话').textContent).toContain('9/30');
    expect(listRequests()[0]).toEqual({ section: 'owner', limit: 200 });
  });

  it('房间按适配器实例分组：组头写通用图标、组名、房间数与需要处理的数；组默认折叠，有需要处理的组自动展开', async () => {
    const groups = [
      group('im-a', { label: 'QQ 主号', rooms: 3, attention: 1 }),
      group('im-b', { label: 'QQ 小号', rooms: 4 }),
    ];
    const rooms = [room('r1', 'im-a', { title: '示例群 A', attention: true, updatedAt: NOW - DAY })];
    app = await renderApp('/', {
      'sessions/list': lists(p => (p.instance === 'im-a' ? rooms : []), groups),
    });
    const rooms_ = await within(left()).findByRole('region', { name: '房间' });
    const main = within(rooms_).getByRole('button', { name: /^QQ 主号/ });
    const alt = within(rooms_).getByRole('button', { name: /^QQ 小号/ });
    expect(main.getAttribute('aria-expanded')).toBe('true');
    expect(main.textContent).toContain('3 个房间');
    expect(alt.getAttribute('aria-expanded')).toBe('false');
    // 不按平台分图标：每组同一个，读屏不念
    const icons = [main, alt].map(button => button.querySelector('svg:not(:first-child)'));
    expect(icons.map(icon => icon?.getAttribute('class'))).toEqual([
      expect.stringContaining('lucide-messages-square'),
      expect.stringContaining('lucide-messages-square'),
    ]);
    expect(icons.every(icon => icon?.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(within(rooms_).getByText('1').getAttribute('data-tone')).toBe('attention');
    await within(rooms_).findByRole('link', { name: /示例群 A/ });
    expect(listRequests().filter(p => p.instance !== undefined)).toEqual([{ instance: 'im-a', limit: 200 }]);

    fireEvent.click(main);
    expect(within(rooms_).queryByRole('link', { name: /示例群 A/ })).toBeNull();
    fireEvent.click(alt);
    await vi.waitFor(() => expect(listRequests().some(p => p.instance === 'im-b')).toBe(true));
  });

  it('组内只露出需要处理、出错、运行中与近 7 天她开过口的房间，其余收在「其余 N 个」里；多账号时标出账号', async () => {
    const groups = [group('im-a', { label: 'QQ 主号', rooms: 6, attention: 1, accounts: 2 })];
    const rooms = [
      room('r-attention', 'im-a', { title: '要批准的群', attention: true, updatedAt: NOW - 1000 }),
      room('r-recent', 'im-a', { title: '昨天说过话', lastReplyAt: NOW - DAY, updatedAt: NOW - 2000 }),
      room('r-error', 'im-a', { title: '出错的群', error: true, updatedAt: NOW - 3000 }),
      room('r-running', 'im-a', { title: '正在回复', running: true, updatedAt: NOW - 4000 }),
      room('r-stale', 'im-a', { title: '八天前', lastReplyAt: NOW - 8 * DAY, updatedAt: NOW - 5000, account: '10002' }),
      room('r-never', 'im-a', { title: '没开过口', updatedAt: NOW - 6000 }),
    ];
    app = await renderApp('/', { 'sessions/list': lists(p => (p.instance === 'im-a' ? rooms : []), groups) });
    const list = await within(left()).findByRole('list', { name: 'QQ 主号' });
    expect(titles(list)).toEqual(['要批准的群', '昨天说过话', '出错的群', '正在回复']);
    expect(within(list).getByRole('link', { name: /正在回复/ }).textContent).toContain('运行中');
    expect(within(list).getByRole('link', { name: /要批准的群/ }).textContent).toContain('10001');
    fireEvent.click(within(list).getByRole('button', { name: '其余 2 个' }));
    expect(titles(list)).toEqual(['要批准的群', '昨天说过话', '出错的群', '正在回复', '八天前', '没开过口']);
    expect(within(list).getByRole('link', { name: /八天前/ }).textContent).toContain('10002');
    fireEvent.click(within(list).getByRole('button', { name: '收起' }));
    expect(titles(list)).toHaveLength(4);
  });

  it('正在看的房间即使不在露出之列也在组里', async () => {
    const groups = [group('im-a', { label: 'QQ 主号', rooms: 1, attention: 0 })];
    const rooms = [room('r-quiet', 'im-a', { title: '安静的群' })];
    app = await renderApp('/s/r-quiet', { 'sessions/list': lists(p => (p.instance === 'im-a' ? rooms : []), groups) });
    fireEvent.click(await within(left()).findByRole('button', { name: /^QQ 主号/ }));
    const list = await within(left()).findByRole('list', { name: 'QQ 主号' });
    expect(titles(list)).toEqual(['安静的群']);
  });

  it('组头的「表格」打开这一组的房间表，房间表打开时它是当前项；还没记下实例的组按平台', async () => {
    const groups = [group('im-a', { label: 'QQ 主号', rooms: 2 }), group(undefined, { label: 'onebot', rooms: 1 })];
    app = await renderApp('/', { 'sessions/list': lists(() => [], groups) });
    fireEvent.click(await within(left()).findByRole('button', { name: '用表格查看「QQ 主号」的全部房间' }));
    expect(app.where()).toBe('/rooms?instance=im-a');
    expect(
      within(left()).getByRole('button', { name: '用表格查看「QQ 主号」的全部房间' }).getAttribute('aria-current'),
    ).toBe('page');
    fireEvent.click(within(left()).getByRole('button', { name: '用表格查看「onebot」的全部房间' }));
    expect(app.where()).toBe('/rooms?platform=onebot');
  });

  it('推送即时更新：新会话、排序变化、归档后移出、删除；分组跟着推送换', async () => {
    const mine = [
      summary('a', { title: '甲', updatedAt: NOW - 2000 }),
      summary('b', { title: '乙', updatedAt: NOW - 1000 }),
    ];
    app = await renderApp('/', { 'sessions/list': lists(p => (p.section === 'owner' ? mine : [])) });
    const list = await within(section('我的')).findByRole('list');
    expect(titles(list)).toEqual(['乙', '甲']);
    const server = FakeWebSocket.at('/session');
    act(() =>
      server.notify('sessions/changed', {
        upserts: [summary('c', { title: '丙', updatedAt: NOW }), summary('a', { title: '甲', updatedAt: NOW - 500 })],
        removes: [],
        groups: [group('im-a', { label: 'QQ 主号', rooms: 1 })],
      }),
    );
    expect(titles(list)).toEqual(['丙', '甲', '乙']);
    expect(within(left()).getByRole('button', { name: /^QQ 主号/ })).toBeTruthy();
    act(() =>
      server.notify('sessions/changed', {
        upserts: [summary('c', { title: '丙', archived: true }), room('r', 'im-a')],
        removes: ['b'],
        groups: [],
      }),
    );
    expect(titles(list)).toEqual(['甲']);
    expect(within(left()).queryByRole('region', { name: '房间' })).toBeNull();
  });

  it('断线重连后重取', async () => {
    let mine = [summary('a', { title: '甲' })];
    app = await renderApp('/', { 'sessions/list': lists(p => (p.section === 'owner' ? mine : [])) });
    const list = await within(section('我的')).findByRole('list');
    act(() => FakeWebSocket.at('/session').drop());
    mine = [summary('a', { title: '甲' }), summary('b', { title: '乙', updatedAt: 1 })];
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await app.reconnect();
    await vi.waitFor(() => expect(titles(list)).toEqual(['乙', '甲']));
  });

  it('翻页取全；翻页途中来了推送就重取一遍', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => summary(`s${i}`, { title: `会话${i}` }));
    let pushDuringFirstPage = true;
    app = await renderApp('/', {
      'sessions/list': p => {
        if (p.section !== 'owner') return { sessions: [], groups: [] };
        if (p.cursor === undefined) {
          if (pushDuringFirstPage) {
            pushDuringFirstPage = false;
            FakeWebSocket.at('/session').notify('sessions/changed', { upserts: [], removes: ['s0'], groups: [] });
          }
          return { sessions: page(200), nextCursor: '200', groups: [] };
        }
        return { sessions: [summary('last', { title: '最后一个' })], groups: [] };
      },
    });
    const list = await within(section('我的')).findByRole('list');
    await vi.waitFor(() => expect(titles(list)).toHaveLength(201));
    const owner = listRequests().filter(p => p.section === 'owner');
    expect(owner).toEqual([
      { section: 'owner', limit: 200 },
      { section: 'owner', limit: 200, cursor: '200' },
      { section: 'owner', limit: 200 },
      { section: 'owner', limit: 200, cursor: '200' },
    ]);
  });

  it('翻页途中一直有推送时最多取三遍，最后一遍途中收到的推送补上', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => summary(`s${i}`, { title: `会话${i}` }));
    let round = 0;
    app = await renderApp('/', {
      'sessions/list': p => {
        if (p.section !== 'owner') return { sessions: [], groups: [] };
        if (p.cursor !== undefined) return { sessions: [summary('last', { title: '最后一个' })], groups: [] };
        round++;
        const pushed = summary(`pushed-${round}`, { title: `推送${round}`, updatedAt: NOW });
        FakeWebSocket.at('/session').notify('sessions/changed', { upserts: [pushed], removes: [], groups: [] });
        return { sessions: page(200), nextCursor: '200', groups: [] };
      },
    });
    const list = await within(section('我的')).findByRole('list');
    await vi.waitFor(() => expect(titles(list)).toHaveLength(202));
    expect(titles(list)[0]).toBe('推送3');
    expect(listRequests().filter(p => p.section === 'owner')).toHaveLength(6);
  });

  it('取不到时「查看日志」链到提供会话协议的实例的日志（按 provides 找）；插件列表里没有它时不出现，不改链到别的实例', async () => {
    let plugins = [pluginRow('zz-ui', { self: true }), pluginRow('zz-sessions', { provides: [SESSION_PROTOCOL] })];
    app = await renderApp(
      '/',
      {
        'sessions/list': () => {
          throw new Error('存储读取失败');
        },
      },
      { '/api/plugins': () => ({ plugins }) },
    );
    const alert = await within(left()).findByRole('alert');
    expect(alert.textContent).toContain('会话列表没取到');
    await vi.waitFor(() =>
      expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
        '/health/logs?plugin=zz-sessions',
      ),
    );
    plugins = [pluginRow('zz-ui', { self: true })];
    act(() => FakeWebSocket.at('/admin').push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(within(alert).queryByRole('link', { name: '查看日志' })).toBeNull());
  });

  it('取不到时就地写明原因，可以重试；之后来的推送不把错误冲掉', async () => {
    let fail = true;
    app = await renderApp('/', {
      'sessions/list': () => {
        if (fail) throw new Error('存储读取失败');
        return { sessions: [summary('a', { title: '甲' })], groups: [] };
      },
    });
    const alert = await within(left()).findByRole('alert');
    expect(alert.textContent).toContain('存储读取失败');
    act(() =>
      FakeWebSocket.at('/session').notify('sessions/changed', {
        upserts: [summary('b', { title: '乙' })],
        removes: [],
        groups: [],
      }),
    );
    expect(within(left()).getByRole('alert').textContent).toContain('存储读取失败');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    const mine = await within(left()).findByRole('region', { name: '我的' });
    expect(within(mine).getByRole('link', { name: /甲/ })).toBeTruthy();
  });

  it('还没有会话时只写一行', async () => {
    app = await renderApp('/', { 'sessions/list': lists(() => []) });
    expect(await within(section('我的')).findByText('还没有会话')).toBeTruthy();
  });

  it('左栏只列根会话、行上没有子会话的展开；有后台工作的行写「后台 N」，出错的行写一句原因', async () => {
    const mine = [
      summary('p', { title: '父会话', childCount: 2, background: 2, updatedAt: NOW - 1000 }),
      summary('busy', { title: '在跑又有后台', running: true, background: 1, updatedAt: NOW - 2000 }),
      summary('broken', { title: '出了错', error: true, reason: '模型服务返回 500', updatedAt: NOW - 3000 }),
      summary('quiet', { title: '出错没原因', error: true, updatedAt: NOW - 4000 }),
    ];
    app = await renderApp('/', { 'sessions/list': lists(p => (p.section === 'owner' ? mine : [])) });
    const list = await within(section('我的')).findByRole('list');
    const row = (title: string) => within(list).getByRole('link', { name: new RegExp(title) });
    expect(row('父会话').textContent).toContain('后台 2');
    expect(row('在跑又有后台').textContent).toContain('运行中');
    expect(row('在跑又有后台').textContent).not.toContain('后台 1');
    expect(row('出了错').textContent).toContain('模型服务返回 500');
    expect(row('出了错').querySelector('.status-text')?.getAttribute('data-state')).toBe('error');
    expect(row('出错没原因').textContent).toContain('出错');
    expect(within(left()).queryAllByRole('button', { name: /子任务|子会话/ })).toEqual([]);
    expect(listRequests().filter(p => p.parentId !== undefined)).toEqual([]);
  });

  it('房间组里有后台工作的房间露出来，单行的右侧写「后台 N」', async () => {
    const groups = [group('im-a', { label: 'QQ 主号', rooms: 2 })];
    const rooms = [
      room('r-busy', 'im-a', { title: '后台在跑的群', background: 1, updatedAt: NOW - 1000 }),
      room('r-never', 'im-a', { title: '没开过口', updatedAt: NOW - 2000 }),
    ];
    app = await renderApp('/', { 'sessions/list': lists(p => (p.instance === 'im-a' ? rooms : []), groups) });
    fireEvent.click(await within(left()).findByRole('button', { name: /^QQ 主号/ }));
    const list = await within(left()).findByRole('list', { name: 'QQ 主号' });
    expect(titles(list)).toEqual(['后台在跑的群']);
    expect(within(list).getByRole('link', { name: /后台在跑的群/ }).textContent).toContain('后台 1');
  });
});

describe('行的「更多」与归档区', () => {
  const mine = [summary('a', { title: '整理周报' })];

  async function menu(item: string) {
    const row = await within(screen.getByRole('region', { name: '我的' })).findByRole('listitem');
    fireEvent.click(within(row).getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
  }

  it('改名：表单对话框，保存后发 session/rename；名字空着不能保存', async () => {
    const renamed: unknown[] = [];
    app = await renderApp('/', {
      'sessions/list': lists(p => (p.section === 'owner' ? mine : [])),
      'session/rename': params => {
        renamed.push(params);
        return {};
      },
    });
    await menu('改名');
    const dialog = screen.getByRole('dialog', { name: '改名' });
    const input = within(dialog).getByRole('textbox', { name: '会话名' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  ' } });
    expect(within(dialog).getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: ' 周报模板 ' } });
    fireEvent.submit(input);
    await vi.waitFor(() => expect(renamed).toEqual([{ sessionId: 'a', title: '周报模板' }]));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('改名失败时对话框不关，写明原因', async () => {
    app = await renderApp('/', {
      'sessions/list': lists(p => (p.section === 'owner' ? mine : [])),
      'session/rename': () => {
        throw new Error('会话不存在：a');
      },
    });
    await menu('改名');
    const dialog = screen.getByRole('dialog', { name: '改名' });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('会话不存在：a');
  });

  it('归档直接做，Toast 带「撤销」，撤销即恢复', async () => {
    const calls: unknown[] = [];
    app = await renderApp('/', {
      'sessions/list': lists(p => (p.section === 'owner' ? mine : [])),
      'session/batch': params => {
        calls.push(['batch', params]);
        return { failed: [] };
      },
      'session/unarchive': params => {
        calls.push(['unarchive', params]);
        return {};
      },
    });
    await menu('归档');
    const toast = await screen.findByText('已归档「整理周报」');
    fireEvent.click(within(toast.closest('.toast') as HTMLElement).getByRole('button', { name: '撤销' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ['batch', { op: 'archive', ids: ['a'] }],
        ['unarchive', { sessionId: 'a' }],
      ]),
    );
  });

  it('删除先确认：点名对象、写明会清空长期记忆，焦点在「取消」上；确认后删除，失败的出错 Toast', async () => {
    const deleted: unknown[] = [];
    app = await renderApp('/', {
      'sessions/list': lists(p => (p.section === 'owner' ? mine : [])),
      'session/batch': params => {
        deleted.push(params);
        return { failed: [{ sessionId: 'a', message: '存储写入失败' }] };
      },
    });
    await menu('删除');
    const dialog = screen.getByRole('dialog', { name: '删除会话「整理周报」？' });
    expect(dialog.textContent).toContain('长期记忆');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await vi.waitFor(() => expect(deleted).toEqual([{ op: 'delete', ids: ['a'] }]));
    expect((await screen.findByRole('alert')).textContent).toContain('存储写入失败');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('已归档区默认折叠，展开时按 archived 取；行的「更多」能恢复', async () => {
    const archived = [summary('old', { title: '旧事', archived: true })];
    const restored: unknown[] = [];
    app = await renderApp('/', {
      'sessions/list': lists(p => (p.archived ? archived : p.section === 'owner' ? mine : [])),
      'session/unarchive': params => {
        restored.push(params);
        return {};
      },
    });
    const toggle = await within(left()).findByRole('button', { name: '已归档' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(listRequests().some(p => p.archived)).toBe(false);
    fireEvent.click(toggle);
    const list = await within(left()).findByRole('list', { name: '已归档' });
    expect(listRequests().find(p => p.archived)).toEqual({ archived: true, limit: 200 });
    fireEvent.click(within(list).getByRole('button', { name: '更多' }));
    expect(screen.queryByRole('menuitem', { name: '改名' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复' }));
    await vi.waitFor(() => expect(restored).toEqual([{ sessionId: 'old' }]));
  });

  it('没有归档的会话时写一行', async () => {
    app = await renderApp('/', { 'sessions/list': lists(() => []) });
    fireEvent.click(await within(left()).findByRole('button', { name: '已归档' }));
    expect(await within(left()).findByText('没有归档的会话')).toBeTruthy();
  });

  it('「新会话」去新会话（桌面上就是首页），悬停提示写快捷键', async () => {
    app = await renderApp('/s/a', { 'sessions/list': lists(() => mine) });
    const button = within(left()).getByRole('button', { name: '新会话' });
    expect(button.getAttribute('title')).toBe('新会话（⇧⌘O）');
    fireEvent.click(button);
    expect(app.where()).toBe('/');
  });

  it('手机的第一层：顶栏左边是标题，右边是搜索与新会话两个图标按钮', async () => {
    stubViewport(390);
    app = await renderApp('/', { 'sessions/list': lists(() => mine) });
    const header = within(left().querySelector('.session-list-header') as HTMLElement);
    expect(header.getByRole('heading', { name: '会话' })).toBeTruthy();
    expect(
      header.getAllByRole('button').map(button => [button.getAttribute('aria-label'), button.textContent]),
    ).toEqual([
      ['搜索', ''],
      ['新会话', ''],
    ]);
    fireEvent.click(header.getByRole('button', { name: '新会话' }));
    expect(app.where()).toBe('/new');
  });
});
