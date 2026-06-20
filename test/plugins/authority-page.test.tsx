// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ════════════════════════════════════════════════════════════
// AuthorityPage 组件测试（jsdom，档位）—— 锁死「按钮不能是死的」：
// 渲染不崩 + 点档位按钮真触发 setUserTier、点整组真触发 setTierOverride。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

const OVERVIEW = {
  users: [{ platform: 'onebot', userId: '123', isOwner: false, tier: 'visitor' }],
  owners: [],
  platforms: ['onebot', 'webui'],
  deniedCapabilities: [],
  tierOverrides: {},
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

describe('AuthorityPage 渲染 + 档位按钮可点', () => {
  it('挂载后拉 getOverview，渲染「用户」「操作」两视图（不崩白）', async () => {
    render(<AuthorityPage />);
    await waitFor(() => expect(calls.some(c => c.method === 'getOverview')).toBe(true));
    expect(await screen.findByText(/用户（外部身份/)).toBeTruthy();
    expect(screen.getByText(/操作（指令/)).toBeTruthy();
  });

  it('点用户「封禁」档 → 触发 setUserTier(banned)（按钮不是死的）', async () => {
    render(<AuthorityPage />);
    await screen.findByText(/用户（外部身份/);
    fireEvent.click(await screen.findByText('封禁')); // 封禁仅出现在用户档位段，唯一
    await waitFor(() => expect(calls.some(c => c.method === 'setUserTier')).toBe(true));
    expect(calls.find(c => c.method === 'setUserTier')?.args).toMatchObject({
      platform: 'onebot',
      userId: '123',
      tier: 'banned',
    });
  });

  it('点操作整组「信任」→ 触发 setTierOverride', async () => {
    render(<AuthorityPage />);
    await screen.findByText(/操作（指令/);
    // 「信任」出现在 用户档位段[0] 与 操作整组[1]；点整组那个
    const trusted = await screen.findAllByText('信任');
    fireEvent.click(trusted[trusted.length - 1]);
    await waitFor(() => expect(calls.some(c => c.method === 'setTierOverride')).toBe(true));
    expect(calls.find(c => c.method === 'setTierOverride')?.args).toMatchObject({ name: 'tool:weather', tier: 2 });
  });
});
