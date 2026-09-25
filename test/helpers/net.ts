import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 取一个空闲端口：先在 127.0.0.1:0 上开探针拿到系统分配的端口，关掉后交给被测服务 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}
