// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMethodParams } from '../../packages/api-session-protocol/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { group, type Harness, installDialog, listRequests, renderApp, room } from './harness.js';

// ════════════════════════════════════════════════════════════
// 房间表（/rooms?instance=）：一次取全这一组（翻页取完），类型与状态的筛选写进地址，排序、搜索与分页在客户端；
// 批量动作只有归档与删除，全选只作用于筛选结果；窄时只留名称与状态（这里核列上的标记，窄容器里的真实排版在端到端里核）
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
  room('p1', 'im-a', { title: '小林', audience: 'private', running: true, updatedAt: NOW - 3000 }),
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
    expect(row.textContent).toContain('私聊');
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
    ]);
  });

  it('还没记下实例的组按平台取', async () => {
    app = await renderApp('/rooms?platform=onebot', { 'sessions/list': serveRooms });
    await vi.waitFor(() => expect(names()).toEqual(['旧房间']));
    expect(listRequests().some(p => p.platform === 'onebot' && p.instance === undefined)).toBe(true);
  });

  it('类型与状态的筛选写进地址，从地址恢复；排序在客户端', async () => {
    app = await renderApp('/rooms?instance=im-a&status=error', { 'sessions/list': serveRooms });
    await vi.waitFor(() => expect(names()).toEqual(['技术交流']));
    fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '' } });
    expect(app.where()).toBe('/rooms?instance=im-a');
    fireEvent.change(screen.getByRole('combobox', { name: '类型' }), { target: { value: 'private' } });
    expect(app.where()).toBe('/rooms?instance=im-a&type=private');
    expect(names()).toEqual(['小林']);
    fireEvent.change(screen.getByRole('combobox', { name: '类型' }), { target: { value: 'group' } });
    fireEvent.click(within(screen.getByRole('columnheader', { name: /名称/ })).getByRole('button'));
    expect(names()).toEqual(['技术交流', '读书会', '摄影分享'].sort((a, b) => a.localeCompare(b)));
  });

  it('手机上改了筛选（替换当前地址）再「返回」：退回列表，前进回到筛选过的房间表', async () => {
    stubViewport(390);
    app = await renderApp('/', { 'sessions/list': serveRooms });
    fireEvent.click(await screen.findByRole('button', { name: '用表格查看「QQ 主号」的全部房间' }));
    await vi.waitFor(() => expect(names()).toHaveLength(4));
    fireEvent.change(screen.getByRole('combobox', { name: '类型' }), { target: { value: 'group' } });
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
