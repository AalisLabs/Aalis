import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LanceDBVectorStore } from '../../packages/plugin-vectorstore-lancedb/src/index.js';

// ════════════════════════════════════════════════════════════
// 表生命周期回归（2026-08-11 /clear all 事故）：
// 清空与在途建表交错，一次「already exists」失败后 rejected 的 single-flight
// promise 永不重置——此后 1.5 天每次索引 await 到同一僵尸 promise 原样重抛、
// 检索恒 0。根修三纪律：open-first（消掉「表不存在」前提）、失败即重置
// （竞态从永久僵死降为单条瞬态）、clear 先等在途建表落定。
// ════════════════════════════════════════════════════════════

const VEC = [0.1, 0.2, 0.3, 0.4];
const dirs: string[] = [];

function makeStore(dir: string): LanceDBVectorStore {
  return new LanceDBVectorStore(dir, 'vectors', 0, 60);
}

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lancedb-lifecycle-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('LanceDBVectorStore 表生命周期', () => {
  it('建表失败不留僵尸：失败一次后，下一条 add 重试成功', async () => {
    const store = makeStore(newDir());
    await store.init();
    // 让第一次 createTable 失败（复刻 already exists 类瞬态错误）
    const db = (store as unknown as { db: { createTable: (...a: unknown[]) => Promise<unknown> } }).db;
    const realCreate = db.createTable.bind(db);
    let failures = 0;
    db.createTable = async (...args: unknown[]) => {
      failures++;
      db.createTable = realCreate;
      throw new Error("Table 'vectors' already exists");
    };
    await expect(store.add(VEC, { sessionId: 's', timestamp: 1 })).rejects.toThrow('already exists');
    expect(failures).toBe(1);
    // 修复点：僵尸 promise 已重置，下一条重试走通（旧实现此处永远重抛同一错误）
    await store.add(VEC, { sessionId: 's', timestamp: 2 });
    expect(await store.size()).toBe(1);
  });

  it('open-first：表被外部创建后（本实例句柄为空），add 打开而非硬建', async () => {
    const dir = newDir();
    const a = makeStore(dir);
    await a.init(); // 空目录：a 的 table 句柄为 null
    const b = makeStore(dir);
    await b.init();
    await b.add(VEC, { sessionId: 's', timestamp: 1 }); // b 创建了表
    // a 对表存在一无所知；旧实现会 createTable 撞 already exists，open-first 直接打开补写
    await a.add(VEC, { sessionId: 's', timestamp: 2 });
    expect(await a.size()).toBe(2);
  });

  it('clear 后重建：清空 → add 重新建表，功能完整', async () => {
    const store = makeStore(newDir());
    await store.init();
    await store.add(VEC, { sessionId: 's', timestamp: 1 });
    await store.clear();
    expect(await store.size()).toBe(0);
    await store.add(VEC, { sessionId: 's', timestamp: 2 });
    expect(await store.size()).toBe(1);
    const hits = await store.search(VEC, 1);
    expect(hits.length).toBe(1);
  });
});
