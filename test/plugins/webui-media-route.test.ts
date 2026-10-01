import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { registerMediaRoutes } from '../../packages/plugin-webui-server/src/routes/media.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// GET /api/media?uri=<存储地址>：聊天里的图片、视频、音频按存储地址取。只有 owner（cookie）能取；按文件头判定
// 类型，只放行图片、视频与浏览器能播的音频，HTML、SVG、JSON 等一律 415；响应带 nosniff 与 sandbox CSP。
// 真 storage-local，真 HTTP。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-media-route-token';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe('WebUI 媒体路由', () => {
  let base: string;
  let app: App;
  let port: number;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-media-route-'));
    mkdirSync(join(base, 'data', 'images'), { recursive: true });
    writeFileSync(join(base, 'data', 'images', 'cat.png'), PNG);
    writeFileSync(join(base, 'data', 'images', 'page.png'), '<!doctype html><script>alert(1)</script>');
    writeFileSync(join(base, 'data', 'ledger.json'), '{"secret":"zz-not-media"}');
    // 根外的一张真图：路径穿越真的读到它时会以图片回 200
    writeFileSync(join(base, 'outside.png'), PNG);
    port = await freePort();
    app = new App({ name: 'media route test', logLevel: 'error' });
    provideHostPaths(app, base);
    await app.pluginAll([
      {
        definition: storageLocalPlugin,
        config: {
          roots: [
            {
              name: 'data',
              path: join(base, 'data'),
              label: 'data',
              kind: 'data',
              browsable: true,
              readable: true,
              writable: true,
              deletable: true,
            },
          ],
        },
      },
      {
        definition: webuiServerPlugin,
        config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
      },
    ]);
    await app.start();
    // app:started 之后才开始监听：等端口能连上
    for (let i = 0; ; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/media`);
        break;
      } catch (err) {
        if (i > 200) throw err;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  const get = (uri: string, cookie = true) =>
    fetch(`http://127.0.0.1:${port}/api/media?uri=${encodeURIComponent(uri)}`, {
      headers: cookie ? { cookie: `aalis_webui_token=${TOKEN}` } : {},
    });

  it('按文件头判定为图片的照原样提供，带 nosniff 与 sandbox CSP', async () => {
    const res = await get('data:/images/cat.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('安全：扩展名是 .png、内容是网页的不提供；JSON 账本也不提供', async () => {
    const html = await get('data:/images/page.png');
    expect(html.status).toBe(415);
    expect(await html.text()).not.toContain('<script>');
    const json = await get('data:/ledger.json');
    expect(json.status).toBe(415);
    expect(await json.text()).not.toContain('zz-not-media');
  });

  it('安全：没有登录拒绝；网址与不存在的文件不提供', async () => {
    expect((await get('data:/images/cat.png', false)).status).toBeGreaterThanOrEqual(401);
    expect((await get('https://example.invalid/cat.png')).status).toBe(400);
    expect((await get('data:/images/missing.png')).status).toBe(404);
  });

  it('安全：用 .. 指向存储根外的图片取不到', async () => {
    for (const uri of ['data:/../outside.png', 'data:/images/../../outside.png']) {
      const res = await get(uri);
      expect(res.status, uri).toBe(404);
      expect(Buffer.from(await res.arrayBuffer()).includes(PNG), uri).toBe(false);
    }
  });
});

describe('WebUI 媒体路由的读流', () => {
  // 直接驱动路由处理器：文件头是图片，读流由用例控制
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise(resolve => server?.close(resolve));
    server = undefined;
  });

  async function serve(stream: Readable): Promise<{ url: string; warns: string[] }> {
    const warns: string[] = [];
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerMediaRoutes(
      { get: (path: string, ...handlers: never[]) => void routes.set(path, handlers[handlers.length - 1]) } as never,
      {
        readFileRange: async () => PNG,
        createReadStream: async () => ({ stream, stat: { size: 1024 * 1024 } }),
      } as never,
      { warn: (msg: string) => void warns.push(msg) } as never,
      (() => () => {}) as never,
    );
    const handler = routes.get('/api/media');
    if (!handler) throw new Error('媒体路由没有注册');
    server = createServer((_req, res) => void handler({ query: { uri: 'mem:/big.png' } }, res));
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/api/media`, warns };
  }

  // 中途断开时销毁源流、不记 warn 由 pipeToResponse 的用例守（webui-download-stream-leak.test.ts）
  it('读到一半出错时断开这次响应、经 pipeToResponse 记一条带本路由说明的 warn，不让进程退出', async () => {
    let sent = false;
    const stream = new Readable({
      read() {
        if (sent) {
          this.destroy(Object.assign(new Error('zz-eio'), { code: 'EIO' }));
          return;
        }
        sent = true;
        this.push(PNG);
      },
    });
    const { url, warns } = await serve(stream);
    // 响应头已经发出，正文取不完整
    await expect(fetch(url).then(res => res.arrayBuffer())).rejects.toThrow();
    await vi.waitFor(() => expect(warns).toEqual(['媒体文件 mem:/big.png 读取出错: zz-eio']));
  });
});
