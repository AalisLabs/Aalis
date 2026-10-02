import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFileRoutes } from '../../packages/plugin-webui-server/src/routes/files.js';

// ════════════════════════════════════════════════════════════
// GET /api/files/download：读流出错（打开前文件被删、读到一半 EIO）时断开这次响应、记一条 warn，不让进程退出。
// 读流交给 pipeToResponse；客户端中途取消时销毁源流、不记 warn 由它的用例守（webui-download-stream-leak.test.ts）。
// 真 HTTP，存储换成能控制读流的替身。
// ════════════════════════════════════════════════════════════

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  server = undefined;
});

async function serve(stream: Readable): Promise<{ url: string; warns: string[] }> {
  const warns: string[] = [];
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...h: Handler[]) => void routes.set(path, h[h.length - 1]),
    post: () => {},
  };
  registerFileRoutes(
    app as never,
    {
      storage: {
        listRoots: () => [{ name: 'workspace', browsable: true }],
        createReadStream: async () => ({ stream, stat: { name: 'big.bin', size: 1024 * 1024 } }),
      } as never,
      fileRoot: 'workspace',
      logger: { warn: (msg: string) => void warns.push(msg) } as never,
    },
    (() => () => {}) as never,
  );
  const download = routes.get('/api/files/download');
  if (!download) throw new Error('下载路由没有注册');
  server = createServer((_req, res) => void download({ query: { path: 'big.bin' } }, res));
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/files/download`, warns };
}

describe('WebUI 文件下载的读流', () => {
  it('读到一半出错时断开这次响应、记一条 warn，不让进程退出', async () => {
    let sent = false;
    const stream = new Readable({
      read() {
        if (sent) {
          this.destroy(Object.assign(new Error('zz-eio'), { code: 'EIO' }));
          return;
        }
        sent = true;
        this.push(Buffer.alloc(1024));
      },
    });
    const { url, warns } = await serve(stream);
    // 响应头已经发出，正文取不完整
    await expect(fetch(url).then(res => res.arrayBuffer())).rejects.toThrow();
    await vi.waitFor(() => expect(warns).toEqual(['下载文件 big.bin 读取出错: zz-eio']));
  });
});
