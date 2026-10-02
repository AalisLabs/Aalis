import { createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pipeToResponse } from '../../packages/plugin-webui-server/src/routes/pipe-to-response.js';
import { registerUploadedFilesRoutes } from '../../packages/plugin-webui-server/src/routes/uploaded-files.js';

// ════════════════════════════════════════════════════════════
// 下载与媒体路由此前是裸 `stream.pipe(res)`：读流出错时没有监听的 'error' 让进程退出；客户端中断下载（取消/关标签页/
// 断网重试都是正常行为）后，pipe 只 unpipe、不销毁源流，fd 不回收，撞到进程 fd 上限后全进程的 storage 读写一起失败。
// 三条路由（文件下载、上传文件下载、媒体）都经 pipeToResponse 写出。契约：客户端中途取消时销毁源流，不记 warn；
// 读流出错断开这次响应、记一条 warn（各路由各留一条用例，证明走的是它）。真 HTTP，读流由用例控制。
// ════════════════════════════════════════════════════════════

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

const SESSION = 'onebot:1:group:2';
const FILE_ID = 'aaaaaaaaaaaaaaaa';

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

async function serve(stream: Readable): Promise<{ url: string; warns: string[] }> {
  const warns: string[] = [];
  const storage = {
    readFile: async (uri: string) => {
      if (uri !== `pluginData:/file-reader/onebot_1_group_2/${FILE_ID}.meta.json`) throw new Error(`不存在: ${uri}`);
      return JSON.stringify({ id: FILE_ID, name: 'big.bin', mimeType: 'application/octet-stream', size: 1 });
    },
    createReadStream: async () => ({ stream, stat: { size: 1024 * 1024 } }),
  };
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...h: Handler[]) => void routes.set(path, h[h.length - 1]),
    post: () => {},
  };
  registerUploadedFilesRoutes(
    app as never,
    {
      storage: storage as never,
      logger: { debug() {}, warn: (msg: string) => void warns.push(msg) } as never,
      fileIndex: () => undefined,
    },
    (() => () => {}) as never,
  );
  const download = routes.get('/api/uploaded-files/download');
  if (!download) throw new Error('下载路由没有注册');
  const url = await listen(res => void download({ query: { sessionId: SESSION, fileId: FILE_ID } }, res));
  return { url, warns };
}

describe('WebUI 上传文件下载的读流', () => {
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
    await vi.waitFor(() =>
      expect(warns).toEqual([`下载上传文件 pluginData:/file-reader/onebot_1_group_2/${FILE_ID}.bin 读取出错: zz-eio`]),
    );
  });
});
