import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 消息归档停用时，收尾段等本插件自己发起的后台写（送达之后记出站、她发的网址图片补描述）落定再撤回：已经开始的写入写完，
// 停用落定之后不再有写入。识图替身在信号断开时才回（恰在这时回来，照常往下改写）；记忆后端的指定写入卡在一道闸上，用例
// 放行；order 记下写入开始、写完与停用落定的先后。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const URL = 'https://example.invalid/cat.png';

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(gated: 'saveMessage' | 'updateMessageContent') {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks });
  await app.plugin(memoryInMemoryPlugin);
  host.provide.use(media, {
    // 在识图时停用：信号断开时这张图恰好识别回来。收尾开始之后才发起的识图拿到已断开的信号，与真的 media 一样当场以中止原因拒绝
    describeImage: (_url: string, opts?: { signal?: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        if (opts?.signal?.aborted) return reject(opts.signal.reason);
        opts?.signal?.addEventListener('abort', () => resolve('一只橘猫'), { once: true });
      }),
  } as never);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugins.idle();
  // 记忆后端的这一种写入：第一次卡在闸上
  const order: string[] = [];
  const gate = deferred<void>();
  let reached = false;
  const provider = app.bind({ services }).services.use.get(memory) as unknown as Record<
    typeof gated,
    (...args: unknown[]) => Promise<unknown>
  >;
  const write = provider[gated].bind(provider);
  vi.spyOn(provider, gated).mockImplementation((async (...args: unknown[]) => {
    order.push('写入开始');
    if (!reached) {
      reached = true;
      await gate.promise;
    }
    const result = await write(...args);
    order.push('写完');
    return result;
  }) as never);
  /** 停用：写入到了闸上再放行，停用落定时记下 */
  const disableWhileGated = async () => {
    const disabled = app.plugins.disable(messageArchivePlugin.name).then(() => {
      order.push('停用落定');
    });
    await vi.waitFor(() => expect(reached).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { app, host, order, disableWhileGated };
}

const delivered = (): OutgoingMessage => ({
  sessionId: ROOM,
  platform: 'onebot',
  content: '',
  source: 'agent',
  attachments: [{ kind: 'image', data: URL, ref: URL }],
});

describe('消息归档停用时等在途的后台写', () => {
  it('送达之后记出站的写入途中停用：停用等写完才落定，之后不再有写入', async () => {
    const t = await boot('saveMessage');
    await t.host.events.use.emit('outbound:delivered', delivered());
    await t.disableWhileGated();
    expect(t.order).toContain('写完');
    expect(t.order.at(-1)).toBe('停用落定');
    // 收尾等到了落定，不是清理宽限到点放行（放行的会记为未停下）
    expect(t.app.plugins.getStatus().find(p => p.instanceId === messageArchivePlugin.name)?.lingering).toBeFalsy();
  });

  it('补描述的识图途中停用：识图这时回来、开始改写正文，停用等写完才落定，之后不再有写入', async () => {
    const t = await boot('updateMessageContent');
    await t.host.events.use.emit('outbound:delivered', delivered());
    await t.disableWhileGated();
    expect(t.order).toContain('写完');
    expect(t.order.at(-1)).toBe('停用落定');
  });
});
