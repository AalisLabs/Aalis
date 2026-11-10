import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { App, type Logger, provide } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import onebot from '../../packages/plugin-adapter-onebot/src/index.js';
import contributionsPlugin from '../../packages/plugin-contributions/src/index.js';

// ════════════════════════════════════════════════════════════
// 连接鉴权：accessToken 放在握手请求头里；实现端拒绝时日志写得出原因。拒绝有两种形态：握手时直接回 HTTP 状态码
// （OneBot 标准的做法），或接受握手后回一条不对应任何请求的失败回执再断开（NapCat 对 token 不对的做法）。
// 连的是进程内起在 127.0.0.1 的 ws 服务端，不连任何外部服务。
// ════════════════════════════════════════════════════════════

interface WsSocket {
  send(data: string): void;
  close(): void;
}
type VerifyClient = (
  info: { req: IncomingMessage },
  done: (ok: boolean, code?: number, message?: string) => void,
) => void;
/** 用到的 ws 服务端面（ws 是 onebot 包的依赖，test/ 解析不到它的类型） */
interface WsServer {
  once(event: 'listening', listener: () => void): void;
  on(event: 'connection', listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  address(): AddressInfo;
  close(callback: () => void): void;
}
const { WebSocketServer } = createRequire(
  new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url),
)('ws') as {
  WebSocketServer: new (options: { port: number; host: string; verifyClient?: VerifyClient }) => WsServer;
};

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 不走 ws 的裸 HTTP 服务端：升级请求由用例自己回，造得出握手被拒时响应体一直不结束、读到一半断开 */
async function rawServer(upgrade: (socket: Duplex) => void): Promise<number> {
  const http = createServer();
  const sockets = new Set<Duplex>();
  http.on('upgrade', (_req, socket: Duplex) => {
    sockets.add(socket);
    // 客户端读到上限就断开，这边还没写完的会收到 ECONNRESET：升级后的套接字没人接 error，不接就成了未捕获异常
    socket.on('error', () => {});
    upgrade(socket);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        http.close(() => resolve());
      }),
  );
  return (http.address() as AddressInfo).port;
}

async function wsServer(server: {
  verifyClient?: VerifyClient;
  onConnection?: (socket: WsSocket, req: IncomingMessage) => void;
}): Promise<number> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: server.verifyClient });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  cleanups.push(() => new Promise<void>(resolve => wss.close(() => resolve())));
  if (server.onConnection) wss.on('connection', server.onConnection);
  return wss.address().port;
}

async function world(
  connections: (url: string) => Array<Record<string, unknown>>,
  server: {
    verifyClient?: VerifyClient;
    onConnection?: (socket: WsSocket, req: IncomingMessage) => void;
    upgrade?: (socket: Duplex) => void;
  },
) {
  const port = server.upgrade ? await rawServer(server.upgrade) : await wsServer(server);
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const logger: Logger = { debug() {}, info: record, warn: record, error: record, child: () => logger };
  const app = new App({ name: 'T', logger, devMode: false });
  cleanups.push(() => app.stop());
  const root = app.bind({ provide });
  root.provide.use(storage, {} as never);
  root.provide.use(processService, {} as never);
  const url = `ws://127.0.0.1:${port}`;
  await app.pluginAll([
    { definition: contributionsPlugin },
    { definition: onebot, config: { connections: connections(url) } },
  ]);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(onebot.name)?.state).toBe('active');
  await app.start();
  return { lines, url };
}

describe('onebot 连接鉴权', () => {
  it('填了 accessToken 的连接在握手请求头里带 Authorization: Bearer <token>，没填的不带', async () => {
    const headers: Array<string | undefined> = [];
    await world(url => [{ url, accessToken: 'test-token' }, { url }], {
      onConnection: (_socket, req) => void headers.push(req.headers.authorization),
    });
    await until(() => headers.length === 2, '两条连接都连上');
    expect(headers.sort()).toEqual(['Bearer test-token', undefined]);
  });

  it('接受握手后回一条不对应任何请求的失败回执再断开（如 token 不对）：按 warn 记下返回码与原话', async () => {
    const w = await world(url => [{ url }], {
      onConnection: socket => {
        socket.send(
          JSON.stringify({ status: 'failed', retcode: 1403, data: null, message: 'token验证失败', echo: null }),
        );
        socket.close();
      },
    });
    await until(() => w.lines.some(line => line.startsWith('OneBot 连接断开')), '连接断开');
    expect(w.lines.filter(line => line.includes('1403'))).toEqual([
      `OneBot 实现端报错: ${w.url}，返回码 1403，token验证失败`,
    ]);
  });

  it('握手被拒（如 HTTP 401）：记下状态码后立即断开，不等连接超时', async () => {
    const w = await world(url => [{ url }], {
      verifyClient: (_info, done) => done(false, 401, 'Unauthorized'),
    });
    await until(() => w.lines.some(line => line.startsWith('OneBot 连接断开')), '握手被拒后断开');
    expect(w.lines.some(line => line.includes('status=401'))).toBe(true);
    expect(
      w.lines.filter(line => line.startsWith('OneBot 连接错误')),
      '自己断开引出的错误不另记：原因上面已记过',
    ).toEqual([]);
  });

  it('握手被拒的响应体一直不结束：只记开头一段，立即断开，不等连接超时', async () => {
    let gone!: () => void;
    const clientGone = new Promise<void>(resolve => {
      gone = resolve;
    });
    const w = await world(url => [{ url }], {
      upgrade: socket => {
        socket.once('end', gone);
        socket.once('close', gone);
        const chunk = 'x'.repeat(64 * 1024);
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`,
        );
      },
    });
    await until(() => w.lines.some(line => line.startsWith('OneBot 连接断开')), '读到上限后断开');
    // 客户端关掉套接字之后服务端才读得到断开，客户端的响应流随套接字关闭同一拍关上：到这里它已关过
    await clientGone;
    const bodies = w.lines.filter(line => line.startsWith('OneBot unexpected-response body: '));
    expect(bodies, '读到上限与随后的关闭只记一次').toHaveLength(1);
    expect(bodies[0].length).toBeLessThan(5000);
  });

  it('握手被拒的响应体读到一半连接断了：记下读到的部分，立即断开，不等连接超时', async () => {
    const w = await world(url => [{ url }], {
      upgrade: socket => {
        socket.write('HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nhalf');
        setTimeout(() => socket.destroy(), 50);
      },
    });
    await until(() => w.lines.some(line => line.startsWith('OneBot 连接断开')), '读到一半断开后断开');
    expect(w.lines.filter(line => line.startsWith('OneBot unexpected-response body: '))).toEqual([
      'OneBot unexpected-response body: half',
    ]);
  });

  // 连接超时由 15 秒的定时器断开：只假 setTimeout，在握手请求到了服务端之后推进，网络 I/O 照常
  describe('连接超时', () => {
    const timeout = async (upgrade: (socket: Duplex) => void) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cleanups.push(() => void vi.useRealTimers());
      let arrived = false;
      const w = await world(url => [{ url }], {
        upgrade: socket => {
          arrived = true;
          upgrade(socket);
        },
      });
      await until(() => arrived, '握手请求到了服务端');
      return w;
    };

    it('服务端一直不回握手：记下连接超时，不多记一条自己断开引出的连接错误', async () => {
      const w = await timeout(() => {});
      await vi.advanceTimersByTimeAsync(15_000);
      await until(() => w.lines.some(line => line.startsWith('OneBot 连接断开')), '超时后断开');
      expect(w.lines.filter(line => line.startsWith('OneBot 连接超时'))).toHaveLength(1);
      expect(w.lines.filter(line => line.startsWith('OneBot 连接错误'))).toEqual([]);
    });

    it('握手被拒、响应体没到上限又不结束：连接超时断开时记下读到的部分', async () => {
      const w = await timeout(socket => {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 100\r\n\r\ntoken invalid');
      });
      await until(() => w.lines.some(line => line.includes('status=401')), '读到握手被拒');
      await vi.advanceTimersByTimeAsync(15_000);
      await until(
        () => w.lines.some(line => line.startsWith('OneBot unexpected-response body: ')),
        '超时断开后记下响应体',
      );
      expect(w.lines.filter(line => line.startsWith('OneBot unexpected-response body: '))).toEqual([
        'OneBot unexpected-response body: token invalid',
      ]);
      expect(w.lines.filter(line => line.startsWith('OneBot 连接错误'))).toEqual([]);
    });
  });

  it('没有数字返回码的帧不当成失败回执（如事件里带 status: failed）', async () => {
    const w = await world(url => [{ url }], {
      onConnection: socket => {
        socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'x_upload', status: 'failed' }));
        socket.close();
      },
    });
    await until(() => w.lines.some(line => line.startsWith('OneBot 连接断开')), '连接断开');
    expect(w.lines.filter(line => line.includes('实现端报错'))).toEqual([]);
  });
});
