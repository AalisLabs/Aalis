// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingRow } from '../../packages/api-session-protocol/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRest,
  type Harness,
  INIT,
  installDialog,
  lists,
  main,
  renderApp,
  requests,
  server,
  summary,
} from './harness.js';
import { plan, row, snapshot, toolCall, turn, usage, userMessage } from './items.js';

// ════════════════════════════════════════════════════════════
// 右侧面板与会话头：设置（只列服务端给的行，composer 与 common 在前，advanced 收进默认折叠的「高级」按插件分组，
// 每行写生效值与来源，就地修改即存，恢复继承，收到 session/config/changed 重取）、用量（头部百分比、压缩线与换色，
// 拆分表不显示为 0 的行，其余系统提示按插件合并）、计划（有条目才有，可以清空），功能位决定压缩入口，
// 手机上用量从底部弹出，最少插件组合下这些入口都不出现
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

const panel = () => within(screen.getByRole('complementary', { name: '会话面板' }));
const settingRow = (label: string) => within(panel().getByRole('group', { name: label }));

const PLUGINS: FakeRest = {
  '/api/plugins': {
    plugins: [
      { name: '@aalis/plugin-a', instanceId: '@aalis/plugin-a', displayName: '对话代理' },
      { name: '@aalis/plugin-b', instanceId: '@aalis/plugin-b', displayName: '白纸' },
      { name: '@aalis/plugin-c', instanceId: '@aalis/plugin-c', displayName: '跨会话历史' },
      { name: '@aalis/plugin-c', instanceId: '@aalis/plugin-c:two', displayName: '跨会话历史' },
    ],
  },
};

const ROWS: SettingRow[] = [
  row('persona', {
    field: {
      type: 'select',
      label: '人设',
      options: [
        { label: '群聊人设', value: 'group' },
        { label: '私聊人设', value: 'private' },
      ],
    },
    plugin: '@aalis/plugin-a',
    effective: 'group',
    source: 'platform',
  }),
  row('think', {
    field: { type: 'boolean', label: '深度思考' },
    plugin: '@aalis/plugin-a',
    value: true,
    effective: true,
    source: 'session',
  }),
  row('extra', {
    field: { type: 'string', label: '额外提示' },
    plugin: '@aalis/plugin-a',
  }),
  row('maxIterations', {
    field: { type: 'number', label: '最大工具迭代', integer: true, min: 1 },
    plugin: '@aalis/plugin-a',
    prominence: 'advanced',
    effective: 20,
    source: 'defaults',
  }),
  row('roomOnly', {
    field: { type: 'boolean', label: '开启白纸' },
    plugin: '@aalis/plugin-b',
    prominence: 'advanced',
  }),
];

describe('右侧面板与会话头', () => {
  const subscribe = (items = [userMessage('u1', '在吗')]) => ({ 'session/subscribe': () => snapshot(items) });

  it('设置：只列服务端给的行；常用的在前，「高级」默认折叠、按插件分组；每行写生效值与来源，顶部写生效时机', async () => {
    app = await renderApp('/s/s1/settings', { ...subscribe(), 'session/config/get': () => ({ items: ROWS }) }, PLUGINS);
    await panel().findByRole('group', { name: '人设' });
    expect(requests('session/config/get')).toEqual([{ sessionId: 's1' }]);
    expect(panel().getByText('改动从下一轮起生效')).toBeTruthy();
    expect(settingRow('人设').getByText('群聊人设')).toBeTruthy();
    expect(settingRow('人设').getByText('平台档')).toBeTruthy();
    expect(settingRow('深度思考').getByRole('switch', { name: '深度思考' }).getAttribute('aria-checked')).toBe('true');
    expect(settingRow('深度思考').getByText('本会话')).toBeTruthy();
    expect(settingRow('额外提示').getByText('未设置')).toBeTruthy();
    expect(panel().queryByRole('group', { name: '最大工具迭代' })).toBeNull();

    const advanced = panel().getByRole('button', { name: '高级' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    const agent = within(panel().getByRole('region', { name: '对话代理' }));
    expect(within(agent.getByRole('group', { name: '最大工具迭代' })).getByText('20')).toBeTruthy();
    expect(within(agent.getByRole('group', { name: '最大工具迭代' })).getByText('默认')).toBeTruthy();
    expect(within(panel().getByRole('region', { name: '白纸' })).getByRole('group', { name: '开启白纸' })).toBeTruthy();
  });

  it('设置：点行就地修改、改完即存；开关立即存；被本会话覆盖的行有「恢复继承」；写不进去时原因写在行下', async () => {
    let rows = ROWS;
    const updates: unknown[] = [];
    app = await renderApp(
      '/s/s1/settings',
      {
        ...subscribe(),
        'session/config/get': () => ({ items: rows }),
        'session/config/update': params => {
          updates.push(params.patch);
          if ('extra' in params.patch && params.patch.extra === 'bad') {
            throw Object.assign(new Error('额外提示：写不进去'), { code: 'conflict' });
          }
          return { items: rows };
        },
      },
      PLUGINS,
    );
    await panel().findByRole('group', { name: '人设' });

    fireEvent.click(settingRow('额外提示').getByRole('button', { name: /额外提示/ }));
    const text = settingRow('额外提示').getByRole('textbox', { name: '额外提示' });
    expect(document.activeElement).toBe(text);
    fireEvent.change(text, { target: { value: '说话简短些' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    await vi.waitFor(() => expect(updates).toEqual([{ extra: '说话简短些' }]));

    fireEvent.click(settingRow('人设').getByRole('button', { name: /人设/ }));
    fireEvent.change(settingRow('人设').getByRole('combobox', { name: '人设' }), { target: { value: 'private' } });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toEqual({ persona: 'private' });

    fireEvent.click(settingRow('深度思考').getByRole('switch', { name: '深度思考' }));
    await vi.waitFor(() => expect(updates[2]).toEqual({ think: false }));
    expect(settingRow('人设').queryByRole('button', { name: '恢复继承' })).toBeNull();
    fireEvent.click(settingRow('深度思考').getByRole('button', { name: '恢复继承' }));
    await vi.waitFor(() => expect(updates[3]).toEqual({ think: null }));

    fireEvent.click(settingRow('额外提示').getByRole('button', { name: /额外提示/ }));
    const again = settingRow('额外提示').getByRole('textbox', { name: '额外提示' });
    fireEvent.change(again, { target: { value: 'bad' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect((await settingRow('额外提示').findByRole('alert')).textContent).toContain('额外提示：写不进去');

    const cancelled = settingRow('额外提示').getByRole('textbox', { name: '额外提示' });
    fireEvent.change(cancelled, { target: { value: '不要了' } });
    fireEvent.keyDown(cancelled, { key: 'Escape' });
    fireEvent.blur(cancelled);
    expect(settingRow('额外提示').queryByRole('textbox')).toBeNull();

    fireEvent.click(panel().getByRole('button', { name: '高级' }));
    fireEvent.click(settingRow('最大工具迭代').getByRole('button', { name: /最大工具迭代/ }));
    const number = settingRow('最大工具迭代').getByRole('textbox', { name: '最大工具迭代' });
    fireEvent.change(number, { target: { value: '很多' } });
    fireEvent.keyDown(number, { key: 'Enter' });
    expect((await settingRow('最大工具迭代').findByRole('alert')).textContent).toContain('要填一个数');
    fireEvent.change(number, { target: { value: '30' } });
    fireEvent.keyDown(number, { key: 'Enter' });
    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ maxIterations: 30 }));
    expect(updates).toHaveLength(6);

    rows = ROWS.filter(r => r.plugin !== '@aalis/plugin-a');
    act(() => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(panel().queryByRole('group', { name: '人设' })).toBeNull());
    rows = ROWS;
    act(() => server().notify('session/config/changed', {}));
    expect(await panel().findByRole('group', { name: '人设' })).toBeTruthy();
  });

  it('用量：头部百分比在有用量时才出现，达到压缩线换警告色；拆分表不显示为 0 的行，其余系统提示按插件合并，写明压缩线', async () => {
    const data = usage({
      contextWindow: 100_000,
      used: 72_000,
      usageRatio: 0.72,
      compressAt: 0.7,
      breakdown: { history: 30_000, toolDefs: 0, systemOther: 12_000, reservedForReply: 4_000, persona: 0 },
      injectors: {
        '@aalis/plugin-c/history': 5_000,
        '@aalis/plugin-c:two/history': 3_000,
        '@aalis/gone/recall': 1_000,
      },
    });
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot([userMessage('u1', '在吗'), data]) }, PLUGINS);
    const meter = await main().findByRole('button', { name: '上下文已用 72%' });
    expect(meter.dataset.tone).toBe('warning');
    fireEvent.click(meter);
    expect(app.where()).toBe('/s/s1/usage');
    const table = within(panel().getByRole('table', { name: '上下文用量' }));
    const labels = () => table.getAllByRole('rowheader').map(cell => cell.textContent);
    expect(labels()).toEqual(['上下文窗口', '已用', '历史消息', '其余系统提示', '为回复预留']);
    fireEvent.click(table.getByRole('button', { name: '其余系统提示' }));
    await vi.waitFor(() =>
      expect(labels()).toEqual(['上下文窗口', '已用', '历史消息', '其余系统提示', '跨会话历史', '其他', '为回复预留']),
    );
    const plugin = table.getByRole('rowheader', { name: '跨会话历史' }).closest('tr') as HTMLElement;
    expect(plugin.textContent).toContain('8.0k');
    const others = table.getByRole('rowheader', { name: '其他' }).closest('tr') as HTMLElement;
    expect(others.textContent).toContain('4.0k');
    expect(panel().getByText('到 70% 自动压缩')).toBeTruthy();

    act(() =>
      server().notify('item/completed', {
        sessionId: 's1',
        epoch: 'epoch-1',
        seq: 50,
        item: { ...data, usageRatio: 0.3, used: 30_000, compressAt: undefined },
      }),
    );
    expect(main().getByRole('button', { name: '上下文已用 30%' }).dataset.tone).toBeUndefined();
    expect(panel().queryByText(/自动压缩/)).toBeNull();

    act(() =>
      server().notify('item/completed', {
        sessionId: 's1',
        epoch: 'epoch-1',
        seq: 51,
        item: { ...data, contextWindow: 0, usageRatio: 0, compressAt: undefined },
      }),
    );
    expect(table.queryByText(/%/)).toBeNull();
  });

  it('设置：哪一层都没设的项按字段的默认值显示与编辑', async () => {
    const rows = [
      row('mode', {
        field: {
          type: 'select',
          label: '模式',
          default: 'b',
          options: [
            { label: '甲', value: 'a' },
            { label: '乙', value: 'b' },
          ],
        },
      }),
      row('tags', {
        field: {
          type: 'multiselect',
          label: '标签',
          default: ['x'],
          options: [
            { label: '叉', value: 'x' },
            { label: '歪', value: 'y' },
          ],
        },
      }),
      row('note', { field: { type: 'string', label: '备注', default: '<默认备注>' } }),
    ];
    app = await renderApp('/s/s1/settings', {
      ...subscribe(),
      'session/config/get': () => ({ items: rows }),
      'session/config/update': () => ({ items: rows }),
    });
    await panel().findByRole('group', { name: '模式' });
    fireEvent.click(settingRow('模式').getByRole('button', { name: /模式/ }));
    expect((settingRow('模式').getByRole('combobox', { name: '模式' }) as HTMLSelectElement).value).toBe('b');
    fireEvent.click(settingRow('标签').getByRole('button', { name: /标签/ }));
    expect((panel().getByRole('checkbox', { name: '叉' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(panel().getByRole('checkbox', { name: '歪' }));
    await vi.waitFor(() =>
      expect(requests('session/config/update')).toEqual([{ sessionId: 's1', patch: { tags: ['x', 'y'] } }]),
    );
    fireEvent.click(panel().getByRole('button', { name: '完成' }));
    fireEvent.click(settingRow('备注').getByRole('button', { name: /备注/ }));
    expect((settingRow('备注').getByRole('textbox', { name: '备注' }) as HTMLInputElement).value).toBe('<默认备注>');
  });

  it('计划：有条目才有这个标签；可以清空', async () => {
    app = await renderApp('/s/s1/plan', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '在吗'),
          plan([
            { id: 1, title: '读三份草稿', status: 'completed' },
            { id: 2, title: '写模板', status: 'in-progress' },
          ]),
        ]),
      'plan/clear': () => ({}),
    });
    const list = within(await panel().findByRole('list', { name: '计划' }));
    expect(list.getAllByRole('listitem').map(item => item.textContent)).toEqual(['读三份草稿已完成', '写模板进行中']);
    fireEvent.click(panel().getByRole('button', { name: '清空' }));
    await vi.waitFor(() => expect(requests('plan/clear')).toEqual([{ sessionId: 's1' }]));
    act(() => server().notify('item/completed', { sessionId: 's1', epoch: 'epoch-1', seq: 60, item: plan([]) }));
    expect(
      panel()
        .getAllByRole('tab')
        .map(tab => tab.textContent),
    ).toEqual(['设置']);
  });

  it('功能位：压缩入口跟着压缩服务出现或消失，压缩发 session/compress', async () => {
    app = await renderApp('/s/s1', { ...subscribe(), 'session/compress': () => ({}) });
    await main().findByRole('region', { name: '对话' });
    fireEvent.click(main().getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '压缩对话' }));
    await vi.waitFor(() => expect(requests('session/compress')).toEqual([{ sessionId: 's1' }]));
    act(() => server().notify('features/changed', { features: { ...INIT.features, compress: false } }));
    fireEvent.click(main().getByRole('button', { name: '更多' }));
    expect(screen.queryByRole('menuitem', { name: '压缩对话' })).toBeNull();
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['改名', '归档', '删除']);
  });

  it('最少插件组合：没有计划、用量、回滚与压缩时，这些标签与入口都不出现', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([userMessage('u1', '在吗'), turn('t1', { outcome: 'replied' }), toolCall('c1', 'exec')]),
      initialize: () => ({ ...INIT, features: { send: true, rewind: false, compress: false } }),
      'session/config/get': () => ({ items: [] }),
    });
    await main().findByRole('region', { name: '对话' });
    expect(
      panel()
        .getAllByRole('tab')
        .map(tab => tab.textContent),
    ).toEqual(['设置']);
    expect(main().queryByRole('button', { name: /上下文已用/ })).toBeNull();
    expect(main().queryByRole('button', { name: '回滚这一轮' })).toBeNull();
    fireEvent.click(main().getByRole('button', { name: '更多' }));
    expect(screen.queryByRole('menuitem', { name: '压缩对话' })).toBeNull();
    expect(await panel().findByText('这个会话没有可以设置的项')).toBeTruthy();
  });
});

describe('用量打开右侧面板', () => {
  const handlers = {
    'session/subscribe': () => snapshot([userMessage('u1', '在吗'), usage({ breakdown: { history: 10 } })]),
    'session/config/get': () => ({ items: [] }),
  };
  const shell = () => document.querySelector('[data-level]') as HTMLElement;

  it('宽屏上右侧面板收起时，点用量会展开它', async () => {
    stubViewport(1440);
    localStorage.setItem('aalis.panels', JSON.stringify({ left: true, right: false }));
    app = await renderApp('/s/s1', handlers);
    expect(shell().dataset.right).toBe('collapsed');
    fireEvent.click(await main().findByRole('button', { name: '上下文已用 42%' }));
    expect(app.where()).toBe('/s/s1/usage');
    expect(shell().dataset.right).toBeUndefined();
  });

  it('右侧面板是抽屉的宽度上，点用量会打开抽屉', async () => {
    stubViewport(1100);
    app = await renderApp('/s/s1', handlers);
    fireEvent.click(await main().findByRole('button', { name: '上下文已用 42%' }));
    expect(shell().dataset.drawer).toBe('right');
  });
});

describe('手机', () => {
  it('会话头左边是返回，右侧只有用量与「更多」，全部展开与会话面板收进「更多」，标题不被挤掉', async () => {
    stubViewport(390);
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '在吗'), usage({ breakdown: { history: 10 } })]),
      'session/config/get': () => ({ items: [] }),
    });
    await main().findByRole('button', { name: '上下文已用 42%' });
    const header = within(document.querySelector('main .panel-header') as HTMLElement);
    expect(header.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      '返回',
      '上下文已用 42%',
      '更多',
    ]);
    fireEvent.click(header.getByRole('button', { name: '更多' }));
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '全部展开',
      '会话面板',
      '改名',
      '归档',
      '压缩对话',
      '删除',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: '全部展开' }));
    fireEvent.click(header.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('menuitem', { name: '全部折叠' })).toBeTruthy();
  });

  it('用量从底部弹出（/s/:id/usage），关上退回会话、不多留一条历史；会话面板是第三层，「返回」退回会话', async () => {
    stubViewport(390);
    app = await renderApp('/', {
      'sessions/list': lists(params => (params.section === 'owner' ? [summary('s1', { title: '整理周报' })] : [])),
      'session/subscribe': () => snapshot([userMessage('u1', '在吗'), usage({ breakdown: { history: 10 } })]),
      'session/config/get': () => ({ items: [] }),
    });
    fireEvent.click(await screen.findByRole('link', { name: /整理周报/ }));
    fireEvent.click(await main().findByRole('button', { name: '上下文已用 42%' }));
    expect(app.where()).toBe('/s/s1/usage');
    expect((document.querySelector('[data-level]') as HTMLElement).dataset.level).toBe('2');
    const sheet = within(screen.getByRole('dialog', { name: '上下文用量' }));
    expect(sheet.getByRole('table', { name: '上下文用量' })).toBeTruthy();
    fireEvent.click(sheet.getByRole('button', { name: '关闭' }));
    expect(app.where()).toBe('/s/s1');
    app.back();
    expect(app.where()).toBe('/');
    fireEvent.click(await screen.findByRole('link', { name: /整理周报/ }));

    fireEvent.click(await main().findByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '会话面板' }));
    expect(app.where()).toBe('/s/s1/settings');
    expect((document.querySelector('[data-level]') as HTMLElement).dataset.level).toBe('3');
    expect(panel().queryByRole('tab', { name: '用量' })).toBeNull();
    fireEvent.click(panel().getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/s/s1');
    app.back();
    expect(app.where()).toBe('/');
  });
});
