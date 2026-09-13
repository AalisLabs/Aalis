import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';

// ════════════════════════════════════════════════════════════
// 「读不出来」不等于「文件不存在」。
//
// storage-local 的 loadOriginal 曾用裸 catch 把两者压成同一个 null，beforeMutate 拿到
// null 后按 write 记成 write-new（本回合新建），而 rollback 的 write-new 分支是无条件
// _backendDelete——于是一个回合开始前就存在、且没有任何备份的用户文件，在回滚时被直接
// 删掉，且 rollback 仍返回 ok:true。可达场景：只写权限(0200)、fd 打满(EMFILE)、
// 超过单次 readFile 上限。
// ════════════════════════════════════════════════════════════

const ROOT = 'ws:/checkpoints';

function makeService() {
  const disk = new Map<string, string>();
  /** 这些 URI「存在但读不出来」：stat 成功、读取抛错 */
  const unreadable = new Set<string>();
  let svc: CheckpointServiceImpl;

  const snapshot = async (uri: string, op: 'write' | 'delete' | 'rename', toUri?: string) => {
    if (!svc.isActive()) return;
    await svc.beforeMutate(
      uri,
      op,
      async () => {
        // 复刻修好后的 storage-local：只有目录/不存在返回 null，其余读取失败抛出去
        if (unreadable.has(uri)) throw new Error('EACCES: permission denied');
        const cur = disk.get(uri);
        if (cur === undefined) return null;
        const data = Buffer.from(cur);
        return { data, size: data.length };
      },
      toUri,
    );
  };

  const storage = {
    writeFile: async (uri: string, data: string | Uint8Array) => {
      await snapshot(uri, 'write');
      disk.set(uri, typeof data === 'string' ? data : Buffer.from(data).toString());
    },
    readFile: async (uri: string) => {
      const cur = disk.get(uri);
      if (cur === undefined) throw new Error(`ENOENT: ${uri}`);
      return Buffer.from(cur);
    },
    delete: async (uri: string) => {
      await snapshot(uri, 'delete');
      if (!disk.delete(uri)) throw new Error(`ENOENT: ${uri}`);
    },
    move: async (from: string, to: string) => {
      await snapshot(from, 'rename', to);
      const cur = disk.get(from);
      if (cur === undefined) throw new Error(`ENOENT: ${from}`);
      disk.set(to, cur);
      disk.delete(from);
    },
    list: async () => ({ entries: [] }),
    stat: async () => ({ mtime: new Date().toISOString() }),
    listRoots: () => [{ name: 'ws', kind: 'workspace' }],
  };

  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const cfg = { rootUri: ROOT, maxFileSize: 1024 * 1024, keepSessions: 0, scopes: ['*'] };
  svc = new CheckpointServiceImpl(cfg, logger as never, storage as never);
  svc.setBackend(
    (uri, data) => storage.writeFile(uri, data),
    uri => storage.delete(uri),
    (from, to) => storage.move(from, to),
  );
  return { svc, disk, storage, unreadable };
}

function soleTurnId(disk: Map<string, string>, sessionId: string): string {
  const prefix = `${ROOT}/${sessionId}/`;
  const ids = [...disk.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0]);
  const uniq = [...new Set(ids)];
  expect(uniq).toHaveLength(1);
  return uniq[0] as string;
}

describe('checkpoint：原文件读取失败不得当成「本回合新建」', () => {
  it('覆盖一个读不出来的既有文件 → 记 skipped，回滚不删它', async () => {
    const { svc, disk, storage, unreadable } = makeService();
    disk.set('ws:/secret.txt', '回合开始前就存在的用户数据');
    unreadable.add('ws:/secret.txt');

    svc.beginTurn('sessA');
    await storage.writeFile('ws:/secret.txt', 'agent 覆盖后的内容');
    await svc.endTurn('sessA');

    const turnId = soleTurnId(disk, 'sessA');
    const manifest = await svc.getManifest('sessA', turnId);
    const entry = manifest?.files.find(f => f.uri === 'ws:/secret.txt');
    expect(entry, '这条改动必须被记下来').toBeDefined();
    expect(entry?.action, '读取失败被记成 write-new 的话，回滚会把它删掉').not.toBe('write-new');
    expect(entry?.skipped, '应如实标为未快照、不可回滚').toBeTruthy();

    const result = await svc.rollback('sessA', turnId);
    expect(disk.has('ws:/secret.txt'), '用户文件绝不能因回滚而消失').toBe(true);
    expect(
      result.errors.some(e => e.uri === 'ws:/secret.txt'),
      '应如实报告这条无法回滚',
    ).toBe(true);
  });

  it('真·新建的文件仍记 write-new，回滚照常删除', async () => {
    const { svc, disk, storage } = makeService();

    svc.beginTurn('sessB');
    await storage.writeFile('ws:/brand-new.txt', '本回合新建');
    await svc.endTurn('sessB');

    const turnId = soleTurnId(disk, 'sessB');
    const manifest = await svc.getManifest('sessB', turnId);
    expect(manifest?.files.find(f => f.uri === 'ws:/brand-new.txt')?.action).toBe('write-new');

    await svc.rollback('sessB', turnId);
    expect(disk.has('ws:/brand-new.txt'), '新建文件回滚就该删掉').toBe(false);
  });
});
