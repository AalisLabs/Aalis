import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, type Message } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-mem-'));
  const path = join(dir, 'aalis.config.yaml');
  writeFileSync(path, 'name: T\nlogLevel: error\nplugins: {}\n');
  const app = new App({ configPath: path });
  return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    await env.app.ctx.useModule(memoryInMemoryModule);
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
