// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { type FakeRest, type Harness, installDialog, renderApp, restCalls } from './harness.js';
import { actionPath, data, dataPath, GRAPH, JOB_ROWS, JOBS, layoutStore, pagePath, SETTINGS_PAGE } from './pages.js';

// ════════════════════════════════════════════════════════════
// 声明式页面：/p/:instance/:pageKey 的标题栏（标题、实例名、刷新、固定）；五样组件按声明取数并显示，单元格按显示种类；
// 表格在客户端排序与搜索，行数超过一页才有搜索框与分页，行动作按 visibleWhen 显示；带详情的表与关系图选中后在详情里看，
// 选中写进地址；动作按 effect 推出按钮与确认，带输入的弹表单（行动作按行预填）；按 page.invalidate、手动刷新与重连重取；
// 一块取数失败只影响这一块；页面所属的插件停用时显示占位，回来后自动回到原页
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

const SUMMARY = [
  { label: '任务数', value: 2 },
  { label: '最近一次', value: '周报' },
];

/** 计划任务页的 REST：页面表、布局记录、各组件的数据；extra 覆盖或补充 */
function jobsRest(extra: FakeRest = {}): FakeRest {
  return {
    '/api/pages': { pages: [JOBS, GRAPH, SETTINGS_PAGE] },
    '/api/layout': layoutStore().route,
    [dataPath(JOBS, 'summary')]: data(SUMMARY),
    [dataPath(JOBS, 'list')]: data(JOB_ROWS),
    [dataPath(JOBS, 'log', { rowKey: '周报' })]: data('上周一 **成功**'),
    ...extra,
  };
}

const page = () => within(screen.getByRole('region', { name: '计划' }));
/** 页面的标题栏 */
const header = () => within(page().getByRole('heading', { name: '计划' }).closest('header') as HTMLElement);
const table = () => within(page().getByRole('table', { name: '计划' }));
const rowOf = (name: string) => within(table().getByText(name).closest('tr') as HTMLElement);
const gets = (path: string) => restCalls().filter(call => call.method === 'GET' && call.path === path).length;
const posts = (path: string) => restCalls().filter(call => call.method === 'POST' && call.path === path);
const admin = () => FakeWebSocket.at('/admin');

describe('标题栏与取数', () => {
  it('标题、实例名、刷新与固定；概况、表格与按钮组按声明取数显示', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest());
    expect(await page().findByText('任务数')).toBeTruthy();
    expect(header().getByText('night')).toBeTruthy();
    expect(header().getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(header().getByRole('button', { name: '固定到图标栏' }).getAttribute('aria-pressed')).toBe('false');

    expect(page().getByText('概况')).toBeTruthy();
    expect(page().getByText('2').closest('dd')).toBeTruthy();
    expect(await table().findByText('周报')).toBeTruthy();
    expect(page().getByRole('button', { name: '新建' })).toBeTruthy();
    expect(page().getByRole('button', { name: '清空' }).dataset.danger).toBe('true');
    expect(gets(dataPath(JOBS, 'summary'))).toBe(1);
    expect(gets(dataPath(JOBS, 'list'))).toBe(1);
  });

  it('地址里的页面不在页面表里（插件停用）时显示占位；页面重新登记后自动回到原页', async () => {
    let pages = [GRAPH];
    app = await renderApp(pagePath(JOBS), {}, jobsRest({ '/api/pages': () => ({ pages }) }));
    expect(await screen.findByText('这个页面所属的插件已停用')).toBeTruthy();
    pages = [JOBS];
    act(() => admin().push({ type: 'plugins.changed' }));
    await screen.findByRole('region', { name: '计划' });
    expect(await page().findByText('任务数')).toBeTruthy();
    expect(app.where()).toBe(pagePath(JOBS));
    pages = [];
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await screen.findByText('这个页面所属的插件已停用')).toBeTruthy();
  });

  it('设置里的一节不在 /p/ 下显示', async () => {
    app = await renderApp(pagePath(SETTINGS_PAGE), {}, jobsRest());
    expect(await screen.findByText('这个页面所属的插件已停用')).toBeTruthy();
    expect(restCalls().some(call => call.path.includes('/data/'))).toBe(false);
  });

  it('页面表没取到：主区写明原因，可以重试', async () => {
    let fail = true;
    app = await renderApp(
      pagePath(JOBS),
      {},
      jobsRest({
        '/api/pages': () => (fail ? Response.json({ error: '页面表读不了' }, { status: 500 }) : { pages: [JOBS] }),
      }),
    );
    expect(await screen.findByText('页面表读不了')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('region', { name: '计划' });
    expect(await page().findByText('任务数')).toBeTruthy();
  });
});

describe('重取', () => {
  it('page.invalidate：带组件 id 只重取这个组件，不带的整页重取，别的页面不重取；手动刷新与重连都整页重取', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest());
    await table().findByText('周报');
    const counts = () => [gets(dataPath(JOBS, 'summary')), gets(dataPath(JOBS, 'list'))];
    expect(counts()).toEqual([1, 1]);

    act(() => admin().push({ type: 'page.invalidate', instance: JOBS.instance, pageKey: 'jobs', componentId: 'list' }));
    await vi.waitFor(() => expect(counts()).toEqual([1, 2]));
    act(() => admin().push({ type: 'page.invalidate', instance: JOBS.instance, pageKey: 'jobs' }));
    await vi.waitFor(() => expect(counts()).toEqual([2, 3]));
    act(() => admin().push({ type: 'page.invalidate', instance: 'zz-jobs', pageKey: 'jobs' }));
    act(() => admin().push({ type: 'page.invalidate', instance: JOBS.instance, pageKey: 'graph' }));
    act(() =>
      admin().push({ type: 'page.invalidate', instance: JOBS.instance, pageKey: 'jobs', sessionId: 'someone' }),
    );

    fireEvent.click(header().getByRole('button', { name: '刷新' }));
    await vi.waitFor(() => expect(counts()).toEqual([3, 4]));

    act(() => admin().drop());
    act(() => FakeWebSocket.at('/admin').open());
    await vi.waitFor(() => expect(counts()).toEqual([4, 5]));
  });

  it('一块取数失败只影响这一块：写明原因、可以重试，别的块照常', async () => {
    let fail = true;
    app = await renderApp(
      pagePath(JOBS),
      {},
      jobsRest({
        [dataPath(JOBS, 'summary')]: () =>
          fail ? Response.json({ error: '数据源 summary 返回的数据不对' }, { status: 500 }) : data(SUMMARY),
      }),
    );
    const alert = await page().findByRole('alert');
    expect(alert.textContent).toContain('数据源 summary 返回的数据不对');
    expect(await table().findByText('周报')).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await page().findByText('任务数')).toBeTruthy();
    expect(page().queryByRole('alert')).toBeNull();
  });
});

describe('表格', () => {
  it('行动作：第一个不是 destructive 的是文字按钮，其余进「更多」，窄时全部进「更多」；visibleWhen 为假的不显示', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest());
    await table().findByText('周报');
    const weekly = rowOf('周报');
    const wide = weekly.getByText('执行').closest('[data-wide]') as HTMLElement;
    expect(within(wide).getByRole('button', { name: '执行' })).toBeTruthy();

    const menuItems = (scope: HTMLElement) => {
      fireEvent.click(within(scope).getByRole('button', { name: '更多' }));
      const items = screen.getAllByRole('menuitem').map(item => [item.textContent, item.dataset.danger ?? null]);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      return items;
    };
    const wideMenu = weekly.getAllByRole('button', { name: '更多' })[0].closest('[data-wide]') as HTMLElement;
    expect(menuItems(wideMenu)).toEqual([
      ['暂停', null],
      ['编辑', null],
      ['删除', 'true'],
    ]);
    const narrow = (row: typeof weekly) =>
      row
        .getAllByRole('button', { name: '更多' })
        .find(button => button.closest('[data-narrow]'))
        ?.closest('[data-narrow]') as HTMLElement;
    expect(menuItems(narrow(weekly))).toEqual([
      ['执行', null],
      ['暂停', null],
      ['编辑', null],
      ['删除', 'true'],
    ]);
    expect(menuItems(narrow(rowOf('备份'))).map(([label]) => label)).toEqual(['执行', '编辑', '删除']);
  });

  it('列：primary 的标出（窄时只留它们）；数字右对齐；状态按 state 着色', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest());
    await table().findByText('周报');
    const headers = table().getAllByRole('columnheader');
    expect(headers.map(h => [h.textContent, h.dataset.primary ?? null])).toEqual([
      ['名称', 'true'],
      ['间隔', null],
      ['状态', 'true'],
      ['操作', null],
    ]);
    expect(rowOf('周报').getByText('3600').closest('td')?.dataset.numeric).toBe('true');
    expect(rowOf('备份').getByText('执行中').closest('[data-state]')?.getAttribute('data-state')).toBe('running');
  });

  it('都没标 primary 时窄时留第一列；选中用的链接列总留着', async () => {
    const PLAIN: typeof JOBS = {
      ...JOBS,
      actions: {},
      content: [
        {
          type: 'table',
          id: 'list',
          rowKey: 'name',
          columns: [
            { key: 'name', label: '名称' },
            { key: 'at', label: '时间', kind: 'time' },
          ],
        },
        {
          type: 'table',
          id: 'works',
          label: '作品',
          rowKey: 'id',
          columns: [
            { key: 'cover', label: '封面', kind: 'image', primary: true },
            { key: 'title', label: '标题' },
          ],
          detail: [{ type: 'markdown', id: 'log' }],
        },
      ],
    };
    app = await renderApp(
      pagePath(PLAIN),
      {},
      jobsRest({
        '/api/pages': { pages: [PLAIN] },
        [dataPath(PLAIN, 'list')]: data([{ name: '周报', at: 0 }]),
        [dataPath(PLAIN, 'works')]: data([{ id: 'w1', title: '水彩小镇' }]),
      }),
    );
    const primaries = (name: string) =>
      within(page().getByRole('table', { name }))
        .getAllByRole('columnheader')
        .map(h => [h.textContent, h.dataset.primary ?? null]);
    await table().findByText('周报');
    expect(primaries('计划')).toEqual([
      ['名称', 'true'],
      ['时间', null],
    ]);
    await page().findByRole('link', { name: '水彩小镇' });
    expect(primaries('作品')).toEqual([
      ['封面', 'true'],
      ['标题', 'true'],
    ]);
  });

  it('点表头排序；不超过一页没有搜索框，超过一页才出现搜索与分页，搜索按各列的文字', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      name: `任务${String(i).padStart(2, '0')}`,
      every: i,
      status: { text: i === 7 ? '暂停' : '就绪' },
      pausable: false,
    }));
    app = await renderApp(pagePath(JOBS), {}, jobsRest());
    await table().findByText('周报');
    expect(page().queryByRole('searchbox')).toBeNull();
    fireEvent.click(table().getByRole('button', { name: /间隔/ }));
    expect(table().getAllByRole('row')[1].textContent).toContain('备份');
    expect(table().getByRole('columnheader', { name: /间隔/ }).getAttribute('aria-sort')).toBe('ascending');
    app.close();

    app = await renderApp(pagePath(JOBS), {}, jobsRest({ [dataPath(JOBS, 'list')]: data(many) }));
    await table().findByText('任务00');
    expect(page().getByRole('navigation', { name: '分页' })).toBeTruthy();
    fireEvent.change(page().getByRole('searchbox'), { target: { value: '暂停' } });
    expect(
      table()
        .getAllByRole('row')
        .slice(1)
        .map(row => row.textContent?.slice(0, 4)),
    ).toEqual(['任务07']);
  });

  it('没有行时写声明的空状态', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest({ [dataPath(JOBS, 'list')]: data([]) }));
    expect(await table().findByText('还没有任务')).toBeTruthy();
  });
});

describe('详情', () => {
  it('点一行：选中写进地址，详情按 rowKey 取数；详情里的按钮作用于选中的行；关闭后回到列表，后退也回到列表', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest({ [actionPath(JOBS, 'run')]: { message: '已执行 周报' } }));
    await table().findByText('周报');
    fireEvent.click(table().getByRole('link', { name: '周报' }));
    expect(app.where()).toBe(`${pagePath(JOBS)}?detail=list&row=${encodeURIComponent('周报')}`);
    const detail = within(await page().findByRole('region', { name: '周报' }));
    expect(await detail.findByText('成功')).toBeTruthy();
    expect(rowOf('周报').getByRole('link', { name: '周报' }).getAttribute('aria-current')).toBe('true');

    fireEvent.click(detail.getByRole('button', { name: '执行' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'run'))).toHaveLength(1));
    expect(posts(actionPath(JOBS, 'run'))[0].body).toEqual({ rowKey: '周报' });
    expect(await screen.findByText('已执行 周报')).toBeTruthy();

    fireEvent.click(table().getByRole('link', { name: '备份' }));
    expect(app.where()).toContain('row=%E5%A4%87%E4%BB%BD');
    app.back();
    expect(app.where()).toBe(pagePath(JOBS));
    expect(page().queryByRole('region', { name: '备份' })).toBeNull();

    fireEvent.click(table().getByRole('link', { name: '周报' }));
    fireEvent.click(within(page().getByRole('region', { name: '周报' })).getByRole('button', { name: '关闭详情' }));
    expect(app.where()).toBe(pagePath(JOBS));
  });

  it('选中的链接放在写字的列上：第一列是图片时放到后面的文字列，详情的标题也取它', async () => {
    const GALLERY: typeof JOBS = {
      ...JOBS,
      actions: {},
      content: [
        {
          type: 'table',
          id: 'list',
          rowKey: 'id',
          columns: [
            { key: 'cover', label: '封面', kind: 'image', primary: true },
            { key: 'title', label: '标题', primary: true },
          ],
          detail: [{ type: 'markdown', id: 'log' }],
        },
      ],
    };
    app = await renderApp(
      pagePath(GALLERY),
      {},
      jobsRest({
        '/api/pages': { pages: [GALLERY] },
        [dataPath(GALLERY, 'list')]: data([{ id: 'w1', cover: '/api/media?uri=works%3A%2Fa.png', title: '水彩小镇' }]),
        [dataPath(GALLERY, 'log', { rowKey: 'w1' })]: data('说明'),
      }),
    );
    fireEvent.click(await table().findByRole('link', { name: '水彩小镇' }));
    expect(await page().findByRole('region', { name: '水彩小镇' })).toBeTruthy();
  });

  it('地址里选中的行已不在：不显示详情', async () => {
    app = await renderApp(`${pagePath(JOBS)}?detail=list&row=gone`, {}, jobsRest());
    await table().findByText('周报');
    expect(restCalls().some(call => call.path.includes('/data/log'))).toBe(false);
    expect(page().queryByRole('button', { name: '关闭详情' })).toBeNull();
  });
});

describe('动作', () => {
  it('不带输入的直接调：进行中不能再点，成功时 Toast 写处理函数给的结果；失败时出错 Toast 写原因', async () => {
    let release: () => void = () => {};
    let fail = false;
    app = await renderApp(
      pagePath(JOBS),
      {},
      jobsRest({
        [actionPath(JOBS, 'run')]: () =>
          new Promise(resolve => {
            release = () =>
              resolve(
                fail ? Response.json({ error: '任务 周报 不存在' }, { status: 500 }) : { message: '已执行 周报' },
              );
          }),
      }),
    );
    await table().findByText('周报');
    fireEvent.click(rowOf('周报').getByRole('button', { name: '执行' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'run'))).toHaveLength(1));
    expect(rowOf('周报').getByRole('status', { name: '进行中' })).toBeTruthy();
    expect(rowOf('周报').queryByRole('button', { name: '执行' })).toBeNull();
    act(() => release());
    expect(await screen.findByText('已执行 周报')).toBeTruthy();
    expect(posts(actionPath(JOBS, 'run'))[0].body).toEqual({ rowKey: '周报' });

    fail = true;
    fireEvent.click(rowOf('周报').getByRole('button', { name: '执行' }));
    act(() => release());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('执行失败：任务 周报 不存在');
  });

  it('destructive：宿主弹确认框，写插件给的确认文案，焦点在「取消」；取消不调，确认后调', async () => {
    app = await renderApp(
      pagePath(JOBS),
      {},
      jobsRest({ [actionPath(JOBS, 'remove')]: {}, [actionPath(JOBS, 'purge')]: {} }),
    );
    await table().findByText('周报');
    const wideMenu = rowOf('周报').getAllByRole('button', { name: '更多' })[0];
    fireEvent.click(wideMenu);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    const dialog = within(screen.getByRole('dialog', { name: '删除？' }));
    expect(dialog.getByText('删除这个任务？删除后不能恢复。')).toBeTruthy();
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: '取消' }));
    fireEvent.click(dialog.getByRole('button', { name: '取消' }));
    expect(posts(actionPath(JOBS, 'remove'))).toHaveLength(0);

    fireEvent.click(rowOf('周报').getAllByRole('button', { name: '更多' })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除？' })).getByRole('button', { name: '删除' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'remove'))).toHaveLength(1));
    expect(posts(actionPath(JOBS, 'remove'))[0].body).toEqual({ rowKey: '周报' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(page().getByRole('button', { name: '清空' }));
    expect(within(screen.getByRole('dialog', { name: '清空？' })).getByText('这个操作不能撤销。')).toBeTruthy();
  });

  it('带输入的弹表单：控件按字段类型，必填写明；提交时按类型转换，空着的可选项不送；服务端逐项的问题写在字段下，表单不关', async () => {
    let reject = true;
    app = await renderApp(
      pagePath(JOBS),
      {},
      jobsRest({
        [actionPath(JOBS, 'create')]: () =>
          reject
            ? Response.json(
                {
                  error: '输入没过校验：every 不能小于 5',
                  issues: [{ path: 'every', message: '不能小于 5', kind: 'invalid' }],
                },
                { status: 400 },
              )
            : { message: '已保存任务 晨报' },
      }),
    );
    await table().findByText('周报');
    fireEvent.click(page().getByRole('button', { name: '新建' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建' }));
    const name = dialog.getByLabelText('名称') as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    expect(name.closest('.page-field')?.textContent).toContain('必填');
    expect(dialog.getByText('不小于 5')).toBeTruthy();
    expect((dialog.getByLabelText('启用') as HTMLInputElement).checked).toBe(true);
    expect(
      within(dialog.getByLabelText('方式'))
        .getAllByRole('option')
        .map(o => o.textContent),
    ).toEqual(['', '周期', '一次']);

    fireEvent.change(name, { target: { value: '晨报' } });
    fireEvent.change(dialog.getByLabelText('间隔（秒）'), { target: { value: '3' } });
    fireEvent.change(dialog.getByLabelText('标签'), { target: { value: '早上\n\n日报' } });
    fireEvent.change(dialog.getByLabelText('方式'), { target: { value: 'once' } });
    fireEvent.click(dialog.getByRole('button', { name: '新建' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'create'))).toHaveLength(1));
    expect(posts(actionPath(JOBS, 'create'))[0].body).toEqual({
      input: { name: '晨报', every: 3, mode: 'once', enabled: true, tags: ['早上', '日报'] },
    });
    const issue = await dialog.findByText('不能小于 5');
    expect(issue.closest('.page-field')?.querySelector('input')?.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(dialog.getByLabelText('间隔（秒）'), { target: { value: '很久' } });
    fireEvent.click(dialog.getByRole('button', { name: '新建' }));
    expect(await dialog.findByText('要填一个数')).toBeTruthy();
    expect(posts(actionPath(JOBS, 'create'))).toHaveLength(1);

    reject = false;
    fireEvent.change(dialog.getByLabelText('间隔（秒）'), { target: { value: '' } });
    fireEvent.change(dialog.getByLabelText('方式'), { target: { value: '' } });
    fireEvent.click(dialog.getByRole('button', { name: '新建' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(actionPath(JOBS, 'create'))[1].body).toEqual({
      input: { name: '晨报', enabled: true, tags: ['早上', '日报'] },
    });
    expect(await screen.findByText('已保存任务 晨报')).toBeTruthy();
  });

  it('对话框发出后关掉：这一行显示「进行中」、不能再点；回来时不关之后打开的对话框，失败改用 Toast 报', async () => {
    const held: Record<string, () => void> = {};
    const hold = (name: string, reply: unknown) => () =>
      new Promise(resolve => {
        held[name] = () => resolve(reply);
      });
    app = await renderApp(
      pagePath(JOBS),
      {},
      jobsRest({
        [actionPath(JOBS, 'remove')]: hold('remove', { message: '已删除 周报' }),
        [actionPath(JOBS, 'edit')]: hold('edit', Response.json({ error: '任务 备份 不存在' }, { status: 500 })),
      }),
    );
    await table().findByText('周报');
    fireEvent.click(rowOf('周报').getAllByRole('button', { name: '更多' })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除？' })).getByRole('button', { name: '删除' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'remove'))).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除？' })).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowOf('周报').getByRole('status', { name: '进行中' })).toBeTruthy();
    expect(rowOf('周报').queryByRole('button', { name: '更多' }), '删除还在进行，同一行不能再发一次').toBeNull();

    fireEvent.click(page().getByRole('button', { name: '新建' }));
    const form = within(screen.getByRole('dialog', { name: '新建' }));
    fireEvent.change(form.getByLabelText('名称'), { target: { value: '晨报' } });
    act(() => held.remove());
    expect(await screen.findByText('已删除 周报')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '新建' }), '先发出的删除回来时把后打开的表单关掉了').toBeTruthy();
    expect((form.getByLabelText('名称') as HTMLInputElement).value).toBe('晨报');
    expect(rowOf('周报').queryByRole('status', { name: '进行中' })).toBeNull();
    fireEvent.click(form.getByRole('button', { name: '取消' }));

    fireEvent.click(rowOf('备份').getAllByRole('button', { name: '更多' })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '编辑' })).getByRole('button', { name: '编辑' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'edit'))).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('dialog', { name: '编辑' })).getByRole('button', { name: '取消' }));
    act(() => held.edit());
    expect((await screen.findByRole('alert')).textContent).toContain('编辑失败：任务 备份 不存在');
  });

  it('带输入的 destructive 动作：表单里同样写警示，插件没写确认文案时是宿主的默认警示', async () => {
    const ARCHIVE: typeof JOBS = {
      ...JOBS,
      actions: {
        archive: { label: '归档', effect: 'destructive', input: { reason: { type: 'string', label: '原因' } } },
      },
      content: [{ type: 'actions', actions: ['archive'] }],
    };
    app = await renderApp(pagePath(ARCHIVE), {}, { '/api/pages': { pages: [ARCHIVE] } });
    fireEvent.click(await page().findByRole('button', { name: '归档' }));
    expect(within(screen.getByRole('dialog', { name: '归档' })).getByText('这个操作不能撤销。')).toBeTruthy();
  });

  it('行动作的表单：与行字段同名的输入项用这一行的值预填（编辑）', async () => {
    app = await renderApp(pagePath(JOBS), {}, jobsRest({ [actionPath(JOBS, 'edit')]: {} }));
    await table().findByText('周报');
    fireEvent.click(rowOf('周报').getAllByRole('button', { name: '更多' })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }));
    const dialog = within(screen.getByRole('dialog', { name: '编辑' }));
    expect((dialog.getByLabelText('间隔（秒）') as HTMLInputElement).value).toBe('3600');
    expect((dialog.getByLabelText('备注') as HTMLTextAreaElement).value).toBe('每周一');
    fireEvent.click(dialog.getByRole('button', { name: '编辑' }));
    await vi.waitFor(() => expect(posts(actionPath(JOBS, 'edit'))).toHaveLength(1));
    expect(posts(actionPath(JOBS, 'edit'))[0].body).toEqual({ rowKey: '周报', input: { every: 3600, note: '每周一' } });
  });
});

describe('单元格', () => {
  const CELLS: typeof JOBS = {
    ...JOBS,
    actions: {},
    content: [
      {
        type: 'table',
        id: 'list',
        rowKey: 'id',
        columns: [
          { key: 'id', label: '编号', primary: true },
          { key: 'at', label: '时刻', kind: 'time' },
          { key: 'next', label: '下次', kind: 'countdown' },
          { key: 'url', label: '网址', kind: 'link' },
          { key: 'code', label: '代码', kind: 'code' },
          { key: 'text', label: '原文', kind: 'long-text' },
          { key: 'cover', label: '封面', kind: 'image' },
          { key: 'file', label: '文件', kind: 'file' },
        ],
      },
    ],
  };

  it('时间、倒计时、链接、代码、长文本、图片与文件按显示种类显示；不安全的链接与不是媒体地址的图片按文字', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = new Date(2026, 9, 3, 10, 0).getTime();
    vi.setSystemTime(now);
    const rows = [
      {
        id: 'a',
        at: new Date(2026, 9, 3, 9, 5).getTime(),
        next: now + 90_000,
        url: 'https://example.invalid/a',
        code: 'make weekly',
        text: '很长的一段原文',
        cover: '/api/media?uri=works%3A%2Fa.png',
        file: { name: 'a.zip', handle: 'h.1' },
      },
      {
        id: 'b',
        url: 'javascript:alert(1)',
        cover: 'https://img.example.invalid/b.png',
        file: { name: 'b.log' },
      },
    ];
    app = await renderApp(
      pagePath(CELLS),
      {},
      jobsRest({ '/api/pages': { pages: [CELLS] }, [dataPath(CELLS, 'list')]: data(rows) }),
    );
    await table().findByText('a');
    const a = rowOf('a');
    expect(a.getByText('09:05').tagName).toBe('TIME');
    expect(a.getByText('1 分 30 秒后')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(a.getByText('59 秒后')).toBeTruthy();
    const link = a.getByRole('link', { name: 'https://example.invalid/a' });
    expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer']);
    expect(a.getByText('make weekly').tagName).toBe('CODE');
    const expand = a.getByRole('button', { name: '很长的一段原文' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('true');
    const image = a.getByRole('img') as HTMLImageElement;
    expect([image.getAttribute('src'), image.getAttribute('loading')]).toEqual([
      '/api/media?uri=works%3A%2Fa.png',
      'lazy',
    ]);
    const download = a.getByRole('link', { name: /a\.zip/ });
    expect(download.getAttribute('href')).toBe('/api/page-file?handle=h.1');
    expect(download.hasAttribute('download')).toBe(true);

    const b = rowOf('b');
    expect(b.queryByRole('link')).toBeNull();
    expect(b.getByText('javascript:alert(1)')).toBeTruthy();
    expect(b.queryByRole('img')).toBeNull();
    expect(b.getByText('b.log')).toBeTruthy();
  });
});

describe('标签页与关系图', () => {
  const GRAPH_DATA = {
    nodes: [
      { id: 'p1', label: '小明', kind: 'person' },
      { id: 'e1', label: '读书会', kind: 'event' },
      { id: 'x', label: '别的' },
    ],
    edges: [
      { source: 'p1', target: 'e1', kind: 'knows', label: '参加' },
      { source: 'p1', target: 'x' },
    ],
  };
  const graphRest = (extra: FakeRest = {}) =>
    jobsRest({
      [dataPath(GRAPH, 'about')]: data('关系图的说明'),
      [dataPath(GRAPH, 'map')]: data(GRAPH_DATA),
      [dataPath(GRAPH, 'node', { rowKey: 'p1' })]: data([{ label: '名字', value: '小明' }]),
      ...extra,
    });
  const graphPage = () => within(screen.getByRole('region', { name: '关系' }));

  it('标签写进地址：切换用替换，不认识的标签落第一个', async () => {
    app = await renderApp(['/', `${pagePath(GRAPH)}?tab=nope`], {}, graphRest());
    expect(await graphPage().findByText('关系图的说明')).toBeTruthy();
    expect(graphPage().getByRole('tab', { name: '说明' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(graphPage().getByRole('tab', { name: '图' }));
    expect(app.where()).toBe(`${pagePath(GRAPH)}?tab=map`);
    expect(await graphPage().findByRole('button', { name: '小明' })).toBeTruthy();
    app.back();
    expect(app.where()).toBe('/');
  });

  it('节点与边按类别取色（不收颜色值）；图例只列图里有的类别，边的类别画成线；点节点在详情里看，详情按节点 id 取数', async () => {
    app = await renderApp(`${pagePath(GRAPH)}?tab=map`, {}, graphRest());
    const person = await graphPage().findByRole('button', { name: '小明' });
    expect(person.getAttribute('data-tone')).toBe('1');
    expect(graphPage().getByRole('button', { name: '读书会' }).getAttribute('data-tone')).toBe('3');
    expect(graphPage().getByRole('button', { name: '别的' }).hasAttribute('data-tone')).toBe(false);
    const edges = document.querySelectorAll('.page-graph-edge');
    expect([...edges].map(edge => edge.getAttribute('data-tone'))).toEqual(['2', null]);
    expect(
      within(graphPage().getByRole('list', { name: '图例' }))
        .getAllByRole('listitem')
        .map(item => [item.textContent, item.querySelector('[data-edge]') !== null]),
    ).toEqual([
      ['人物', false],
      ['事件', false],
      ['认识', true],
    ]);
    expect(graphPage().getByRole('button', { name: '放大' })).toBeTruthy();
    expect(graphPage().getByRole('button', { name: '缩小' })).toBeTruthy();

    fireEvent.click(person);
    expect(app.where()).toBe(`${pagePath(GRAPH)}?tab=map&detail=map&row=p1`);
    const detail = within(await graphPage().findByRole('region', { name: '小明' }));
    expect(await detail.findByText('名字')).toBeTruthy();
    expect(person.getAttribute('aria-pressed')).toBe('true');
  });

  it('没有节点时写声明的空状态', async () => {
    app = await renderApp(
      `${pagePath(GRAPH)}?tab=map`,
      {},
      graphRest({ [dataPath(GRAPH, 'map')]: data({ nodes: [], edges: [] }) }),
    );
    expect(await graphPage().findByText('还没有关系')).toBeTruthy();
  });
});
