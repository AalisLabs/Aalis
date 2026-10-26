import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SessionPeer, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { freePort, upgrade, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebSocket 连接建立时认不出身份就关掉连接、记 warn，不补成 webui:console（owner）。握手的认证与这里的身份同步相继判同一个
// token cookie，今天走不到这一支，所以把认证模块的 identify 换成认不出，其余照原实现。关掉的连接同样挂着 'error' 监听：
// 关掉之前对端发来不合规的帧时，没人接的 'error' 会抛成 uncaughtException 打死整个进程。
// ════════════════════════════════════════════════════════════

vi.mock('../../packages/plugin-webui-server/src/auth.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../packages/plugin-webui-server/src/auth.js')>();
  return {
    ...original,
    createAuthSystem: (...args: Parameters<typeof original.createAuthSystem>) => ({
      ...original.createAuthSystem(...args),
      identify: () => undefined,
    }),
  };
});

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const TOKEN = 'ws-identity-test-token-000000000000';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const WEBUI_CONFIG = { host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN };

const apps: App[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const app of apps.splice(0)) await app.stop();
});

/** 起 webui-server，会话服务是记下对端的替身；warns 是记下的 warn */
async function start() {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (message: string) => void warns.push(message),
    error() {},
    child: () => logger,
  };
  const port = await freePort();
  const app = new App({ name: 'T', logLevel: 'warn', logger });
  apps.push(app);
  const peers: SessionPeer[] = [];
  app.bind({ provide }).provide.use(sessionProtocol, {
    connect(peer) {
      peers.push(peer);
      return { receive: async () => {}, close: () => {} };
    },
    resolveFile: () => undefined,
  });
  await app.plugin(webuiServer, { ...WEBUI_CONFIG, port });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  return { port, peers, warns };
}

describe('WebSocket 连接认不出身份', () => {
  it('带着有效 token 连上：连接被关掉、记一条 warn，没有以 webui:console 接到会话服务', async () => {
    const { port, peers, warns } = await start();
    const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/session`, {
      headers: { cookie: COOKIE },
    });
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      ws.onclose = event => resolve({ code: event.code, reason: event.reason });
    });
    const connected = vi.waitFor(
      () => {
        if (peers.length === 0) throw new Error('还没接到会话服务');
        return 'connected';
      },
      { timeout: 3000 },
    );
    expect(await Promise.race([closed, connected])).toEqual({ code: 1008, reason: '认不出身份' });
    expect(peers).toEqual([]);
    expect(warns.some(message => message.includes('认不出身份'))).toBe(true);
  });

  it('关掉之前对端发来不合规的帧（不带掩码）：这条连接照常断开，进程不被没人接的 error 打死', async () => {
    const { port } = await start();
    const { status, socket } = await upgrade(port, '/session', { cookie: COOKIE }, sockets);
    expect(status).toBe(101);
    if (!socket) throw new Error('没有升级后的套接字');
    const closed = new Promise<'closed'>(resolve => socket.once('close', () => resolve('closed')));
    // 读掉服务端发来的关闭帧：暂停着的套接字读不到结尾，看不到服务端断开
    socket.resume();
    socket.write(Buffer.from([0x81, 0x01, 0x41]));
    const stuck = new Promise<'stuck'>(resolve => setTimeout(() => resolve('stuck'), 3000));
    expect(await Promise.race([closed, stuck])).toBe('closed');
  });
});
