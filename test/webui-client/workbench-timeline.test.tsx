// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_NOTICE } from '../../packages/api-tools/src/index.js';
import { SESSION_PROTOCOL } from '../../packages/plugin-webui-client/src/plugins/list.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type Harness,
  INIT,
  installDialog,
  language,
  main,
  pluginRow,
  renderApp,
  requests,
  room,
  server,
  summary,
} from './harness.js';
import {
  agentMessage,
  notice,
  push,
  pushDelta,
  queue,
  reasoning,
  snapshot,
  toolCall,
  turn,
  userMessage,
} from './items.js';

// ════════════════════════════════════════════════════════════
// 会话工作台的时间线：条目按种类渲染（提问、回复与模型角标、未发出、思考、工具卡、通知与「继续」、回合的结局写在这一轮最后一段、
// 输入怎么进的这一轮、没有输入的一轮的来源），排着的消息在输入框上方，
// 流式拼接，工具卡按 display 渲染（生成参数期间写「正在生成」），全部折叠，回合上的回滚按功能位出现、打开即可确认，
// 驱动房间的提示条，更早的历史，
// 完成未读的清除，会话被删掉时回首页，Esc 停止，订阅失败的错误态，附件
// ════════════════════════════════════════════════════════════

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => true),
  render: vi.fn(async () => ({ svg: '<svg data-testid="chart"></svg>' })),
}));
vi.mock('../../packages/plugin-webui-client/node_modules/mermaid', () => ({ default: mermaid }));

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

const timeline = () => main().findByRole('region', { name: '对话' });

describe('时间线', () => {
  it('条目按种类渲染：提问、回复（Markdown，下面一行写模型与这一轮的 token）、默认折叠的思考、宿主通知；头部写标题与所在场所', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '把周报整理一下'),
          turn('t1', { outcome: 'replied' }),
          reasoning('r1', '先读三份草稿'),
          agentMessage('a1', '**好的**，已经整理好', {
            model: { provider: 'p', model: 'demo-model', promptTokens: 12_345, completionTokens: 456 },
          }),
          agentMessage('a2', '只有输出', { model: { completionTokens: 8 } }),
          notice('n1', '对话已压缩', { topic: 'compress' }),
        ]),
    });
    const log = within(await timeline());
    expect(log.getByText('把周报整理一下')).toBeTruthy();
    expect(log.getByText('好的').tagName).toBe('STRONG');
    const meta = (text: RegExp) =>
      [...(log.getByText(text).closest('.message')?.querySelectorAll('.message-meta > span') ?? [])].map(
        span => span.textContent,
      );
    expect(meta(/已经整理好/)).toEqual(['demo-model', '输入 12.3k', '输出 456']);
    expect(meta(/只有输出/)).toEqual(['输出 8']);
    expect(log.getByText('对话已压缩')).toBeTruthy();
    const thinking = log.getByRole('button', { name: /思考/ });
    expect(thinking.getAttribute('aria-expanded')).toBe('false');
    expect(log.queryByText('先读三份草稿')).toBeNull();
    fireEvent.click(thinking);
    expect(log.getByText('先读三份草稿')).toBeTruthy();
    expect(main().getByRole('heading', { name: '整理周报' })).toBeTruthy();
    expect(main().getByText('默认工作区')).toBeTruthy();
  });

  it('流式：started 之后的增量接在正文后面，completed 的全文是正本', async () => {
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot([]) });
    const log = within(await timeline());
    act(() => push('started', agentMessage('a1', '你')));
    act(() => pushDelta('a1', '好'));
    expect(log.getByText('你好')).toBeTruthy();
    expect(log.getByLabelText('正在输出')).toBeTruthy();
    act(() => push('completed', agentMessage('a1', '你好，在的')));
    expect(log.getByText('你好，在的')).toBeTruthy();
    expect(log.queryByText('你好')).toBeNull();
    expect(log.queryByLabelText('正在输出')).toBeNull();
    act(() =>
      push('started', toolCall('c1', 'exec', { status: 'running', display: { kind: 'command', command: 'ls' } })),
    );
    act(() => pushDelta('c1', 'a.txt\n'));
    act(() => pushDelta('c1', 'b.txt'));
    const line = log.getByRole('button', { name: /执行 ls/ });
    expect(line.textContent).toContain('运行中');
    fireEvent.click(line);
    expect(log.getByText(/a\.txt\s+b\.txt/)).toBeTruthy();
  });

  it('命令太长的工具卡行：保留首尾，中间写明省略了多少字', async () => {
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot([]) });
    const log = within(await timeline());
    const command = `${'a'.repeat(30)}${'x'.repeat(40)}${'b'.repeat(30)}`;
    act(() => push('started', toolCall('c1', 'exec', { status: 'running', display: { kind: 'command', command } })));
    expect(log.getByRole('button', { name: /执行 a{30}…（省略 40 字）…b{30}/ })).toBeTruthy();
  });

  it('正在输出的回复里的 Mermaid 图输出完才画', async () => {
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot([]) });
    const log = within(await timeline());
    mermaid.parse.mockClear();
    act(() => push('started', agentMessage('a1', '```mermaid\ngraph TD; A-->')));
    act(() => pushDelta('a1', 'B\n```'));
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    expect(mermaid.parse).not.toHaveBeenCalled();
    act(() => push('completed', agentMessage('a1', '```mermaid\ngraph TD; A-->B\n```')));
    expect(await log.findByTestId('chart')).toBeTruthy();
  });

  it('工具卡按 display 渲染：命令与工作目录、改文件的两侧，没声明的走通用卡并逐字列出参数；失败写在行上', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          toolCall('c1', 'exec', {
            args: { command: 'npm test', cwd: '/repo' },
            display: { kind: 'command', command: 'npm test', cwd: '/repo' },
            output: 'ok 12 tests',
            durationMs: 1200,
          }),
          toolCall('c2', 'file_edit', {
            args: { path: 'src/a.ts', oldText: 'old line', newText: 'new line' },
            display: { kind: 'file-change', path: 'src/a.ts', removed: 'old line', added: 'new line' },
          }),
          toolCall('c3', 'web_search', { args: { query: '天气', limit: 3 }, result: '晴' }),
          toolCall('c5', 'send_group_message', { sentToRoom: true, durationMs: 300 }),
          toolCall('c4', 'exec', {
            status: 'failed',
            args: { command: 'false' },
            display: { kind: 'command', command: 'false' },
          }),
        ]),
    });
    const log = within(await timeline());
    const exec = log.getByRole('button', { name: /执行 npm test/ });
    expect(exec.textContent).toContain('1.2 秒');
    expect(exec.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(exec);
    expect(log.getByText('ok 12 tests')).toBeTruthy();
    expect(log.getByText('/repo')).toBeTruthy();

    fireEvent.click(log.getByRole('button', { name: /修改 src\/a\.ts/ }));
    expect(log.getByText('-old line')).toBeTruthy();
    expect(log.getByText('+new line')).toBeTruthy();

    fireEvent.click(log.getByRole('button', { name: /调用 web_search/ }));
    expect(log.getByText(/"query": "天气"/)).toBeTruthy();
    expect(log.getByText('晴')).toBeTruthy();

    expect(log.getByRole('button', { name: /执行 false/ }).textContent).toContain('失败');
    expect(log.getByRole('button', { name: /调用 send_group_message/ }).textContent).toContain('已发出 · 0.3 秒');
  });

  it('工具卡的结局：退出码不为 0 的写退出码、用危险色；停止时还没结束的写「已停止」、不用危险色；没有退出码的失败写「失败」', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          toolCall('c1', 'exec', {
            status: 'failed',
            display: { kind: 'command', command: 'make', exitCode: 2 },
            durationMs: 1200,
          }),
          toolCall('c2', 'exec', { status: 'aborted', display: { kind: 'command', command: 'sleep 9' } }),
          toolCall('c3', 'web_search', { status: 'failed' }),
          toolCall('c4', 'exec', {
            display: { kind: 'command', command: 'ls', exitCode: 0 },
            durationMs: 300,
          }),
          toolCall('c5', 'exec', { status: 'failed', display: { kind: 'command', command: 'cat', exitCode: 0 } }),
        ]),
    });
    const log = within(await timeline());
    const status = (name: RegExp) => {
      const element = log.getByRole('button', { name }).querySelector('.tool-line-status');
      return [element?.textContent, element?.getAttribute('data-tone')];
    };
    expect(status(/执行 make/)).toEqual(['退出码 2', 'danger']);
    expect(status(/执行 sleep 9/)).toEqual(['已停止', null]);
    expect(status(/调用 web_search/)).toEqual(['失败', 'danger']);
    expect(status(/执行 ls/)).toEqual(['0.3 秒', null]);
    expect(status(/执行 cat/)).toEqual(['失败', 'danger']);
  });

  it('生成了却没有执行的调用（notExecuted）：细节里写「没有执行」', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([toolCall('c1', 'web_search', { status: 'failed', notExecuted: true })]),
    });
    const log = within(await timeline());
    fireEvent.click(log.getByRole('button', { name: /调用 web_search/ }));
    expect(log.getByText('没有执行')).toBeTruthy();
  });

  it('模型还在生成参数的工具卡写工具名与「正在生成」，不能展开；开始执行后同一张卡照常', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([turn('t1'), toolCall('c1', 'file_write', { status: 'generating' })]),
    });
    const log = within(await timeline());
    const line = log.getByRole('button', { name: /调用 file_write/ });
    expect(line.textContent).toContain('正在生成');
    expect((line as HTMLButtonElement).disabled).toBe(true);
    expect(line.getAttribute('aria-expanded')).toBeNull();

    act(() =>
      push(
        'started',
        toolCall('c1', 'file_write', {
          status: 'running',
          args: { path: 'a.md', content: '全文' },
          display: { kind: 'file-change', path: 'a.md', added: '全文' },
        }),
      ),
    );
    const running = log.getByRole('button', { name: /写入 a\.md/ });
    expect(running.textContent).toContain('运行中');
    expect(log.queryByText('正在生成')).toBeNull();
    fireEvent.click(running);
    expect(log.getByText('+全文')).toBeTruthy();
  });

  it('工具行上来自参数的文字经过清洗：看不见的字符显示出来', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([toolCall('c1', 'exec', { display: { kind: 'command', command: 'echo \u202Egnp.exe' } })]),
    });
    const line = within(await timeline()).getByRole('button', { name: /执行/ });
    expect(line.textContent).toContain('echo ⟨U+202E⟩gnp.exe');
    expect(line.textContent).not.toContain('\u202E');
  });

  it('改文件的细节：两侧经过清洗；只有新增一侧时不多出一行删除', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          toolCall('c1', 'file_write', {
            display: { kind: 'file-change', path: 'a.txt', added: 'ok\u202Egnp.exe' },
          }),
        ]),
    });
    const log = within(await timeline());
    fireEvent.click(log.getByRole('button', { name: /写入 a\.txt/ }));
    const diff = log.getByText(/^\+ok/).parentElement as HTMLElement;
    expect([...diff.children].map(row => row.textContent)).toEqual(['+ok⟨U+202E⟩gnp.exe']);
  });

  it('相隔超过 10 分钟的两段之间插一行时间，挨得近的不插', async () => {
    const at = (minute: number) => new Date(2026, 9, 3, 9, minute).getTime();
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '第一句', { at: at(0) }),
          userMessage('u2', '第二句', { at: at(5) }),
          userMessage('u3', '第三句', { at: at(30) }),
        ]),
    });
    const log = await timeline();
    expect([...log.querySelectorAll('time')].map(time => time.textContent)).toEqual([
      expect.stringContaining('09:00'),
      expect.stringContaining('09:30'),
    ]);
  });

  it('「全部展开」与「全部折叠」：工具卡与思考一起展开或收起，单张卡可以单独展开', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          reasoning('r1', '想一想'),
          toolCall('c1', 'exec', { display: { kind: 'command', command: 'ls' } }),
          toolCall('c2', 'exec', { display: { kind: 'command', command: 'pwd' } }),
        ]),
    });
    const log = within(await timeline());
    const cards = () => log.queryAllByRole('button', { expanded: true });
    expect(cards()).toHaveLength(0);
    fireEvent.click(log.getByRole('button', { name: /执行 ls/ }));
    expect(cards()).toHaveLength(1);
    fireEvent.click(main().getByRole('button', { name: '全部展开' }));
    expect(cards()).toHaveLength(3);
    fireEvent.click(main().getByRole('button', { name: '全部折叠' }));
    expect(cards()).toHaveLength(0);
  });

  it('回合：中止与出错写在回合末尾；回滚挂在收尾了的回合上、按功能位出现，两种范围，之后的回合也改过的文件如实提示', async () => {
    const rewound: unknown[] = [];
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '改一下配置'),
          turn('t1', { outcome: 'aborted' }),
          agentMessage('a1', '好的，我先改', { turnId: 't1' }),
          userMessage('u2', '再试一次'),
          turn('t2', { outcome: 'error' }),
          agentMessage('a2', '出错前说的', { turnId: 't2' }),
          userMessage('u3', '还在吗'),
          turn('t3'),
        ]),
      'turn/rewind': params => {
        rewound.push(params);
        return {
          ok: true,
          restored: ['workspace:/a.ts'],
          deleted: [],
          errors: [],
          alsoChangedBy: [{ uri: 'workspace:/a.ts', turnIds: ['t2'] }],
          ...(params.scope === 'code-and-chat' ? { deletedMessages: 2, chatDeleted: true } : {}),
        };
      },
    });
    const log = within(await timeline());
    expect(log.getByText('已停止')).toBeTruthy();
    expect(log.getByText('这一轮出错了')).toBeTruthy();
    const rewinds = log.getAllByRole('button', { name: '回滚这一轮' });
    expect(rewinds).toHaveLength(2);

    const sent = server().frames.length;
    fireEvent.click(rewinds[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: '回滚文件改动' }));
    const dialog = within(screen.getByRole('dialog', { name: '回滚这一轮的文件改动？' }));
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: '取消' }));
    const confirm = dialog.getByRole('button', { name: '回滚' }) as HTMLButtonElement;
    expect(confirm.disabled, '打开即可确认').toBe(false);
    expect(server().frames.slice(sent), '打开对话框不发请求').toEqual([]);
    expect(dialog.getByText('回滚只撤回经存储的文件改动，命令与外部工具的效果撤不回。')).toBeTruthy();
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(rewound).toEqual([{ sessionId: 's1', turnId: 't1', scope: 'code' }]));
    const toasts = within(screen.getByRole('region', { name: '通知' }));
    expect(await toasts.findByText(/已回滚：恢复 1 个文件/)).toBeTruthy();
    expect(toasts.getByText(/workspace:\/a\.ts/)).toBeTruthy();

    fireEvent.click(rewinds[1]);
    fireEvent.click(screen.getByRole('menuitem', { name: '回滚文件改动与这一轮对话' }));
    const second = within(screen.getByRole('dialog'));
    expect(second.getByText('回滚只撤回经存储的文件改动，命令与外部工具的效果撤不回。')).toBeTruthy();
    fireEvent.click(second.getByRole('button', { name: '回滚' }));
    await vi.waitFor(() => expect(rewound).toHaveLength(2));
    expect(rewound[1]).toEqual({ sessionId: 's1', turnId: 't2', scope: 'code-and-chat' });

    act(() => server().notify('features/changed', { features: { ...INIT.features, rewind: false } }));
    expect(log.queryAllByRole('button', { name: '回滚这一轮' })).toHaveLength(0);
  });

  it('回滚确认：这一轮有转到后台的调用（工具卡带 taskId）时写明它们在这一轮结束之后写的文件不会撤回，没有时不写', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '起开发服务器'),
          turn('t1', { outcome: 'replied' }),
          toolCall('c1', 'exec', { turnId: 't1', taskId: 'bg_1' }),
          agentMessage('a1', '放到后台了', { turnId: 't1' }),
          userMessage('u2', '再改一下'),
          turn('t2', { outcome: 'replied' }),
          toolCall('c2', 'exec', { turnId: 't2' }),
          agentMessage('a2', '改好了', { turnId: 't2' }),
        ]),
    });
    const log = within(await timeline());
    const note = '这一轮有转到后台的调用，它们在这一轮结束之后写的文件不会撤回。';
    const [first, second] = log.getAllByRole('button', { name: '回滚这一轮' });
    for (const [button, shown] of [
      [first, true],
      [second, false],
    ] as const) {
      fireEvent.click(button);
      fireEvent.click(screen.getByRole('menuitem', { name: '回滚文件改动' }));
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.queryByText(note) !== null).toBe(shown);
      fireEvent.click(dialog.getByRole('button', { name: '取消' }));
    }
  });

  it('回滚确认按整轮判：一轮被插话隔成两段，从后一段回滚，前一段里转到后台的调用照样写明', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '起开发服务器'),
          turn('t1', { outcome: 'replied' }),
          toolCall('c1', 'exec', { turnId: 't1', taskId: 'bg_1' }),
          userMessage('u2', '顺便看看日志'),
          agentMessage('a1', '放到后台了', { turnId: 't1' }),
        ]),
    });
    const log = within(await timeline());
    const buttons = log.getAllByRole('button', { name: '回滚这一轮' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: '回滚文件改动' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('这一轮有转到后台的调用，它们在这一轮结束之后写的文件不会撤回。')).toBeTruthy();
  });

  it('没有回复、只有输入的一轮按整轮判没有回滚：被别人的话隔成两段时哪一段都不出', async () => {
    const other = { platform: 'onebot', userId: '20001', nickname: '小林', owner: false };
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '<先说>', { turnId: 't1', entry: 'opened' }),
          userMessage('x1', '<别人的话>', { speaker: other }),
          userMessage('u2', '<又说>', { turnId: 't1', entry: 'joined' }),
          turn('t1', { outcome: 'silent' }),
        ]),
    });
    const log = within(await timeline());
    expect(log.getByText('没有回复')).toBeTruthy();
    expect(log.queryAllByRole('button', { name: '回滚这一轮' })).toHaveLength(0);
  });

  it('驱动别人的房间时顶部有提示条；房间里逐条写说话人（她的回复写握手给的应用名），没发出的回复写明原因', async () => {
    app = await renderApp('/s/s1', {
      initialize: () => ({ ...INIT, appName: '<应用名>' }),
      'session/subscribe': () =>
        snapshot(
          [
            userMessage('u1', '今晚谁来讲', {
              speaker: { platform: 'onebot', userId: '20001', nickname: '小林', owner: false },
            }),
            userMessage('u2', '我来讲', { speaker: { platform: 'webui', userId: 'console', owner: true } }),
            agentMessage('a1', '不客气', { undelivered: { reason: '没有发出：这一轮静默结束' } }),
          ],
          { session: room('onebot:10000:group:20001', 'im-a', { title: '示例群 A' }) },
        ),
    });
    const log = within(await timeline());
    expect(main().getByText('你正在以 owner 身份在「示例群 A」发言')).toBeTruthy();
    expect(main().getByText('group · onebot')).toBeTruthy();
    expect(log.getByText('小林')).toBeTruthy();
    expect(log.getByText('你')).toBeTruthy();
    const reply = log.getByText('不客气').closest('.message') as HTMLElement;
    expect(within(reply).getByText('<应用名>')).toBeTruthy();
    expect(log.getByText('没有发出：这一轮静默结束')).toBeTruthy();
  });

  it('私聊房间的提示条与群用同一句，只有房间名不同', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([userMessage('u1', '在吗')], {
          session: room('onebot:10000:private:30001', 'im-a', {
            title: '小林',
            chat: { type: 'private', multiParty: false },
          }),
        }),
    });
    await timeline();
    expect(main().getByText('你正在以 owner 身份在「小林」发言')).toBeTruthy();
  });

  it('「我的」会话没有提示条，也不逐条写说话人', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '你好'), agentMessage('a1', '在的')]),
    });
    const log = within(await timeline());
    expect(main().queryByText(/你正在以 owner 身份/)).toBeNull();
    expect(log.queryByText('你')).toBeNull();
    expect(log.queryByText('Aalis')).toBeNull();
  });

  it('更早的消息：按快照给的游标取历史，接在前面，取完了按钮消失', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u2', '最近的一句')], { before: 'cursor-1' }),
      'session/history': () => ({ items: [userMessage('u1', '更早的一句')] }),
    });
    const log = within(await timeline());
    fireEvent.click(log.getByRole('button', { name: '更早的消息' }));
    await log.findByText('更早的一句');
    expect(requests('session/history')).toEqual([{ sessionId: 's1', before: 'cursor-1' }]);
    const texts = log.getAllByText(/的一句$/).map(node => node.textContent);
    expect(texts).toEqual(['更早的一句', '最近的一句']);
    expect(log.queryByRole('button', { name: '更早的消息' })).toBeNull();
  });

  it('更早的消息没取到：原地写明哪里没取到与原因，可以重试，「查看日志」去提供会话协议的插件', async () => {
    let fail = true;
    app = await renderApp(
      '/s/s1',
      {
        'session/subscribe': () => snapshot([userMessage('u2', '最近的一句')], { before: 'cursor-1' }),
        'session/history': () => {
          if (fail) throw new Error('存档读不出来');
          return { items: [userMessage('u1', '更早的一句')] };
        },
      },
      { '/api/plugins': { plugins: [pluginRow('zz-sessions', { provides: [SESSION_PROTOCOL] })] } },
    );
    const log = within(await timeline());
    fireEvent.click(log.getByRole('button', { name: '更早的消息' }));
    const alert = await log.findByRole('alert');
    expect(alert.textContent).toContain('更早的消息没取到：存档读不出来');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-sessions',
    );
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await log.findByText('更早的一句');
    expect(log.queryByRole('alert')).toBeNull();
  });

  it('看着「我的」会话时清掉完成未读；会话被删掉时回首页', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([], { session: { unread: true } }),
      'session/markSeen': () => ({}),
    });
    await timeline();
    await vi.waitFor(() => expect(requests('session/markSeen')).toEqual([{ sessionId: 's1' }]));
    for (const unread of [false, true]) {
      act(() =>
        server().notify('sessions/changed', {
          upserts: [summary('s1', { title: '整理周报', unread })],
          removes: [],
          groups: [],
        }),
      );
    }
    await vi.waitFor(() => expect(requests('session/markSeen')).toHaveLength(2));
    act(() => server().notify('sessions/changed', { upserts: [], removes: ['s1'], groups: [] }));
    expect(app.where()).toBe('/');
  });

  it('Esc 停止正在跑的那一轮（带 turnId）；有弹层时 Esc 只关弹层，输入法组字时的 Esc（isComposing 与 keyCode 229）不算', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '跑一下'), turn('t9')], { session: { running: true } }),
      'turn/abort': () => ({}),
    });
    await timeline();
    fireEvent.click(main().getByRole('button', { name: '更多' }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(requests('turn/abort')).toEqual([]);
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 229 });
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true });
    fireEvent.keyDown(screen.getByRole('combobox', { name: '搜索会话、页面与插件' }), { key: 'Escape' });
    expect(requests('turn/abort')).toEqual([]);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await vi.waitFor(() => expect(requests('turn/abort')).toEqual([{ sessionId: 's1', turnId: 't9' }]));
  });

  it('坏数据只坏它自己：重复的条目 id、没收尾就接上下一轮的回合，时间线照常画出，前后的条目都在', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '之前'),
          turn('t1'),
          toolCall('dup', 'read', { result: '甲' }),
          toolCall('dup', 'read', { result: '乙' }),
          userMessage('u2', '之后'),
          turn('t2', { outcome: 'replied' }),
          agentMessage('a2', '答', { turnId: 't2' }),
        ]),
    });
    const log = within(await timeline());
    expect(log.getByText('之前')).toBeTruthy();
    expect(log.getByText('之后')).toBeTruthy();
    expect(log.getByText('答')).toBeTruthy();
  });

  it('订阅失败时会话区写明原因并可以重试', async () => {
    let fail = true;
    app = await renderApp('/s/s1', {
      'session/subscribe': () => {
        if (fail) throw Object.assign(new Error('会话不存在：s1'), { code: 'not-found' });
        return snapshot([userMessage('u1', '回来了')]);
      },
    });
    const alert = await main().findByRole('alert');
    expect(alert.textContent).toContain('会话不存在：s1');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(within(await timeline()).getByText('回来了')).toBeTruthy();
  });

  it('工具调用达到上限的通知可以「继续」，请求在途时不能再点；没有对话服务时不出现', async () => {
    const items = [
      userMessage('u1', '整理一下'),
      turn('t1', { outcome: 'replied' }),
      notice('n1', '工具调用达到这一轮的上限，可以让她继续', { turnId: 't1', topic: 'tool-limit', canContinue: true }),
    ];
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot(items), 'turn/continue': () => ({}) });
    const log = within(await timeline());
    fireEvent.click(log.getByRole('button', { name: '继续' }));
    fireEvent.click(log.getByRole('button', { name: '继续' }));
    await vi.waitFor(() => expect(requests('turn/continue')).toEqual([{ sessionId: 's1' }]));
    await vi.waitFor(() =>
      expect((log.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(requests('turn/continue')).toHaveLength(1);
    act(() => server().notify('features/changed', { features: { ...INIT.features, send: false } }));
    expect(log.queryByRole('button', { name: '继续' })).toBeNull();
  });

  it('指令的回复（topic 为 command-reply）是单独的一张卡，读屏名「指令的回复」，不折叠，不是她的消息，也不是一行通知：只认段落与列表，回显的链接与强调写法按原文显示，附件照常显示；别的通知照旧是一行', async () => {
    const echoed = '没有指令 [点此领取](https://example.invalid/x) **x**';
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          notice('n1', `${echoed}\n\n选项\n- --type, -t <type>：清理类型\n  - all：全部类型`, {
            topic: 'command-reply',
            attachments: [{ kind: 'file', name: '清理记录.txt' }],
          }),
          notice('n2', '对话已压缩', { topic: 'compress' }),
        ]),
    });
    const log = within(await timeline());
    const card = log.getByRole('note', { name: '指令的回复' });
    expect(within(card).getByText(echoed)).toBeTruthy();
    expect(card.closest('.message, .notice')).toBeNull();
    expect(card.querySelector('a, strong, button')).toBeNull();
    const option = within(card).getByText('--type, -t <type>：清理类型');
    expect(option.closest('li')?.querySelector('li')?.textContent).toBe('all：全部类型');
    expect(within(card).getByText('清理记录.txt')).toBeTruthy();
    expect(log.getByText('对话已压缩').closest('.notice')).toBeTruthy();
  });

  it('「继续」只给最后一段里的通知，回合在跑时不出现', async () => {
    const items = [
      turn('t1', { outcome: 'replied' }),
      notice('n1', '工具调用达到这一轮的上限，可以让她继续', { turnId: 't1', topic: 'tool-limit', canContinue: true }),
    ];
    app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot(items) });
    const log = within(await timeline());
    expect(log.getByRole('button', { name: '继续' })).toBeTruthy();
    act(() =>
      server().notify('sessions/changed', { upserts: [summary('s1', { running: true })], removes: [], groups: [] }),
    );
    expect(log.queryByRole('button', { name: '继续' })).toBeNull();
    act(() =>
      server().notify('sessions/changed', { upserts: [summary('s1', { running: false })], removes: [], groups: [] }),
    );
    act(() => push('completed', userMessage('u2', '先别继续')));
    expect(log.queryByRole('button', { name: '继续' })).toBeNull();
  });

  it('附件：图片走媒体地址，外站图片经代理，取不到时显示替代；文件一行写名字与类型，按句柄下载，网址的文件链到网址，没有句柄的只写名字', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          agentMessage('a1', '', {
            attachments: [
              { kind: 'image', src: 'data:/images/x.png', name: 'x.png' },
              { kind: 'image', src: 'https://example.com/a.png', name: 'a.png' },
              { kind: 'file', src: 'handle-1', name: '报告.pdf' },
              { kind: 'file', name: '只有名字.txt' },
              { kind: 'file', src: 'handle-3', name: 'Makefile' },
              { kind: 'file', src: 'https://example.invalid/manual.pdf', name: '手册.pdf' },
            ],
          }),
        ]),
    });
    const log = within(await timeline());
    const images = log.getAllByRole('img');
    expect(images.map(img => img.getAttribute('src'))).toEqual([
      '/api/media?uri=data%3A%2Fimages%2Fx.png',
      '/api/proxy/image?url=https%3A%2F%2Fexample.com%2Fa.png',
    ]);
    fireEvent.error(images[0]);
    expect(log.getByRole('img', { name: 'x.png（取不到）' }).textContent).toBe('图片取不到');
    const file = log.getByRole('link', { name: /报告\.pdf/ });
    expect(file.getAttribute('href')).toBe('/api/session-file?sessionId=s1&handle=handle-1');
    expect(file.hasAttribute('download')).toBe(true);
    expect(file.textContent).toBe('报告.pdfPDF');
    expect(log.getByText('只有名字.txt').closest('a, button')).toBeNull();
    expect(log.getByText('只有名字.txt').parentElement?.textContent).toBe('只有名字.txtTXT');
    expect(log.getByRole('link', { name: /Makefile/ }).textContent).toBe('Makefile文件');
    expect(log.getByRole('link', { name: /手册\.pdf/ }).getAttribute('href')).toBe(
      'https://example.invalid/manual.pdf',
    );
  });

  it('文本类的文件与通知里的成品点开预览（Markdown 照常渲染），预览里也能下载；太大的、取不到的写明原因，只给下载', async () => {
    const href = (handle: string) => `/api/session-file?sessionId=s1&handle=${handle}`;
    app = await renderApp(
      '/s/s1',
      {
        'session/subscribe': () =>
          snapshot([
            agentMessage('a1', '', { attachments: [{ kind: 'file', src: 'h-md', name: '周报.md' }] }),
            notice('n1', '作品已完成', {
              topic: 'works',
              attachments: [
                { kind: 'file', src: 'h-log', name: 'build.log' },
                { kind: 'file', src: 'h-big', name: 'big.txt' },
                { kind: 'file', src: 'h-gone', name: 'gone.txt' },
              ],
            }),
          ]),
      },
      {
        [href('h-md')]: () => new Response('# 本周\n\n做完了三件事', { headers: { 'Content-Length': '30' } }),
        [href('h-log')]: () => new Response('<b>原样</b>\nok', { headers: { 'Content-Length': '16' } }),
        [href('h-big')]: () => new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024) } }),
        [href('h-gone')]: () => Response.json({ error: '文件已不在' }, { status: 404 }),
      },
    );
    const log = within(await timeline());
    fireEvent.click(log.getByRole('button', { name: /周报\.md/ }));
    let dialog = within(screen.getByRole('dialog', { name: '周报.md' }));
    expect((await dialog.findByRole('heading', { name: '本周' })).tagName).toBe('H1');
    const download = dialog.getByRole('link', { name: '下载' });
    expect([download.getAttribute('href'), download.getAttribute('download')]).toEqual([href('h-md'), '周报.md']);
    fireEvent.click(dialog.getByRole('button', { name: '关闭' }));

    fireEvent.click(log.getByRole('button', { name: /build\.log/ }));
    dialog = within(screen.getByRole('dialog', { name: 'build.log' }));
    expect((await dialog.findByText(/原样/)).textContent).toBe('<b>原样</b>\nok');
    fireEvent.click(dialog.getByRole('button', { name: '关闭' }));

    fireEvent.click(log.getByRole('button', { name: /big\.txt/ }));
    dialog = within(screen.getByRole('dialog', { name: 'big.txt' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('文件超过 512 KB，下载后查看');
    fireEvent.click(dialog.getByRole('button', { name: '关闭' }));

    fireEvent.click(log.getByRole('button', { name: /gone\.txt/ }));
    dialog = within(screen.getByRole('dialog', { name: 'gone.txt' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('文件已不在');
  });
});

describe('收起、没有回复与运行指示', () => {
  const command = (itemId: string, line: string, fields: Parameters<typeof toolCall>[2] = {}) =>
    toolCall(itemId, 'exec', { display: { kind: 'command', command: line }, ...fields });
  const edit = (itemId: string, path: string) =>
    toolCall(itemId, 'file_edit', { display: { kind: 'file-change', path, removed: 'a', added: 'b' } });

  it('连续 3 个以上的工具调用收成一行（按展示种类计数，夹着的思考一起收），点开看每一条；2 个不收；收起的内容不在页面上；写给用户的正文不收', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u1', '整理一下'),
          turn('t1', { outcome: 'replied' }),
          command('c1', 'ls'),
          reasoning('r1', '再看看文件'),
          edit('c2', 'a.ts'),
          toolCall('c3', 'web_search'),
          command('c4', 'pwd'),
          agentMessage('a1', '中间说一句'),
          command('c5', 'git status'),
          command('c6', 'git diff'),
          agentMessage('a2', '做完了'),
          userMessage('u2', '再跑三条'),
          turn('t2', { outcome: 'replied' }),
          command('c7', 'npm test'),
          command('c8', 'npm run lint'),
          command('c9', 'npm run build'),
        ]),
    });
    const log = within(await timeline());
    const mixed = log.getByRole('button', { name: '调用了 4 个工具：执行命令 2、改动文件 1、其他 1' });
    expect(mixed.getAttribute('aria-expanded')).toBe('false');
    for (const name of [/执行 ls/, /修改 a\.ts/, /调用 web_search/, /执行 pwd/, /思考/]) {
      expect(log.queryByRole('button', { name }), String(name)).toBeNull();
    }
    expect(log.getByText('中间说一句')).toBeTruthy();
    expect(log.getByRole('button', { name: /执行 git status/ })).toBeTruthy();
    expect(log.getByRole('button', { name: /执行 git diff/ })).toBeTruthy();
    expect(log.getByRole('button', { name: '执行了 3 条命令' })).toBeTruthy();
    expect(log.queryByRole('button', { name: /执行 npm test/ })).toBeNull();

    fireEvent.click(mixed);
    expect(mixed.getAttribute('aria-expanded')).toBe('true');
    for (const name of [/执行 ls/, /修改 a\.ts/, /调用 web_search/, /执行 pwd/, /思考/]) {
      expect(log.getByRole('button', { name }), String(name)).toBeTruthy();
    }
    fireEvent.click(main().getByRole('button', { name: '全部展开' }));
    expect(log.getByRole('button', { name: /执行 npm test/ })).toBeTruthy();
    fireEvent.click(main().getByRole('button', { name: '全部折叠' }));
    expect(log.queryByRole('button', { name: /执行 ls/ })).toBeNull();
    expect(log.queryByRole('button', { name: /执行 npm test/ })).toBeNull();
  });

  it('认不出的展示种类（服务端比客户端新）走通用卡：单独的一张逐字列出参数，连续的收成一行算作其他', async () => {
    const unknown = (itemId: string) =>
      toolCall(itemId, 'zz_fetch', {
        args: { url: 'https://example.invalid' },
        display: { kind: 'zz-fetch', url: 'https://example.invalid' } as unknown as NonNullable<
          Parameters<typeof toolCall>[2]
        >['display'],
      });
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          turn('t1', { outcome: 'replied' }),
          unknown('k1'),
          agentMessage('m1', '一'),
          unknown('k2'),
          unknown('k3'),
          command('k4', 'ls'),
        ]),
    });
    const log = within(await timeline());
    const single = log.getByRole('button', { name: /调用 zz_fetch/ });
    fireEvent.click(single);
    expect(log.getByText(/"url": "https:\/\/example\.invalid"/)).toBeTruthy();
    expect(log.getByRole('button', { name: '调用了 3 个工具：其他 2、执行命令 1' })).toBeTruthy();
  });

  it('英文界面：收起的一行按单复数与列表写，过长的命令写明省略了几个字符', async () => {
    app = await renderApp(
      '/s/s1',
      {
        'session/subscribe': () =>
          snapshot([
            turn('t1', { outcome: 'replied' }),
            command('c1', 'ls'),
            edit('c2', 'a.ts'),
            toolCall('c3', 'web_search'),
            command('c4', 'pwd'),
            agentMessage('a1', 'done'),
            command('c5', `echo ${'x'.repeat(80)}`),
          ]),
      },
      language(['en']),
    );
    const log = within(await main().findByRole('region', { name: 'Conversation' }));
    expect(log.getByRole('button', { name: 'Called 4 tools: 2 commands, 1 file change, 1 other' })).toBeTruthy();
    expect(log.getByRole('button', { name: /^Run echo x{25}…\(25 characters omitted\)…x{30}$/ })).toBeTruthy();
  });

  it('其中有待审批、失败或运行中的不收，被停止的（aborted）照收；还在跑的这一轮末尾那一组不收，收尾后收起', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          turn('t1', { outcome: 'replied' }),
          command('c1', 'a1'),
          command('c2', 'a2'),
          command('c3', 'a3', { status: 'failed' }),
          agentMessage('m1', '一'),
          command('c4', 'b1'),
          command('c5', 'b2', { approvalId: 'ap-1' }),
          command('c6', 'b3'),
          agentMessage('m2', '二'),
          command('c7', 'c1'),
          command('c8', 'c2', { status: 'aborted' }),
          command('c9', 'c3'),
          agentMessage('m3', '三'),
          command('e1', 'e1'),
          command('e2', 'e2', { status: 'running' }),
          command('e3', 'e3'),
          agentMessage('m4', '四'),
          turn('t2'),
          command('d1', 'd1', { turnId: 't2' }),
          command('d2', 'd2', { turnId: 't2' }),
          command('d3', 'd3', { turnId: 't2', status: 'running' }),
        ]),
    });
    const log = within(await timeline());
    expect(log.getByRole('button', { name: /执行 a3/ })).toBeTruthy();
    expect(log.getByRole('button', { name: /执行 b2/ })).toBeTruthy();
    expect(log.getByRole('button', { name: '执行了 3 条命令' })).toBeTruthy();
    expect(log.queryByRole('button', { name: /执行 c2/ })).toBeNull();
    expect(log.getByRole('button', { name: /执行 e2/ }), '中间一条还在运行').toBeTruthy();
    expect(log.getByRole('button', { name: /执行 d3/ })).toBeTruthy();

    act(() => push('completed', command('d3', 'd3', { turnId: 't2' })));
    expect(log.getByRole('button', { name: /执行 d1/ }), '这一轮还在跑：末尾那一组不收').toBeTruthy();
    act(() => push('completed', turn('t2', { outcome: 'replied' })));
    expect(log.getAllByRole('button', { name: '执行了 3 条命令' })).toHaveLength(2);
    expect(log.queryByRole('button', { name: /执行 d1/ })).toBeNull();
  });

  it('还在跑的一轮被别人的话隔成两段：前一段末尾连着的 3 个调用照收，只有最后一段末尾那一组等这一轮收尾', async () => {
    const other = { platform: 'onebot', userId: '20001', nickname: '小林', owner: false };
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot(
          [
            turn('t1'),
            userMessage('u1', '<开轮>', { turnId: 't1', entry: 'opened' }),
            command('c1', 'ls', { turnId: 't1' }),
            command('c2', 'pwd', { turnId: 't1' }),
            command('c3', 'whoami', { turnId: 't1' }),
            userMessage('x1', '<别人的话>', { speaker: other }),
            userMessage('u2', '<插进来>', { turnId: 't1', entry: 'joined' }),
            command('c4', 'date', { turnId: 't1' }),
            command('c5', 'id', { turnId: 't1' }),
            command('c6', 'uname', { turnId: 't1' }),
          ],
          { session: { running: true } },
        ),
    });
    const log = within(await timeline());
    expect(log.getByRole('button', { name: '执行了 3 条命令' })).toBeTruthy();
    expect(log.queryByRole('button', { name: /执行 ls/ }), '前一段收起').toBeNull();
    expect(log.getByRole('button', { name: /执行 date/ }), '最后一段末尾那一组等收尾').toBeTruthy();
  });

  it('没有回复的一轮写一行「没有回复」，只有输入的几轮（中间只隔着不在回合里的消息）合成「N 轮没有回复」写在最后一轮，被并掉的几轮的输入照常显示；房间与 owner 的会话一样', async () => {
    const asked = (itemId: string, text: string, turnId: string) =>
      userMessage(itemId, text, { turnId, entry: 'opened' });
    const items = [
      asked('u1', '第一句', 't1'),
      turn('t1', { outcome: 'silent' }),
      asked('u2', '第二句', 't2'),
      turn('t2', { outcome: 'silent' }),
      userMessage('x1', '被吞掉的一句'),
      asked('u3', '第三句', 't3'),
      turn('t3', { outcome: 'silent' }),
      asked('u4', '第四句', 't4'),
      turn('t4', { outcome: 'replied' }),
      agentMessage('a4', '回一句', { turnId: 't4' }),
      asked('u5', '第五句', 't5'),
      turn('t5', { outcome: 'silent' }),
    ];
    for (const session of [{}, room('s1', 'im-a')]) {
      app = await renderApp('/s/s1', { 'session/subscribe': () => snapshot(items, { session }) });
      const log = await timeline();
      const lines = [...log.querySelectorAll('.message-text, .markdown, .turn-outcome')].map(node => node.textContent);
      expect(lines, JSON.stringify(session)).toEqual([
        '第一句',
        '第二句',
        '被吞掉的一句',
        '第三句',
        '3 轮没有回复',
        '第四句',
        '回一句',
        '第五句',
        '没有回复',
      ]);
      app.close();
      app = undefined;
    }
  });

  it('结局写在这一轮最后一段的末尾：什么都没做就停下的一轮，「已停止」紧跟在它的消息下面，不落在之后别人的消息后面；被别人的消息隔成两段时写在第二段末尾', async () => {
    const other = { platform: 'onebot', userId: '20001', nickname: '小林', owner: false };
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot(
          [
            // 历史的次序：回合条目由回合记录还原，排在这一轮最后落库的那条之后
            userMessage('u1', '<停下的那一轮>', { turnId: 't1', entry: 'opened' }),
            userMessage('x1', '<之后别人的话>', { speaker: other }),
            turn('t1', { outcome: 'aborted' }),
            // 实时的次序：回合条目随这一轮的第一条推出
            turn('t2', { outcome: 'error' }),
            userMessage('u2', '<开轮>', { turnId: 't2', entry: 'opened' }),
            userMessage('x2', '<中间别人的话>', { speaker: other }),
            userMessage('u3', '<插进来>', { turnId: 't2', entry: 'joined' }),
          ],
          { session: room('s1', 'im-a') },
        ),
    });
    const log = await timeline();
    expect([...log.querySelectorAll('.message-text, .turn-outcome')].map(node => node.textContent)).toEqual([
      '<停下的那一轮>',
      '已停止',
      '<之后别人的话>',
      '<开轮>',
      '<中间别人的话>',
      '<插进来>',
      '这一轮出错了',
    ]);
  });

  it('写不出东西的段不画：只有回合条目、被并进「N 轮没有回复」的一轮（如被下游拦下的），与刚推出回合条目、还没有条目的一轮', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([turn('t1', { outcome: 'silent' }), turn('t2', { outcome: 'silent' }), turn('t3')], {
          session: { running: true },
        }),
    });
    const log = await timeline();
    expect([...log.querySelectorAll('.turn')].map(node => node.textContent)).toEqual(['2 轮没有回复']);
    expect(log.querySelectorAll('.timeline-time')).toHaveLength(1);
  });

  it('输入下面写它怎么进的这一轮：开了这一轮 · 被点名、开了这一轮 · 插话、并入这一轮，通知与后台任务的结束通知同样；别的开轮与不在回合里的不写', async () => {
    const member = { platform: 'onebot', userId: '20001', owner: false };
    const ended = (itemId: string, fields: Parameters<typeof notice>[2]) =>
      notice(itemId, '<写给模型的那句>', {
        topic: BACKGROUND_TASK_NOTICE,
        noticeId: itemId,
        facts: { tool: 'exec', status: 'completed', durationMs: 3_000 },
        ...fields,
      });
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot(
          [
            userMessage('u1', '<点名>', { turnId: 't1', entry: 'opened', addressed: true, speaker: member }),
            turn('t1', { outcome: 'silent' }),
            userMessage('u2', '<插话>', { turnId: 't2', entry: 'opened', addressed: false, speaker: member }),
            turn('t2', { outcome: 'silent' }),
            userMessage('u3', '<没经判定>', { turnId: 't3', entry: 'opened' }),
            userMessage('u4', '<并进来>', { turnId: 't3', entry: 'joined', addressed: true, speaker: member }),
            ended('n3', { turnId: 't3', entry: 'joined' }),
            turn('t3', { outcome: 'replied' }),
            agentMessage('a3', '<答>', { turnId: 't3' }),
            notice('n4', '<戳她开的>', { turnId: 't4', entry: 'opened', addressed: true, topic: 'poke' }),
            notice('n5', '<戳她并进来的>', { turnId: 't4', entry: 'joined', addressed: true, topic: 'poke' }),
            turn('t4', { outcome: 'silent' }),
            notice('n6', '<开轮的通知>', { turnId: 't5', entry: 'opened' }),
            turn('t5', { outcome: 'silent' }),
            ended('n7', { turnId: 't6', entry: 'opened' }),
            turn('t6', { outcome: 'silent' }),
            userMessage('x1', '<被吞掉>', { speaker: member }),
          ],
          { session: room('s1', 'im-a') },
        ),
    });
    const log = within(await timeline());
    const metaOf = (text: string) =>
      [...(log.getByText(text).closest('.message, .notice')?.querySelectorAll('.message-meta') ?? [])].map(
        p => p.textContent,
      );
    expect(metaOf('<点名>')).toEqual(['开了这一轮 · 被点名']);
    expect(metaOf('<插话>')).toEqual(['开了这一轮 · 插话']);
    expect(metaOf('<没经判定>')).toEqual([]);
    expect(metaOf('<并进来>')).toEqual(['并入这一轮']);
    expect(metaOf('<戳她开的>')).toEqual(['开了这一轮 · 被点名']);
    expect(metaOf('<戳她并进来的>')).toEqual(['并入这一轮']);
    expect(metaOf('<开轮的通知>')).toEqual([]);
    expect(metaOf('<被吞掉>')).toEqual([]);
    const ends = log.getAllByRole('button', { name: /^后台任务 exec/ });
    expect(
      ends.map(line =>
        [...(line.closest('.task-notice')?.querySelectorAll('.message-meta') ?? [])].map(p => p.textContent),
      ),
    ).toEqual([['并入这一轮'], []]);
  });

  it('没有输入条目的一轮（空闲开话题）在段首写来源，刷新之后（回合条目排在回复之后）同样；有输入的一轮不写', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          agentMessage('a1', '<开个话题>', { turnId: 't1' }),
          turn('t1', { outcome: 'replied', source: 'idle-trigger' }),
          userMessage('u2', '<定时提醒>', {
            turnId: 't2',
            entry: 'opened',
            speaker: { platform: 'webui', source: 'scheduler', owner: false },
          }),
          turn('t2', { outcome: 'replied', source: 'scheduler' }),
          agentMessage('a2', '<提醒你>', { turnId: 't2' }),
        ]),
    });
    const log = await timeline();
    const lines = [...log.querySelectorAll('.message-meta, .message-text, .markdown')].map(node => node.textContent);
    expect(lines).toEqual(['来自 idle-trigger', '<开个话题>', '来自 scheduler', '<定时提醒>', '<提醒你>']);
  });

  it('排着的消息列在输入框上方：说话人、写的话、附件个数；进了一轮从列表移进时间线，列表空了不占位置', async () => {
    const member = { platform: 'onebot', userId: '20001', nickname: '小林', owner: false };
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot(
          [
            userMessage('u1', '<先说的>', { turnId: 't1', entry: 'opened' }),
            turn('t1'),
            queue([
              {
                speaker: { platform: 'webui', userId: 'console', owner: true },
                text: '<排着的>',
                attachments: 0,
              },
              { speaker: member, text: '<带图的>', attachments: 2 },
              { speaker: { platform: 'webui', source: 'scheduler', owner: false }, text: '<定时>', attachments: 0 },
            ]),
          ],
          { session: { running: true } },
        ),
    });
    await timeline();
    const list = () => main().queryByRole('list', { name: '排着的消息' });
    const rows = [...(list()?.querySelectorAll('li') ?? [])].map(li => li.textContent);
    expect(rows).toEqual(['你<排着的>', '小林<带图的>2 个附件', '来自 scheduler<定时>']);
    expect(within(await timeline()).queryByText('<排着的>'), '排着的还不在时间线上').toBeNull();

    act(() => push('completed', queue([])));
    act(() => push('completed', userMessage('u2', '<排着的>', { turnId: 't1', entry: 'joined' })));
    expect(list()).toBeNull();
    expect(within(await timeline()).getByText('<排着的>')).toBeTruthy();
  });

  it('会话头部在回合进行中有转动的运行指示，回合结束时消失', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '跑一下'), turn('t1')], { session: { running: true } }),
    });
    await timeline();
    const header = () => within(main().getByRole('heading', { name: '整理周报' }).closest('header') as HTMLElement);
    expect(header().getByRole('img', { name: '正在运行' })).toBeTruthy();
    act(() =>
      server().notify('sessions/changed', {
        upserts: [summary('s1', { title: '整理周报', running: false })],
        removes: [],
        groups: [],
      }),
    );
    expect(header().queryByRole('img', { name: '正在运行' })).toBeNull();
  });
});

describe('回滚放回输入框', () => {
  const rewound = (scope: string) => ({
    ok: true,
    restored: [],
    deleted: [],
    errors: [],
    alsoChangedBy: [],
    ...(scope === 'code-and-chat' ? { deletedMessages: 2, chatDeleted: true } : {}),
  });

  it('连对话一起回滚：那一轮 owner 的各条输入（开轮的与插进来的）空行连起来放回输入框，别人的不放，附件不放回、不自动发；只回滚文件时输入框不动', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          userMessage('u0', '上一轮的', { turnId: 't0', entry: 'opened' }),
          turn('t0', { outcome: 'replied' }),
          agentMessage('a0', '好', { turnId: 't0' }),
          userMessage('u1', '把配置改成生产的', {
            turnId: 't1',
            entry: 'opened',
            attachments: [{ kind: 'file', name: '配置.yaml' }],
          }),
          turn('t1', { outcome: 'replied' }),
          userMessage('u2', '别人插的话', {
            turnId: 't1',
            entry: 'joined',
            speaker: { platform: 'onebot', userId: '20001', owner: false },
          }),
          userMessage('u3', '顺便把日志级别也调低', { turnId: 't1', entry: 'joined' }),
          agentMessage('a1', '改好了', { turnId: 't1' }),
        ]),
      'turn/rewind': ({ scope }) => rewound(scope),
      'turn/send': () => ({}),
    });
    const log = within(await timeline());
    const box = main().getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    const rewind = async (item: string) => {
      fireEvent.click(log.getAllByRole('button', { name: '回滚这一轮' }).at(-1) as HTMLElement);
      fireEvent.click(screen.getByRole('menuitem', { name: item }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '回滚' }));
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    await rewind('回滚文件改动');
    expect(box.value).toBe('');
    await rewind('回滚文件改动与这一轮对话');
    expect(box.value).toBe('把配置改成生产的\n\n顺便把日志级别也调低');
    expect(main().queryByRole('list', { name: '附件' })).toBeNull();
    expect(requests('turn/send')).toEqual([]);
  });
});
