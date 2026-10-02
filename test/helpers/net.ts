import { Buffer } from 'node:buffer';
import { createServer, request } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { vi } from 'vitest';

/** 取一个空闲端口：先在 127.0.0.1:0 上开探针拿到系统分配的端口，关掉后交给被测服务 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

/** webui-server 在 app:ready 时才监听：等登录状态接口答得上来 */
export async function waitListening(port: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (!res.ok) throw new Error(`状态接口回 ${res.status}`);
    },
    { timeout: 3000, interval: 20 },
  );
}

/**
 * 发一个 WebSocket 升级请求，headers 是额外的请求头（cookie、Origin）：被接受时给出状态码与升级后的套接字，
 * 被拒时只有状态码。升级后的套接字同时放进 opened，由调用方在用例结束时销毁
 */
export function upgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
  opened: Socket[],
): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      opened.push(socket);
      resolve({ status: res.statusCode ?? 0, socket });
    });
    req.on('response', res => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}
