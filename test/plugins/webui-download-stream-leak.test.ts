import { createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pipeToResponse } from '../../packages/plugin-webui-server/src/routes/pipe-to-response.js';

// ════════════════════════════════════════════════════════════
// 下载与媒体路由此前是裸 `stream.pipe(res)`：读流出错时没有监听的 'error' 让进程退出；客户端中断下载（取消/关标签页/
// 断网重试都是正常行为）后，pipe 只 unpipe、不销毁源流，fd 不回收，撞到进程 fd 上限后全进程的 storage 读写一起失败。
// 会话文件与媒体两条路由都经 pipeToResponse 写出。契约：客户端中途取消时销毁源流，不记 warn；
// 读流出错断开这次响应、记一条 warn（媒体路由的用例里留了一条，证明走的是它）。真 HTTP，读流由用例控制。
// ════════════════════════════════════════════════════════════

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  server = undefined;
});

async function listen(handler: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => handler(res));
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

describe('pipeToResponse', () => {
  it('客户端中途断开时销毁源流，不记 warn', async () => {
    const warns: string[] = [];
    const stream = new Readable({
      read() {
        setTimeout(() => this.push(Buffer.alloc(1024)), 5);
      },
    });
    const url = await listen(res =>
      pipeToResponse(stream, res, { warn: (msg: string) => void warns.push(msg) } as never, '下载 zz-label'),
    );
    await new Promise<void>((resolve, reject) => {
      const req = request(url, res => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', reject);
      req.end();
    });
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    expect(warns).toEqual([]);
  });
});
