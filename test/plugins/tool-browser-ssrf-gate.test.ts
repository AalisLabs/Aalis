import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { promises as dns } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// 浏览器工具的 SSRF 闸（真 Chromium + 测试自己在本机起的 http / udp 服务）：
// 浏览器的全部 TCP 连接经插件进程内的网络闸，页面、SharedWorker、Service Worker、页面自己 window.open 出的窗口、
// 重定向的每一跳与 WebSocket 都经过它；WebRTC 不发 UDP。
//
// 取址约定：页面由 127.0.0.1 提供（allowedHosts 放行），「不该到达」的目标写成 http://localhost:端口，
// 与页面同一个服务。闸失效时请求真会落到服务端，所以「服务端收不到」就是被拦的直接证据。
// 局域网、链路本地地址与解析到私网的主机名只经重定向到达，断言导航以 net::ERR_SOCKS_CONNECTION_FAILED 失败。
//
// 不外发：闸的域名解析全部由 DNS 替身作答（未知主机一律解析失败），Chrome 自己的后台请求同样经闸、被拒；
// 测试启动的 Chrome 另把回环以外的主机（含 IP 字面量）映射到本机没有服务的端口，闸失效、浏览器直连时也出不了本机。
// 不开闸的一组另加 --no-proxy-server，不走系统代理。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

// 测试里启动的 Chrome 追加参数：没起闸（没有 --proxy-server）时不走系统代理，起了闸时不加这一条，免得盖掉闸；
// 除 127.0.0.1 与 localhost 外的主机一律映射到 127.0.0.1:1（只作用于浏览器自己解析的连接，经闸的连接由闸解析）；
// WebRTC 不用 mDNS 主机名（否则会向局域网发组播）。
// 不映射成「解析不到」：导航因解析失败出错时，Chrome 会拿公网域名做一次 DNS 探测
vi.mock(
  '../../packages/plugin-tool-browser/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    // 根目录不直接依赖 puppeteer：只声明用到的部分，不经类型导入引用它
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<unknown>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = options =>
      actual.launch({
        ...options,
        args: [
          ...(options?.args ?? []),
          ...(options?.args?.some(a => a.startsWith('--proxy-server=')) ? [] : ['--no-proxy-server']),
          '--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE 127.0.0.1, EXCLUDE localhost',
          '--disable-features=WebRtcHideLocalIpsWithMdns',
        ],
      });
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

const RUN_JS = `
const q = new URLSearchParams(location.search);
const kind = q.get('kind'), target = q.get('target'), tag = q.get('tag');
const probe = url => fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(() => 'passed', () => 'blocked');
const done = r => fetch('/zz-done/' + tag + '?r=' + encodeURIComponent(r), { cache: 'no-store' });
async function run() {
  if (kind === 'page') return probe(target);
  if (kind === 'ws') {
    return new Promise(resolve => {
      const ws = new WebSocket(target);
      ws.onopen = () => resolve('passed');
      ws.onerror = () => resolve('blocked');
    });
  }
  if (kind === 'rtc') {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: target }] });
    pc.createDataChannel('zz');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => {
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
      setTimeout(resolve, 3000);
    });
    pc.close();
    return 'gathered';
  }
  if (kind === 'shared') {
    return new Promise(resolve => {
      const worker = new SharedWorker('/shared.js');
      worker.port.onmessage = e => resolve(e.data);
      worker.port.postMessage(target);
    });
  }
  if (kind === 'sw') {
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => resolve(e.data);
      reg.active.postMessage(target, [channel.port2]);
    });
  }
  // popup：新窗口自己探测并回报，本页不回报
  window.open('/run.html?' + new URLSearchParams({ kind: 'page', target, tag }));
  return null;
}
run().then(r => r === null || done(r), e => done('error:' + e));
`;
const SHARED_JS = `
onconnect = e => {
  const port = e.ports[0];
  port.onmessage = ev =>
    fetch(ev.data, { mode: 'no-cors', cache: 'no-store' }).then(() => 'passed', () => 'blocked').then(r => port.postMessage(r));
};
`;
const SW_JS = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e =>
  e.waitUntil(
    fetch(e.data, { mode: 'no-cors', cache: 'no-store' }).then(() => 'passed', () => 'blocked').then(r => e.ports[0].postMessage(r)),
  ),
);
`;
const ROUTES: Record<string, [string, string]> = {
  '/normal.html': ['text/html; charset=utf-8', '<title>普通页</title><body><script src="/normal.js"></script></body>'],
  '/normal.js': ['text/javascript', "document.body.append('zz-子资源已加载');"],
  '/run.html': ['text/html; charset=utf-8', '<title>run</title><body><script src="/run.js"></script></body>'],
  '/run.js': ['text/javascript', RUN_JS],
  '/shared.js': ['text/javascript', SHARED_JS],
  '/sw.js': ['text/javascript', SW_JS],
};

let server: Server;
let udp: UdpSocket;
let port: number;
let origin: string;
const hits: string[] = [];
const hits6: string[] = [];
const udpPackets: string[] = [];
/** 重绑定主机名被解析的次数：第一次答 ::1，此后答 127.0.0.1 */
let rebindLookups = 0;

/** 与页面同一个服务、但主机写成 localhost：闸失效时请求会真的落到服务端 */
const secret = (tag: string) => `http://localhost:${port}/zz-secret/${tag}`;
/** 两个服务都算：闸失效时 Chrome 自己解析 localhost，可能连到监听 ::1 的那个 */
const secretHits = (tag: string) => [...hits, ...hits6].filter(p => p === `/zz-secret/${tag}`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(url.pathname + url.search);
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    const route = ROUTES[url.pathname];
    if (route) {
      res.writeHead(200, { 'content-type': route[0], 'cache-control': 'no-store' });
      res.end(route[1]);
      return;
    }
    res.writeHead(url.pathname.startsWith('/zz-') ? 200 : 404, { 'content-type': 'text/plain' });
    res.end('zz');
  });
  // WebSocket 握手：记下到达的路径即断开，不必真的建立连接
  server.on('upgrade', (req, socket) => {
    hits.push(`upgrade ${new URL(req.url ?? '/', 'http://x').pathname}`);
    socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  udp = createSocket('udp4');
  udp.on('message', (_msg, rinfo) => udpPackets.push(`${rinfo.address}:${rinfo.port}`));
  await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
  // DNS 替身：只认测试自己的主机名，其余一律解析失败，测试进程不向外发 DNS 查询
  vi.spyOn(dns, 'lookup').mockImplementation((async (host: string) => {
    if (host === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'intranet.zz-test') return [{ address: '10.1.2.3', family: 4 }];
    if (host === 'rebind.zz-test') {
      return ++rebindLookups === 1 ? [{ address: '::1', family: 6 }] : [{ address: '127.0.0.1', family: 4 }];
    }
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }) as never);
});

afterAll(async () => {
  vi.restoreAllMocks();
  udp.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

/** 起一个装好浏览器插件的 App，工具 handler 收进返回的表里 */
async function startBrowserTools(
  config: Record<string, unknown>,
): Promise<{ app: App; handlers: Record<string, Handler> }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide });
  const handlers: Record<string, Handler> = {};
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, { registerPage: () => () => {}, registerAction: () => () => {} } as never);
  await app.plugins.register(browserPlugin, { headless: true, defaultTimeout: 20_000, ...config });
  await app.plugins.idle();
  return { app, handlers };
}

async function navigate(handlers: Record<string, Handler>, url: string): Promise<{ error?: string; text?: string }> {
  return JSON.parse((await handlers.browser_navigate({ url }, { sessionId: 's' })) as string);
}

/** 等页面（或它开的窗口、它起的 worker）把探测结果回报到 /zz-done/<tag> */
async function waitForDone(tag: string, timeoutMs = 30_000): Promise<string> {
  const prefix = `/zz-done/${tag}?r=`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = hits.find(p => p.startsWith(prefix));
    if (hit) return decodeURIComponent(hit.slice(prefix.length));
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`${timeoutMs}ms 内没等到 ${tag} 的回报`);
}

/** 打开 run.html，让页面 / WebSocket / WebRTC / SharedWorker / Service Worker / 弹出窗口去访问 target */
async function runScenario(
  handlers: Record<string, Handler>,
  kind: 'page' | 'ws' | 'rtc' | 'shared' | 'sw' | 'popup',
  target: string,
  tag: string,
): Promise<string> {
  const out = await navigate(handlers, `${origin}/run.html?${new URLSearchParams({ kind, target, tag })}`);
  if (out.error) throw new Error(`打开场景页失败: ${out.error}`);
  return waitForDone(tag);
}

describe('blockPrivate=true：浏览器网络闸', () => {
  let app: App | undefined;
  let handlers: Record<string, Handler>;

  // 与 server 同端口、监听 ::1 的第二个服务：重绑定用例里放行的地址，也是 IPv6 白名单用例的目标
  let server6: Server;

  beforeAll(async () => {
    server6 = createServer((req, res) => {
      hits6.push(new URL(req.url ?? '/', 'http://x').pathname);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('zz-v6');
    });
    server6.on('upgrade', (req, socket) => {
      hits6.push(`upgrade ${new URL(req.url ?? '/', 'http://x').pathname}`);
      socket.destroy();
    });
    // 监听失败（没有 IPv6 回环、端口在 ::1 上被占）立即带原因报出，不等到钩子超时
    await new Promise<void>((resolve, reject) => {
      server6.once('error', reject);
      server6.listen(port, '::1', resolve);
    });
    ({ app, handlers } = await startBrowserTools({ blockPrivate: true, allowedHosts: ['127.0.0.1', '[::1]'] }));
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await new Promise<void>(resolve => server6.close(() => resolve()));
  }, 30_000);

  it('正常页面加载不受影响：白名单主机的页面与子资源照常加载', async () => {
    const out = await navigate(handlers, `${origin}/normal.html`);
    expect(out.error).toBeUndefined();
    expect(out.text).toContain('zz-子资源已加载');
  }, 60_000);

  it('allowedHosts 里的主机放行：页面与 SharedWorker 的请求都到达服务端', async () => {
    const allowed = (tag: string) => `${origin}/zz-secret/${tag}`;
    expect(await runScenario(handlers, 'page', allowed('allowed-page'), 'allowed-page')).toBe('passed');
    expect(await runScenario(handlers, 'shared', allowed('allowed-shared'), 'allowed-shared')).toBe('passed');
    expect(secretHits('allowed-page')).toHaveLength(1);
    expect(secretHits('allowed-shared')).toHaveLength(1);
  }, 60_000);

  it('allowedHosts 里的 IPv6 字面量（带方括号写）放行', async () => {
    const out = await navigate(handlers, `http://[::1]:${port}/zz-v6-allowed`);
    expect(out.error).toBeUndefined();
    expect(out.text).toContain('zz-v6');
    expect(hits6).toContain('/zz-v6-allowed');
  }, 60_000);

  it('页面 fetch 回环地址被拦，服务端收不到', async () => {
    expect(await runScenario(handlers, 'page', secret('page'), 'page')).toBe('blocked');
    expect(secretHits('page')).toEqual([]);
  }, 60_000);

  it('写成 IP 字面量的回环地址被拦（IPv4 映射的 IPv6 写法，闸失效时会连到 127.0.0.1）', async () => {
    const target = `http://[::ffff:127.0.0.1]:${port}/zz-secret/mapped`;
    expect(await runScenario(handlers, 'page', target, 'mapped')).toBe('blocked');
    expect(secretHits('mapped')).toEqual([]);
  }, 60_000);

  it('WebSocket 连回环地址被拦，服务端收不到握手', async () => {
    expect(await runScenario(handlers, 'ws', `ws://localhost:${port}/zz-secret/ws`, 'ws')).toBe('blocked');
    expect([...hits, ...hits6]).not.toContain('upgrade /zz-secret/ws');
  }, 60_000);

  it('WebRTC 不发 UDP：页面向本机 STUN 端口收集候选，UDP 服务收不到包', async () => {
    const before = udpPackets.length;
    expect(await runScenario(handlers, 'rtc', `stun:127.0.0.1:${udp.address().port}`, 'rtc')).toBe('gathered');
    expect(udpPackets.slice(before)).toEqual([]);
  }, 60_000);

  it('SharedWorker fetch 回环地址被拦，服务端收不到', async () => {
    expect(await runScenario(handlers, 'shared', secret('shared'), 'shared')).toBe('blocked');
    expect(secretHits('shared')).toEqual([]);
  }, 60_000);

  it('Service Worker fetch 回环地址被拦，服务端收不到', async () => {
    expect(await runScenario(handlers, 'sw', secret('sw'), 'sw')).toBe('blocked');
    expect(secretHits('sw')).toEqual([]);
  }, 60_000);

  it('运行中途由页面 window.open 打开的新窗口，请求同样被拦', async () => {
    expect(await runScenario(handlers, 'popup', secret('popup'), 'popup')).toBe('blocked');
    expect(secretHits('popup')).toEqual([]);
  }, 60_000);

  it('重定向到回环地址被拦：跳转前一跳到达，跳转目标收不到；报错附带拦截说明', async () => {
    const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent(secret('redirect'))}`);
    expect(out.error).toContain('net::ERR_SOCKS_CONNECTION_FAILED');
    expect(out.error).toContain('被 blockPrivate 拦截');
    expect(hits).toContain(`/redirect?to=${encodeURIComponent(secret('redirect'))}`);
    expect(secretHits('redirect')).toEqual([]);
  }, 60_000);

  it('重定向到局域网、链路本地地址与 https 回环地址被拦', async () => {
    const targets = [
      'http://192.168.255.254:8080/',
      'http://10.255.255.1:8080/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[fe80::1]:8080/',
      `https://localhost:${port}/`,
    ];
    for (const target of targets) {
      const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent(target)}`);
      expect(out.error, target).toContain('net::ERR_SOCKS_CONNECTION_FAILED');
    }
  }, 60_000);

  it('解析到私网的主机名被拦（字符串级判定放过、DNS 级判定拦下）', async () => {
    const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent('http://intranet.zz-test/')}`);
    expect(out.error).toContain('net::ERR_SOCKS_CONNECTION_FAILED');
    expect(dns.lookup).toHaveBeenCalledWith('intranet.zz-test', expect.objectContaining({ all: true }));
  }, 60_000);

  it('DNS 解析失败按拒绝处理', async () => {
    const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent('http://dnsfail.zz-test/')}`);
    expect(out.error).toContain('net::ERR_SOCKS_CONNECTION_FAILED');
    expect(dns.lookup).toHaveBeenCalledWith('dnsfail.zz-test', expect.objectContaining({ all: true }));
  }, 60_000);

  it('DNS 重绑定：连接用的就是判定过的那次解析，再解析换成的受限地址收不到请求', async () => {
    // 策略：::1 放行、127.0.0.1 受限；替身第一次把 rebind.zz-test 答成 ::1，此后答成 127.0.0.1
    setNetworkPolicy({ blockPrivate: false, denyCidrs: ['127.0.0.1/32'] });
    try {
      const out = await navigate(handlers, `http://rebind.zz-test:${port}/zz-secret/rebind`);
      expect(out.error).toBeUndefined();
      expect(out.text).toContain('zz-v6');
      expect(hits6).toContain('/zz-secret/rebind');
      expect(hits).not.toContain('/zz-secret/rebind');
    } finally {
      setNetworkPolicy({});
    }
  }, 60_000);

  it('拦截之后正常请求照常可用', async () => {
    const out = await navigate(handlers, `${origin}/normal.html`);
    expect(out.error).toBeUndefined();
    expect(out.text).toContain('zz-子资源已加载');
  }, 60_000);
});

describe('blockPrivate=false：不开闸', () => {
  let app: App;
  let handlers: Record<string, Handler>;

  beforeAll(async () => {
    ({ app, handlers } = await startBrowserTools({ blockPrivate: false }));
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  }, 30_000);

  it('页面、SharedWorker 与 WebSocket 访问回环地址都到达服务端', async () => {
    expect(await runScenario(handlers, 'page', secret('open-page'), 'open-page')).toBe('passed');
    expect(await runScenario(handlers, 'shared', secret('open-shared'), 'open-shared')).toBe('passed');
    // 服务端收到握手即断开，页面一侧总是 onerror；到没到达看服务端
    await runScenario(handlers, 'ws', `ws://localhost:${port}/zz-secret/open-ws`, 'open-ws');
    expect(secretHits('open-page')).toHaveLength(1);
    expect(secretHits('open-shared')).toHaveLength(1);
    expect(hits).toContain('upgrade /zz-secret/open-ws');
  }, 60_000);

  it('WebRTC 照常向 STUN 端口发 UDP（上一组「收不到包」的对照）', async () => {
    const before = udpPackets.length;
    expect(await runScenario(handlers, 'rtc', `stun:127.0.0.1:${udp.address().port}`, 'open-rtc')).toBe('gathered');
    expect(udpPackets.length).toBeGreaterThan(before);
  }, 60_000);
});
