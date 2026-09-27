import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OfflineRenderer, type RenderRequest } from '../../packages/util-offline-render/src/index.js';

// ════════════════════════════════════════════════════════════
// 离线渲染的隔离（真 Chromium）：
// - 宿主文件取不到：文档里的 <img>、<iframe>、<link rel=stylesheet>、CSS url() 引用 file:/// 与 ../../ 相对路径，
//   截图里看不到哨兵色，拦截记录里没有完成的 file: 请求。https 文档对 file: 的引用由 Chrome 自己的来源规则挡住
//   （请求到不了拦截回调），拦截对 file: 的处理是纵深防御；所以入口只收 https 网址。
// - 脚本不执行；清单外的 http(s) 子资源一律中止，清单里的精确网址被响应。
// - 每次渲染新建并关闭浏览器上下文；并发槽把同时渲染压到上限。
// - 三种截图范围的尺寸。
// puppeteer 的 launch 外包一层只做记录；封网参数由被测代码自己给（没给时这里补上不走系统代理，防变异时外发）。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({
  launches: 0,
  contexts: [] as Array<{ closed: boolean }>,
  /** 当前没关的上下文数与峰值 */
  open: 0,
  peak: 0,
  /** failed 的 errorText：被拦截中止的以 net::ERR_BLOCKED_BY_CLIENT 开头，放出去再失败的是别的（如代理连不上） */
  requests: [] as Array<{ url: string; outcome: 'finished' | 'failed'; errorText?: string }>,
}));

vi.mock(
  '../../packages/util-offline-render/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    // 根目录不直接依赖 puppeteer：只声明用到的部分，不经类型导入引用它
    type Req = { url(): string; failure(): { errorText: string } | null };
    type Page = { on(event: string, handler: (r: Req) => void): void };
    type Context = { closed: boolean; newPage(): Promise<Page>; close(): Promise<void> };
    type Browser = { createBrowserContext(...a: unknown[]): Promise<Context> };
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<Browser>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = async options => {
      probe.launches++;
      const args = options?.args ?? [];
      const browser = await actual.launch({
        ...options,
        args: args.some(a => a.startsWith('--proxy-server=')) ? args : [...args, '--no-proxy-server'],
      });
      const createBrowserContext = browser.createBrowserContext.bind(browser);
      browser.createBrowserContext = async (...a: unknown[]) => {
        const context = await createBrowserContext(...a);
        probe.contexts.push(context);
        probe.open++;
        probe.peak = Math.max(probe.peak, probe.open);
        const close = context.close.bind(context);
        let counted = true;
        context.close = async () => {
          if (counted) {
            counted = false;
            probe.open--;
          }
          await close();
        };
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          page.on('requestfinished', r => probe.requests.push({ url: r.url(), outcome: 'finished' }));
          page.on('requestfailed', r =>
            probe.requests.push({ url: r.url(), outcome: 'failed', errorText: r.failure()?.errorText }),
          );
          return page;
        };
        return context;
      };
      return browser;
    };
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

const logger = { debug: () => {}, info: () => {}, warn: () => {} };
const ENTRY = 'https://render.invalid/w/';
/** 拦截回调里 abort('blockedbyclient') 的请求：子资源报 net::ERR_BLOCKED_BY_CLIENT.Inspector，框的导航不带后缀 */
const blockedByInterception = (errorText: string | undefined): boolean =>
  errorText?.startsWith('net::ERR_BLOCKED_BY_CLIENT') ?? false;
/** 1×1 的品红 PNG：截图里出现品红就说明这张图被加载了 */
const MAGENTA_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z/AfAAQAAf8iCjrwAAAAAElFTkSuQmCC',
  'base64',
);

let renderer: OfflineRenderer | undefined;

function makeRenderer(maxConcurrency = 2): OfflineRenderer {
  renderer = new OfflineRenderer({ sandbox: 'preferred', idleShutdownSec: 0, maxConcurrency, logger });
  return renderer;
}

function html(body: string): { body: Uint8Array; contentType: string } {
  return { body: new TextEncoder().encode(body), contentType: 'text/html; charset=utf-8' };
}

function request(doc: string, extra: Array<[string, { body: Uint8Array; contentType: string }]> = []): RenderRequest {
  return {
    entry: ENTRY,
    resources: new Map([[ENTRY, html(doc)], ...extra]),
    viewport: { width: 400, height: 300 },
    clip: { kind: 'viewport' },
  };
}

/** 解 Chrome 截图的 PNG（8 位 RGB/RGBA、不隔行），数接近品红的像素 */
function magentaPixels(png: Uint8Array): number {
  const buf = Buffer.from(png);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  expect(depth).toBe(8);
  expect([2, 6]).toContain(colorType);
  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let count = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const r = line[x * channels];
      const g = line[x * channels + 1];
      const bl = line[x * channels + 2];
      if (r > 200 && g < 60 && bl > 200) count++;
    }
    prev.set(line);
  }
  return count;
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(png);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

afterEach(async () => {
  await renderer?.dispose();
  renderer = undefined;
  probe.launches = 0;
  probe.contexts.length = 0;
  probe.open = 0;
  probe.peak = 0;
  probe.requests.length = 0;
});

describe('宿主文件取不到（真浏览器）', () => {
  let dir: string;
  let fileDoc: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'works-offline-render-'));
    writeFileSync(join(dir, 'sentinel.png'), MAGENTA_PNG);
    writeFileSync(join(dir, 'sentinel.css'), 'html,body{background:#ff00ff !important}');
    writeFileSync(join(dir, 'sentinel.html'), '<body style="margin:0;background:#ff00ff"></body>');
    const abs = (name: string) => pathToFileURL(join(dir, name)).href;
    // 相对路径从 https 入口出发只会解析成同主机的 https 网址，逃不出去；这里一并列上
    const rel = (name: string) => `../../../..${join(dir, name)}`;
    fileDoc =
      '<!doctype html><html><head>' +
      `<link rel="stylesheet" href="${abs('sentinel.css')}"><link rel="stylesheet" href="${rel('sentinel.css')}">` +
      '<link rel="stylesheet" href="file:///etc/hosts">' +
      '<style>body{margin:0;background:#fff}div.bg{width:100px;height:60px;display:inline-block}' +
      `#a{background:url("${abs('sentinel.png')}")}#b{background:url("${rel('sentinel.png')}")}` +
      '#c{background:url("file:///etc/hosts")}</style></head><body>' +
      `<img src="${abs('sentinel.png')}" width="100" height="60"><img src="${rel('sentinel.png')}" width="100" height="60">` +
      '<img src="file:///etc/hosts" width="20" height="20"><img src="../../../../etc/hosts" width="20" height="20">' +
      `<iframe src="${abs('sentinel.html')}" width="100" height="60" style="border:0"></iframe>` +
      `<iframe src="${rel('sentinel.html')}" width="100" height="60" style="border:0"></iframe>` +
      '<iframe src="file:///etc/hosts" width="100" height="60"></iframe>' +
      '<div class="bg" id="a"></div><div class="bg" id="b"></div><div class="bg" id="c"></div>' +
      '</body></html>';
    writeFileSync(join(dir, 'doc.html'), fileDoc);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('对照：清单里的同一张图会显示成品红（判据本身有效）', async () => {
    const png = await makeRenderer().renderPng(
      request('<body style="margin:0"><img src="/s.png" width="100" height="60"></body>', [
        ['https://render.invalid/s.png', { body: MAGENTA_PNG, contentType: 'image/png' }],
      ]),
    );
    expect(magentaPixels(png)).toBeGreaterThan(5000);
  }, 30_000);

  it('file:/// 与 ../ 相对路径引用的宿主文件：截图里没有、拦截记录里没有完成的 file: 请求', async () => {
    const png = await makeRenderer().renderPng(request(fileDoc));
    expect(magentaPixels(png)).toBe(0);
    const finished = probe.requests.filter(r => r.outcome === 'finished').map(r => r.url);
    expect(finished.filter(u => u.startsWith('file:'))).toEqual([]);
    // 相对路径解析成同主机的 https 网址，不在清单里，一律中止
    const relFailed = probe.requests.filter(r => r.outcome === 'failed' && r.url.startsWith('https://render.invalid/'));
    expect(relFailed.length).toBeGreaterThan(0);
    for (const r of relFailed) expect(blockedByInterception(r.errorText), `${r.url} ${r.errorText}`).toBe(true);
    // 完成的只有入口与 data:（被中止的框里 Chrome 错误页自带的图标）
    expect(finished.filter(u => u !== ENTRY && !u.startsWith('data:'))).toEqual([]);
  }, 30_000);

  it('入口只收 https 网址、且必须是清单里的键：file: 入口被拒，浏览器没有启动', async () => {
    const r = makeRenderer();
    const fileEntry = pathToFileURL(join(dir, 'doc.html')).href;
    await expect(
      r.renderPng({ ...request(fileDoc), entry: fileEntry, resources: new Map([[fileEntry, html(fileDoc)]]) }),
    ).rejects.toThrow(TypeError);
    await expect(r.renderPng({ ...request(fileDoc), entry: 'https://render.invalid/other/' })).rejects.toThrow(
      TypeError,
    );
    await expect(
      r.renderPng({
        ...request(fileDoc),
        entry: 'http://render.invalid/w/',
        resources: new Map([['http://render.invalid/w/', html(fileDoc)]]),
      }),
    ).rejects.toThrow(TypeError);
    // 不是规范写法（缺结尾斜杠）的入口在 Chrome 里会换成另一个网址、落空，提前拒绝
    await expect(
      r.renderPng({
        ...request(fileDoc),
        entry: 'https://render.invalid',
        resources: new Map([['https://render.invalid', html(fileDoc)]]),
      }),
    ).rejects.toThrow(TypeError);
    expect(probe.launches).toBe(0);
  });
});

describe('脚本与请求拦截（真浏览器）', () => {
  it('<script> 不执行', async () => {
    const png = await makeRenderer().renderPng(
      request(
        '<body style="margin:0;background:#fff"><script>document.body.style.background="#ff00ff"</script></body>',
      ),
    );
    expect(magentaPixels(png)).toBe(0);
  }, 30_000);

  it('清单外的 http(s) 子资源一律中止，清单里的精确网址被响应，渲染不挂死', async () => {
    const started = Date.now();
    const png = await makeRenderer().renderPng(
      request(
        '<style>body{margin:0}#b{width:50px;height:50px;background:url(http://10.0.0.1/bg.png)}</style>' +
          '<div id="b"></div><img src="http://169.254.169.254/latest/meta-data/">' +
          '<img src="https://evil.example.com/pixel.png"><img src="https://render.invalid/w/ok.png?x=1">' +
          '<svg viewBox="0 0 10 10" width="10" height="10"><image href="https://evil.example.com/s.png" width="10" height="10"/></svg>' +
          '<img src="https://render.invalid/w/ok.png" width="100" height="60">',
        [['https://render.invalid/w/ok.png', { body: MAGENTA_PNG, contentType: 'image/png' }]],
      ),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(magentaPixels(png)).toBeGreaterThan(5000);
    const finished = new Set(probe.requests.filter(r => r.outcome === 'finished').map(r => r.url));
    expect(finished).toEqual(new Set([ENTRY, 'https://render.invalid/w/ok.png']));
    // 被拦截中止（而不是放出去之后在死端口上失败）
    const blocked = probe.requests
      .filter(r => r.outcome === 'failed' && blockedByInterception(r.errorText))
      .map(r => r.url);
    for (const u of [
      'http://10.0.0.1/bg.png',
      'http://169.254.169.254/latest/meta-data/',
      'https://evil.example.com/pixel.png',
      'https://evil.example.com/s.png',
      // 查询串不同就不是清单里的网址
      'https://render.invalid/w/ok.png?x=1',
    ]) {
      expect(blocked, u).toContain(u);
    }
  }, 30_000);
});

describe('上下文与并发（真浏览器）', () => {
  it('每次渲染新建一个浏览器上下文，渲染结束时关闭', async () => {
    const r = makeRenderer();
    await r.renderPng(request('<p>one</p>'));
    await r.renderPng(request('<p>two</p>'));
    expect(probe.launches).toBe(1);
    expect(probe.contexts).toHaveLength(2);
    expect(probe.contexts.every(c => c.closed)).toBe(true);
  }, 30_000);

  it('并发槽：maxConcurrency=1 时三个渲染排队，同一时刻只开一个上下文', async () => {
    const r = makeRenderer(1);
    await Promise.all([
      r.renderPng(request('<p>a</p>')),
      r.renderPng(request('<p>b</p>')),
      r.renderPng(request('<p>c</p>')),
    ]);
    expect(probe.contexts).toHaveLength(3);
    expect(probe.peak).toBe(1);
  }, 30_000);
});

describe('截图范围（真浏览器）', () => {
  const tall = '<body style="margin:0"><div id="c" style="width:120px;height:5000px;background:#123"></div></body>';

  it('viewport：视口大小乘缩放倍率', async () => {
    const png = await makeRenderer().renderPng({
      ...request(tall),
      viewport: { width: 300, height: 200, deviceScaleFactor: 2 },
    });
    expect(pngSize(png)).toEqual({ width: 600, height: 400 });
  }, 30_000);

  it('element：按元素量高、受 maxHeight 限高', async () => {
    const r = makeRenderer();
    const capped = await r.renderPng({
      ...request(tall),
      viewport: { width: 200, height: 100, deviceScaleFactor: 2 },
      clip: { kind: 'element', selector: '#c', maxHeight: 300 },
    });
    expect(pngSize(capped)).toEqual({ width: 240, height: 600 });
    const short = await r.renderPng({
      ...request('<body style="margin:0"><div id="c" style="width:80px;height:40px"></div></body>'),
      viewport: { width: 200, height: 600 },
      clip: { kind: 'element', selector: '#c', maxHeight: 300 },
    });
    expect(pngSize(short)).toEqual({ width: 80, height: 40 });
    await expect(
      r.renderPng({ ...request(tall), clip: { kind: 'element', selector: '#missing', maxHeight: 300 } }),
    ).rejects.toThrow('#missing');
  }, 30_000);

  it('page：整页、受 maxHeight 限高', async () => {
    const r = makeRenderer();
    const capped = await r.renderPng({
      ...request(tall),
      viewport: { width: 300, height: 200 },
      clip: { kind: 'page', maxHeight: 400 },
    });
    expect(pngSize(capped)).toEqual({ width: 300, height: 400 });
    const short = await r.renderPng({
      ...request('<body style="margin:0"><div style="height:250px"></div></body>'),
      viewport: { width: 300, height: 200 },
      clip: { kind: 'page', maxHeight: 400 },
    });
    expect(pngSize(short)).toEqual({ width: 300, height: 250 });
  }, 30_000);
});
