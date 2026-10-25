import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { DocSessionManager } from '../../packages/plugin-office/src/session.js';
import { registerDocxTools } from '../../packages/plugin-office/src/tools/docx.js';
import { registerPptTools } from '../../packages/plugin-office/src/tools/pptx.js';
import { loadImage } from '../../packages/plugin-office/src/utils.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// doc_add_image / ppt_add_image 的图片：
//   - 远程下载与 plugin-media、ASR 同口径：带 15 秒超时信号、20 MiB 流式限额（慢速对端不挂住整轮工具调用，超大响应
//     不整块读进内存）
//   - 格式按文件头认，不看扩展名与 Content-Type；不是图片的拒绝，Word 与 PPT 嵌不进的格式明确报错，不产出打不开的文档
//   - 来源按文件工具的同一判定求值：存储地址原样，相对路径落在输出目录下，宿主机绝对路径（含 C:/）拒绝
// ════════════════════════════════════════════════════════════

const MIB = 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
/** 'BM'、文件长度、保留字、像素偏移与 40 字节的 DIB 头长度 */
const BMP = Buffer.from('424d3a0000000000000036000000280000000000', 'hex');

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
    if (req.url === '/mislabeled.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(JPEG);
      return;
    }
    if (req.url === '/text.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('not an image');
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

  it('下载请求带 15 秒超时信号；正常大小照常返回内容与格式', async () => {
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
    expect(r.format.format).toBe('PNG');
    expect(signal, '下载未带 AbortSignal，慢速对端会挂住整轮工具调用').toBeInstanceOf(AbortSignal);
    const i = timeoutSpy.mock.results.findIndex(res => res.value === signal);
    expect(i, '下载信号不是 AbortSignal.timeout 造的').toBeGreaterThanOrEqual(0);
    expect(timeoutSpy.mock.calls[i]).toEqual([15_000]);
  });

  it('非 2xx 响应先取消响应体再报错，不占着连接', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {}, // 对端不再发数据：不取消的话流一直挂着
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 404 })),
    );
    await expect(loadImage(noStorage, `${base}/missing.png`, 'data:/docs')).rejects.toThrow('图片下载失败: 404');
    expect(cancelled, '没读的响应体没有取消').toBe(true);
  });
});

/** 只读的存储桩：每个地址读出 files 里的字节，记下读过的地址 */
function storageWith(files: Record<string, Buffer>) {
  const reads: string[] = [];
  const storage = {
    readFile: async (uri: string) => {
      reads.push(uri);
      const data = files[uri];
      if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return data;
    },
  } as never;
  return { storage, reads };
}

describe('office loadImage：格式按文件头认', () => {
  it('扩展名写成 .png 的 JPEG：存储与网址来源都按 JPEG 收下', async () => {
    const { storage } = storageWith({ 'data:/docs/pic.png': JPEG });
    expect((await loadImage(storage, 'data:/docs/pic.png', 'data:/docs')).format.format).toBe('JPEG');
    expect((await loadImage(noStorage, `${base}/mislabeled.png`, 'data:/docs')).format.format).toBe('JPEG');
  });

  it('类型头写着 image/png、内容是文本：报不是图片', async () => {
    await expect(loadImage(noStorage, `${base}/text.png`, 'data:/docs')).rejects.toThrow('不是图片');
  });

  it('相对路径落在输出目录下；宿主机绝对路径（含 C:/）报错，不当存储地址读', async () => {
    const { storage, reads } = storageWith({ 'data:/docs/a/pic.png': PNG });
    expect((await loadImage(storage, 'a/pic.png', 'data:/docs')).format.format).toBe('PNG');
    await expect(loadImage(storage, 'C:/x.png', 'data:/docs')).rejects.toThrow('宿主机绝对路径');
    await expect(loadImage(storage, '/abs/x.png', 'data:/docs')).rejects.toThrow('宿主机绝对路径');
    expect(reads).toEqual(['data:/docs/a/pic.png']);
  });
});

describe('doc_add_image / ppt_add_image：嵌不进的格式明确报错', () => {
  const files = { 'data:/docs/pic.webp': WEBP, 'data:/docs/pic.bmp': BMP, 'data:/docs/pic.png': JPEG };

  function tools(register: typeof registerDocxTools | typeof registerPptTools, sessions = new DocSessionManager()) {
    const out: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
    register(
      stubBoundTools({
        onRegister: t => {
          out[t.definition.function.name] = t;
        },
      }),
      sessions,
      storageWith(files).storage,
      'data:/docs',
    );
    return out;
  }
  const ctx = toolContext({ sessionId: 's', enabledGroups: undefined });

  it('Word：WebP 报不支持，扩展名写错的 JPEG 照常插入', async () => {
    const docx = tools(registerDocxTools);
    const { docId } = JSON.parse((await docx.doc_create.handler({ filename: 'a.docx' }, ctx)) as string);
    await expect(docx.doc_add_image.handler({ docId, source: 'data:/docs/pic.webp' }, ctx)).rejects.toThrow(
      'Word 文档不支持 WebP 图片',
    );
    expect(String(await docx.doc_add_image.handler({ docId, source: 'data:/docs/pic.png' }, ctx))).toContain(
      '图片已添加',
    );
  });

  it('PPT：WebP 与 BMP 报不支持，扩展名写错的 JPEG 按 image/jpeg 插入', async () => {
    const sessions = new DocSessionManager();
    const ppt = tools(registerPptTools, sessions);
    const { docId } = JSON.parse((await ppt.ppt_create.handler({ filename: 'a.pptx' }, ctx)) as string);
    await ppt.ppt_add_slide.handler({ docId }, ctx);
    const slide = (sessions.require(docId).doc as { slides: Array<{ addImage: (o: { data: string }) => unknown }> })
      .slides[0];
    const added = vi.spyOn(slide, 'addImage');
    await expect(ppt.ppt_add_image.handler({ docId, source: 'data:/docs/pic.webp' }, ctx)).rejects.toThrow(
      'PPT 不支持 WebP 图片',
    );
    await expect(ppt.ppt_add_image.handler({ docId, source: 'data:/docs/pic.bmp' }, ctx)).rejects.toThrow(
      'PPT 不支持 BMP 图片',
    );
    await ppt.ppt_add_image.handler({ docId, source: 'data:/docs/pic.png' }, ctx);
    expect(added.mock.calls.map(([o]) => o.data.slice(0, 18))).toEqual(['image/jpeg;base64,']);
  });
});
