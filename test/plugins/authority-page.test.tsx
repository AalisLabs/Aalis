// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ════════════════════════════════════════════════════════════
// AuthorityPage 组件测试（jsdom）—— 锁死「按钮不能是死的」：
// 渲染不崩 + 点击按钮真的触发 pageAction（用户反复反馈"按钮点不动"，本测试守门）。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

const OVERVIEW = {
  users: [{ platform: 'onebot', userId: '123', isOwner: false }],
  owners: [],
  platforms: ['onebot', 'webui'],
  deniedCapabilities: [],
  visibilityOverrides: {},
  confirmOverrides: {},
  restrictedPolicy: {},
  temporaryGrants: [],
  commandPrefix: '/',
  commands: [],
  tools: [
    { key: 'weather', name: 'weather', type: 'tool', displayName: 'weather', pluginName: 'p', visibility: 'public' },
  ],
};

// AuthorityPage 内 `import { pageAction } from '../api'`；按解析到的同一模块路径打桩。
vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    return method === 'getOverview' ? OVERVIEW : {};
  }),
  // 组件其余 api（若被树摇引用）给空壳，避免导入副作用
  api: vi.fn(),
  proxiedMediaUrl: (s: string) => s,
}));

import { AuthorityPage } from '../../packages/plugin-webui-client/src/pages/AuthorityPage.js';

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => cleanup());

describe('AuthorityPage 渲染 + 按钮可点', () => {
  it('挂载后拉 getOverview，渲染「操作」「用户」两视图（不崩白）', async () => {
    render(<AuthorityPage />);
    await waitFor(() => expect(calls.some(c => c.method === 'getOverview')).toBe(true));
    expect(await screen.findByText(/操作（指令/)).toBeTruthy();
    expect(screen.getByText(/用户（外部身份/)).toBeTruthy();
  });

  it('点「整组·受限」→ 触发 setVisibilityOverride（按钮不是死的）', async () => {
    render(<AuthorityPage />);
    await screen.findByText(/操作（指令/);
    const restrictedBtn = await screen.findByText('受限');
    fireEvent.click(restrictedBtn);
    await waitFor(() =>
      expect(calls.some(c => c.method === 'setVisibilityOverride' && c.args.visibility === 'restricted')).toBe(true),
    );
    const call = calls.find(c => c.method === 'setVisibilityOverride');
    expect(call?.args.name).toBe('tool:weather');
  });

  it('点用户预设「封禁」→ 触发 setUserCapabilities(deny:[*])', async () => {
    render(<AuthorityPage />);
    await screen.findByText(/用户（外部身份/);
    fireEvent.click(await screen.findByText('封禁'));
    await waitFor(() => expect(calls.some(c => c.method === 'setUserCapabilities')).toBe(true));
    const call = calls.find(c => c.method === 'setUserCapabilities');
    expect(call?.args).toMatchObject({ platform: 'onebot', userId: '123', deny: ['*'] });
  });
});
