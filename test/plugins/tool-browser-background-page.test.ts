import { promises as dns } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';

// ════════════════════════════════════════════════════════════
// 被压到后台的页面上的操作（真 Chromium + 本机 http 服务）：
// 无头 Chrome 的后台页不跑渲染，puppeteer 的点击、默认先清空的输入与按选择器截图都要等元素进入视口，
// 在后台页上会一直挂住。页面自己开窗（window.open、target=_blank）会把原页压到后台；插件的多个页面
// 若同在一个窗口里，也会互相压到后台。
// 每次工具调用都与时限赛跑：挂住时以超时失败，而不是让测试一直等下去。
//
// 不外发：浏览器的连接全部经网络闸（blockPrivate=true，只放行 127.0.0.1），闸的域名解析由 DNS 替身作答、
// 一律失败；Chrome 自己解析的主机另映射到本机没有服务的端口。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

vi.mock(
  '../../packages/plugin-tool-browser/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<unknown>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = options =>
      actual.launch({
        ...options,
        args: [...(options?.args ?? []), '--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE 127.0.0.1'],
      });
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

const PAGE = `<!doctype html><title>zz-page</title><body>
<button id="plain" onclick="document.title = 'zz-clicked'">plain</button>
<button id="noopener" onclick="window.open('/landing', '_blank', 'noopener')">noopener</button>
<a id="blank" href="/landing" target="_blank">blank</a>
<input id="input" value="zz-old">
</body>`;

/**
 * 单次工具调用的时限：覆盖首次调用里的浏览器冷启动（懒启动 Chrome、起网络闸）与点击后最多 5 秒的网络空闲等待，
 * 挂住时仍远早于用例的 60 秒时限暴露
 */
const CALL_LIMIT_MS = 20_000;

let server: Server;
let origin: string;
let app: App;
const handlers: Record<string, Handler> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/landing' ? '<title>zz-landing</title>landing' : PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.spyOn(dns, 'lookup').mockImplementation((async (host: string) => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }) as never);

  app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide });
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, { registerPage: () => () => {}, registerAction: () => () => {} } as never);
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

/** 调一个工具并与时限赛跑，返回解析后的结果；超时直接抛错 */
async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tool} 超过 ${CALL_LIMIT_MS}ms 未返回`)), CALL_LIMIT_MS);
  });
  try {
    const out = await Promise.race([handlers[tool](args, { sessionId: 's', acceptsImages: true }), limit]);
    return JSON.parse(typeof out === 'string' ? out : out.content);
  } finally {
    clearTimeout(timer);
  }
}

async function openPage(): Promise<string> {
  const out = await call('browser_navigate', { url: `${origin}/` });
  if (out.error) throw new Error(`打开页面失败: ${out.error}`);
  return out.pageId as string;
}

describe('页面被压到后台后的操作按时返回', () => {
  it('页面用 window.open(noopener) 开出新窗口后，再点原页面', async () => {
    const pageId = await openPage();
    expect((await call('browser_click', { pageId, selector: '#noopener' })).ok).toBe(true);
    const out = await call('browser_click', { pageId, selector: '#plain' });
    expect(out).toMatchObject({ ok: true, title: 'zz-clicked' });
  }, 60_000);

  it('点 target=_blank 链接开出新标签页后，再点原页面', async () => {
    const pageId = await openPage();
    expect((await call('browser_click', { pageId, selector: '#blank' })).ok).toBe(true);
    const out = await call('browser_click', { pageId, selector: '#plain' });
    expect(out).toMatchObject({ ok: true, title: 'zz-clicked' });
  }, 60_000);

  it('页面自己开出新窗口后，对原页面做默认先清空的输入、按选择器截图', async () => {
    const pageId = await openPage();
    expect((await call('browser_click', { pageId, selector: '#noopener' })).ok).toBe(true);
    expect(await call('browser_type', { pageId, selector: '#input', text: 'zz-new' })).toEqual({ ok: true });
    expect((await call('browser_click', { pageId, selector: '#noopener' })).ok).toBe(true);
    expect(await call('browser_screenshot', { pageId, selector: '#plain' })).toMatchObject({ ok: true });
  }, 60_000);

  it('两页上的点击并发，多轮都按时返回', async () => {
    const first = await openPage();
    const second = await openPage();
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all([
        call('browser_click', { pageId: first, selector: '#plain' }),
        call('browser_click', { pageId: second, selector: '#plain' }),
        call('browser_click', { pageId: first, selector: '#plain' }),
      ]);
      expect(results.map(r => r.ok)).toEqual([true, true, true]);
    }
  }, 120_000);
});
