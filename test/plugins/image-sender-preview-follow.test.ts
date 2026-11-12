import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// preview_image 随 media 在场注册：识别全靠 media，media 缺席时这个工具只会返回
// 「未启用 media 服务」，挂着只是让 agent 做一次无效尝试。media 上线才挂、离场即撤。
// ════════════════════════════════════════════════════════════

const tick = () => new Promise(r => setTimeout(r, 0));

describe('preview_image 跟随 media 在场', () => {
  let app: App;
  let provideMedia: () => () => void;
  const registered = new Set<string>();

  beforeEach(async () => {
    registered.clear();
    app = new App({ name: 'T', logLevel: 'error' });
    provideEvents(app);
    const host = app.bind({ provide, events });
    host.provide.use(tools, {
      register: (t: { definition: { function: { name: string } } }) => {
        const name = t.definition.function.name;
        registered.add(name);
        return () => registered.delete(name);
      },
      registerGroup: () => () => {},
    } as never);
    provideMedia = () => host.provide.use(media, { describeImage: async () => '一只猫' } as never);
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();
  });

  afterEach(async () => {
    await app.stop();
  });

  it('media 缺席不挂；media 上线补挂；media 下线撤回（send_attachment 始终在）', async () => {
    expect(registered.has('send_attachment')).toBe(true);
    expect(registered.has('preview_image'), 'media 缺席时不该挂 preview_image').toBe(false);

    const withdraw = provideMedia();
    await tick();
    expect(registered.has('preview_image'), 'media 上线后应补挂 preview_image').toBe(true);

    withdraw();
    await tick();
    expect(registered.has('preview_image'), 'media 下线后应撤回 preview_image').toBe(false);
    expect(registered.has('send_attachment')).toBe(true);
  });
});

/** 真插件装进 App，识图替身一直不回、只在收到的信号断开时按中止原因落定（收到时已断的立即落定），记下收到的信号 */
async function bootPreview() {
  const app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  const host = app.bind({ provide });
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide.use(tools, {
    register: (t: Omit<RegisteredTool, 'pluginName'>) => {
      handlers.set(t.definition.function.name, t.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  const signals: Array<AbortSignal | undefined> = [];
  host.provide.use(media, {
    describeImage: (_url: string, opts?: { signal?: AbortSignal }) => {
      signals.push(opts?.signal);
      if (opts?.signal?.aborted) return Promise.reject(opts.signal.reason);
      return new Promise<string>((_, reject) =>
        opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true }),
      );
    },
  } as never);
  await app.plugins.register(imageSenderPlugin, {});
  await app.plugins.idle();
  const preview = handlers.get('preview_image');
  if (!preview) throw new Error('preview_image 没有登记');
  return { app, preview, signals };
}

describe('preview_image 的识图接这次调用的中止信号与时限', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('识图途中回合中止：交给识图的信号随之断开，后面的图不再识别，调用抛中止原因', async () => {
    const { app, preview, signals } = await bootPreview();
    try {
      const ac = new AbortController();
      const urls = ['https://example.invalid/a.png', 'https://example.invalid/b.png'];
      const pending = Promise.resolve(preview({ urls }, toolContext({ sessionId: 's', signal: ac.signal })));
      await expect.poll(() => signals.length).toBe(1);
      ac.abort();
      expect(signals[0]?.aborted).toBe(true);
      await expect(pending).rejects.toBe(ac.signal.reason);
      expect(signals).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  it('识图到 25 秒时限：交给识图的信号随之断开，这张的回执写 vision 超时', async () => {
    // 时限信号换成用例手里的，到时由用例断开
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const { app, preview, signals } = await bootPreview();
    try {
      const url = 'https://example.invalid/a.png';
      const pending = preview({ urls: [url] }, toolContext({ sessionId: 's' }));
      await expect.poll(() => signals.length).toBe(1);
      expect(timeout).toHaveBeenCalledWith(25_000);
      deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      expect(signals[0]?.aborted).toBe(true);
      expect(JSON.parse(String(await pending)).results).toEqual([{ index: 0, url, ok: false, error: 'vision 超时' }]);
    } finally {
      await app.stop();
    }
  });
});
