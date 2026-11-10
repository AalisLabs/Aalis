import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineRenderer, type RenderRequest } from '../../packages/util-chromium/src/index.js';

// ════════════════════════════════════════════════════════════
// 离线渲染的空闲关停只关没人在用的浏览器：空闲计时在每次渲染结束时重设，到点时还有渲染在跑（跨过时限的那一次，
// 或并发时别的渲染结束重设了计时）就不关，等它结束再重新计时。浏览器是替身（换掉启动），页面加载由用例放行，用假时钟。
// ════════════════════════════════════════════════════════════

const browser = vi.hoisted(() => ({ launches: 0, closes: 0, loads: [] as Array<() => void> }));
vi.mock('../../packages/util-chromium/src/launch.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  launchChromium: async () => {
    browser.launches++;
    const page = {
      setJavaScriptEnabled: async () => {},
      setRequestInterception: async () => {},
      on: () => {},
      setViewport: async () => {},
      goto: () => new Promise<void>(resolve => browser.loads.push(resolve)),
      evaluate: async () => true,
      screenshot: async () => new Uint8Array([1]),
    };
    return {
      connected: true,
      createBrowserContext: async () => ({ newPage: async () => page, close: async () => {} }),
      close: async () => {
        browser.closes++;
      },
    };
  },
}));

const ENTRY = 'https://render.invalid/1/';
const request: RenderRequest = {
  entry: ENTRY,
  resources: new Map([[ENTRY, { body: new Uint8Array(), contentType: 'text/html' }]]),
  viewport: { width: 10, height: 10 },
  clip: { kind: 'viewport' },
};
const logger = { debug() {}, info() {}, warn() {} };

/** 开始一次渲染，等它走到页面加载（由用例放行） */
async function startRender(renderer: OfflineRenderer) {
  const loading = browser.loads.length;
  const result = renderer.renderPng(request);
  await vi.waitFor(() => expect(browser.loads).toHaveLength(loading + 1));
  return { load: browser.loads[loading], result };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.assign(browser, { launches: 0, closes: 0, loads: [] });
});
afterEach(() => vi.useRealTimers());

describe('离线渲染的空闲关停', () => {
  it('一次渲染跨过空闲时限：到点不关，渲染结束后重新计时', async () => {
    const renderer = new OfflineRenderer({ sandbox: false, idleShutdownSec: 1, logger });
    const first = await startRender(renderer);
    first.load();
    await first.result;
    await vi.advanceTimersByTimeAsync(900);
    const second = await startRender(renderer);
    await vi.advanceTimersByTimeAsync(200);
    expect(browser.closes, '还在渲染，不关').toBe(0);
    second.load();
    expect(await second.result).toEqual(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(999);
    expect(browser.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.closes, '渲染结束一个时限后关掉').toBe(1);
    expect(browser.launches).toBe(1);
    await renderer.dispose();
  });

  it('并发：先结束的那次重设了计时，还在跑的那次跨过时限，到点不关', async () => {
    const renderer = new OfflineRenderer({ sandbox: false, idleShutdownSec: 1, logger });
    const a = await startRender(renderer);
    const b = await startRender(renderer);
    a.load();
    await a.result;
    await vi.advanceTimersByTimeAsync(1500);
    expect(browser.closes, '还有一次在渲染，不关').toBe(0);
    b.load();
    await b.result;
    await vi.advanceTimersByTimeAsync(1000);
    expect(browser.closes).toBe(1);
    expect(browser.launches).toBe(1);
    await renderer.dispose();
  });
});
