import { LogHub, provide } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 会话管理停用时，收尾段等在途的自动标题落定，之后 onDispose 照旧刷一次盘；onDispose 之后不再排落盘定时器。标题模型替身
// 在信号断开之后过一会儿才回（模拟已在路上的回复）；order 记下写进标题的那次落盘与停用落定的先后，停用之后再走过一个落盘
// 间隔看还有没有写入。定时器用假时钟，从装插件之前起。
// ════════════════════════════════════════════════════════════

const apps: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

const PERSIST_INTERVAL_MS = 1000;

async function boot(answerDelayMs: number, disposeTimeoutMs?: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { app } = hostedApp(
    { logLevel: 'error' },
    { logHub: new LogHub(), ...(disposeTimeoutMs === undefined ? {} : { disposeTimeoutMs }) },
  );
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  const store = fakeMemory();
  const order: string[] = [];
  const commit = store.commitMetadata;
  store.commitMetadata = async ops => {
    await commit(ops);
    if (ops.some(o => o.data?.title === '装修预算')) order.push('写进标题');
    else order.push('落盘');
  };
  host.provide.use(memory, store as never);
  host.provide.use(llm, {
    id: 'mock',
    capabilities: ['chat'],
    chat: (req: { signal?: AbortSignal }) =>
      new Promise(resolve =>
        req.signal?.addEventListener('abort', () => setTimeout(() => resolve({ content: '装修预算' }), answerDelayMs), {
          once: true,
        }),
      ),
  } as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  const sm = host.sessionManager.use;
  const session = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
  await host.events.use.emit('inbound:message', {
    content: '帮我算下装修预算',
    sessionId: session.id,
    platform: 'webui',
  });
  // 停用：时钟走到模型回复之后，落定时记下，再走过一个落盘间隔
  const disable = async () => {
    const disabled = app.plugins.disable(sessionManagerPlugin.name).then(() => {
      order.push('停用落定');
    });
    await vi.advanceTimersByTimeAsync(answerDelayMs);
    await disabled;
    await vi.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS + 300);
  };
  return { order, disable };
}

describe('会话管理停用时等在途的自动标题', () => {
  it('标题模型调用途中停用、回复随后回来：收尾等它落定，onDispose 刷盘带上标题，停用之后不再有写入', async () => {
    const t = await boot(50);
    await t.disable();
    expect(t.order).toContain('写进标题');
    expect(t.order.at(-1)).toBe('停用落定');
  });

  it('收尾等过了时限、标题在 onDispose 之后才回来：不再排落盘定时器，停用之后不再有写入', async () => {
    const t = await boot(200, 20);
    await t.disable();
    expect(t.order.at(-1)).toBe('停用落定');
  });
});
