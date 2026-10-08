// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTask, SessionItem, SessionSummary } from '../../packages/api-session-protocol/src/index.js';
import { DEFAULT_PAGE_URL, setPageUrl, stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type Harness,
  installDialog,
  lists,
  main,
  renderApp,
  requests,
  restCalls,
  server,
  summary,
} from './harness.js';
import { AT, backgroundTask, pushTasks, snapshot, toolCall, turn, userMessage } from './items.js';
import { hostTab, layoutStore } from './pages.js';

// ════════════════════════════════════════════════════════════
// 后台任务：会话面板的「后台」标签（子会话的树与这个会话的工具调用两组，在跑的在前、结束的收进「已结束」，日志、停止与
// 全部停止，只画登记表里的状态）、时间线里转了后台的工具卡、会话头部的「后台 N」（手机上在「更多」里、「更多」上一个点）、
// 子会话页顶部的路径、最后一行里的本机网址；重连后重新 watch 与取列表，没有后台任务登记时按没有任务
// ════════════════════════════════════════════════════════════

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(AT + 63_000);
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
const tabs = () =>
  panel()
    .queryAllByRole('tab')
    .map(tab => tab.textContent);
/** 一行任务或子会话所在的 li */
const rowOf = (element: HTMLElement) => element.closest('li') as HTMLElement;
/** 时间线里一张工具卡 */
const cardOf = (element: HTMLElement) => element.closest('.tool-call') as HTMLElement;

const DEV = backgroundTask('t-dev', {
  display: { kind: 'command', command: 'npm run dev', cwd: '/home/me/code/app' },
  lastLine: 'VITE ready in 300 ms',
  lastOutputAt: AT + 60_000,
});

const config = { 'session/config/get': () => ({ items: [] }) };

interface Setup {
  session?: Partial<SessionSummary>;
  tasks?: BackgroundTask[];
  items?: SessionItem[];
  children?: Record<string, SessionSummary[]>;
  output?: (params: { taskId: string; after?: number }) => { text: string; end: number; truncated: boolean };
}

function handlers({ session, tasks = [], items = [userMessage('u1', '在吗')], children = {}, output }: Setup) {
  return {
    'session/subscribe': () => snapshot(items, { session }),
    'sessions/list': lists(p => (p.parentId ? (children[p.parentId] ?? []) : [])),
    'background/list': () => ({ tasks }),
    'background/stop': () => ({}),
    'background/stopAll': () => ({}),
    'turn/abort': () => ({}),
    ...(output ? { 'background/output': output } : {}),
    ...config,
  };
}

/** 把时钟拨到 AT 之后 ms，让走着的耗时按它重画一次（假时钟另随真实时间走，画面要在拨钟之后才可比） */
async function clockAt(ms: number) {
  vi.setSystemTime(AT + ms - 1000);
  await act(() => vi.advanceTimersByTimeAsync(1000));
}

/** 等后台任务的列表取回来、画完 */
async function loaded() {
  await vi.waitFor(() => expect(requests('background/list')).toHaveLength(1));
  await act(async () => {});
}

describe('「后台」标签', () => {
  it.each([
    ['没有子会话也没有后台任务：不可用', {}, [], false],
    ['别的会话的任务不算：不可用', {}, [backgroundTask('x', { sessionId: 's2' })], false],
    ['本会话有结束的任务：可用', {}, [backgroundTask('a', { status: 'completed', endedAt: AT + 1000 })], true],
    ['有子会话：可用', { childCount: 1 }, [], true],
  ])('%s', async (_name, session, tasks, available) => {
    app = await renderApp('/s/s1', handlers({ session, tasks }));
    await panel().findByRole('tab', { name: '设置' });
    await loaded();
    expect(tabs().includes('后台')).toBe(available);
    expect(panel().queryByRole('button', { name: '打开标签' })).toBeNull();
  });

  it('子会话按会话树列出，工具调用列这个会话的任务；组头带数目，在跑的在前，结束的收进默认折叠的「已结束」（刚建还没开始的不算），非零退出码标红', async () => {
    const children = {
      s1: [
        summary('c-run', { title: '子任务一', kind: 'task', parentId: 's1', running: true, childCount: 1 }),
        summary('c-done', {
          title: '做完的子任务',
          kind: 'task',
          parentId: 's1',
          createdAt: AT,
          lastTurn: { outcome: 'replied', endedAt: AT + 125_000 },
          tokens: { input: 1000, output: 234 },
        }),
        summary('c-error', {
          title: '出错的子任务',
          kind: 'task',
          parentId: 's1',
          error: true,
          reason: '模型服务返回 500',
          lastTurn: { outcome: 'error', endedAt: AT + 2000 },
        }),
        summary('c-new', { title: '刚建的子任务', kind: 'task', parentId: 's1' }),
        summary('c-stopped', {
          title: '停掉的子任务',
          kind: 'task',
          parentId: 's1',
          lastTurn: { outcome: 'aborted', endedAt: AT + 1000 },
        }),
      ],
      'c-run': [
        summary('g', {
          title: '孙任务',
          kind: 'task',
          parentId: 'c-run',
          lastTurn: { outcome: 'replied', endedAt: AT },
        }),
      ],
    };
    const tasks = [
      backgroundTask('t-fail', {
        exitCode: 2,
        display: { kind: 'command', command: 'make test' },
        status: 'failed',
        endedAt: AT + 3000,
      }),
      DEV,
      backgroundTask('t-done', { label: 'http_download', status: 'completed', endedAt: AT + 5000 }),
      backgroundTask('t-stopped', { label: 'pdf_convert', status: 'stopped', endedAt: AT + 1000 }),
      backgroundTask('t-other', { sessionId: 's2', label: 'draw_image' }),
    ];
    app = await renderApp('/s/s1/background', handlers({ session: { childCount: 5 }, tasks, children }));
    const sessions = await panel().findByRole('region', { name: '子会话 · 5' });
    const calls = panel().getByRole('region', { name: '工具调用 · 4' });
    expect(sessions.compareDocumentPosition(calls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const running = await within(sessions).findByRole('link', { name: /子任务一/ });
    expect(running.textContent).toContain('运行中');
    expect(await within(rowOf(running)).findByRole('link', { name: /孙任务/ })).toBeTruthy();
    // 刚建、还没开始的不算结束，跟在在跑的后面
    const fresh = within(sessions).getByRole('link', { name: /刚建的子任务/ });
    expect(running.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sessions).queryByRole('link', { name: /做完的子任务/ })).toBeNull();
    const endedSessions = within(sessions).getByRole('button', { name: '已结束 · 3' });
    expect(endedSessions.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(endedSessions);
    const done = within(sessions).getByRole('link', { name: /做完的子任务/ });
    expect(done.textContent).toContain('完成');
    expect(done.textContent).toContain('2 分 5 秒');
    expect(done.textContent).toContain('1.2k token');
    const failed = within(sessions).getByRole('link', { name: /出错的子任务/ });
    expect(failed.textContent).toContain('模型服务返回 500');
    expect(failed.querySelector('.status-text')?.getAttribute('data-state')).toBe('error');
    expect(within(sessions).getByRole('link', { name: /停掉的子任务/ }).textContent).toContain('已停止');

    expect(within(calls).getByText('npm run dev')).toBeTruthy();
    expect(within(calls).queryByText('make test')).toBeNull();
    expect(within(calls).queryByText('draw_image')).toBeNull();
    fireEvent.click(within(calls).getByRole('button', { name: '已结束 · 3' }));
    const ended = within(calls).getAllByRole('listitem');
    expect(ended.map(row => row.querySelector('.task-name, .task-command')?.textContent)).toEqual([
      'npm run dev',
      'http_download',
      'make test',
      'pdf_convert',
    ]);
    const exit = within(rowOf(within(calls).getByText('make test'))).getByText(/退出码 2/);
    expect(exit.closest('.status-text')?.getAttribute('data-state')).toBe('error');
    expect(rowOf(within(calls).getByText('pdf_convert')).textContent).toContain('已停止');
  });

  it('失败与中断的行写一句原因', async () => {
    const tasks = [
      backgroundTask('t-error', { label: 'http_download', status: 'failed', endedAt: AT + 2000, reason: '连接被拒绝' }),
      backgroundTask('t-restart', {
        label: 'draw_image',
        status: 'aborted',
        endedAt: AT + 1000,
        reason: 'Aalis 重启时还在跑',
      }),
    ];
    app = await renderApp('/s/s1/background', handlers({ tasks }));
    fireEvent.click(await panel().findByRole('button', { name: '已结束 · 2' }));
    const row = (name: string) => rowOf(panel().getByText(name));
    expect(row('http_download').textContent).toContain('失败');
    expect(within(row('http_download')).getByText('连接被拒绝').getAttribute('data-status')).toBe('failed');
    expect(row('draw_image').textContent).toContain('已中断');
    expect(row('draw_image').textContent).toContain('Aalis 重启时还在跑');
  });

  it('命令行：等宽单行、过长时中间省略，悬停与点开看全；工作目录写最后两级；在跑的耗时实时走；别的种类写工具名', async () => {
    const command = 'npm run build -- --watch --mode production --config packages/web/vite.config.ts';
    const tasks = [
      backgroundTask('t-long', { display: { kind: 'command', command, cwd: '/Users/me/code/app/packages/web' } }),
      backgroundTask('t-image', { label: 'analyze_image' }),
    ];
    app = await renderApp('/s/s1/background', handlers({ tasks }));
    const line = await panel().findByRole('button', { name: command });
    await clockAt(63_000);
    expect(line.getAttribute('title')).toBe(command);
    const [head, tail] = [...line.children].map(part => part.textContent ?? '');
    expect(head + tail).toBe(command);
    expect(tail.length).toBeGreaterThan(0);
    expect(head.length).toBeGreaterThan(0);
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(line.children).toHaveLength(0);
    expect(line.textContent).toBe(command);

    const row = rowOf(line);
    expect(within(row).getByText('…/packages/web').getAttribute('title')).toBe('/Users/me/code/app/packages/web');
    expect(row.textContent).toContain('1 分 3 秒');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(row.textContent).toContain('1 分 5 秒');
    expect(rowOf(panel().getByText('analyze_image')).textContent).toContain('1 分 5 秒');
  });

  it('最后一行里的本机网址：页面经回环地址打开时给「打开」链接，否则只显示地址', async () => {
    const task = backgroundTask('t-dev', { lastLine: '  ➜  Local:   http://localhost:5173/app ' });
    app = await renderApp('/s/s1/background', handlers({ tasks: [task] }));
    const link = await panel().findByRole('link', { name: '打开' });
    expect(link.getAttribute('href')).toBe('http://localhost:5173/app');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    app.close();

    setPageUrl('http://192.168.1.5:3000/');
    try {
      FakeWebSocket.install();
      app = await renderApp('/s/s1/background', handlers({ tasks: [task] }));
      expect(await panel().findByText(/http:\/\/localhost:5173\/app/)).toBeTruthy();
      expect(panel().queryByRole('link', { name: '打开' })).toBeNull();
    } finally {
      setPageUrl(DEFAULT_PAGE_URL);
    }
  });

  it('停止不弹确认，推送到来之前状态不变；停后按推送标「已停止」、收进「已结束」', async () => {
    app = await renderApp('/s/s1/background', handlers({ tasks: [DEV] }));
    fireEvent.click(await panel().findByRole('button', { name: '停止「npm run dev」' }));
    await vi.waitFor(() => expect(requests('background/stop')).toEqual([{ taskId: 't-dev' }]));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    const row = rowOf(panel().getByText('npm run dev'));
    expect(row.querySelector('.status-text')?.getAttribute('data-state')).toBe('running');
    expect(row.textContent).not.toContain('已停止');
    expect(within(row).getByRole('button', { name: '停止「npm run dev」' })).toBeTruthy();

    act(() => pushTasks([{ ...DEV, status: 'stopped', endedAt: AT + 62_000 }]));
    expect(panel().queryByText('npm run dev')).toBeNull();
    fireEvent.click(panel().getByRole('button', { name: '已结束 · 1' }));
    expect(rowOf(panel().getByText('npm run dev')).textContent).toContain('已停止');
    expect(panel().queryByRole('button', { name: '停止「npm run dev」' })).toBeNull();
  });

  it('「全部停止」只在有在跑的后台工作时出现，调 background/stopAll；子会话的「停止」停它的回合并对它全部停止，点行打开子会话', async () => {
    const children = { s1: [summary('c-run', { title: '子任务一', kind: 'task', parentId: 's1', running: true })] };
    app = await renderApp(
      '/s/s1/background',
      handlers({ session: { childCount: 1, background: 2 }, tasks: [DEV], children }),
    );
    fireEvent.click(await panel().findByRole('button', { name: '全部停止' }));
    await vi.waitFor(() => expect(requests('background/stopAll')).toEqual([{ sessionId: 's1' }]));

    fireEvent.click(await panel().findByRole('button', { name: '停止「子任务一」' }));
    await vi.waitFor(() => expect(requests('turn/abort')).toEqual([{ sessionId: 'c-run' }]));
    await vi.waitFor(() =>
      expect(requests('background/stopAll')).toEqual([{ sessionId: 's1' }, { sessionId: 'c-run' }]),
    );

    act(() =>
      server().notify('sessions/changed', {
        upserts: [summary('s1', { title: '整理周报', childCount: 1 })],
        removes: [],
        groups: [],
      }),
    );
    expect(panel().queryByRole('button', { name: '全部停止' })).toBeNull();
    fireEvent.click(panel().getByRole('link', { name: /子任务一/ }));
    expect(app.where()).toBe('/s/c-run');
  });

  it('输出：在标签里打开日志，取新增的接在后面，可复制；最新的在底部跟着走；超出缓冲时写明前面的已丢弃、取回的换掉旧的；回到列表', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    const outputs = [
      { text: 'line1\nline2\n', end: 70_000, truncated: true },
      { text: 'line3\n', end: 70_006, truncated: false },
      { text: 'line9\n', end: 200_000, truncated: true },
    ];
    const asked: Array<{ taskId: string; after?: number }> = [];
    app = await renderApp(
      '/s/s1/background',
      handlers({
        tasks: [DEV],
        output: params => {
          asked.push(params);
          return outputs[asked.length - 1];
        },
      }),
    );
    fireEvent.click(await panel().findByRole('button', { name: '输出「npm run dev」' }));
    const log = await panel().findByText('line1 line2', { normalizer: text => text.trim().replace(/\s+/g, ' ') });
    expect(panel().getByText('前面的输出已丢弃，只留着最后一段')).toBeTruthy();
    expect(log.parentElement?.getAttribute('data-anchor')).toBe('end');
    expect(asked).toEqual([{ taskId: 't-dev' }]);

    act(() => pushTasks([{ ...DEV, lastLine: 'line3', lastOutputAt: AT + 62_000 }]));
    await vi.waitFor(() => expect(log.textContent).toBe('line1\nline2\nline3\n'));
    expect(asked).toEqual([{ taskId: 't-dev' }, { taskId: 't-dev', after: 70_000 }]);

    fireEvent.click(panel().getByRole('button', { name: '复制输出' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('line1\nline2\nline3\n'));

    // 又过了很久才取：前面的已不在缓冲里，取回来的是缓冲的全部，换掉而不是接上
    act(() => pushTasks([{ ...DEV, lastLine: 'line9', lastOutputAt: AT + 63_000 }]));
    await vi.waitFor(() => expect(log.textContent).toBe('line9\n'));
    expect(asked.at(-1)).toEqual({ taskId: 't-dev', after: 70_006 });

    fireEvent.click(panel().getByRole('button', { name: '回到列表' }));
    expect(panel().queryByText('line1', { exact: false })).toBeNull();
    expect(panel().getByRole('region', { name: '工具调用 · 1' })).toBeTruthy();
  });

  it('日志开着时换看另一个任务：从头取它的输出，不接着上一个的', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    const build = { kind: 'command' as const, command: 'npm run build' };
    const asked: Array<{ taskId: string; after?: number }> = [];
    app = await renderApp(
      '/s/s1',
      handlers({
        tasks: [DEV, backgroundTask('t-build', { display: build })],
        items: [
          toolCall('call-t-dev', 'exec', { taskId: 't-dev', display: { kind: 'command', command: 'npm run dev' } }),
          toolCall('call-t-build', 'exec', { taskId: 't-build', display: build }),
        ],
        output: params => {
          asked.push(params);
          return params.taskId === 't-dev'
            ? { text: 'dev output\n', end: 5000, truncated: false }
            : { text: 'build output\n', end: 13, truncated: false };
        },
      }),
    );
    fireEvent.click(await main().findByRole('button', { name: '输出「npm run dev」' }));
    await panel().findByText('dev output');
    fireEvent.click(main().getByRole('button', { name: '输出「npm run build」' }));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toEqual({ taskId: 't-build' });
    expect((await panel().findByText('build output')).textContent).toBe('build output\n');
    fireEvent.click(panel().getByRole('button', { name: '复制输出' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('build output\n'));
  });

  it('剪贴板不可用（不是安全上下文）时没有复制按钮', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    vi.stubGlobal('isSecureContext', false);
    app = await renderApp(
      '/s/s1/background',
      handlers({ tasks: [DEV], output: () => ({ text: 'line1\n', end: 6, truncated: false }) }),
    );
    fireEvent.click(await panel().findByRole('button', { name: '输出「npm run dev」' }));
    await panel().findByText('line1');
    expect(panel().queryByRole('button', { name: '复制输出' })).toBeNull();
  });

  it('手机：日志从底部全屏弹出，关上回到标签', async () => {
    stubViewport(390);
    app = await renderApp(
      '/s/s1/background',
      handlers({ tasks: [DEV], output: () => ({ text: 'line1\n', end: 6, truncated: false }) }),
    );
    fireEvent.click(await panel().findByRole('button', { name: '输出「npm run dev」' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'npm run dev' }));
    expect(await sheet.findByText('line1')).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('data-size')).toBe('full');
    fireEvent.click(sheet.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.where()).toBe('/s/s1/background');
  });

  it('后台任务没取到时写明原因，可以重试；没有后台任务登记（unsupported）时按没有任务', async () => {
    let fail = true;
    app = await renderApp('/s/s1/background', {
      ...handlers({ session: { childCount: 1 } }),
      'background/list': () => {
        if (fail) throw new Error('登记表读不出');
        return { tasks: [DEV] };
      },
    });
    const alert = await panel().findByRole('alert');
    expect(alert.textContent).toContain('登记表读不出');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await panel().findByText('npm run dev')).toBeTruthy();
    app.close();

    FakeWebSocket.install();
    app = await renderApp('/s/s1/background', {
      ...handlers({
        session: { childCount: 1 },
        items: [toolCall('call-t-dev', 'exec', { taskId: 't-dev', durationMs: 1200 })],
      }),
      'background/list': () => {
        throw Object.assign(new Error('没有后台任务登记'), { code: 'unsupported' });
      },
    });
    await panel().findByRole('region', { name: '子会话 · 1' });
    await loaded();
    expect(panel().queryByRole('alert')).toBeNull();
    expect(panel().queryByRole('region', { name: /^工具调用/ })).toBeNull();
    expect(main().getByRole('button', { name: /调用 exec/ }).textContent).toContain('1.2 秒');
  });

  it('后台任务没取到时标签照样可用，写明原因', async () => {
    app = await renderApp('/s/s1', {
      ...handlers({}),
      'background/list': () => {
        throw new Error('登记表读不出');
      },
    });
    fireEvent.click(await panel().findByRole('tab', { name: '后台' }));
    expect((await panel().findByRole('alert')).textContent).toContain('登记表读不出');
  });

  it('取列表途中推来的增量，取回来以后按先后补上', async () => {
    const { 'background/list': _list, ...rest } = handlers({});
    app = await renderApp('/s/s1/background', rest);
    await vi.waitFor(() => expect(requests('background/list')).toHaveLength(1));
    act(() => pushTasks([{ ...DEV, lastLine: '推来的一行' }]));
    act(() => pushTasks([], ['t-gone']));
    act(() => server().reply('background/list', { tasks: [DEV, backgroundTask('t-gone', { label: 'draw_image' })] }));
    expect(await panel().findByText('推来的一行')).toBeTruthy();
    expect(panel().queryByText('draw_image')).toBeNull();
  });

  it('重连后重新 background/watch 与 background/list，按新取的画', async () => {
    let tasks = [DEV];
    app = await renderApp('/s/s1/background', { ...handlers({}), 'background/list': () => ({ tasks }) });
    await panel().findByText('npm run dev');
    expect(requests('background/watch')).toEqual([{}]);
    tasks = [{ ...DEV, status: 'completed', endedAt: AT + 62_000 }];
    server().drop();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const again = await app.reconnect();
    await vi.waitFor(() => expect(requests('background/watch', again)).toEqual([{}]));
    await vi.waitFor(() => expect(requests('background/list', again)).toHaveLength(1));
    await vi.waitFor(() => expect(panel().getByRole('button', { name: '已结束 · 1' })).toBeTruthy());
  });

  it('重连后取列表失败：之后推来的增量照常套上，原因与重试一直留着，直到取成功', async () => {
    let fail = false;
    const draw = backgroundTask('t-draw', { label: 'draw_image' });
    app = await renderApp('/s/s1/background', {
      ...handlers({}),
      'background/list': () => {
        if (fail) throw new Error('登记表读不出');
        return { tasks: [DEV, draw] };
      },
    });
    await panel().findByText('npm run dev');
    fail = true;
    server().drop();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await app.reconnect();
    const alert = await panel().findByRole('alert');
    act(() => pushTasks([{ ...draw, lastLine: '推来的一行' }]));
    expect(await panel().findByText('推来的一行')).toBeTruthy();
    expect(panel().getByRole('alert')).toBe(alert);
    fail = false;
    server().drop();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await app.reconnect();
    await vi.waitFor(() => expect(panel().queryByRole('alert')).toBeNull());
  });
});

describe('时间线里转了后台的工具卡', () => {
  const command = { kind: 'command' as const, command: 'npm run dev' };

  it('按 taskId 画登记表里的状态、耗时、最后一行与「输出」「停止」；登记表里找不到的只画调用本身', async () => {
    const items = [
      turn('t1', { outcome: 'replied' }),
      toolCall('call-t-dev', 'exec', { taskId: 't-dev', display: command, durationMs: 1200 }),
      toolCall('call-gone', 'exec', { taskId: 'gone', display: { kind: 'command', command: 'ls' }, durationMs: 800 }),
    ];
    app = await renderApp('/s/s1', handlers({ tasks: [DEV], items }));
    const live = cardOf(await main().findByRole('button', { name: /执行 npm run dev/ }));
    await loaded();
    await clockAt(63_000);
    expect(live.textContent).toContain('1 分 3 秒');
    expect(live.textContent).toContain('VITE ready in 300 ms');
    expect(within(live).getByRole('button', { name: '输出「npm run dev」' })).toBeTruthy();
    fireEvent.click(within(live).getByRole('button', { name: '停止「npm run dev」' }));
    await vi.waitFor(() => expect(requests('background/stop')).toEqual([{ taskId: 't-dev' }]));

    const plain = cardOf(main().getByRole('button', { name: /执行 ls/ }));
    expect(plain.textContent).toContain('0.8 秒');
    expect(within(plain).queryByRole('button', { name: /^输出/ })).toBeNull();

    act(() => pushTasks([{ ...DEV, status: 'failed', endedAt: AT + 62_000, exitCode: 1 }]));
    expect(live.textContent).toContain('退出码 1');
    expect(within(live).queryByRole('button', { name: '停止「npm run dev」' })).toBeNull();
  });

  it('同一个任务在工具卡与「后台」标签里的耗时同一拍走，不会对不上', async () => {
    vi.setSystemTime(AT + 3_000);
    app = await renderApp(
      '/s/s1',
      handlers({ tasks: [DEV], items: [toolCall('call-t-dev', 'exec', { taskId: 't-dev', display: command })] }),
    );
    const card = cardOf(await main().findByRole('button', { name: /执行 npm run dev/ }));
    await loaded();
    await act(() => vi.advanceTimersByTimeAsync(500));
    fireEvent.click(panel().getByRole('tab', { name: '后台' }));
    const row = rowOf(await panel().findByRole('button', { name: 'npm run dev' }));
    const elapsed = (element: HTMLElement) => element.querySelector('.status-text')?.textContent;
    expect(elapsed(row)).toBe(elapsed(card));
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(elapsed(row)).toBe(elapsed(card));
  });

  it('收起规则：后台还在跑的卡不收，结束后照收', async () => {
    const items = [
      turn('t1', { outcome: 'replied' }),
      toolCall('call-a', 'exec', { display: { kind: 'command', command: 'a' } }),
      toolCall('call-t-dev', 'exec', { taskId: 't-dev', display: command }),
      toolCall('call-b', 'exec', { display: { kind: 'command', command: 'b' } }),
    ];
    app = await renderApp('/s/s1', handlers({ tasks: [DEV], items }));
    await main().findByRole('button', { name: /执行 npm run dev/ });
    await loaded();
    expect(main().queryByText('执行了 3 条命令')).toBeNull();
    act(() => pushTasks([{ ...DEV, status: 'completed', endedAt: AT + 62_000 }]));
    expect(main().getByText('执行了 3 条命令')).toBeTruthy();
  });

  it('桌面上工具卡的「输出」打开「后台」标签里的日志，标签关着时先打开', async () => {
    const layout = layoutStore({
      panelTabs: [hostTab('plan'), hostTab('settings'), hostTab('usage'), hostTab('background', false)],
    });
    app = await renderApp(
      '/s/s1',
      handlers({
        tasks: [DEV],
        items: [toolCall('call-t-dev', 'exec', { taskId: 't-dev', display: command })],
        output: () => ({ text: 'ready\n', end: 6, truncated: false }),
      }),
      { '/api/layout': layout.route, '/api/session-pages?sessionId=s1': { pages: [] } },
    );
    fireEvent.click(await main().findByRole('button', { name: '输出「npm run dev」' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s1/background'));
    expect(
      restCalls()
        .filter(call => call.method === 'POST')
        .map(call => call.body),
    ).toEqual([{ op: 'open-tab', tab: { host: 'background' } }]);
    expect(await panel().findByText('ready')).toBeTruthy();
  });
});

describe('会话头部', () => {
  const header = () => within(document.querySelector('main .panel-header') as HTMLElement);

  it('有后台工作时写「后台 N」（带转动），点开「后台」标签；标签关着时先打开再跳过去；没有时不出现', async () => {
    const layout = layoutStore({
      panelTabs: [hostTab('plan'), hostTab('settings'), hostTab('usage'), hostTab('background', false)],
    });
    app = await renderApp('/s/s1', handlers({ session: { background: 2 }, tasks: [DEV] }), {
      '/api/layout': layout.route,
      '/api/session-pages?sessionId=s1': { pages: [] },
    });
    const entry = await header().findByRole('button', { name: '后台 2' });
    expect(entry.querySelector('.spin')).not.toBeNull();
    fireEvent.click(entry);
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s1/background'));
    expect(layout.records.panelTabs.at(-1)).toEqual(hostTab('background'));
    expect(tabs()).toContain('后台');

    act(() =>
      server().notify('sessions/changed', { upserts: [summary('s1', { title: '整理周报' })], removes: [], groups: [] }),
    );
    expect(header().queryByRole('button', { name: /^后台/ })).toBeNull();
  });

  it('没有子会话、任务表还没取到或没取到时，点「后台 N」照样到「后台」标签，写明原因，重试成功后列出任务', async () => {
    const { 'background/list': _list, ...rest } = handlers({ session: { background: 1 } });
    app = await renderApp('/s/s1', rest);
    fireEvent.click(await header().findByRole('button', { name: '后台 1' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s1/background'));
    expect(panel().getByRole('tab', { name: '后台' }).getAttribute('aria-selected')).toBe('true');
    act(() => server().fail('background/list', '登记表读不出'));
    const alert = await panel().findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(requests('background/list')).toHaveLength(2));
    act(() => server().reply('background/list', { tasks: [DEV] }));
    expect(await panel().findByText('npm run dev')).toBeTruthy();
  });

  it('手机：「后台 N」收进「更多」，「更多」上加一个点；没有后台工作时都没有', async () => {
    stubViewport(390);
    app = await renderApp('/s/s1', handlers({ session: { background: 1 }, tasks: [DEV] }));
    const more = await header().findByRole('button', { name: '更多' });
    expect(header().queryByRole('button', { name: /^后台/ })).toBeNull();
    expect(more.hasAttribute('data-dot')).toBe(true);
    fireEvent.click(more);
    expect(screen.getAllByRole('menuitem')[0].textContent).toBe('后台 1');
    fireEvent.click(screen.getByRole('menuitem', { name: '后台 1' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/s/s1/background'));
    app.back();

    act(() =>
      server().notify('sessions/changed', { upserts: [summary('s1', { title: '整理周报' })], removes: [], groups: [] }),
    );
    expect(header().getByRole('button', { name: '更多' }).hasAttribute('data-dot')).toBe(false);
    fireEvent.click(header().getByRole('button', { name: '更多' }));
    expect(screen.queryByRole('menuitem', { name: /^后台/ })).toBeNull();
  });
});

describe('子会话页', () => {
  const ancestors = [
    { id: 'root', title: '根会话' },
    { id: 'mid', title: '中间一级' },
  ];

  it('顶部路径「父会话 › 本会话」：各级父会话可点，逐层退回；路径已表明是子会话，头部不另写种类', async () => {
    app = await renderApp('/s/s1', handlers({ session: { kind: 'task', parentId: 'mid', ancestors } }));
    const title = await main().findByRole('heading', { level: 2, name: /整理周报/ });
    expect(title.textContent).toBe('根会话中间一级整理周报');
    expect(main().queryByText('子任务')).toBeNull();
    fireEvent.click(within(title).getByRole('link', { name: '中间一级' }));
    expect(app.where()).toBe('/s/mid');
  });

  it('手机：头部的返回回到父会话', async () => {
    stubViewport(390);
    app = await renderApp('/s/s1', handlers({ session: { kind: 'task', parentId: 'mid', ancestors } }));
    await main().findByRole('heading', { level: 2, name: /整理周报/ });
    fireEvent.click(main().getByRole('button', { name: '返回' }));
    expect(app.where()).toBe('/s/mid');
  });
});
