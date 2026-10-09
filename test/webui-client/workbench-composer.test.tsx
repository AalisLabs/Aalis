// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  choose,
  type Harness,
  INIT,
  installDialog,
  lists,
  main,
  optionsOf,
  renderApp,
  requests,
  server,
  summary,
} from './harness.js';
import { row, snapshot, turn, userMessage } from './items.js';

// ════════════════════════════════════════════════════════════
// 输入框：Enter 发送、Shift+Enter 换行，输入法组字的回车（isComposing 与 keyCode 229）不发送，触屏上回车换行、按钮发送；
// 附件一律接收，只有附件也能发；首页的新会话先建会话再发；没有对话服务时不可用并写明原因；正在跑时发送键换成停止；
// 左侧是 composer 档设置项的快捷切换，改了即存，收到 session/config/changed 重取
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

const input = () => main().getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

const MODELS = {
  providers: [
    { model: 'alpha', provider: '服务甲', contextId: '@aalis/llm-a', capabilities: [] },
    { model: 'beta', provider: '服务甲', contextId: '@aalis/llm-a', capabilities: [] },
  ],
};

describe('输入框', () => {
  const session = { 'session/subscribe': () => snapshot([userMessage('u1', '在吗')]), 'turn/send': () => ({}) };

  it('Enter 发送、Shift+Enter 不发送；输入法组字时的回车（isComposing 与 keyCode 229）不发送', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', session);
    await main().findByRole('region', { name: '对话' });
    type('第一句');
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(requests('turn/send')).toEqual([]);
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    await vi.waitFor(() =>
      expect(requests('turn/send')).toEqual([{ sessionId: 's1', content: '第一句', attachments: [] }]),
    );
    await vi.waitFor(() => expect(input().value).toBe(''));
  });

  it('触屏上回车换行，用按钮发送', async () => {
    stubViewport(390, { coarse: true });
    app = await renderApp('/s/s1', session);
    await main().findByRole('region', { name: '对话' });
    type('第二句');
    expect(fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 })).toBe(true);
    expect(requests('turn/send')).toEqual([]);
    fireEvent.click(main().getByRole('button', { name: '发送' }));
    await vi.waitFor(() =>
      expect(requests('turn/send')).toEqual([{ sessionId: 's1', content: '第二句', attachments: [] }]),
    );
  });

  it('附件一律接收：只有附件也能发，随 turn/send 以 data URL 发出；可以移除', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', session);
    await main().findByRole('region', { name: '对话' });
    const send = main().getByRole('button', { name: '发送' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['hello'], 'note.txt', { type: 'text/plain' }),
      new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', { type: 'image/png' }),
    ];
    fireEvent.change(picker, { target: { files } });
    const attached = within(await main().findByRole('list', { name: '附件' }));
    await vi.waitFor(() => expect(attached.getAllByRole('listitem')).toHaveLength(2));
    fireEvent.click(attached.getByRole('button', { name: '移除 note.txt' }));
    expect(attached.getAllByRole('listitem')).toHaveLength(1);
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await vi.waitFor(() => expect(requests('turn/send')).toHaveLength(1));
    expect(requests('turn/send')[0]).toEqual({
      sessionId: 's1',
      content: '',
      attachments: [
        { kind: 'image', name: 'pic.png', mimeType: 'image/png', byteSize: 4, data: 'data:image/png;base64,iVBORw==' },
      ],
    });
  });

  it('发送在途时接着打的字与新加的附件，回应到了也不清掉；清掉的只是发出去的', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot([userMessage('u1', '在吗')]) });
    await main().findByRole('region', { name: '对话' });
    type('第一句');
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    await vi.waitFor(() => expect(requests('turn/send')).toHaveLength(1));
    type('第二句');
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(['hello'], 'note.txt', { type: 'text/plain' })] } });
    await main().findByRole('list', { name: '附件' });
    act(() => server().reply('turn/send', {}));
    await vi.waitFor(() => expect(main().getByRole('button', { name: '发送' }).getAttribute('aria-busy')).toBeNull());
    expect(input().value).toBe('第二句');
    expect(within(main().getByRole('list', { name: '附件' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('附件合计超过上限时写明原因，这次选的不加上', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', session);
    await main().findByRole('region', { name: '对话' });
    const big = new File(['x'], 'huge.bin');
    Object.defineProperty(big, 'size', { value: 65 * 1024 * 1024 });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [big] } });
    expect(main().getByRole('alert').textContent).toContain('64 MB');
    expect(main().queryByRole('list', { name: '附件' })).toBeNull();
  });

  it('首页的新会话：先建会话再发消息，然后打开它', async () => {
    stubViewport(1440);
    app = await renderApp('/', {
      'session/create': () => ({ session: summary('fresh', { title: '新会话' }) }),
      'turn/send': () => ({}),
    });
    type('帮我查一下');
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    await vi.waitFor(() => expect(app?.where()).toBe('/s/fresh'));
    expect(requests('session/create')).toEqual([{}]);
    expect(requests('turn/send')).toEqual([{ sessionId: 'fresh', content: '帮我查一下', attachments: [] }]);
  });

  it('新会话建好了、消息没发出去时，再发用同一个会话，不另建', async () => {
    stubViewport(1440);
    let accept = false;
    app = await renderApp('/', {
      'session/create': () => ({ session: summary('fresh', { title: '新会话' }) }),
      'turn/send': () => {
        if (!accept) throw new Error('网关没收下');
        return {};
      },
    });
    type('帮我查一下');
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    expect((await main().findByRole('alert')).textContent).toContain('网关没收下');
    expect(input().value).toBe('帮我查一下');
    accept = true;
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    await vi.waitFor(() => expect(app?.where()).toBe('/s/fresh'));
    expect(requests('session/create')).toHaveLength(1);
    expect(requests('turn/send')).toHaveLength(2);
  });

  it('没有对话服务时输入框不可用并写明原因，服务回来后恢复', async () => {
    stubViewport(1440);
    app = await renderApp('/', {});
    act(() => server().notify('features/changed', { features: { ...INIT.features, send: false } }));
    expect(input().disabled).toBe(true);
    expect(main().getByText('没有对话服务，暂时不能发消息')).toBeTruthy();
    act(() => server().notify('features/changed', { features: INIT.features }));
    expect(input().disabled).toBe(false);
  });

  it('正在跑的回合：发送键换成停止，停止带这一轮的 turnId；发新消息照常可以', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '跑一下'), turn('t5')], { session: { running: true } }),
      'turn/abort': () => ({}),
    });
    await main().findByRole('region', { name: '对话' });
    expect(main().queryByRole('button', { name: '发送' })).toBeNull();
    const stop = main().getByRole('button', { name: '停止' });
    // 实心方块单独看像个勾选框：停止用带圆圈的停止图标
    expect(stop.querySelector('svg.lucide-circle-stop')).toBeTruthy();
    fireEvent.click(stop);
    await vi.waitFor(() => expect(requests('turn/abort')).toEqual([{ sessionId: 's1', turnId: 't5' }]));
    type('换个方向');
    expect(main().getByRole('button', { name: '发送' })).toBeTruthy();
  });

  it('输入框旁是 composer 档设置项的快捷切换：只显示生效值，名字在读屏标签与悬停提示里；改了即存；收到 session/config/changed 重取', async () => {
    stubViewport(1440);
    let rows = [
      row('llm', {
        field: { type: 'llm-ref', label: '模型' },
        prominence: 'composer',
        effective: { provider: '@aalis/llm-a', model: 'alpha' },
        source: 'defaults',
      }),
      row('zz-flag', { field: { type: 'boolean', label: '开关项' }, prominence: 'common' }),
    ];
    app = await renderApp(
      '/s/s1',
      {
        ...session,
        'session/config/get': () => ({ items: rows }),
        'session/config/update': () => ({ items: rows }),
      },
      { '/api/models/llm': MODELS },
    );
    const model = await main().findByRole('combobox', { name: '模型' });
    await vi.waitFor(() => expect(model.textContent).toBe('alpha'));
    expect(model.title).toBe('模型');
    expect(main().queryByRole('combobox', { name: '开关项' })).toBeNull();
    choose(model, 'beta');
    await vi.waitFor(() =>
      expect(requests('session/config/update')).toEqual([
        { sessionId: 's1', patch: { llm: { provider: '@aalis/llm-a', model: 'beta' } } },
      ]),
    );

    rows = [rows[1]];
    act(() => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(main().queryByRole('combobox', { name: '模型' })).toBeNull());
  });

  it('快捷切换里可选项依赖另一项的，带上那一项的生效值去取，它变了就重取', async () => {
    stubViewport(1440);
    const levels = (name: string) =>
      `/api/models/llm-thinking?dependency=${encodeURIComponent(JSON.stringify({ provider: '@aalis/llm-a', model: name }))}`;
    const rowsFor = (name: string) => [
      row('llm', {
        field: { type: 'llm-ref', label: '模型' },
        prominence: 'composer',
        effective: { provider: '@aalis/llm-a', model: name },
        source: 'defaults',
      }),
      row('think', {
        field: { type: 'select', label: '深度思考', dynamicOptions: 'llm-thinking' },
        prominence: 'composer',
        dependsOn: 'llm',
      }),
    ];
    let rows = rowsFor('alpha');
    app = await renderApp(
      '/s/s1',
      { ...session, 'session/config/get': () => ({ items: rows }) },
      {
        '/api/models/llm': MODELS,
        [levels('alpha')]: { details: [{ value: 'deep', label: '深', default: true }] },
        [levels('beta')]: { details: [{ value: 'light', label: '浅' }] },
      },
    );
    const think = () => main().getByRole('combobox', { name: '深度思考' });
    await vi.waitFor(() => expect(optionsOf(think())).toEqual(['深（默认）']));
    expect(think().textContent).toBe('深（默认）');
    rows = rowsFor('beta');
    act(() => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(optionsOf(think())).toEqual(['浅']));
  });

  it('快捷切换的可选项没取到时写明原因；哪一层都没设的项按字段的默认值显示', async () => {
    stubViewport(1440);
    const rows = [
      row('llm', {
        field: { type: 'llm-ref', label: '模型' },
        prominence: 'composer',
        effective: { provider: '@aalis/llm-a', model: 'alpha' },
        source: 'defaults',
      }),
      row('extra', { field: { type: 'string', label: '额外提示', default: '<默认提示>' }, prominence: 'composer' }),
    ];
    app = await renderApp(
      '/s/s1',
      { ...session, 'session/config/get': () => ({ items: rows }) },
      { '/api/models/llm': () => Response.json({ error: '模型服务不在' }, { status: 503 }) },
    );
    const model = await main().findByRole('combobox', { name: '模型' });
    await vi.waitFor(() => expect(model.title).toContain('可选项没取到'));
    fireEvent.click(model);
    expect(screen.getByRole('option', { name: /可选项没取到/ }).getAttribute('aria-disabled')).toBe('true');
    const extra = main().getByRole('link', { name: '额外提示：<默认提示>' });
    expect([extra.textContent, extra.title]).toEqual(['<默认提示>', '额外提示：<默认提示>']);
  });

  it('快捷切换里不能就地选的项按可选项的标签显示；没设又没有默认值的写登记方给的「没设时」，都没有才写名字', async () => {
    stubViewport(1440);
    const rows = [
      row('groups', {
        field: { type: 'multiselect', label: '工具分组', dynamicOptions: 'toolGroups' },
        prominence: 'composer',
        effective: ['*'],
        source: 'defaults',
      }),
      row('note', { field: { type: 'string', label: '备注' }, prominence: 'composer' }),
      row('limit', { field: { type: 'number', label: '上限' }, prominence: 'composer', unset: '<不限>' }),
    ];
    app = await renderApp(
      '/s/s1',
      { ...session, 'session/config/get': () => ({ items: rows }) },
      { '/api/models/toolGroups': { details: [{ value: '*', label: '全部分组' }] } },
    );
    expect((await main().findByRole('link', { name: '工具分组：全部分组' })).textContent).toBe('全部分组');
    expect(main().getByRole('link', { name: '备注' }).textContent).toBe('备注');
    expect(main().getByRole('link', { name: '上限：<不限>' }).textContent).toBe('<不限>');
  });

  it('草稿按会话存在本浏览器：切会话、刷新后还在，发出去就清掉；首页的新会话也一样', async () => {
    stubViewport(1440);
    const mine = [summary('s1', { title: '甲' }), summary('s2', { title: '乙' })];
    const handlers = {
      ...session,
      'sessions/list': lists(params => (params.section === 'owner' ? mine : [])),
      'session/create': () => ({ session: summary('s3') }),
    };
    app = await renderApp('/s/s1', handlers);
    await main().findByRole('region', { name: '对话' });
    type('给甲的半句话');
    fireEvent.click(await screen.findByRole('link', { name: /乙/ }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s2'));
    expect(input().value).toBe('');
    type('给乙的');
    fireEvent.click(screen.getByRole('link', { name: /甲/ }));
    await vi.waitFor(() => expect(input().value).toBe('给甲的半句话'));

    app.close();
    app = await renderApp('/s/s2', handlers);
    await main().findByRole('region', { name: '对话' });
    expect(input().value).toBe('给乙的');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await vi.waitFor(() => expect(input().value).toBe(''));
    app.close();
    app = await renderApp('/s/s2', handlers);
    await main().findByRole('region', { name: '对话' });
    expect(input().value).toBe('');

    app.close();
    app = await renderApp('/', handlers);
    type('新会话的开头');
    app.close();
    app = await renderApp('/', handlers);
    expect(input().value).toBe('新会话的开头');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s3'));
    app.close();
    app = await renderApp('/', handlers);
    expect(input().value).toBe('');
  });

  it('发送在途时切到别的会话，回应到了以后切回来，输入框是空的：发出去的不当草稿留着', async () => {
    stubViewport(1440);
    const mine = [summary('s1', { title: '甲' }), summary('s2', { title: '乙' })];
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '在吗')]),
      'sessions/list': lists(params => (params.section === 'owner' ? mine : [])),
    });
    await main().findByRole('region', { name: '对话' });
    type('发出去的话');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await vi.waitFor(() => expect(requests('turn/send')).toHaveLength(1));
    fireEvent.click(await screen.findByRole('link', { name: /乙/ }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s2'));
    await act(async () => server().reply('turn/send', {}));
    fireEvent.click(screen.getByRole('link', { name: /甲/ }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s1'));
    await main().findByRole('region', { name: '对话' });
    expect(input().value).toBe('');
  });

  it('打开存着草稿的会话不算改过：草稿的先后不因打开而变', async () => {
    stubViewport(1440);
    localStorage.setItem('aalis.drafts', JSON.stringify({ s1: { text: '存着的半句', at: 1 } }));
    app = await renderApp('/s/s1', session);
    await main().findByRole('region', { name: '对话' });
    expect(input().value).toBe('存着的半句');
    expect(JSON.parse(localStorage.getItem('aalis.drafts') ?? '{}')).toEqual({ s1: { text: '存着的半句', at: 1 } });
  });

  it('浏览器存储不可用时输入框照常能打字、发送', async () => {
    stubViewport(1440);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('存储被禁用');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('存储被禁用');
    });
    app = await renderApp('/s/s1', session);
    await main().findByRole('region', { name: '对话' });
    type('照常');
    expect(input().value).toBe('照常');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await vi.waitFor(() =>
      expect(requests('turn/send')).toEqual([{ sessionId: 's1', content: '照常', attachments: [] }]),
    );
  });

  it('文件拖到会话里就成为附件，与附件按钮同一条路；拖着时输入框标出能放下', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', session);
    const log = await main().findByRole('region', { name: '对话' });
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const dataTransfer = { types: ['Files'], files: [file] };
    const form = main().getByRole('form', { name: '发消息' });
    fireEvent.dragOver(log, { dataTransfer });
    expect(form.hasAttribute('data-dropping')).toBe(true);
    fireEvent.drop(log, { dataTransfer });
    expect(form.hasAttribute('data-dropping')).toBe(false);
    const attachments = await main().findByRole('list', { name: '附件' });
    expect(within(attachments).getByText('note.txt')).toBeTruthy();
    await vi.waitFor(() =>
      expect((main().getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(main().getByRole('button', { name: '发送' }));
    await vi.waitFor(() => expect(requests('turn/send')).toHaveLength(1));
    expect((requests('turn/send')[0] as { attachments: unknown[] }).attachments).toEqual([
      expect.objectContaining({ kind: 'file', name: 'note.txt', mimeType: 'text/plain' }),
    ]);

    // 拖的不是文件（选中的文字）：不拦
    const text = fireEvent.dragOver(log, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(text).toBe(true);
    expect(form.hasAttribute('data-dropping')).toBe(false);
  });

  it('不能用时拖进来的文件照样拦下（浏览器不离开页面去打开它），不加附件、不标能放下；拖着时变得不能用，标记随之撤掉', async () => {
    stubViewport(1440);
    app = await renderApp('/s/s1', session);
    const log = await main().findByRole('region', { name: '对话' });
    const dataTransfer = { types: ['Files'], files: [new File(['hello'], 'note.txt', { type: 'text/plain' })] };
    const form = main().getByRole('form', { name: '发消息' });
    fireEvent.dragOver(log, { dataTransfer });
    expect(form.hasAttribute('data-dropping')).toBe(true);
    act(() => server().notify('features/changed', { features: { ...INIT.features, send: false } }));
    expect(form.hasAttribute('data-dropping')).toBe(false);
    expect(fireEvent.dragOver(log, { dataTransfer })).toBe(false);
    expect(form.hasAttribute('data-dropping')).toBe(false);
    expect(fireEvent.drop(log, { dataTransfer })).toBe(false);
    expect(main().queryByRole('list', { name: '附件' })).toBeNull();
  });
});
