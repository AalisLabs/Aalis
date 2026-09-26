import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { App, events, type Logger, lifecycle, provide } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import onebot from '../../packages/plugin-adapter-onebot/src/index.js';
import contributionsPlugin from '../../packages/plugin-contributions/src/index.js';

// ════════════════════════════════════════════════════════════
// onebot 关闭一开始（lifecycle.signal 已断）就不再重连：scheduleReconnect 不排新定时器，已排的定时器
// 到点时 doConnect 不再建连接。signal 在本激活收尾段入口断开；这里让宿主根绑定 platform（required），
// 根的收尾因此排在 onebot 收尾之后、撤回之前——两者之间 onebot 已断、清理段还没跑，正是这两处检查守的窗口。
// 连的是进程内起在 127.0.0.1 的 ws 服务端，不连任何外部服务。
// ════════════════════════════════════════════════════════════

/** 用到的 ws 服务端面（ws 是 onebot 包的依赖，test/ 解析不到它的类型） */
interface WsServer {
  once(event: 'listening', listener: () => void): void;
  on(event: 'connection', listener: (socket: { terminate(): void }) => void): void;
  address(): AddressInfo;
  close(callback: () => void): void;
}
const { WebSocketServer } = createRequire(
  new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url),
)('ws') as { WebSocketServer: new (options: { port: number; host: string }) => WsServer };

// 轮询用 setImmediate：第二个用例假了 setTimeout
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(onRootDrain: (h: { dropClient: () => void; lines: string[] }) => Promise<void>) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const sockets: Array<{ terminate(): void }> = [];
  server.on('connection', socket => void sockets.push(socket));
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const logger: Logger = { debug() {}, info: record, warn: record, error: record, child: () => logger };
  const app = new App({ name: 'T', logger, devMode: false });
  cleanups.push(() => app.stop());
  const root = app.bind({ provide, events, lifecycle, platform });
  root.provide(storage, {} as never);
  root.provide(processService, {} as never);
  const dropClient = () => {
    for (const socket of sockets.splice(0)) socket.terminate();
  };
  root.lifecycle.onDrain(() => onRootDrain({ dropClient, lines }));
  const url = `ws://127.0.0.1:${server.address().port}`;
  await app.pluginAll([
    { definition: contributionsPlugin },
    { definition: onebot, config: { connections: [{ url }] } },
  ]);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(onebot.name)?.state).toBe('active');
  await app.start();
  await until(() => sockets.length === 1, '适配器连上服务端');
  return { app, lines, dropClient, sockets, server };
}

describe('onebot 收尾段开始后不再重连', () => {
  it('收尾段里连接断开：不排重连定时器', async () => {
    let dropped = false;
    const w = await world(async ({ dropClient, lines }) => {
      dropClient();
      await until(() => lines.some(line => line.startsWith('OneBot 连接断开')), '客户端收到断开');
      dropped = true;
    });
    await w.app.stop();
    expect(dropped).toBe(true);
    expect(w.lines.filter(line => line.includes('后尝试重连'))).toEqual([]);
  });

  it('收尾前已排的重连定时器在收尾段里到点：不再建连接', async () => {
    let fired = false;
    const w = await world(async () => {
      vi.advanceTimersByTime(5000);
      fired = true;
    });
    // 只假计时器：重连定时器由测试在根的收尾段里推进，网络 I/O 照常
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    w.dropClient();
    await until(() => w.lines.some(line => line.includes('后尝试重连')), '断开后排了重连');
    const before = w.lines.length;
    await w.app.stop();
    expect(fired).toBe(true);
    expect(w.lines.slice(before).filter(line => line.startsWith('正在连接 OneBot'))).toEqual([]);
  });
});
