import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OfflineRenderer } from '../../packages/util-offline-render/src/index.js';

// ════════════════════════════════════════════════════════════
// 零网络（真 Chromium）：渲染期间没有连接到达「死端口」之外的任何地方，文档引用的资源没有一个被真正请求出去。
//
// 生产里有三道：逐请求拦截（清单外一律中止）；解析规则把所有主机名映射到 127.0.0.1:1；代理指向同一个死端口，
// 且 `<-loopback>` 让回环地址也走代理。这里 puppeteer 的 launch 外包一层，把解析规则与代理的目标换成两个本地
// 计数监听（记下每条连接的第一行），另起一个监听代表「外网」，文档用 IP 字面量引用它。
// 本机实测：解析规则 `MAP *` 连代理地址与 IP 字面量一起映射，所以连接实际都落在解析规则那个监听上；生产里两者
// 本来就是同一个死端口，下面把两个监听合起来看。
//
// 断言：
// - 「外网」监听收到 0 个连接；计数监听上没有发往回环 IP 字面量的真请求。
// - 取资源的向量（img、srcset、prefetch、@import、@font-face、poster，各用一个独立主机名）的主机一次都不出现：
//   这些请求都在拦截里被中止，根本不出浏览器。
// - 框的导航（iframe、框里的 meta refresh）：Chrome 在导航开始时先按目标预连接，早于拦截（与入口导航出现的
//   render.invalid:443 同理），所以它们的主机允许出现，但只能是建连（经代理的 CONNECT，或直连时的 TLS 握手），
//   不能是明文请求行。建连本身看不出里面有没有请求；导航请求确实被拦截中止，由 offline-render-isolation 按
//   requestfailed 的错误码断言。
// - 预连接与 DNS 预取是投机连接、不经拦截，允许落在死端口上（生产里那里没有服务），只记录。
// - Chrome 自己的后台请求（审查与本机实测：clients2.google.com/time、accounts.google.com:443、www.google.com:443）
//   同样落在死端口上，所以不断言计数监听为 0，观察到的连接打印在输出里。
// 主框架的 meta refresh 不在这里测：被中止后 Chrome 换上错误页，渲染随之失败（见 engine.ts 头注释），放进框里测同一机制。
//
// 变异记录（2026-09-28，本机 Chrome 146）：拦截改为全部放行 → 本用例失败（img.ext.test 的 CONNECT 出现）。
// 去掉代理两项参数、同时去掉下面对这两项参数的断言 → 本用例仍通过：解析规则 `MAP *` 已把主机名与 IP 字面量都送到
// 死端口，投机连接经不经代理在本环境不可观测；代理另外压住的 macOS 系统代理，不外发就测不了。所以代理这一道
// 只由参数断言守着（参数还在），没有行为上的验证。
//
// 「外网」监听放在 127.0.0.1 的另一个端口上：macOS 默认只有 127.0.0.1 这一个回环地址，127.0.0.2 绑不上；
// 对 Chrome 而言两者同为回环地址，走的是同一条「回环默认直连」的规则。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({
  /** 被测代码自己给的启动参数（换端口之前） */
  originalArgs: [] as string[][],
  resolverPort: 0,
  proxyPort: 0,
}));

vi.mock(
  '../../packages/util-offline-render/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<unknown>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = async options => {
      const args = options?.args ?? [];
      probe.originalArgs.push([...args]);
      let rewritten = args.map(a =>
        a === '--host-resolver-rules=MAP * 127.0.0.1:1'
          ? `--host-resolver-rules=MAP * 127.0.0.1:${probe.resolverPort}`
          : a === '--proxy-server=http://127.0.0.1:1'
            ? `--proxy-server=http://127.0.0.1:${probe.proxyPort}`
            : a,
      );
      // 测试保底：被测代码没给代理（变异时）就直连，不走本机的系统代理
      if (!rewritten.some(a => a.startsWith('--proxy-server='))) rewritten = [...rewritten, '--no-proxy-server'];
      return actual.launch({ ...options, args: rewritten });
    };
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

interface Counter {
  server: Server;
  port: number;
  /** 每条连接的第一行（没发数据的连接记空串） */
  lines: string[];
}

async function listenCounter(): Promise<Counter> {
  const lines: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let recorded = false;
    const record = (line: string) => {
      if (recorded) return;
      recorded = true;
      lines.push(line);
    };
    socket.once('data', chunk => {
      record(chunk.toString('latin1').split('\r\n')[0]);
      socket.destroy();
    });
    socket.on('close', () => {
      record('');
      sockets.delete(socket);
    });
    socket.on('error', () => {});
  });
  server.on('close', () => {
    for (const s of sockets) s.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('监听地址异常');
  return { server, port: address.port, lines };
}

/** 取资源的向量：每个一个独立主机名，出现在计数监听上就说明请求出了浏览器 */
const FETCH_HOSTS = [
  'img.ext.test',
  'srcset.ext.test',
  'prefetch.ext.test',
  'import.ext.test',
  'font.ext.test',
  'poster.ext.test',
];
/** 框的导航：允许导航开始时的预连接（CONNECT 或 TLS 握手），不允许明文请求行 */
const NAVIGATION_HOSTS = ['iframe.ext.test', 'refresh.ext.test'];
/** 投机连接向量：允许落在死端口上，只记录 */
const HINT_HOSTS = ['preconnect.ext.test', 'dnsprefetch.ext.test'];

let resolver: Counter;
let proxy: Counter;
let external: Counter;

beforeAll(async () => {
  resolver = await listenCounter();
  proxy = await listenCounter();
  external = await listenCounter();
  probe.resolverPort = resolver.port;
  probe.proxyPort = proxy.port;
});

afterAll(async () => {
  for (const c of [resolver, proxy, external]) await new Promise(resolve => c?.server.close(resolve));
});

describe('零网络（真浏览器）', () => {
  it('外部引用与 IP 字面量：「外网」收到 0 个连接，取资源的向量没有一个出浏览器', async () => {
    const ext = `127.0.0.1:${external.port}`;
    const doc =
      '<!doctype html><html><head>' +
      '<link rel="preconnect" href="https://preconnect.ext.test">' +
      `<link rel="preconnect" href="http://${ext}">` +
      '<link rel="dns-prefetch" href="//dnsprefetch.ext.test">' +
      '<link rel="prefetch" href="https://prefetch.ext.test/p.bin">' +
      `<link rel="prefetch" href="http://${ext}/prefetch.bin">` +
      '<style>@import url("https://import.ext.test/a.css");' +
      '@font-face{font-family:x;src:url("https://font.ext.test/f.woff2")}body{font-family:x;margin:0}' +
      `#ip{width:10px;height:10px;background:url("http://${ext}/bg.png")}</style>` +
      '</head><body><p>字</p>' +
      '<img src="https://img.ext.test/a.png">' +
      '<img srcset="https://srcset.ext.test/a.png 1x, https://srcset.ext.test/b.png 2x">' +
      '<video poster="https://poster.ext.test/p.png" width="20" height="20"></video>' +
      '<iframe src="https://iframe.ext.test/"></iframe><iframe src="frame.html"></iframe>' +
      `<img src="http://${ext}/ip.png"><div id="ip"></div>` +
      '</body></html>';
    const frame = '<meta http-equiv="refresh" content="0;url=https://refresh.ext.test/next"><p>frame</p>';
    const html = (body: string) => ({ body: new TextEncoder().encode(body), contentType: 'text/html; charset=utf-8' });
    const renderer = new OfflineRenderer({
      sandbox: 'preferred',
      idleShutdownSec: 0,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    try {
      await renderer.renderPng({
        entry: 'https://render.invalid/w/',
        resources: new Map([
          ['https://render.invalid/w/', html(doc)],
          ['https://render.invalid/w/frame.html', html(frame)],
        ]),
        viewport: { width: 400, height: 300 },
        clip: { kind: 'viewport' },
      });
      // 框里的 refresh、投机连接与后台请求是异步发起的，多等一会儿再看
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      await renderer.dispose();
    }

    // 换端口确实发生了：被测代码给的就是生产里的死端口参数
    expect(probe.originalArgs.length).toBeGreaterThan(0);
    for (const args of probe.originalArgs) {
      expect(args).toContain('--host-resolver-rules=MAP * 127.0.0.1:1');
      expect(args).toContain('--proxy-server=http://127.0.0.1:1');
      expect(args).toContain('--proxy-bypass-list=<-loopback>');
    }

    const seen = [...resolver.lines, ...proxy.lines];
    const hints = HINT_HOSTS.filter(host => seen.some(line => line.includes(host)));
    console.info(
      `[offline-render] 死端口上的连接：解析 ${JSON.stringify(resolver.lines)}；代理 ${JSON.stringify(proxy.lines)}；` +
        `其中投机连接向量 ${JSON.stringify(hints)}`,
    );
    expect(external.lines).toEqual([]);
    for (const host of FETCH_HOSTS) {
      expect(
        seen.filter(line => line.includes(host)),
        host,
      ).toEqual([]);
    }
    for (const host of NAVIGATION_HOSTS) {
      expect(
        seen.filter(
          line => line.includes(host) && !line.startsWith(`CONNECT ${host}:443 `) && !line.startsWith('\x16'),
        ),
        host,
      ).toEqual([]);
    }
    // 回环 IP 字面量上的真请求（图片、背景、prefetch）同样不该出现在计数监听上
    expect(seen.filter(line => /http:\/\/127\.0\.0\.1:\d+\/|^GET \/(ip|bg|prefetch)/.test(line))).toEqual([]);
  }, 60_000);
});
