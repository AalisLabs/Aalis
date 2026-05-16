import { describe, expect, it } from 'vitest';
import { App, type Message } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';

function makeApp() {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
}

async function saveAcross(
  memory: MemoryService,
  entries: Array<{ sessionId: string; platform?: string; content: string; ts: number; role?: 'user' | 'assistant' }>,
) {
  for (const e of entries) {
    await memory.saveMessage(e.sessionId, {
      role: e.role ?? 'user',
      content: e.content,
      timestamp: e.ts,
      metadata: e.platform ? { platform: e.platform } : undefined,
    });
  }
}

describe('plugin-memory-history', () => {
  it('cross-platform: 注入跨会话最近消息为独立 system block', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;

    const baseTs = Date.now() - 10_000;
    await saveAcross(memory, [
      { sessionId: 's-a', platform: 'onebot', content: 'A1', ts: baseTs + 1 },
      { sessionId: 's-b', platform: 'webui', content: 'B1', ts: baseTs + 2 },
      { sessionId: 's-a', platform: 'onebot', content: 'A2', ts: baseTs + 3 },
    ]);

    await app.ctx.useModule(memoryHistory, {
      scope: 'cross-platform',
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
      headerText: '[TEST-HEADER]',
    });

    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'now' },
    ];
    await app.ctx.hooks.run('agent:llm:before', {
      messages,
      tools: [],
      sessionId: 'current',
      platform: 'onebot',
    });

    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('system');
    expect(messages[1].metadata?.source).toBe('memory-history');
    expect(messages[1].content).toContain('[TEST-HEADER]');
    expect(messages[1].content).toContain('A1');
    expect(messages[1].content).toContain('B1');
    expect(messages[1].content).toContain('A2');
    expect(messages[2].role).toBe('user');
  });

  it('same-platform: 仅注入当前 platform 的消息', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;

    const baseTs = Date.now() - 5000;
    await saveAcross(memory, [
      { sessionId: 's-a', platform: 'onebot', content: 'ONE', ts: baseTs + 1 },
      { sessionId: 's-b', platform: 'webui', content: 'WEB', ts: baseTs + 2 },
    ]);

    await app.ctx.useModule(memoryHistory, {
      scope: 'same-platform',
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
    });

    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await app.ctx.hooks.run('agent:llm:before', {
      messages,
      tools: [],
      sessionId: 'current',
      platform: 'onebot',
    });
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('ONE');
    expect(messages[0].content).not.toContain('WEB');
  });

  it('excludeCurrentSession: 默认排除当前会话', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;

    const baseTs = Date.now() - 1000;
    await saveAcross(memory, [
      { sessionId: 'current', platform: 'onebot', content: 'SELF', ts: baseTs + 1 },
      { sessionId: 'other', platform: 'onebot', content: 'OTHER', ts: baseTs + 2 },
    ]);

    await app.ctx.useModule(memoryHistory, { scope: 'cross-platform', maxAgeMinutes: 0 });
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await app.ctx.hooks.run('agent:llm:before', {
      messages,
      tools: [],
      sessionId: 'current',
      platform: 'onebot',
    });
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('OTHER');
    expect(messages[0].content).not.toContain('SELF');
  });

  it('scope=off: 不注入', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;
    await saveAcross(memory, [{ sessionId: 's-a', platform: 'onebot', content: 'X', ts: Date.now() - 1000 }]);

    await app.ctx.useModule(memoryHistory, { scope: 'off' });
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await app.ctx.hooks.run('agent:llm:before', {
      messages,
      tools: [],
      sessionId: 'current',
      platform: 'onebot',
    });
    expect(messages.length).toBe(1);
  });

  it('maxAgeMinutes 过滤旧消息', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;
    const now = Date.now();
    await saveAcross(memory, [
      { sessionId: 's-a', platform: 'onebot', content: 'OLD', ts: now - 10 * 60_000 },
      { sessionId: 's-a', platform: 'onebot', content: 'NEW', ts: now - 60_000 },
    ]);

    await app.ctx.useModule(memoryHistory, {
      scope: 'cross-platform',
      maxAgeMinutes: 5,
      excludeCurrentSession: false,
    });
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await app.ctx.hooks.run('agent:llm:before', {
      messages,
      tools: [],
      sessionId: 'current',
      platform: 'onebot',
    });
    expect(messages[0].content).toContain('NEW');
    expect(messages[0].content).not.toContain('OLD');
  });

  it('重复触发 hook 不重复注入', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;
    await saveAcross(memory, [{ sessionId: 's-a', platform: 'onebot', content: 'X', ts: Date.now() - 1000 }]);

    await app.ctx.useModule(memoryHistory, {
      scope: 'cross-platform',
      maxAgeMinutes: 0,
      excludeCurrentSession: false,
    });
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await app.ctx.hooks.run('agent:llm:before', { messages, tools: [], sessionId: 'current', platform: 'onebot' });
    await app.ctx.hooks.run('agent:llm:before', { messages, tools: [], sessionId: 'current', platform: 'onebot' });
    const injected = messages.filter(m => m.metadata?.source === 'memory-history');
    expect(injected.length).toBe(1);
  });
});
