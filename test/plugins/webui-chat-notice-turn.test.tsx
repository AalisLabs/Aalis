// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../packages/plugin-webui-client/src/types.js';

// 她自己开的回合（后台命令结束通知等）不是从输入框发起的：客户端没有先 setLoading(true)，以前整轮都不显示停止键，
// 工具调用还会接到上一条已完成的助手回复上。收到流式片段或工具调用开始时点亮 loading，工具调用只接到进行中的
// 流式气泡上。这里渲染真 App，只替换网络层、WebSocket、两块首屏重组件；会话管理用真 state 的替身，
// 聊天面板的替身把 loading 与消息的时间线原样显示出来。

const ws = vi.hoisted(() => ({ handlers: undefined as unknown as Record<string, (...args: unknown[]) => void> }));

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async (url: string) => {
    if (url === '/api/status') return { name: 'Aalis' };
    if (url === '/api/config') return { name: 'Aalis', plugins: {} };
    if (url === '/api/pages') return [];
    if (url === '/api/plugins') return { plugins: [] };
    if (url === '/api/services') return { services: {} };
    if (url === '/api/auth/status') return { authed: false };
    if (url.startsWith('/api/logs/tail')) return [];
    return {};
  }),
  getSessionId: () => 'zz-slice1-webui-session',
  pageAction: vi.fn(async () => []),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));
vi.mock('../../packages/plugin-webui-client/src/useWebSocket', () => ({
  useWebSocket: (handlers: Record<string, (...args: unknown[]) => void>) => {
    ws.handlers = handlers;
    return { send: () => {}, sendRaw: () => {}, connected: true };
  },
}));
vi.mock('../../packages/plugin-webui-client/src/useSessionManager', async () => {
  const React = await import('react');
  const initial: ChatMessage[] = [
    { role: 'user', content: '在后台跑测试', timestamp: 1 },
    { role: 'assistant', content: '起好了', segments: [{ type: 'text', content: '起好了' }], timestamp: 2 },
  ];
  return {
    useSessionManager: () => {
      const [messages, setMessages] = React.useState<ChatMessage[]>(initial);
      const [loading, setLoading] = React.useState(false);
      const streamingRef = React.useRef(false);
      return {
        messages,
        setMessages,
        loading,
        setLoading,
        streamingRef,
        refresh: () => {},
        handleHistoryChanged: () => {},
        activeSessionId: 'zz-slice1-webui-session',
        activeSessionTitle: '',
        isNewChat: false,
        pluginName: undefined,
        ensureSession: async () => {},
        startNewChat: () => {},
        switchSession: () => {},
      };
    },
  };
});
vi.mock('../../packages/plugin-webui-client/src/pages/ChatPanel', () => ({
  ChatPanel: ({ loading, messages }: { loading: boolean; messages: ChatMessage[] }) => (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="timeline">
        {JSON.stringify(messages.map(m => [m.role, (m.segments ?? []).map(s => s.type)]))}
      </div>
    </div>
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
  window.requestAnimationFrame ??= (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame ??= (id: number) => window.clearTimeout(id);
});
afterEach(cleanup);

const timeline = () => JSON.parse(screen.getByTestId('timeline').textContent ?? '[]') as Array<[string, string[]]>;

it('没有从输入框发起的回合：流式片段到达即显示停止键', async () => {
  render(<App />);
  expect((await screen.findByTestId('loading')).textContent).toBe('false');
  act(() => ws.handlers.onStream('后台测试结束了'));
  expect(screen.getByTestId('loading').textContent).toBe('true');
});

it('上一条助手回复已完成时，工具调用开始另起一条助手消息，并显示停止键', async () => {
  render(<App />);
  expect((await screen.findByTestId('loading')).textContent).toBe('false');
  act(() => ws.handlers.onToolCall('process_read', { processId: 'proc_0a1b2c_1' }, 'start'));
  expect(screen.getByTestId('loading').textContent).toBe('true');
  expect(timeline()).toEqual([
    ['user', []],
    ['assistant', ['text']],
    ['assistant', ['tool_call']],
  ]);
});
