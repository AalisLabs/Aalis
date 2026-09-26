// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// AuthorityPage 组件测试（jsdom，数字等级）—— 锁死「输入不能是死的」：
// 渲染不崩 + 改用户等级输入真触发 setUserLevel、改整组等级真触发 setAuthorityOverride；
// 操作成功后显示服务端返回的 message（拒写附注靠它让 owner 看见），没有才用本地提示；
// 整组设最低等级汇总各条回执（撤销数、失败原因），无论成败都刷新。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
/** 各 action 的返回值（缺省 {}，即不带 message）；给函数时按调用参数取返回值，抛错即该次调用失败 */
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
    { key: 'exec', name: 'exec', type: 'tool', displayName: 'exec', pluginName: 'p', visibility: 'restricted' },
    { key: 'shell', name: 'shell', type: 'tool', displayName: 'shell', pluginName: 'p', visibility: 'restricted' },
  ],
};

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === 'getOverview') return OVERVIEW;
    const reply = replies[method];
    return typeof reply === 'function' ? reply(args) : (reply ?? {});
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

/**
 * 往等级输入框里输入并失焦提交。首屏数据到达后，输入框按 value 重置草稿的挂载副作用可能还没跑；负载高时它晚于输入
 * 执行，把草稿盖回原值，失焦就提交了旧值。输入没留住就重输，留住了在同一同步段里失焦提交。
 */
async function commitInput(title: string, value: string) {
  const input = (await screen.findByTitle(title)) as HTMLInputElement;
  await waitFor(() => {
    fireEvent.change(input, { target: { value } });
    expect(input.value, '输入被挂载副作用盖回').toBe(value);
    fireEvent.blur(input);
  });
}

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
    await commitInput('整数；越大越高，负数=封禁', '5');
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
    await commitInput('批量设置本组所有操作的最低等级', '3');
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

  const commitLevel = (value: string) => commitInput('整数；越大越高，负数=封禁', value);

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

// 回执直接取自真实的 plugin-authority 处理器：撤销数的字段名或形状在插件那边一改，这里就变红
describe('AuthorityPage 整组设最低等级', () => {
  const OWNER = { platform: 'webui', userId: 'console' };
  const STRANGER = { platform: 'onebot', userId: 'bob' };
  let app: App | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  /** 装上真插件，按 grants 给各能力建会话授予（alice 名下，每条一个会话）；返回真实的 setAuthorityOverride 处理器 */
  async function realOverride(grants: Record<string, number> = {}): Promise<WebuiActionHandler> {
    const hosted = hostedApp();
    app = hosted.app;
    const host = app.bind({ provide, authority });
    const actions = new Map<string, WebuiActionHandler>();
    host.provide(webuiServer, {
      registerPage: () => () => {},
      registerAction: (method: string, handler: WebuiActionHandler) => {
        actions.set(method, handler);
        return () => void actions.delete(method);
      },
    } as never);
    await app.plugins.idle();
    await app.plugin(authorityPlugin, {});
    const manager = host.authority.current;
    const handler = actions.get('setAuthorityOverride');
    if (!manager || !handler) throw new Error('authority 没起来');
    manager.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
    for (const [capability, n] of Object.entries(grants)) {
      for (let i = 0; i < n; i++) {
        const name = capability.slice(capability.indexOf(':') + 1);
        const req = {
          name,
          type: 'tool',
          capability,
          sessionId: `s${i}`,
          platform: 'onebot',
          userId: 'alice',
        } as const;
        if (!(await manager.requestAccess(req))) throw new Error('前置：会话授予没建起来');
      }
    }
    return handler;
  }

  async function commitGroupLevel(value: string) {
    await screen.findByTitle('批量设置本组所有操作的最低等级');
    const overviews = calls.filter(c => c.method === 'getOverview').length;
    await commitInput('批量设置本组所有操作的最低等级', value);
    return overviews;
  }

  const refreshedAfter = (overviews: number) =>
    waitFor(() =>
      expect(calls.filter(c => c.method === 'getOverview').length, '整组操作落定后没有刷新').toBe(overviews + 1),
    );

  it('全部成功：提示里带各条回执撤销数的合计', async () => {
    const override = await realOverride({ 'tool:weather': 2, 'tool:exec': 1 });
    replies.setAuthorityOverride = (args: Record<string, unknown>) => override(args, OWNER);
    render(<AuthorityPage />);
    const overviews = await commitGroupLevel('3');
    expect(await screen.findByText('整组最低等级已更新（已撤销 3 条相关会话授予）')).toBeTruthy();
    await refreshedAfter(overviews);
  });

  it('部分失败：列出成功与失败的条数、撤销数与失败原因，并照常刷新', async () => {
    const override = await realOverride({ 'tool:weather': 2, 'tool:exec': 1 });
    replies.setAuthorityOverride = (args: Record<string, unknown>) => {
      if (args.name === 'tool:shell') throw new Error('未写入配置文件');
      return override(args, OWNER);
    };
    render(<AuthorityPage />);
    const overviews = await commitGroupLevel('3');
    expect(
      await screen.findByText('整组最低等级：2 项已更新（已撤销 3 条相关会话授予），1 项失败：未写入配置文件'),
    ).toBeTruthy();
    await refreshedAfter(overviews);
  });

  it('全部失败：相同的失败原因只列一次，照常刷新', async () => {
    const override = await realOverride();
    replies.setAuthorityOverride = (args: Record<string, unknown>) => override(args, STRANGER);
    render(<AuthorityPage />);
    const overviews = await commitGroupLevel('3');
    expect(await screen.findByText('整组最低等级：0 项已更新，3 项失败：只有 owner 可管理权限')).toBeTruthy();
    await refreshedAfter(overviews);
  });
});
