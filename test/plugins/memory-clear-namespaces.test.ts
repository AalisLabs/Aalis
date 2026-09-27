import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { clearMetadataNamespaces, type MemoryService } from '../../packages/api-memory/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// clearMetadataNamespaces：按命名空间整体清理。listMetadata 跳过读不出的条目，此前各插件按它枚举键清理，
// 坏条目删不掉、回执条数也不含它们。后端实现了 listMetadataKeys 时按它列键，坏条目一并删除并记一条 info 点名；
// 没实现时退回 listMetadata。sqlite 用内存库。
// ════════════════════════════════════════════════════════════

function world() {
  const db = new Database(':memory:');
  const svc = new SQLiteMemoryService(db, { logger: { warn() {} } });
  const infos: string[] = [];
  const logger = { info: (message: string) => void infos.push(message) };
  const insertRaw = (namespace: string, key: string, data: string) =>
    db.prepare('INSERT INTO metadata (namespace, key, data) VALUES (?, ?, ?)').run(namespace, key, data);
  const rows = () =>
    (db.prepare('SELECT namespace, key FROM metadata').all() as Array<{ namespace: string; key: string }>)
      .map(r => `${r.namespace}/${r.key}`)
      .sort();
  return { svc, infos, logger, insertRaw, rows };
}

describe('clearMetadataNamespaces', () => {
  it('读不出的条目与其余条目一并删除、计入返回的键，一次提交；info 点名全部读不出的条目', async () => {
    const { svc, infos, logger, insertRaw, rows } = world();
    await svc.saveMetadata('ns-a', 'good', { v: 1 });
    await svc.saveMetadata('ns-b', 'good', { v: 2 });
    await svc.saveMetadata('keep', 'k', { v: 3 });
    insertRaw('ns-a', 'broken', '{not json');
    insertRaw('ns-b', 'array', '[1,2]');
    insertRaw('keep', 'bad', 'null');
    let commits = 0;
    const counted = new Proxy(svc, {
      get(target, prop) {
        if (prop === 'commitMetadata') commits++;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as MemoryService;

    const [a, b] = await clearMetadataNamespaces(counted, ['ns-a', 'ns-b'], logger);

    expect(a.toSorted()).toEqual(['broken', 'good']);
    expect(b.toSorted()).toEqual(['array', 'good']);
    expect(rows(), '只清指定的命名空间').toEqual(['keep/bad', 'keep/k']);
    expect(commits).toBe(1);
    expect(infos).toEqual(['清理时一并删除了 2 条读不出的数据：ns-a/broken、ns-b/array']);
  });

  it('没有读不出的条目时不记 info', async () => {
    const { svc, infos, logger, rows } = world();
    await svc.saveMetadata('ns', 'good', { v: 1 });
    expect(await clearMetadataNamespaces(svc, ['ns'], logger)).toEqual([['good']]);
    expect(rows()).toEqual([]);
    expect(infos).toEqual([]);
  });

  it('读不出的条目多于 10 条：info 只点名前 10 条，写明其余条数', async () => {
    const { svc, infos, logger, insertRaw, rows } = world();
    const keys = Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, '0')}`);
    for (const key of keys) insertRaw('ns', key, '{not json');

    const [cleared] = await clearMetadataNamespaces(svc, ['ns'], logger);

    expect(cleared.toSorted()).toEqual(keys);
    expect(rows()).toEqual([]);
    expect(infos).toHaveLength(1);
    const named = infos[0].match(/ns\/k\d\d/g) ?? [];
    expect(named).toHaveLength(10);
    expect(infos[0].startsWith('清理时一并删除了 12 条读不出的数据：')).toBe(true);
    expect(infos[0].endsWith(' 等（另有 2 条未列出）')).toBe(true);
  });

  it('读不出的条目正好 10 条：全部点名，不写省略', async () => {
    const { svc, infos, logger, insertRaw } = world();
    const keys = Array.from({ length: 10 }, (_, i) => `k${String(i).padStart(2, '0')}`);
    for (const key of keys) insertRaw('ns', key, '{not json');

    await clearMetadataNamespaces(svc, ['ns'], logger);

    expect(infos).toHaveLength(1);
    expect(infos[0].match(/ns\/k\d\d/g)?.toSorted()).toEqual(keys.map(k => `ns/${k}`));
    expect(infos[0]).not.toContain('未列出');
  });

  it('后端没有实现 listMetadataKeys：按 listMetadata 枚举，读不出的条目留在库里，不记 info', async () => {
    const { svc, infos, logger, insertRaw, rows } = world();
    await svc.saveMetadata('ns', 'good', { v: 1 });
    insertRaw('ns', 'broken', '{not json');
    const withoutKeys = new Proxy(svc, {
      get(target, prop) {
        if (prop === 'listMetadataKeys') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as MemoryService;

    expect(await clearMetadataNamespaces(withoutKeys, ['ns'], logger)).toEqual([['good']]);
    expect(rows()).toEqual(['ns/broken']);
    expect(infos).toEqual([]);
  });
});
