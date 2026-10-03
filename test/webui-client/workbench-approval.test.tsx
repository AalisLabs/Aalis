// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { type Harness, INIT, installDialog, main, renderApp, requests, server } from './harness.js';
import { approval, push, snapshot, toolCall, turn, userMessage } from './items.js';

// ════════════════════════════════════════════════════════════
// 审批卡：挂在工具卡下面，事实取会话服务按展示种类给出的命令、目录与 diff，没声明的逐字列出全部参数，显示前一律清洗、
// 完整列出不限高；只有批准与拒绝（拒绝可附理由），不显示倒计时，出现时不抢输入框的焦点；结算后收成工具行上的一句
// （结果、原因与时间），刷新后从条目恢复；标签页标题是握手给的应用名，有未结审批时带上待处理数
// ════════════════════════════════════════════════════════════

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 3, 15, 0));
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  stubViewport(1440);
  document.title = 'Aalis';
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
const card = () => within(screen.getByRole('region', { name: '审批' }));

const exec = toolCall('c1', 'exec', {
  status: 'running',
  args: { command: 'npm run lint', cwd: '/repo' },
  display: { kind: 'command', command: 'npm run lint', cwd: '/repo' },
  approvalId: 'ap1',
});
const execApproval = approval('ap1', { facts: { command: 'npm run lint', cwd: '/repo', params: {} } });

describe('审批卡', () => {
  it('挂在工具卡下面：标题带工具名，命令与目录，只有批准与拒绝两种决定（拒绝可附理由），没有倒计时；工具行写「等你批准」', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([turn('t1'), exec], { approvals: [execApproval] }),
    });
    const log = within(await timeline());
    expect(log.getByRole('button', { name: /执行 npm run lint/ }).textContent).toContain('等你批准');
    expect(card().getByText('要执行一条命令 · exec')).toBeTruthy();
    expect(card().getByText('npm run lint')).toBeTruthy();
    expect(card().queryByText(/超出的部分在框内滚动/)).toBeNull();
    expect(card().getByText('/repo')).toBeTruthy();
    expect(
      card()
        .getAllByRole('button')
        .map(button => button.textContent),
    ).toEqual(['批准', '拒绝', '拒绝并附理由']);
    expect(card().queryByText(/秒后/)).toBeNull();
  });

  it('改文件的审批给出路径与 diff；疑似含密钥的只给路径；没声明展示的逐字列出全部参数，显示前经过清洗', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot(
          [
            turn('t1'),
            toolCall('c1', 'file_write', { status: 'running', approvalId: 'ap1' }),
            toolCall('c2', 'file_write', { status: 'running', approvalId: 'ap2' }),
            toolCall('c3', 'web_fetch', { status: 'running', approvalId: 'ap3' }),
          ],
          {
            approvals: [
              approval('ap1', {
                tool: 'file_write',
                facts: { diff: { path: 'src/a.ts', patch: '-old\n+new' }, params: {} },
              }),
              approval('ap2', { tool: 'file_write', callId: 'c2', facts: { diff: { path: '.env' }, params: {} } }),
              approval('ap3', {
                tool: 'web_fetch',
                callId: 'c3',
                facts: { params: { url: 'https://a.example/‮gnp.exe', depth: 2 } },
              }),
            ],
          },
        ),
    });
    await timeline();
    const [diff, secret, generic] = screen.getAllByRole('region', { name: '审批' }).map(node => within(node));
    expect(diff.getByText('要改动文件 · file_write')).toBeTruthy();
    expect(diff.getByText('src/a.ts')).toBeTruthy();
    expect(diff.getByText('-old')).toBeTruthy();
    expect(diff.getByText('+new')).toBeTruthy();
    expect(secret.getByText('.env')).toBeTruthy();
    expect(secret.getByText(/疑似含密钥/)).toBeTruthy();
    expect(generic.getByText('要调用 web_fetch')).toBeTruthy();
    const params = generic.getByText(/"depth": 2/).textContent ?? '';
    expect(params).toContain('⟨U+202E⟩');
    expect(params).not.toContain('‮');
  });

  it('卡上的命令、参数与 diff 完整显示，不设行数上限、不在框内滚动：长串空白后面的半截照样在卡上', async () => {
    const hidden = `echo ok${' '.repeat(500)}&& rm -rf ~`;
    const script = Array.from({ length: 8 }, (_, i) => `step ${i}`).join('\n');
    const patch = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join('\n');
    const params = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, i]));
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot(
          [
            turn('t1'),
            toolCall('c1', 'exec', { status: 'running', approvalId: 'ap1' }),
            toolCall('c2', 'exec', { status: 'running', approvalId: 'ap2' }),
            toolCall('c3', 'file_write', { status: 'running', approvalId: 'ap3' }),
            toolCall('c4', 'web_fetch', { status: 'running', approvalId: 'ap4' }),
          ],
          {
            approvals: [
              approval('ap1', { facts: { command: hidden, params: {} } }),
              approval('ap2', { callId: 'c2', facts: { command: script, params: {} } }),
              approval('ap3', {
                callId: 'c3',
                tool: 'file_write',
                facts: { diff: { path: 'a.txt', patch }, params: {} },
              }),
              approval('ap4', { callId: 'c4', tool: 'web_fetch', facts: { params } }),
            ],
          },
        ),
    });
    await timeline();
    const cards = screen.getAllByRole('region', { name: '审批' });
    const [long, lines, diff, generic] = cards.map(node => within(node));
    expect(long.getByText(hidden, { normalizer: text => text })).toBeTruthy();
    expect(lines.getByText(script, { normalizer: text => text })).toBeTruthy();
    expect(diff.getAllByText(/^\+line \d+$/)).toHaveLength(30);
    expect(generic.getByText(/"key19": 19/)).toBeTruthy();
    for (const card of cards) expect(card.textContent).not.toMatch(/滚动|共 \d+ 行/);
  });

  it('批准与拒绝发 approval/respond，带回内容哈希；拒绝可附理由', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([turn('t1'), exec, toolCall('c2', 'exec', { status: 'running', approvalId: 'ap2' })], {
          approvals: [execApproval, approval('ap2', { callId: 'c2' })],
        }),
      'approval/respond': () => ({}),
    });
    await timeline();
    const [first, second] = screen.getAllByRole('region', { name: '审批' }).map(node => within(node));
    fireEvent.click(first.getByRole('button', { name: '批准' }));
    await vi.waitFor(() =>
      expect(requests('approval/respond')).toEqual([
        { approvalId: 'ap1', decision: 'approve', contentHash: 'hash-ap1' },
      ]),
    );
    fireEvent.click(second.getByRole('button', { name: '拒绝并附理由' }));
    fireEvent.change(second.getByRole('textbox', { name: '拒绝的理由' }), { target: { value: '写错了' } });
    fireEvent.click(second.getByRole('button', { name: '取消' }));
    fireEvent.click(second.getByRole('button', { name: '拒绝并附理由' }));
    expect((second.getByRole('textbox', { name: '拒绝的理由' }) as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(second.getByRole('textbox', { name: '拒绝的理由' }), { target: { value: '先别动生产' } });
    fireEvent.click(second.getByRole('button', { name: '拒绝' }));
    await vi.waitFor(() =>
      expect(requests('approval/respond')[1]).toEqual({
        approvalId: 'ap2',
        decision: 'deny',
        contentHash: 'hash-ap2',
        note: '先别动生产',
      }),
    );
  });

  it('在拒绝的理由里按 Esc 收起理由框，不停掉这一轮', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([turn('t1'), exec], { approvals: [execApproval], session: { running: true } }),
      'turn/abort': () => ({}),
    });
    await timeline();
    fireEvent.click(card().getByRole('button', { name: '拒绝并附理由' }));
    const reason = card().getByRole('textbox', { name: '拒绝的理由' });
    fireEvent.change(reason, { target: { value: '写错了' } });
    fireEvent.keyDown(reason, { key: 'Escape' });
    expect(card().queryByRole('textbox', { name: '拒绝的理由' })).toBeNull();
    expect(card().getByRole('button', { name: '拒绝并附理由' })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(requests('turn/abort')).toEqual([]);
  });

  it('应答时审批已经结算（别处先答了）不算出错：等结算的推送', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([turn('t1'), exec], { approvals: [execApproval] }),
      'approval/respond': () => {
        throw Object.assign(new Error('这个审批已经结算'), { code: 'approval-settled' });
      },
    });
    await timeline();
    fireEvent.click(card().getByRole('button', { name: '批准' }));
    await vi.waitFor(() => expect(requests('approval/respond')).toHaveLength(1));
    await vi.waitFor(() =>
      expect((card().getByRole('button', { name: '批准' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(card().queryByRole('alert')).toBeNull();
  });

  it('应答被拒（内容哈希对不上）时原因写在卡上', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([turn('t1'), exec], { approvals: [execApproval] }),
      'approval/respond': () => {
        throw Object.assign(new Error('内容哈希对不上'), { code: 'hash-mismatch' });
      },
    });
    await timeline();
    fireEvent.click(card().getByRole('button', { name: '拒绝' }));
    expect((await card().findByRole('alert')).textContent).toContain('内容哈希对不上');
  });

  it('推来时不抢输入框的焦点；结算后收成工具行上的一句，卡片消失', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([userMessage('u1', '检查一下'), turn('t1')]),
    });
    await timeline();
    const input = main().getByRole('textbox', { name: '消息' });
    input.focus();
    act(() => push('started', exec));
    act(() => server().notify('approval/requested', { approval: execApproval }));
    expect(card().getByText('npm run lint')).toBeTruthy();
    expect(document.activeElement).toBe(input);

    const at = new Date(2026, 9, 3, 10, 35).getTime();
    act(() => server().notify('approval/settled', { approvalId: 'ap1', state: 'expired', source: 'absent', at }));
    act(() => push('started', { ...exec, status: 'denied', settlement: { state: 'expired', source: 'absent', at } }));
    expect(screen.queryByRole('region', { name: '审批' })).toBeNull();
    expect(main().getByRole('button', { name: /执行 npm run lint/ }).textContent).toContain(
      '已按拒绝 · 没人在场 · 10:35',
    );
  });

  it('快照里的审批：工具卡带上结算后卡片收起，这条连接没收到 approval/settled 也一样', async () => {
    app = await renderApp('/s/s1', {
      'session/subscribe': () => snapshot([turn('t1'), exec], { approvals: [execApproval] }),
    });
    await timeline();
    expect(card().getByText('npm run lint')).toBeTruthy();
    const at = new Date(2026, 9, 3, 10, 40).getTime();
    act(() => push('started', { ...exec, status: 'denied', settlement: { state: 'expired', source: 'timeout', at } }));
    expect(screen.queryByRole('region', { name: '审批' })).toBeNull();
    expect(main().getByRole('button', { name: /执行 npm run lint/ }).textContent).toContain(
      '已按拒绝 · 等待超时 · 10:40',
    );
  });

  it('刷新后从条目恢复结算：批准、owner 拒绝与撤销各写成一句', async () => {
    const at = new Date(2026, 9, 3, 9, 5).getTime();
    app = await renderApp('/s/s1', {
      'session/subscribe': () =>
        snapshot([
          toolCall('c1', 'exec', {
            display: { kind: 'command', command: 'make' },
            approvalId: 'ap1',
            settlement: { state: 'approved', source: 'owner', at },
          }),
          toolCall('c2', 'exec', {
            status: 'denied',
            display: { kind: 'command', command: 'rm -rf build' },
            approvalId: 'ap2',
            settlement: { state: 'denied', source: 'owner', at },
          }),
          toolCall('c3', 'exec', {
            status: 'denied',
            display: { kind: 'command', command: 'sleep 9' },
            approvalId: 'ap3',
            settlement: { state: 'cancelled', source: 'turn-ended', at },
          }),
        ]),
    });
    const log = within(await timeline());
    expect(log.getByRole('button', { name: /执行 make/ }).textContent).toContain('已批准 · 09:05');
    expect(log.getByRole('button', { name: /执行 rm -rf build/ }).textContent).toContain('已拒绝 · 09:05');
    expect(log.getByRole('button', { name: /执行 sleep 9/ }).textContent).toContain('已撤销 · 回合已结束 · 09:05');
    expect(screen.queryByRole('region', { name: '审批' })).toBeNull();
  });

  it('标签页标题是握手给的应用名，有推来的未结审批时带上待处理数，结算后去掉；连接断开时清空', async () => {
    app = await renderApp('/s/s1', {
      initialize: () => ({ ...INIT, appName: '<应用名>' }),
      'session/subscribe': () => snapshot([]),
    });
    await timeline();
    expect(document.title).toBe('<应用名>');
    act(() => server().notify('approval/requested', { approval: execApproval }));
    act(() => server().notify('approval/requested', { approval: approval('ap2', { sessionId: 'other' }) }));
    expect(document.title).toBe('(2) <应用名>');
    act(() => server().notify('approval/settled', { approvalId: 'ap1', state: 'approved', source: 'owner', at: 0 }));
    expect(document.title).toBe('(1) <应用名>');
    act(() => server().drop());
    expect(document.title).toBe('<应用名>');
  });
});
