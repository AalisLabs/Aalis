import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadImage } from '../../packages/plugin-office/src/utils.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// doc_add_image / ppt_add_image 的远程图片下载与 plugin-media、ASR 同口径：带 15 秒超时信号、20 MiB 流式限额。
// 此前裸 safeFetch(url) 后整读 arrayBuffer()：慢速对端挂住整轮工具调用，超大响应整块读进内存。
// ════════════════════════════════════════════════════════════

const MIB = 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let server: Server;
let base: string;

beforeAll(async () => {
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机测试服务；afterAll 复原
  server = createServer((req, res) => {
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    if (req.url === '/big-chunked') {
      // 不带 Content-Length（分块传输）：只有流式累计才能在读完之前发现超限
      res.writeHead(200, { 'content-type': 'image/png' });
      Readable.from(Array.from({ length: 21 }, () => Buffer.alloc(MIB))).pipe(res);
      return;
    }
    if (req.url === '/big-declared') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(21 * MIB) });
      Readable.from(Array.from({ length: 21 }, () => Buffer.alloc(MIB))).pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  setNetworkPolicy({ blockPrivate: true });
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const noStorage = {} as never;

describe('office loadImage：远程图片下载', () => {
  it('超过 20 MiB 的响应在读完之前被拒（无 Content-Length 按流式累计，有则按声明值）', async () => {
    // 只取错误文案断言：若误放行，把 21 MiB 的 Buffer 交给断言库会在格式化失败信息时撑爆内存
    const failure = (path: string) =>
      loadImage(noStorage, `${base}${path}`, 'data:/docs').then(
        () => '未拒绝',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    expect(await failure('/big-chunked')).toMatch(/图片过大/);
    expect(await failure('/big-declared')).toMatch(/图片过大/);
  });

  it('下载请求带 15 秒超时信号；正常大小照常返回内容与类型', async () => {
    const realFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return realFetch(url, init);
      }),
    );
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const r = await loadImage(noStorage, `${base}/ok.png`, 'data:/docs');
    expect(r.buffer.equals(PNG)).toBe(true);
    expect(r.mime).toBe('image/png');
    expect(signal, '下载未带 AbortSignal，慢速对端会挂住整轮工具调用').toBeInstanceOf(AbortSignal);
    const i = timeoutSpy.mock.results.findIndex(res => res.value === signal);
    expect(i, '下载信号不是 AbortSignal.timeout 造的').toBeGreaterThanOrEqual(0);
    expect(timeoutSpy.mock.calls[i]).toEqual([15_000]);
  });
});
