import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

function makeApp() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  return { app, cleanup: () => {} };
}

const msg = (role: Message['role'], content: string, ts?: number): Message => ({
  role,
  content,
  timestamp: ts,
});

describe('plugin-memory-inmemory', () => {
  let env: ReturnType<typeof makeApp>;
  let mem: MemoryService;
  beforeEach(async () => {
    env = makeApp();
    // biome-ignore lint/suspicious/noExplicitAny: src 与 dist 的 PluginModule 类型路径不同，运行时结构等价
    await env.app.ctx.useModule(memoryInMemoryModule as any);
    const m = env.app.ctx.getService<MemoryService>('memory');
    if (!m) throw new Error('memory service missing');
    mem = m;
  });
  afterEach(() => env.cleanup());

  it('saveMessage + getHistory', async () => {
    await mem.saveMessage('s1', msg('user', 'hello'));
    await mem.saveMessage('s1', msg('assistant', 'hi'));
    const h = await mem.getHistory('s1');
    expect(h).toHaveLength(2);
    expect(h[0].content).toBe('hello');
    expect(h[1].role).toBe('assistant');
  });

  it('getHistory limit 取尾部', async () => {
    for (let i = 0; i < 10; i++) await mem.saveMessage('s', msg('user', `m${i}`));
    const h = await mem.getHistory('s', 3);
    expect(h.map(m => m.content)).toEqual(['m7', 'm8', 'm9']);
  });

  it('clearSession 清空指定 session 但不影响其他', async () => {
    await mem.saveMessage('a', msg('user', 'aaa'));
    await mem.saveMessage('b', msg('user', 'bbb'));
    await mem.clearSession('a');
    expect(await mem.getHistory('a')).toEqual([]);
    expect(await mem.getHistory('b')).toHaveLength(1);
  });

  it('saveMessage 自动填充 timestamp', async () => {
    const before = Date.now();
    await mem.saveMessage('s', { role: 'user', content: 'no-ts' });
    const after = Date.now();
    const [m] = await mem.getHistory('s');
    expect(m.timestamp).toBeGreaterThanOrEqual(before);
    expect(m.timestamp).toBeLessThanOrEqual(after);
  });

  it('trimHistory 把旧消息搬到 archived', async () => {
    if (!mem.trimHistory) throw new Error('trimHistory missing');
    for (let i = 0; i < 10; i++) await mem.saveMessage('s', msg('user', `m${i}`));
    const removed = await mem.trimHistory('s', 3);
    expect(removed).toBe(7);
    const active = await mem.getHistory('s');
    expect(active).toHaveLength(3);
    const full = await mem.getFullHistory!('s');
    expect(full).toHaveLength(10);
  });

  it('trimHistory keepRecent ≥ 长度时返回 0', async () => {
    if (!mem.trimHistory) throw new Error('trimHistory missing');
    await mem.saveMessage('s', msg('user', 'a'));
    expect(await mem.trimHistory('s', 10)).toBe(0);
  });

  it('getMessagesBySessionRange 按时间过滤 + role', async () => {
    await mem.saveMessage('s', msg('user', 'a', 1000));
    await mem.saveMessage('s', msg('assistant', 'b', 2000));
    await mem.saveMessage('s', msg('user', 'c', 3000));
    const all = await mem.getMessagesBySessionRange!('s', 1500, 3500);
    expect(all.map(m => m.content)).toEqual(['b', 'c']);
    const onlyUser = await mem.getMessagesBySessionRange!('s', 0, 4000, ['user']);
    expect(onlyUser.map(m => m.content)).toEqual(['a', 'c']);
  });

  it('metadata 存取', async () => {
    if (!mem.saveMetadata || !mem.getMetadata || !mem.listMetadata || !mem.deleteMetadata) {
      throw new Error('metadata API missing');
    }
    await mem.saveMetadata('ns', 'k1', { foo: 1 });
    await mem.saveMetadata('ns', 'k2', { bar: 2 });
    expect(await mem.getMetadata('ns', 'k1')).toEqual({ foo: 1 });
    const list = await mem.listMetadata('ns');
    expect(list).toHaveLength(2);
    await mem.deleteMetadata('ns', 'k1');
    expect(await mem.getMetadata('ns', 'k1')).toBeUndefined();
  });

  it('updateMessageContent 替换内容', async () => {
    if (!mem.updateMessageContent) throw new Error('updateMessageContent missing');
    await mem.saveMessage('s', msg('user', 'hello world'));
    await mem.saveMessage('s', msg('user', 'world peace'));
    const n = await mem.updateMessageContent('s', 'world', 'WORLD');
    expect(n).toBe(2);
    const h = await mem.getHistory('s');
    expect(h[0].content).toBe('hello WORLD');
  });

  it('deleteMessagesByTimestamps 精确删除', async () => {
    if (!mem.deleteMessagesByTimestamps) throw new Error('missing');
    await mem.saveMessage('s', msg('user', 'a', 100));
    await mem.saveMessage('s', msg('user', 'b', 200));
    await mem.saveMessage('s', msg('user', 'c', 300));
    const n = await mem.deleteMessagesByTimestamps('s', [200]);
    expect(n).toBe(1);
    expect((await mem.getHistory('s')).map(m => m.content)).toEqual(['a', 'c']);
  });

  it('clearAll 清空所有', async () => {
    if (!mem.clearAll) throw new Error('clearAll missing');
    await mem.saveMessage('a', msg('user', 'x'));
    await mem.saveMessage('b', msg('user', 'y'));
    await mem.clearAll();
    expect(await mem.getHistory('a')).toEqual([]);
    expect(await mem.getHistory('b')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// metadata 面的两条契约变更
//   ① listMetadata 返回 updatedAt —— 三家后端本来都存着这一列却从不返回，于是
//      「按时间清理」在契约上不可能做到（onebot 合并转发原文因此只增不减）。
//   ② commitMetadata 原子提交 —— 要的是原子性不是速度（实测 500 条只快 1.1×）。
//      没有它时 session-manager 的刷盘中途抛错就停在半新半旧，且 dirty 已置 false 不重试。
// ════════════════════════════════════════════════════════════

describe('plugin-memory-inmemory: metadata 契约', () => {
  let env: ReturnType<typeof makeApp>;
  let mem: MemoryService;
  beforeEach(async () => {
    env = makeApp();
    // biome-ignore lint/suspicious/noExplicitAny: src 与 dist 的 PluginModule 类型路径不同，运行时结构等价
    await env.app.ctx.useModule(memoryInMemoryModule as any);
    const m = env.app.ctx.getService<MemoryService>('memory');
    if (!m) throw new Error('memory service missing');
    mem = m;
  });
  afterEach(() => env.cleanup());

  it('listMetadata 带出 updatedAt，且写入后会推进', async () => {
    const before = Date.now();
    await mem.saveMetadata('ns', 'k1', { v: 1 });
    const [e1] = await mem.listMetadata('ns');
    expect(e1.key).toBe('k1');
    expect(e1.data).toEqual({ v: 1 });
    expect(e1.updatedAt).toBeGreaterThanOrEqual(before);

    await new Promise(r => setTimeout(r, 2));
    await mem.saveMetadata('ns', 'k1', { v: 2 });
    const [e2] = await mem.listMetadata('ns');
    expect(e2.updatedAt, '覆盖写要刷新时间戳').toBeGreaterThan(e1.updatedAt);
  });

  it('commitMetadata：put 与 del 一批提交', async () => {
    await mem.saveMetadata('ns', 'old', { keep: false });
    await mem.commitMetadata([
      { op: 'put', namespace: 'ns', key: 'a', data: { n: 1 } },
      { op: 'put', namespace: 'ns', key: 'b', data: { n: 2 } },
      { op: 'del', namespace: 'ns', key: 'old' },
    ]);
    const keys = (await mem.listMetadata('ns')).map(e => e.key).sort();
    expect(keys).toEqual(['a', 'b']);
    expect(await mem.getMetadata('ns', 'a')).toEqual({ n: 1 });
  });

  it('commitMetadata：空数组是 no-op，删不存在的 key 不报错', async () => {
    await mem.commitMetadata([]);
    await mem.commitMetadata([{ op: 'del', namespace: 'ns', key: '不存在' }]);
    expect(await mem.listMetadata('ns')).toEqual([]);
  });

  it('commitMetadata 可跨 namespace', async () => {
    await mem.commitMetadata([
      { op: 'put', namespace: 'n1', key: 'k', data: { a: 1 } },
      { op: 'put', namespace: 'n2', key: 'k', data: { b: 2 } },
    ]);
    expect(await mem.getMetadata('n1', 'k')).toEqual({ a: 1 });
    expect(await mem.getMetadata('n2', 'k')).toEqual({ b: 2 });
  });
});

describe('plugin-memory-inmemory: 与另两家后端的语义对齐', () => {
  let env: ReturnType<typeof makeApp>;
  let mem: MemoryService;
  beforeEach(async () => {
    env = makeApp();
    // biome-ignore lint/suspicious/noExplicitAny: src 与 dist 的 PluginModule 类型路径不同，运行时结构等价
    await env.app.ctx.useModule(memoryInMemoryModule as any);
    const m = env.app.ctx.getService<MemoryService>('memory');
    if (!m) throw new Error('memory service missing');
    mem = m;
  });
  afterEach(() => env.cleanup());

  it('存的是深拷贝：事后改原对象不污染存储', async () => {
    const src: Record<string, unknown> = { v: 'original' };
    await mem.saveMetadata('ns', 'k', src);
    src.v = 'mutated';
    (src as { injected?: boolean }).injected = true;
    expect(await mem.getMetadata('ns', 'k')).toEqual({ v: 'original' });
  });

  it('读回来的也是拷贝：改它不污染存储', async () => {
    await mem.saveMetadata('ns', 'k', { v: 'original' });
    const got = (await mem.getMetadata('ns', 'k')) as Record<string, unknown>;
    got.v = 'mutated';
    expect(await mem.getMetadata('ns', 'k')).toEqual({ v: 'original' });
  });

  it('commitMetadata 不撕裂：并发读看不到批的中间态', async () => {
    const ops = Array.from({ length: 5 }, (_, i) => ({
      op: 'put' as const,
      namespace: 'tear',
      key: `k${i}`,
      data: { i },
    }));
    const inflight = mem.commitMetadata(ops); // 故意不 await
    const during = await mem.listMetadata('tear');
    await inflight;
    // 判据是「不撕裂」：0（还没开始）或 5（已整批落完）都对，1~4 才是中间态。
    // 现在批体内无 await，整批在 promise 让出之前就落完，所以实际观察到 5。
    expect([0, 5], `并发读采到 ${during.length} 条 —— 撕裂了`).toContain(during.length);
    expect((await mem.listMetadata('tear')).length).toBe(5);
  });

  it('不可序列化的载荷整批不生效（与 sqlite/mongodb 一致）', async () => {
    await mem.saveMetadata('ns', 'pre', { keep: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      mem.commitMetadata([
        { op: 'put', namespace: 'ns', key: 'a', data: { ok: 1 } },
        { op: 'put', namespace: 'ns', key: 'b', data: circular },
        { op: 'del', namespace: 'ns', key: 'pre' },
      ]),
    ).rejects.toThrow();
    // 一条都不该生效：pre 还在、a 没进去
    expect((await mem.listMetadata('ns')).map(e => e.key)).toEqual(['pre']);
  });

  it('listMetadata 按 key 升序（与另两家的索引扫顺序一致）', async () => {
    for (const k of ['c', 'a', 'b']) await mem.saveMetadata('ord', k, { k });
    expect((await mem.listMetadata('ord')).map(e => e.key)).toEqual(['a', 'b', 'c']);
  });
});
