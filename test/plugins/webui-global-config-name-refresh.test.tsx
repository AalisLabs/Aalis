// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

// 只改应用名称时服务端不重启，名称由 /api/status 实时读取。全局配置保存成功后，界面要连同状态一起重拉，
// 否则名称要等 30 秒一次的轮询才更新。这里渲染真 App，只替换网络层、WebSocket、会话管理与两块首屏重组件；
// 聊天面板的替身把 App 传给它的 status.name 原样显示出来。

const server = vi.hoisted(() => ({
  name: 'OldName',
  slow: undefined as number | undefined,
  lastPut: undefined as unknown,
}));
const session = vi.hoisted(() => ({
  messages: [],
  setMessages: () => {},
  loading: false,
  setLoading: () => {},
  streamingRef: { current: false },
  refresh: () => {},
  handleHistoryChanged: () => {},
  activeSessionId: null,
  activeSessionTitle: '',
  isNewChat: true,
  pluginName: undefined,
  ensureSession: async () => {},
  startNewChat: () => {},
  switchSession: () => {},
}));

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (url === '/api/status') return { name: server.name };
    if (url === '/api/config' && method === 'GET') {
      return {
        name: server.name,
        logLevel: 'info',
        slowThresholdMs: server.slow,
        plugins: {},
        _schema: {
          name: { type: 'string', label: '应用名称' },
          slowThresholdMs: { type: 'number', label: '慢操作阈值（毫秒）' },
        },
      };
    }
    if (url === '/api/config' && method === 'PUT') {
      server.lastPut = JSON.parse(String(opts?.body));
      server.name = (server.lastPut as { name: string }).name;
      return { ok: true, message: '全局配置已更新并保存', ignored: [] };
    }
    if (url === '/api/pages')
      return [{ key: 'plugin-config', label: '插件配置', plugin: 'webui', renderer: 'plugin-config' }];
    if (url === '/api/plugins') return { plugins: [] };
    if (url === '/api/services') return { services: {} };
    if (url === '/api/auth/status') return { authed: false };
    if (url.startsWith('/api/logs/tail')) return [];
    throw new Error(`unexpected ${method} ${url}`);
  }),
  getSessionId: () => 'session-placeholder',
  pageAction: vi.fn(async () => []),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));
vi.mock('../../packages/plugin-webui-client/src/useWebSocket', () => ({
  useWebSocket: () => ({ send: () => {}, sendRaw: () => {}, connected: true }),
}));
vi.mock('../../packages/plugin-webui-client/src/useSessionManager', () => ({ useSessionManager: () => session }));
vi.mock('../../packages/plugin-webui-client/src/pages/ChatPanel', () => ({
  ChatPanel: ({ status }: { status: { name?: string } | null }) => (
    <div data-testid="app-name">{status?.name ?? ''}</div>
  ),
}));
vi.mock('../../packages/plugin-webui-client/src/pages/DashboardPage', () => ({ DashboardPage: () => null }));

import { App } from '../../packages/plugin-webui-client/src/App.js';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

it('只改应用名称并保存：不等轮询，界面上的名称随即更新', async () => {
  window.location.hash = '#plugin-config';
  render(<App />);
  expect((await screen.findByTestId('app-name')).textContent).toBe('OldName');

  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.change(await screen.findByDisplayValue('OldName'), { target: { value: 'NewName' } });
  fireEvent.click(screen.getByText('保存'));

  expect(await screen.findByText('全局配置已更新并保存'), '前置：保存走的是不重启的分支').toBeTruthy();
  await vi.waitFor(() => expect(screen.getByTestId('app-name').textContent).toBe('NewName'));
});

it('清空慢操作阈值后保存：这一项以 null 发出（JSON 会丢掉 undefined，服务端据 null 回到默认值）', async () => {
  server.slow = 30000;
  window.location.hash = '#plugin-config';
  render(<App />);

  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.change(await screen.findByDisplayValue('30000'), { target: { value: '' } });
  fireEvent.click(screen.getByText('保存'));

  await vi.waitFor(() => expect(server.lastPut).toBeDefined());
  expect((server.lastPut as Record<string, unknown>).slowThresholdMs).toBeNull();
});
