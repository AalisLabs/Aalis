import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 页面与登录态都归打开它的根会话（子会话归它的根会话）：
// - 同一根会话里（根会话与它的子会话）能取、能关；别的会话取不到，回的与不存在的页面一样，带别人的 pageId 导航开的是新页面。
// - 每个根会话的页面开在它自己的浏览器上下文里；没有会话的调用（sessionId 为空）共用一个，不在会话表里的会话按它自己算。
//   浏览器重启后上下文随之作废，按需重建。登录态确实不跨上下文，由 tool-browser-login-isolation（真浏览器）守着。
// - 会话删除时关掉它的上下文与页面，别的会话的不动；开页途中被删的，不登记；关上下文卡住时不阻塞删除。
// puppeteer 换成替身（按 util-chromium 的依赖路径 mock），不启动真浏览器；不启动网络闸（blockPrivate=false）。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const fake = vi.hoisted(() => {
  type ContextState = { closed: boolean; pages: PageState[] };
  type PageState = {
    context: ContextState;
    goto: ReturnType<typeof vi.fn>;
    touched: ReturnType<typeof vi.fn>;
    closed: boolean;
  };
  const pages: PageState[] = [];
  const contexts: ContextState[] = [];
  const browsers: Array<{ connected: boolean }> = [];
  /** launching：启动浏览器等它放行；opening：开页面等它放行；failContext：下一次建上下文失败；closeHangs：关上下文一直不返回 */
  const ctl = {
    launching: null as Promise<void> | null,
    opening: null as Promise<void> | null,
    failContext: false,
    closeHangs: false,
  };
  const newPage = vi.fn(async (context: ContextState) => {
    await ctl.opening;
    if (context.closed) throw new Error('zz-上下文已关闭');
    const touched = vi.fn();
    const state: PageState = { context, goto: vi.fn(async () => {}), touched, closed: false };
    pages.push(state);
    context.pages.push(state);
    return {
      setDefaultTimeout: () => {},
      goto: state.goto,
      url: () => 'http://example.zz-test/',
      title: async () => 'zz',
      evaluate: async () => {
        touched('evaluate');
        return 'zz-body';
      },
      bringToFront: async () => touched('bringToFront'),
      click: async () => touched('click'),
      type: async () => touched('type'),
      screenshot: async () => {
        touched('screenshot');
        return Buffer.from('zz-png');
      },
      waitForNetworkIdle: async () => {},
      browser: () => ({}),
      close: async () => {
        state.closed = true;
      },
    };
  });
  const launch = vi.fn(async () => {
    await ctl.launching;
    const browser = {
      connected: true,
      on: () => {},
      close: async () => {},
      createBrowserContext: async () => {
        if (ctl.failContext) {
          ctl.failContext = false;
          throw new Error('zz-建上下文失败');
        }
        const context: ContextState = { closed: false, pages: [] };
        contexts.push(context);
        return {
          newPage: () => newPage(context),
          close: async () => {
            context.closed = true;
            for (const page of context.pages) page.closed = true;
            if (ctl.closeHangs) await new Promise(() => {});
          },
        };
      },
    };
    browsers.push(browser);
    return browser;
  });
  return { launch, newPage, pages, contexts, browsers, ctl };
});
vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: { launch: fake.launch, defaultBrowser: 'chrome', configuration: {} },
  launch: fake.launch,
}));

/** 会话表：root 有子会话 child；other 是另一个根会话。不在表里的 id 按它自己算 */
const SESSIONS = new Map<string, Partial<SessionInfo>>([
  ['root', { id: 'root' }],
  ['child', { id: 'child', parentId: 'root' }],
  ['other', { id: 'other' }],
]);

const apps: App[] = [];
afterEach(async () => {
  fake.ctl.launching = null;
  fake.ctl.opening = null;
  fake.ctl.failContext = false;
  fake.ctl.closeHangs = false;
  for (const app of apps.splice(0)) await app.stop();
  fake.pages.length = 0;
  fake.contexts.length = 0;
  fake.browsers.length = 0;
  fake.launch.mockClear();
  fake.newPage.mockClear();
});

async function start() {
  const app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  const host = app.bind({ provide, events });
  const handlers: Record<string, Handler> = {};
  host.provide.use(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(sessionManager, { getSession: (id: string) => SESSIONS.get(id) } as never);
  // executablePath 非空：跳过「Chrome 未安装就自动下载」那一步
  await app.plugins.register(browserPlugin, { blockPrivate: false, executablePath: '/zz-fake-chrome' });
  await app.plugins.idle();
  // 接得住图：没有存储服务时截图只随结果交出
  const call = async (name: string, args: Record<string, unknown>, sessionId: string) => {
    const out = await handlers[name](args, toolContext({ sessionId, acceptsImages: true }));
    return JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;
  };
  const open = async (sessionId: string) =>
    (await call('browser_navigate', { url: 'http://example.zz-test/' }, sessionId)).pageId as string;
  return { call, open, emit: host.events.use.emit };
}

/** 带 pageId 的工具与它们的其余参数 */
const PAGE_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['browser_get_text', {}],
  ['browser_click', { selector: 'a' }],
  ['browser_type', { selector: 'input', text: 'zz' }],
  ['browser_screenshot', {}],
  ['browser_get_links', {}],
  ['browser_close_page', {}],
];

describe('页面归打开它的根会话', () => {
  it.each(PAGE_TOOLS)('别的会话用 %s 取不到，回的与不存在的页面一样，页面不被碰', async (name, args) => {
    const { call, open } = await start();
    const pageId = await open('root');
    fake.pages[0].touched.mockClear();
    const missing = await call(name, { ...args, pageId: 'page_999' }, 'other');

    expect(await call(name, { ...args, pageId }, 'other')).toEqual(missing);
    expect(fake.pages[0].touched).not.toHaveBeenCalled();
    expect(fake.pages[0].closed).toBe(false);
  });

  it('子会话取得到根会话打开的页面', async () => {
    const { call, open } = await start();
    const pageId = await open('root');

    expect(await call('browser_get_text', { pageId }, 'child')).not.toHaveProperty('error');
  });

  it('根会话取得到、关得掉子会话打开的页面', async () => {
    const { call, open } = await start();
    const pageId = await open('child');

    expect(await call('browser_get_text', { pageId }, 'root')).not.toHaveProperty('error');
    expect(await call('browser_close_page', { pageId }, 'root')).toEqual({ ok: true });
    expect(fake.pages[0].closed).toBe(true);
  });

  it('带别的会话的 pageId 导航开的是新页面，不复用', async () => {
    const { call, open } = await start();
    const pageId = await open('root');
    const out = await call('browser_navigate', { url: 'http://example.zz-test/', pageId }, 'other');

    expect(out.pageId).not.toBe(pageId);
    expect(fake.pages).toHaveLength(2);
    expect(fake.pages[0].goto).toHaveBeenCalledTimes(1);
  });

  it('没有会话的调用只取得到同样没有会话打开的页面；不在会话表里的会话按它自己算', async () => {
    const { call, open } = await start();
    const rootPage = await open('root');
    const anonymousPage = await open('');
    const outsiderPage = await open('zz-outsider');

    expect(await call('browser_get_text', { pageId: rootPage }, '')).toHaveProperty('error');
    expect(await call('browser_get_text', { pageId: anonymousPage }, '')).not.toHaveProperty('error');
    expect(await call('browser_get_text', { pageId: anonymousPage }, 'root')).toHaveProperty('error');
    expect(await call('browser_get_text', { pageId: outsiderPage }, 'zz-outsider')).not.toHaveProperty('error');
    expect(await call('browser_get_text', { pageId: outsiderPage }, '')).toHaveProperty('error');
  });

  it('每个根会话的页面开在它自己的浏览器上下文里：子会话与根会话共用，别的会话、没有会话的各用一个', async () => {
    const { open } = await start();
    for (const sessionId of ['root', 'child', 'other', '', '']) await open(sessionId);
    const [root, child, other, anonymous, anonymousAgain] = fake.pages.map(page => page.context);

    expect(fake.contexts).toHaveLength(3);
    expect(child).toBe(root);
    expect(anonymousAgain).toBe(anonymous);
    expect(new Set([root, other, anonymous]).size).toBe(3);
  });

  it('同一根会话同时发起的首次开页只建一个上下文', async () => {
    const { open } = await start();
    await Promise.all([open('root'), open('root'), open('child')]);

    expect(fake.contexts).toHaveLength(1);
    expect(new Set(fake.pages.map(page => page.context)).size).toBe(1);
  });

  it('浏览器重启后上下文随之作废，按需重建', async () => {
    const { open } = await start();
    await open('root');
    fake.browsers[0].connected = false;
    await open('root');

    expect(fake.launch).toHaveBeenCalledTimes(2);
    expect(fake.contexts).toHaveLength(2);
    expect(fake.pages[1].context).toBe(fake.contexts[1]);
  });

  it('建上下文失败时不留，下次调用重建', async () => {
    const { call, open } = await start();
    fake.ctl.failContext = true;

    expect(await call('browser_navigate', { url: 'http://example.zz-test/' }, 'root')).toEqual({
      error: 'zz-建上下文失败',
    });
    expect(await open('root')).toMatch(/^page_/);
    expect(fake.contexts).toHaveLength(1);
  });

  it('会话删除时关掉它的上下文与页面，别的会话的不动', async () => {
    const { call, open, emit } = await start();
    await open('root');
    const otherPage = await open('other');
    await emit('session:deleted', 'root');

    expect(fake.pages[0]).toMatchObject({ closed: true, context: { closed: true } });
    expect(fake.pages[1]).toMatchObject({ closed: false, context: { closed: false } });
    expect(await call('browser_get_text', { pageId: otherPage }, 'other')).not.toHaveProperty('error');
  });

  it('删子会话不动根会话的页面，子会话打开的也不动', async () => {
    const { call, open, emit } = await start();
    const pageId = await open('child');
    await emit('session:deleted', 'child');

    expect(fake.pages[0].closed).toBe(false);
    expect(await call('browser_get_text', { pageId }, 'root')).not.toHaveProperty('error');
  });

  it('浏览器启动途中会话被删：不为它建上下文，调用回错误', async () => {
    const { call, emit } = await start();
    let release!: () => void;
    fake.ctl.launching = new Promise(resolve => {
      release = resolve;
    });
    const navigating = call('browser_navigate', { url: 'http://example.zz-test/' }, 'root');
    await vi.waitFor(() => expect(fake.launch).toHaveBeenCalled());
    await emit('session:deleted', 'root');
    release();

    expect(await navigating).toEqual({ error: '调用所在的会话已删除' });
    expect(fake.contexts).toHaveLength(0);
  });

  it('页面刚开好时会话被删：上下文连同页面关掉、不登记，调用回错误', async () => {
    const { call, emit } = await start();
    let release!: () => void;
    fake.ctl.opening = new Promise(resolve => {
      release = resolve;
    });
    const navigating = call('browser_navigate', { url: 'http://example.zz-test/' }, 'root');
    await vi.waitFor(() => expect(fake.newPage).toHaveBeenCalled());
    // 先放行再删除：页面在删除处理关掉上下文之前开好
    release();
    await emit('session:deleted', 'root');

    expect(await navigating).toEqual({ error: '调用所在的会话已删除' });
    expect(fake.pages[0]).toMatchObject({ closed: true, context: { closed: true } });
  });

  it('关上下文卡住时不阻塞会话删除：页面先从表里摘掉', async () => {
    const { call, open, emit } = await start();
    const pageId = await open('root');
    fake.ctl.closeHangs = true;
    let deleted = false;
    void emit('session:deleted', 'root').then(() => {
      deleted = true;
    });

    await vi.waitFor(() => expect(deleted).toBe(true));
    expect(fake.pages[0].closed).toBe(true);
    expect(await call('browser_get_text', { pageId }, 'root')).toEqual({ error: '页面不存在' });
  });

  it('pageId 是随机串，看不出别的会话开过几页', async () => {
    const { open } = await start();
    const ids = [await open('root'), await open('other')];

    expect(ids).toEqual([expect.stringMatching(/^page_[0-9a-f]{8}$/), expect.stringMatching(/^page_[0-9a-f]{8}$/)]);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
