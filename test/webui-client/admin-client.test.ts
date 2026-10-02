// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdminClient, createAdminClient } from '../../packages/plugin-webui-client/src/protocol/admin-client.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';

// 管理面客户端：连 /admin，按事件名分给登记的处理函数；事件只是「变了」的信号，断线期间丢的不补发，
// 所以重连上以后通知调用方重取

let client: AdminClient;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.install();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ authed: true })),
  );
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('管理面客户端', () => {
  it('连到页面所在源的 /admin，事件按名字分发', async () => {
    client = createAdminClient();
    const socket = FakeWebSocket.last;
    expect(socket.url).toBe('ws://localhost:3000/admin');
    const changed = vi.fn();
    const reload = vi.fn();
    client.on('plugins.changed', changed);
    client.on('client.reload', reload);
    socket.open();
    await vi.waitFor(() => expect(client.state.status).toBe('open'));
    socket.push({ type: 'plugins.changed' });
    socket.push({ type: 'client.reload' });
    socket.push({ type: 'app.restarting' });
    expect(changed).toHaveBeenCalledWith({ type: 'plugins.changed' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('重连上以后通知调用方重取，第一次连上不算', async () => {
    client = createAdminClient();
    const reconnected = vi.fn();
    client.onReconnect(reconnected);
    FakeWebSocket.last.open();
    await vi.waitFor(() => expect(client.state.status).toBe('open'));
    expect(reconnected).not.toHaveBeenCalled();

    FakeWebSocket.last.drop(1006);
    expect(client.state.status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.last.open();
    await vi.waitFor(() => expect(client.state.status).toBe('open'));
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it('连接状态的变化通知订阅者', async () => {
    client = createAdminClient();
    const states: string[] = [];
    client.onState(state => states.push(state.status));
    FakeWebSocket.last.open();
    await vi.waitFor(() => expect(states).toEqual(['open']));
    FakeWebSocket.last.drop();
    expect(states).toEqual(['open', 'retrying']);
  });
});
