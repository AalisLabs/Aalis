import { promises as dns } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';

// ════════════════════════════════════════════════════════════
// 浏览器工具的 SSRF 闸（真 Chromium + 测试自己在 127.0.0.1 起的 http 服务）：
// 闸开在浏览器级，页面、SharedWorker、Service Worker 与页面自己 window.open 出的窗口发出的请求都要经过它。
// 页面级拦截（page.setRequestInterception）管不到后三种——请求直达服务端、拦截函数不被调用。
//
// 取址约定：页面由 127.0.0.1 提供（allowedHosts 放行），「不该到达」的目标写成 http://localhost:端口，
// 与页面同一个服务。闸失效时请求真会落到服务端，所以「服务端收不到」就是被拦的直接证据。
// 局域网地址、https 回环地址与解析到私网的主机名只经重定向到达（顶层导航开始时 Chrome 会对目标预连接，
// 重定向与 fetch 不会），断言导航以 net::ERR_BLOCKED_BY_CLIENT 失败。
//
// 不外发解析：测试进程的 DNS 由替身作答；测试启动的 Chrome 不走系统代理，回环以外的主机一律映射到本机没有服务的
// 端口，所以即使闸失效，*.zz-test 这类测试主机名也不会被 Chrome 或代理拿去做真实解析，请求出不了本机。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

/** 判定注入点：返回 promise 即取代 assertSafeHost 的这一次判定，返回 undefined 走真实实现 */
const guard = vi.hoisted(() => ({
  override: undefined as ((host: string) => Promise<void> | undefined) | undefined,
}));
vi.mock('../../packages/util-network-guard/src/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/util-network-guard/src/index.js')>();
  return { ...actual, assertSafeHost: (host: string) => guard.override?.(host) ?? actual.assertSafeHost(host) };
});

// 测试里启动的 Chrome 追加两个参数：不走系统代理；除 127.0.0.1 与 localhost 外的主机一律映射到 127.0.0.1:1。
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
          '--no-proxy-server',
          '--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE 127.0.0.1, EXCLUDE localhost',
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
let port: number;
let origin: string;
const hits: string[] = [];

/** 与页面同一个服务、但主机写成 localhost：闸失效时请求会真的落到服务端 */
const secret = (tag: string) => `http://localhost:${port}/zz-secret/${tag}`;
const secretHits = (tag: string) => hits.filter(p => p === `/zz-secret/${tag}`);

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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  // DNS 替身：只认测试自己的主机名，其余一律解析失败，测试进程不向外发 DNS 查询
  vi.spyOn(dns, 'lookup').mockImplementation((async (host: string) => {
    if (host === 'intranet.zz-test') return [{ address: '10.1.2.3', family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }) as never);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  guard.override = undefined;
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

/** 打开 run.html，让页面 / SharedWorker / Service Worker / 弹出窗口去 fetch target，返回 passed | blocked */
async function runScenario(
  handlers: Record<string, Handler>,
  kind: 'page' | 'shared' | 'sw' | 'popup',
  target: string,
  tag: string,
): Promise<string> {
  const out = await navigate(handlers, `${origin}/run.html?${new URLSearchParams({ kind, target, tag })}`);
  if (out.error) throw new Error(`打开场景页失败: ${out.error}`);
  return waitForDone(tag);
}

describe('blockPrivate=true：浏览器级请求闸', () => {
  let app: App;
  let handlers: Record<string, Handler>;

  beforeAll(async () => {
    ({ app, handlers } = await startBrowserTools({ blockPrivate: true, allowedHosts: ['127.0.0.1'] }));
  }, 60_000);

  afterAll(async () => {
    await app.stop();
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

  it('页面 fetch 回环地址被拦，服务端收不到', async () => {
    expect(await runScenario(handlers, 'page', secret('page'), 'page')).toBe('blocked');
    expect(secretHits('page')).toEqual([]);
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

  it('重定向到回环地址被拦：跳转前一跳到达，跳转目标收不到', async () => {
    const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent(secret('redirect'))}`);
    expect(out.error).toContain('net::ERR_BLOCKED_BY_CLIENT');
    expect(hits).toContain(`/redirect?to=${encodeURIComponent(secret('redirect'))}`);
    expect(secretHits('redirect')).toEqual([]);
  }, 60_000);

  it('重定向到局域网地址（192.168.x、10.x）与 https 回环地址被拦', async () => {
    for (const target of ['http://192.168.255.254:9/', 'http://10.255.255.1:9/', `https://localhost:${port}/`]) {
      const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent(target)}`);
      expect(out.error, target).toContain('net::ERR_BLOCKED_BY_CLIENT');
    }
  }, 60_000);

  it('解析到私网的主机名被拦（字符串级判定放过、DNS 级判定拦下）', async () => {
    const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent('http://intranet.zz-test/')}`);
    expect(out.error).toContain('net::ERR_BLOCKED_BY_CLIENT');
    expect(dns.lookup).toHaveBeenCalledWith('intranet.zz-test', { all: true });
  }, 60_000);

  it('DNS 解析失败按拒绝处理', async () => {
    const out = await navigate(handlers, `${origin}/redirect?to=${encodeURIComponent('http://dnsfail.zz-test/')}`);
    expect(out.error).toContain('net::ERR_BLOCKED_BY_CLIENT');
    expect(dns.lookup).toHaveBeenCalledWith('dnsfail.zz-test', { all: true });
  }, 60_000);

  it('判定抛错时请求被拒而不是放行', async () => {
    const judged: string[] = [];
    guard.override = host => {
      judged.push(host);
      return host === 'localhost' ? Promise.reject(new TypeError('zz-注入的判定故障')) : undefined;
    };
    expect(await runScenario(handlers, 'page', secret('throw'), 'throw')).toBe('blocked');
    expect(judged).toContain('localhost');
    expect(secretHits('throw')).toEqual([]);
  }, 60_000);

  it('判定迟迟不返回时按时限拒绝，暂停的请求不会一直挂着', async () => {
    guard.override = host => (host === 'localhost' ? new Promise<void>(() => {}) : undefined);
    const started = Date.now();
    expect(await runScenario(handlers, 'page', secret('hang'), 'hang')).toBe('blocked');
    // 判定时限是 10 秒：远早于此就回报，说明走的不是超时这条路
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(secretHits('hang')).toEqual([]);
  }, 60_000);
});

describe('blockPrivate=false：不开拦截', () => {
  let app: App;
  let handlers: Record<string, Handler>;

  beforeAll(async () => {
    ({ app, handlers } = await startBrowserTools({ blockPrivate: false }));
  }, 60_000);

  afterAll(async () => {
    await app.stop();
  }, 30_000);

  it('页面与 SharedWorker 访问回环地址都到达服务端', async () => {
    expect(await runScenario(handlers, 'page', secret('open-page'), 'open-page')).toBe('passed');
    expect(await runScenario(handlers, 'shared', secret('open-shared'), 'open-shared')).toBe('passed');
    expect(secretHits('open-page')).toHaveLength(1);
    expect(secretHits('open-shared')).toHaveLength(1);
  }, 60_000);
});
