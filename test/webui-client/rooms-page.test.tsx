// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMethodParams, SettingLayer } from '../../packages/api-session-protocol/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  choose,
  group,
  type Harness,
  HOME_PLACE,
  installDialog,
  listRequests,
  optionsOf,
  renderApp,
  requests,
  room,
} from './harness.js';
import { row as settingRow } from './items.js';

// ════════════════════════════════════════════════════════════
// 房间表（/rooms?instance=）：一次取全这一组（翻页取完），类型与状态的筛选写进地址，排序、搜索与分页在客户端；
// 类型是平台自定的类型名，筛选只列本组出现过的，原样写；批量动作只有归档与删除，全选只作用于筛选结果；每行的「场所设置」
// 在页内打开这一行所在窗口的设置；窄时只留名称与状态（这里核列上的标记，窄容器里的真实排版在端到端里核）
// ════════════════════════════════════════════════════════════

const NOW = new Date(2026, 9, 3, 15, 0).getTime();
const DAY = 24 * 60 * 60_000;

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
});

const GROUPS = [
  group('im-a', { label: 'QQ 主号', rooms: 4, accounts: 1 }),
  group(undefined, { label: 'onebot', rooms: 1 }),
];
const ROOMS = [
  room('g1', 'im-a', { title: '读书会', updatedAt: NOW - 1000, lastReplyAt: NOW - DAY }),
  room('g2', 'im-a', { title: '技术交流', error: true, updatedAt: NOW - 2000 }),
  room('p1', 'im-a', {
    title: '小林',
    chat: { type: 'private', multiParty: false },
    place: { key: 'onebot:private:p1', kind: 'window', name: '小林' },
    running: true,
    updatedAt: NOW - 3000,
  }),
  room('g3', 'im-a', { title: '摄影分享', updatedAt: NOW - 3 * DAY }),
];

function serveRooms(params: SessionMethodParams<'sessions/list'>) {
  if (params.instance === 'im-a') {
    // 一页两条，翻页取完
    const offset = Number(params.cursor ?? 0);
    const next = offset + 2;
    return {
      sessions: ROOMS.slice(offset, next),
      nextCursor: next < ROOMS.length ? String(next) : undefined,
      groups: GROUPS,
    };
  }
  if (params.platform === 'onebot')
    return { sessions: [room('legacy', undefined, { title: '旧房间' })], groups: GROUPS };
  return { sessions: [], groups: GROUPS };
}

const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map(row => row.querySelector('td[data-column="name"]')?.textContent);

describe('房间表', () => {
  it('按实例取全这一组，标题写通用图标与组名；行链到会话', async () => {
    app = await renderApp('/rooms?instance=im-a', { 'sessions/list': serveRooms });
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'QQ 主号' })).toBeTruthy();
    expect(main.querySelector('.panel-header .lucide-messages-square')?.getAttribute('aria-hidden')).toBe('true');
    await vi.waitFor(() => expect(names()).toEqual(['读书会', '技术交流', '小林', '摄影分享']));
    expect(listRequests().filter(p => p.instance === 'im-a')).toEqual([
      { instance: 'im-a', limit: 200 },
      { instance: 'im-a', limit: 200, cursor: '2' },
    ]);
    const row = screen.getByRole('row', { name: /小林/ });
    expect(row.querySelector('td[data-column="type"]')?.textContent).toBe('private');
    expect(row.textContent).toContain('运行中');
    expect(screen.getByRole('row', { name: /读书会/ }).textContent).toContain('10/2');
    expect(within(row).getByRole('link', { name: '小林' }).getAttribute('href')).toBe('/s/p1');
    // 窄时只留名称与状态；一个账号时没有账号列
    expect(screen.getAllByRole('columnheader').map(th => [th.textContent, th.hasAttribute('data-primary')])).toEqual([
      ['', false],
      ['名称', true],
      ['类型', false],
      ['状态', true],
      ['最后活动', false],
      ['她最近开口', false],
      ['操作', false],
    ]);
  });

  it('表格下面一句提示：统一设置一个平台或一种类型去设置的「会话默认」，单个窗口在这里设', async () => {
    app = await renderApp('/rooms?instance=im-a', { 'sessions/list': serveRooms });
    await vi.waitFor(() => expect(names()).toHaveLength(4));
    const main = within(screen.getByRole('main'));
    expect(main.getByText(/统一设置/).textContent).toBe('统一设置一个平台或一种类型去「会话默认」，单个窗口在这里设。');
    fireEvent.click(main.getByRole('link', { name: '去会话默认' }));
    expect(app.where()).toBe('/settings/session-defaults');
  });

  it('还没记下实例的组按平台取', async () => {
    app = await renderApp('/rooms?platform=onebot', { 'sessions/list': serveRooms });
    await vi.waitFor(() => expect(names()).toEqual(['旧房间']));
    expect(listRequests().some(p => p.platform === 'onebot' && p.instance === undefined)).toBe(true);
  });

  it('类型与状态的筛选写进地址，从地址恢复；类型只列本组出现过的类型名，原样写；排序在客户端', async () => {
    // 平台自定的类型名（这里的 channel）照样列出、原样写
    const channel = room('c1', 'im-a', { title: '公告频道', chat: { type: 'channel', multiParty: true } });
    app = await renderApp('/rooms?instance=im-a&status=error', {
      'sessions/list': () => ({ sessions: [...ROOMS, channel], groups: GROUPS }),
    });
    await vi.waitFor(() => expect(names()).toEqual(['技术交流']));
    choose(screen.getByRole('combobox', { name: '状态' }), '全部');
    expect(app.where()).toBe('/rooms?instance=im-a');
    expect(optionsOf(screen.getByRole('combobox', { name: '类型' }))).toEqual(['全部', 'channel', 'group', 'private']);
    expect(screen.getByRole('row', { name: /公告频道/ }).querySelector('td[data-column="type"]')?.textContent).toBe(
      'channel',
    );
    choose(screen.getByRole('combobox', { name: '类型' }), 'private');
    expect(app.where()).toBe('/rooms?instance=im-a&type=private');
    expect(names()).toEqual(['小林']);
    choose(screen.getByRole('combobox', { name: '类型' }), 'group');
    fireEvent.click(within(screen.getByRole('columnheader', { name: /名称/ })).getByRole('button'));
    expect(names()).toEqual(['技术交流', '读书会', '摄影分享'].sort((a, b) => a.localeCompare(b)));
  });

  it('手机上改了筛选（替换当前地址）再「返回」：退回列表，前进回到筛选过的房间表', async () => {
    stubViewport(390);
    app = await renderApp('/', { 'sessions/list': serveRooms });
    fireEvent.click(await screen.findByRole('button', { name: '用表格查看「QQ 主号」的全部房间' }));
    await vi.waitFor(() => expect(names()).toHaveLength(4));
    choose(screen.getByRole('combobox', { name: '类型' }), 'group');
    expect(app.where()).toBe('/rooms?instance=im-a&type=group');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/');
    app.forward();
    expect(app.where()).toBe('/rooms?instance=im-a&type=group');
  });

  it('全选只作用于筛选结果；批量归档、批量删除（先确认）', async () => {
    const batches: unknown[] = [];
    app = await renderApp('/rooms?instance=im-a&type=group', {
      'sessions/list': serveRooms,
      'session/batch': params => {
        batches.push(params);
        return { failed: [] };
      },
    });
    await vi.waitFor(() => expect(names()).toHaveLength(3));
    fireEvent.click(screen.getByRole('checkbox', { name: '全选筛选结果' }));
    expect(screen.getByText('已选 3 项')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    await vi.waitFor(() => expect(batches).toEqual([{ op: 'archive', ids: ['g1', 'g2', 'g3'] }]));
    expect(screen.queryByText(/已选/)).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 读书会' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除会话「读书会」？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await vi.waitFor(() => expect(batches.at(-1)).toEqual({ op: 'delete', ids: ['g1'] }));
  });

  it('「场所设置」在页内打开这一行窗口的设置：按层读写这个场所，行与会话默认同一套；场所不是窗口的行（owner 的 IM 私聊）没有这个动作', async () => {
    const place = { scope: 'place', key: 'onebot:group:g1' } as const;
    const rows = [
      settingRow('persona', { field: { type: 'string', label: '人设' }, effective: '<群人设>', source: 'type' }),
      settingRow('paperEnabled', {
        field: { type: 'boolean', label: '开启白纸' },
        value: true,
        effective: true,
        source: 'place',
      }),
    ];
    const mine = room('p0', 'im-a', {
      title: '<我的私聊>',
      chat: { type: 'private', multiParty: false },
      place: HOME_PLACE,
    });
    app = await renderApp('/rooms?instance=im-a', {
      'sessions/list': () => ({ sessions: [...ROOMS, mine], groups: GROUPS }),
      'session/config/layer/get': () => ({ items: rows }),
      'session/config/layer/update': () => ({ items: rows }),
    });
    await vi.waitFor(() => expect(names()).toHaveLength(5));
    const own = screen.getByRole('row', { name: /<我的私聊>/ });
    expect(within(own).queryByRole('button', { name: '场所设置' })).toBeNull();
    fireEvent.click(within(screen.getByRole('row', { name: /读书会/ })).getByRole('button', { name: '场所设置' }));
    const dialog = within(screen.getByRole('dialog', { name: '场所设置：读书会' }));
    const persona = within(await dialog.findByRole('group', { name: '人设' }));
    expect(requests('session/config/layer/get')).toEqual([{ layer: place }]);
    expect(persona.getByText('<群人设>')).toBeTruthy();
    expect(persona.getByText('平台类型档')).toBeTruthy();
    expect(persona.queryByRole('button', { name: '恢复继承' })).toBeNull();
    const paper = within(dialog.getByRole('group', { name: '开启白纸' }));
    expect(paper.getByText('场所')).toBeTruthy();

    fireEvent.click(paper.getByRole('switch', { name: '开启白纸' }));
    await vi.waitFor(() =>
      expect(requests('session/config/layer/update')).toEqual([
        { layer: place satisfies SettingLayer, patch: { paperEnabled: false } },
      ]),
    );
    fireEvent.click(dialog.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('多账号的组有账号列', async () => {
    const multi = [group('im-a', { label: 'QQ 主号', rooms: 1, accounts: 2 })];
    app = await renderApp('/rooms?instance=im-a', {
      'sessions/list': () => ({ sessions: [room('g1', 'im-a', { title: '读书会', account: '10002' })], groups: multi }),
    });
    await vi.waitFor(() => expect(names()).toEqual(['读书会']));
    expect(screen.getByRole('columnheader', { name: '账号' })).toBeTruthy();
    expect(screen.getByRole('row', { name: /读书会/ }).textContent).toContain('10002');
  });

  it('取不到时就地写明原因，可以重试；没有指定组时回首页', async () => {
    let fail = true;
    app = await renderApp('/rooms?instance=im-a', {
      'sessions/list': params => {
        if (fail && params.instance) throw new Error('会话服务出错');
        return serveRooms(params);
      },
    });
    const main = screen.getByRole('main');
    const alert = await within(main).findByRole('alert');
    expect(alert.textContent).toContain('会话服务出错');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(names()).toHaveLength(4));
    app.close();
    app = await renderApp('/rooms', { 'sessions/list': serveRooms });
    expect(app.where()).toBe('/');
  });
});
