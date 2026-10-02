// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMethodResult } from '../../packages/api-session-protocol/src/index.js';
import { PRESENCE_WINDOW_MS, trackPresence } from '../../packages/plugin-webui-client/src/protocol/presence.js';
import {
  createSessionClient,
  type SessionClient,
} from '../../packages/plugin-webui-client/src/protocol/session-client.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';

// ════════════════════════════════════════════════════════════
// 在场上报：页面可见且最近 10 分钟有键盘或指针活动算在场。有活动时按需报在场，转到后台报不在场；
// 断线重连后，页面可见且 10 分钟内有过活动就立即重报，否则等下一次活动
// ════════════════════════════════════════════════════════════

const init: SessionMethodResult<'initialize'> = {
  protocolVersion: '1.0',
  experimental: true,
  server: { name: 'server' },
  identity: { platform: 'webui', userId: 'console' },
  surface: 'webui',
  features: { send: true, rewind: true, compress: true },
};

let client: SessionClient;
let stop: () => void;
let visibility: DocumentVisibilityState = 'visible';

/** 发出的在场上报，按先后 */
const reports = (socket = FakeWebSocket.last) =>
  socket.frames.filter(f => f.method === 'presence/update').map(f => f.params?.active);

async function connect(): Promise<FakeWebSocket> {
  const socket = FakeWebSocket.last;
  socket.open();
  socket.reply('initialize', init);
  await vi.waitFor(() => expect(client.state.status).toBe('open'));
  return socket;
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.install();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ authed: true })),
  );
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  client = createSessionClient();
  stop = trackPresence(client);
});

afterEach(() => {
  stop();
  client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('在场上报', () => {
  it('打开页面不算活动；键盘或指针活动报在场，持续活动时每分钟最多再报一次', async () => {
    const socket = await connect();
    expect(reports()).toEqual([]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    document.dispatchEvent(new Event('pointermove'));
    await vi.waitFor(() => expect(reports(socket)).toEqual([true]));
    await vi.advanceTimersByTimeAsync(59_000);
    document.dispatchEvent(new Event('pointerdown'));
    expect(reports(socket)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1_000);
    document.dispatchEvent(new Event('wheel'));
    await vi.waitFor(() => expect(reports(socket)).toEqual([true, true]));
  });

  it('转到后台报不在场；回到前台时 10 分钟内有过活动就报在场', async () => {
    const socket = await connect();
    document.dispatchEvent(new Event('pointerdown'));
    setVisibility('hidden');
    document.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(reports(socket)).toEqual([true, false]));
    setVisibility('visible');
    await vi.waitFor(() => expect(reports(socket)).toEqual([true, false, true]));

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS + 1);
    setVisibility('visible');
    await vi.waitFor(() => expect(reports(socket)).toEqual([true, false, true, false]));
    expect(reports(socket)).toEqual([true, false, true, false]);
  });

  it('重连后页面可见且 10 分钟内有过活动时立即重报在场', async () => {
    await connect();
    document.dispatchEvent(new Event('pointerdown'));
    FakeWebSocket.last.drop();
    // 断开期间的活动只记下时间，等连上再报
    document.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(1_000);
    const again = await connect();
    await vi.waitFor(() => expect(reports(again)).toEqual([true]));
  });

  it('补报的在场只到最近一次活动满 10 分钟为止：那时还没有新活动就报不在场，有新活动就照常', async () => {
    await connect();
    document.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    FakeWebSocket.last.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    const again = await connect();
    await vi.waitFor(() => expect(reports(again)).toEqual([true]));
    await vi.advanceTimersByTimeAsync(59_000 + 1);
    expect(reports(again)).toEqual([true, false]);

    document.dispatchEvent(new Event('keydown'));
    await vi.waitFor(() => expect(reports(again)).toEqual([true, false, true]));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    document.dispatchEvent(new Event('keydown'));
    await vi.waitFor(() => expect(reports(again)).toEqual([true, false, true, true]));

    // 报在场之后不到一分钟的活动不另报，满 10 分钟按这次活动算
    await vi.advanceTimersByTimeAsync(30_000);
    document.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS - 30_000 + 1);
    expect(reports(again)).toEqual([true, false, true, true]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reports(again)).toEqual([true, false, true, true, false]);
  });

  it('重连时最近一次活动已超过 10 分钟，或页面不可见，就不报，等下一次活动', async () => {
    await connect();
    document.dispatchEvent(new Event('pointerdown'));
    FakeWebSocket.last.drop();
    await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS + 1);
    const again = await connect();
    expect(reports(again)).toEqual([]);

    again.drop();
    document.dispatchEvent(new Event('pointerdown'));
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1_000);
    const third = await connect();
    expect(reports(third)).toEqual([]);
  });
});
