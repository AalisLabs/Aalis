import { describe, expect, it } from 'vitest';
import { App, type Message } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as memoryRecency from '../../packages/plugin-memory-recency/src/index.js';
import { RecencyBuffer, type RecencyService } from '../../packages/plugin-memory-recency/src/index.js';

function makeApp() {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
}

describe('RecencyBuffer', () => {
  it('按 timestamp 升序保持，超量从最旧淘汰', () => {
    const b = new RecencyBuffer(3);
    b.push({ timestamp: 100, platform: 'p', sessionId: 's', role: 'user', content: 'a' });
    b.push({ timestamp: 200, platform: 'p', sessionId: 's', role: 'user', content: 'b' });
    b.push({ timestamp: 50, platform: 'p', sessionId: 's', role: 'user', content: 'c' }); // 乱序插入
    b.push({ timestamp: 300, platform: 'p', sessionId: 's', role: 'user', content: 'd' });
    const snap = b.snapshot();
    // 50 被淘汰（容量 3，按 timestamp 排序后最旧的就是 50）
    // 实际：先 100, 200, 50, 300 → 排序 50,100,200,300 → 截到 100,200,300
    expect(snap.map(e => e.timestamp)).toEqual([100, 200, 300]);
  });

  it('幂等去重：同 sessionId+timestamp+role+content 长度不重复入', () => {
    const b = new RecencyBuffer(10);
    const e = { timestamp: 100, platform: 'p', sessionId: 's', role: 'user' as const, content: 'hi' };
    expect(b.push(e)).toBe(true);
    expect(b.push({ ...e })).toBe(false);
    expect(b.size()).toBe(1);
  });

  it('query 取最近 N 条并按时间升序返回', () => {
    const b = new RecencyBuffer(10);
    for (let i = 1; i <= 5; i++) {
      b.push({ timestamp: i * 100, platform: 'p', sessionId: 's', role: 'user', content: `m${i}` });
    }
    const r = b.query(() => true, 3);
    expect(r.map(e => e.content)).toEqual(['m3', 'm4', 'm5']);
  });

  it('query 支持 sinceTs 早停', () => {
    const b = new RecencyBuffer(10);
    for (let i = 1; i <= 5; i++) {
      b.push({ timestamp: i * 100, platform: 'p', sessionId: 's', role: 'user', content: `m${i}` });
    }
    const r = b.query(() => true, 10, 350); // 只要 >=350 的
    expect(r.map(e => e.content)).toEqual(['m4', 'm5']);
  });

  it('query 支持 filter 排除', () => {
    const b = new RecencyBuffer(10);
    b.push({ timestamp: 100, platform: 'a', sessionId: 's', role: 'user', content: 'A' });
    b.push({ timestamp: 200, platform: 'b', sessionId: 's', role: 'user', content: 'B' });
    const r = b.query(e => e.platform === 'a', 10);
    expect(r.map(e => e.content)).toEqual(['A']);
  });
});

describe('plugin-memory-recency 集成', () => {
  it('监听 inbound:message:archived 写入 buffer', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    await app.ctx.useModule(memoryRecency, {
      preheatPerSession: 0,
      scope: 'cross-platform',
      maxAgeMinutes: 0,
    });
    const svc = app.ctx.getService<RecencyService>('memory-recency');
    expect(svc).toBeDefined();
    expect(svc!.size()).toBe(0);

    await app.ctx.emit('inbound:message:archived', {
      sessionId: 'session-A',
      incoming: {
        content: 'hello world',
        sessionId: 'session-A',
        platform: 'onebot',
        userId: '1001',
        nickname: 'Alice',
      },
      archivedMessage: {
        role: 'user',
        content: '[Alice(1001)]: hello world',
        timestamp: Date.now(),
        metadata: { platform: 'onebot', nickname: 'Alice' },
      },
    });

    expect(svc!.size()).toBe(1);
    const r = svc!.query({ scope: 'cross-platform' });
    expect(r).toHaveLength(1);
    expect(r[0].platform).toBe('onebot');
    expect(r[0].sessionId).toBe('session-A');
    expect(r[0].senderName).toBe('Alice');
  });

  it('scope=same-platform 仅返回当前 platform 的条目', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    await app.ctx.useModule(memoryRecency, { preheatPerSession: 0, scope: 'same-platform', maxAgeMinutes: 0 });
    const svc = app.ctx.getService<RecencyService>('memory-recency')!;

    const baseTs = Date.now() - 1000;
    for (const [pf, sid, content, ts] of [
      ['onebot', 's1', 'A', baseTs + 1],
      ['onebot', 's2', 'B', baseTs + 2],
      ['webui', 's3', 'C', baseTs + 3],
    ] as const) {
      await app.ctx.emit('inbound:message:archived', {
        sessionId: sid,
        incoming: { content, sessionId: sid, platform: pf },
        archivedMessage: { role: 'user', content, timestamp: ts, metadata: { platform: pf } },
      });
    }

    const r = svc.query({ currentPlatform: 'onebot' });
    expect(r.map(e => e.content)).toEqual(['A', 'B']);
    const all = svc.query({ scope: 'cross-platform' });
    expect(all.map(e => e.content)).toEqual(['A', 'B', 'C']);
  });

  it('黑名单 session 永远排除', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    await app.ctx.useModule(memoryRecency, {
      preheatPerSession: 0,
      scope: 'cross-platform',
      blacklistSessions: 'evil-session',
      maxAgeMinutes: 0,
    });
    const svc = app.ctx.getService<RecencyService>('memory-recency')!;

    await app.ctx.emit('inbound:message:archived', {
      sessionId: 'evil-session',
      incoming: { content: 'x', sessionId: 'evil-session', platform: 'onebot' },
      archivedMessage: { role: 'user', content: 'x', timestamp: Date.now(), metadata: { platform: 'onebot' } },
    });
    await app.ctx.emit('inbound:message:archived', {
      sessionId: 'good-session',
      incoming: { content: 'y', sessionId: 'good-session', platform: 'onebot' },
      archivedMessage: { role: 'user', content: 'y', timestamp: Date.now(), metadata: { platform: 'onebot' } },
    });

    const r = svc.query({ scope: 'cross-platform' });
    expect(r.map(e => e.sessionId)).toEqual(['good-session']);
  });

  it('agent:llm:before hook 注入 system-block', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    await app.ctx.useModule(memoryRecency, {
      preheatPerSession: 0,
      scope: 'cross-platform',
      maxAgeMinutes: 0,
      headerText: '[TEST-HEADER]',
    });

    await app.ctx.emit('inbound:message:archived', {
      sessionId: 'past',
      incoming: { content: 'past msg', sessionId: 'past', platform: 'onebot' },
      archivedMessage: {
        role: 'user',
        content: 'past msg',
        timestamp: Date.now() - 10_000,
        metadata: { platform: 'onebot' },
      },
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

    // 注入应在第一条非 system 之前
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('[TEST-HEADER]');
    expect(messages[1].content).toContain('past msg');
    expect(messages[1].metadata?.source).toBe('memory-recency');
    expect(messages[2].role).toBe('user');
  });

  it('scope=off 时不注入', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    await app.ctx.useModule(memoryRecency, { preheatPerSession: 0, scope: 'off' });

    await app.ctx.emit('inbound:message:archived', {
      sessionId: 'past',
      incoming: { content: 'x', sessionId: 'past', platform: 'onebot' },
      archivedMessage: { role: 'user', content: 'x', timestamp: Date.now(), metadata: { platform: 'onebot' } },
    });

    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await app.ctx.hooks.run('agent:llm:before', {
      messages,
      tools: [],
      sessionId: 'current',
      platform: 'onebot',
    });
    expect(messages.length).toBe(1);
  });

  it('启动预热从 memory.getHistory 拉历史填入 buffer', async () => {
    const app = makeApp();
    await app.ctx.useModule(memoryInMemoryModule);
    const memory = app.ctx.getService<MemoryService>('memory')!;
    // 先塞两条
    await memory.saveMessage('preheat-session', {
      role: 'user',
      content: 'old-1',
      timestamp: Date.now() - 5000,
      metadata: { platform: 'onebot', nickname: 'Bob' },
    });
    await memory.saveMessage('preheat-session', {
      role: 'assistant',
      content: 'old-2',
      timestamp: Date.now() - 4000,
    });

    // mock 一个 session-manager 服务，仅暴露 listSessions
    app.ctx.provide('session-manager', { listSessions: () => [{ id: 'preheat-session' }] });

    await app.ctx.useModule(memoryRecency, { preheatPerSession: 50, scope: 'cross-platform', maxAgeMinutes: 0 });
    // 预热是异步的，等下一个 tick
    await new Promise(r => setTimeout(r, 50));

    const svc = app.ctx.getService<RecencyService>('memory-recency')!;
    const r = svc.query({ scope: 'cross-platform' });
    expect(r.map(e => e.content)).toEqual(['old-1', 'old-2']);
    expect(r[0].platform).toBe('onebot');
    expect(r[1].platform).toBe('unknown'); // metadata 缺失
  });
});
