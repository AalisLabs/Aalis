// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ════════════════════════════════════════════════════════════
// AuthorityPage 组件测试（jsdom，数字等级）—— 锁死「输入不能是死的」：
// 渲染不崩 + 改用户等级输入真触发 setUserLevel、改整组等级真触发 setAuthorityOverride；
// 操作成功后显示服务端返回的 message（拒写附注靠它让 owner 看见），没有才用本地提示。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
/** 各 action 的返回值（缺省 {}，即不带 message） */
const replies: Record<string, unknown> = {};

const OVERVIEW = {
  users: [{ platform: 'onebot', userId: '123', isOwner: false, level: 2 }],
  owners: [],
  platforms: ['onebot', 'webui'],
  deniedCapabilities: [],
  authorityOverrides: {},
  defaultAuthority: 0,
  confirmOverrides: {},
  restrictedPolicy: {},
  temporaryGrants: [],
  commandPrefix: '/',
  commands: [],
  tools: [
    { key: 'weather', name: 'weather', type: 'tool', displayName: 'weather', pluginName: 'p', visibility: 'public' },
  ],
};

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    return method === 'getOverview' ? OVERVIEW : (replies[method] ?? {});
  }),
  api: vi.fn(),
  proxiedMediaUrl: (s: string) => s,
}));

import { AuthorityPage } from '../../packages/plugin-webui-client/src/pages/AuthorityPage.js';

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(replies)) delete replies[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AuthorityPage 渲染 + 等级输入可用', () => {
  it('挂载后拉 getOverview，渲染「用户」「操作」两视图（不崩白）', async () => {
    render(<AuthorityPage />);
    await waitFor(() => expect(calls.some(c => c.method === 'getOverview')).toBe(true));
    expect(await screen.findByText(/用户（外部身份/)).toBeTruthy();
    expect(screen.getByText(/操作（指令/)).toBeTruthy();
  });

  it('改用户等级输入 → 触发 setUserLevel（输入不是死的）', async () => {
    render(<AuthorityPage />);
    await screen.findByText(/用户（外部身份/);
    const input = await screen.findByTitle('整数；越大越高，负数=封禁');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.some(c => c.method === 'setUserLevel')).toBe(true));
    expect(calls.find(c => c.method === 'setUserLevel')?.args).toMatchObject({
      platform: 'onebot',
      userId: '123',
      level: 5,
    });
  });

  it('改整组等级 → 触发 setAuthorityOverride', async () => {
    render(<AuthorityPage />);
    await screen.findByText(/操作（指令/);
    const groupInput = await screen.findByTitle('批量设置本组所有操作的最低等级');
    fireEvent.change(groupInput, { target: { value: '3' } });
    fireEvent.blur(groupInput);
    await waitFor(() => expect(calls.some(c => c.method === 'setAuthorityOverride')).toBe(true));
    expect(calls.find(c => c.method === 'setAuthorityOverride')?.args).toMatchObject({
      name: 'tool:weather',
      level: 3,
    });
  });
});

describe('AuthorityPage 操作提示', () => {
  const NOTE = '；仅本次运行生效，未写入 users.json（加载失败，见日志）';

  /**
   * 首屏数据与输入框的挂载副作用先用真计时器跑完，再换假计时器量提示时长。假计时器会接管 React 调度
   * 挂载副作用用的 setImmediate：负载高时，输入框同步 value 的挂载副作用可能晚于下面的输入，把草稿重置回原值。
   */
  async function renderThenFakeTimers() {
    render(<AuthorityPage />);
    await screen.findByTitle('整数；越大越高，负数=封禁');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  }

  async function commitLevel(value: string) {
    const input = await screen.findByTitle('整数；越大越高，负数=封禁');
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }

  it('setUserLevel / deleteUser 返回带附注的 message：页面显示这段 message，而不是本地的成功提示', async () => {
    replies.setUserLevel = { message: `onebot:123 等级已更新为 -1${NOTE}` };
    replies.deleteUser = { message: `onebot:123 记录已删除${NOTE}` };
    render(<AuthorityPage />);

    await commitLevel('-1');
    expect(await screen.findByText(`onebot:123 等级已更新为 -1${NOTE}`)).toBeTruthy();
    expect(screen.queryByText('已设等级: -1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText(`onebot:123 记录已删除${NOTE}`)).toBeTruthy();
    expect(screen.queryByText('已删除')).toBeNull();
  });

  it('返回值不带字符串 message 时退回本地提示', async () => {
    replies.setUserLevel = { message: 42 };
    render(<AuthorityPage />);
    await commitLevel('5');
    expect(await screen.findByText('已设等级: 5')).toBeTruthy();
  });

  it('带附注的长提示停留更久：过了短提示的 2200ms 仍在，按字数到时才清掉', async () => {
    const text = `onebot:123 等级已更新为 -1${NOTE}`;
    replies.setUserLevel = { message: text };
    await renderThenFakeTimers();
    await commitLevel('-1');
    await screen.findByText(text);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText(text), '附注在短提示的时长内就被清掉，owner 来不及读').not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(text.length * 100);
    });
    expect(screen.queryByText(text)).toBeNull();
  });

  it('新提示顶掉旧提示时，旧提示的计时不会把新提示提前清掉', async () => {
    const text = `onebot:123 记录已删除${NOTE}`;
    replies.deleteUser = { message: text };
    await renderThenFakeTimers();
    await commitLevel('5');
    await screen.findByText('已设等级: 5');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await screen.findByText(text);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText(text), '第一条提示的 2200ms 计时已到，不该清掉后来的附注').not.toBeNull();
  });
});
