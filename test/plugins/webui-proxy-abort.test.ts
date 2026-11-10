import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../packages/core/src/index.js';
import { registerProxyRoutes } from '../../packages/plugin-webui-server/src/routes/proxy.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// ════════════════════════════════════════════════════════════
// 图片代理替浏览器的那次请求取图：客户端断开（换页、图片滚出视野被取消）时，连上游与读文件头这一段也随之停下，不等满
// 15 秒时限；客户端已经不在，不记「图片代理失败」的告警。上游是本机桩；客户端断开用路由夹具的连接事件源 emit('close') 模拟。
// ════════════════════════════════════════════════════════════

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 本机上游桩：head 为真时回响应头、只发两个字节就停住，否则什么都不回；requested、closed 记那条请求 */
async function upstream(head: boolean) {
  const seen = { requested: false, closed: false };
  const server = createServer((req, res) => {
    seen.requested = true;
    req.on('close', () => {
      seen.closed = true;
    });
    if (head) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.from([0x89, 0x50]));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；用完复原
  cleanups.push(async () => {
    setNetworkPolicy({ blockPrivate: true });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.png` };
}

function mount() {
  const warns: string[] = [];
  const logger = {
    debug() {},
    info() {},
    warn: (message: string) => void warns.push(message),
    error() {},
    child: () => logger,
  } as unknown as Logger;
  const { expressApp, invoke } = captureRoutes();
  registerProxyRoutes(expressApp as never, logger, () => (_req: unknown, _res: unknown, next: () => void) => next());
  return { warns, invoke };
}

describe('图片代理随客户端断开中止', () => {
  it.each([
    ['连上游途中', false],
    ['读文件头途中', true],
  ])('%s客户端断开：到上游的请求随之断开，不记告警', async (_label, head) => {
    const up = await upstream(head);
    const { warns, invoke } = mount();
    const connection = new EventEmitter();
    const reply = invoke('GET /api/proxy/image', { query: { url: up.url } }, connection);
    await expect.poll(() => up.seen.requested).toBe(true);
    connection.emit('close');
    await expect.poll(() => up.seen.closed).toBe(true);
    await reply;
    expect(warns).toEqual([]);
  });
});
