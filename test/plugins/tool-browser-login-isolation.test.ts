import { promises as dns } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 登录态归打开它的根会话（真 Chromium + 本机 http 服务）：一个会话登录后（站点种下 cookie、页面写 localStorage），
// 别的会话与没有会话的调用打开同一站点读不到，它的子会话读得到；会话删除后，同一 id 再打开也读不到原来的登录态。
//
// 不外发：浏览器的连接全部经网络闸（blockPrivate=true，只放行 127.0.0.1），闸的域名解析由 DNS 替身作答、
// 一律失败；Chrome 自己解析的主机另映射到本机没有服务的端口。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', async importOriginal => {
  type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<unknown>;
  const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
  const launch: Launch = options =>
    actual.launch({
      ...options,
      args: [...(options?.args ?? []), '--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE 127.0.0.1'],
    });
  return { ...actual, default: { ...actual.default, launch }, launch };
});

/** /login 种下 cookie 并写 localStorage；其余路径把收到的 cookie 与读到的 localStorage 写进正文 */
const LOGIN = `<!doctype html><title>zz-login</title><body>logged in
<script>localStorage.setItem('zz-token', 'zz-placeholder-token')</script></body>`;
const me = (cookie: string) =>
  `<!doctype html><title>zz-me</title><body>cookie=[${cookie}]<script>document.body.append(' storage=[' + (localStorage.getItem('zz-token') ?? '') + ']')</script></body>`;
const LOGGED_IN = 'cookie=[sid=zz-placeholder-session] storage=[zz-placeholder-token]';
const LOGGED_OUT = 'cookie=[] storage=[]';

/** 会话表：root 有子会话 child；other 是另一个根会话 */
const SESSIONS = new Map<string, Partial<SessionInfo>>([
  ['root', { id: 'root' }],
  ['child', { id: 'child', parentId: 'root' }],
  ['other', { id: 'other' }],
]);

let server: Server;
let origin: string;
let app: App;
let emit: (event: 'session:deleted', sessionId: string) => Promise<void>;
const handlers: Record<string, Handler> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'sid=zz-placeholder-session; Path=/',
      });
      res.end(LOGIN);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(me(req.headers.cookie ?? ''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.spyOn(dns, 'lookup').mockImplementation((async (host: string) => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }) as never);

  app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, events });
  host.provide.use(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(sessionManager, { getSession: (id: string) => SESSIONS.get(id) } as never);
  emit = (event, sessionId) => host.events.use.emit(event, sessionId);
  await app.plugins.register(browserPlugin, {
    headless: true,
    defaultTimeout: 15_000,
    blockPrivate: true,
    allowedHosts: ['127.0.0.1'],
  });
  await app.plugins.idle();
}, 60_000);

afterAll(async () => {
  await app.stop();
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
}, 30_000);

/** 在这个会话里打开站点上的一页，返回 pageId 与正文 */
async function visit(path: string, sessionId: string): Promise<{ pageId: string; text: string }> {
  const out = await handlers.browser_navigate({ url: `${origin}${path}` }, toolContext({ sessionId }));
  const result = JSON.parse(typeof out === 'string' ? out : out.content);
  if (result.error) throw new Error(`打开页面失败: ${result.error}`);
  return { pageId: result.pageId, text: result.text };
}

describe('登录态归打开它的根会话', () => {
  it('会话登录后，别的会话与没有会话的调用打开同一站点读不到，它的子会话读得到', async () => {
    await visit('/login', 'root');

    expect((await visit('/me', 'other')).text).toContain(LOGGED_OUT);
    expect((await visit('/me', '')).text).toContain(LOGGED_OUT);
    expect((await visit('/me', 'child')).text).toContain(LOGGED_IN);
  }, 60_000);

  it('会话删除后它的页面关掉，同一 id 再打开读不到原来的登录态', async () => {
    const { pageId } = await visit('/login', 'other');
    expect((await visit('/me', 'other')).text).toContain(LOGGED_IN);
    await emit('session:deleted', 'other');

    const stale = await handlers.browser_get_text({ pageId }, toolContext({ sessionId: 'other' }));
    expect(JSON.parse(stale as string)).toEqual({ error: '页面不存在' });
    expect((await visit('/me', 'other')).text).toContain(LOGGED_OUT);
  }, 60_000);
});
