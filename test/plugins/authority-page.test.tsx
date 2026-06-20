// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ════════════════════════════════════════════════════════════
// AuthorityPage 组件测试（jsdom，数字等级）—— 锁死「输入不能是死的」：
// 渲染不崩 + 改用户等级输入真触发 setUserLevel、改整组等级真触发 setAuthorityOverride。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

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
    return method === 'getOverview' ? OVERVIEW : {};
  }),
  api: vi.fn(),
  proxiedMediaUrl: (s: string) => s,
}));

import { AuthorityPage } from '../../packages/plugin-webui-client/src/pages/AuthorityPage.js';

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => cleanup());

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
