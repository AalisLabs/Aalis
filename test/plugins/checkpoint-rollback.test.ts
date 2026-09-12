import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { CheckpointServiceImpl, type TurnManifest } from '../../packages/plugin-checkpoint/src/service.js';

// ════════════════════════════════════════════════════════════
// checkpoint 回滚：备份不得把自己也记成一条改动。
// （回归：storage 的写前快照钩子会把 checkpoint 自己写 blob 的动作递归送回 beforeMutate，
//  blob 此刻尚不存在 → 记成 write-new 且排在真实条目之前 → 回滚先删备份再读它 → ENOENT，
//  覆盖/删除类恢复必败且备份被毁；listTurns 也因此虚高并暴露内部路径。）
// ════════════════════════════════════════════════════════════

const ROOT = 'data:/checkpoints'; // 生产默认形状：非根级、无尾斜杠，钉住 isOwnUri 的补分隔符分支

/**
 * 夹具：一份内存「磁盘」+ 复刻 storage-local 写前快照钩子的 storage 假实现。
 * checkpoint 自己的 blob/manifest 与用户文件共用这块磁盘，以复现递归路径。
 */
function makeService() {
  const disk = new Map<string, string>();
  let svc: CheckpointServiceImpl;

  // storage-local 的 snapshot(): 回合活跃时，在实际改动前调 beforeMutate
  const snapshot = async (uri: string, op: 'write' | 'delete' | 'rename') => {
    if (!svc.isActive()) return;
    await svc.beforeMutate(uri, op, async () => {
      const cur = disk.get(uri);
      if (cur === undefined) return null;
      const data = Buffer.from(cur);
      return { data, size: data.length };
    });
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
    list: async (dirUri: string) => {
      const prefix = dirUri.endsWith('/') ? dirUri : `${dirUri}/`;
      const names = new Map<string, boolean>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        names.set(name, names.get(name) === true || slash !== -1);
      }
      return {
        entries: [...names].map(([name, isDirectory]) => ({ name, isDirectory, uri: `${prefix}${name}` })),
      };
    },
    stat: async () => ({ mtime: new Date().toISOString() }),
  };

  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const cfg = { rootUri: ROOT, maxFileSize: 1024 * 1024, keepSessions: 0, scopes: ['*'] };
  // 不注入 memory：commitTurn 跳过消息时间戳，仅凭文件改动判断是否落盘
  svc = new CheckpointServiceImpl(cfg, logger as never, storage as never);
  svc.setBackend(
    (uri, data) => storage.writeFile(uri, data),
    uri => storage.delete(uri),
  );
  return { svc, disk, storage };
}

/** 取某会话唯一一个已落盘回合的 turnId */
function soleTurnId(disk: Map<string, string>, sessionId: string): string {
  const prefix = `${ROOT}/${sessionId}/`;
  const ids = [...disk.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0]);
  const uniq = [...new Set(ids)];
  expect(uniq).toHaveLength(1);
  return uniq[0] as string;
}

describe('checkpoint 回滚', () => {
  it('覆盖写：回滚恢复原文', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('data:/a.txt', 'orig');

    svc.beginTurn('sessA');
    await storage.writeFile('data:/a.txt', 'changed');
    await svc.endTurn('sessA');
    expect(disk.get('data:/a.txt')).toBe('changed');

    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.restored).toEqual(['data:/a.txt']);
    expect(disk.get('data:/a.txt')).toBe('orig');
  });

  it('删除：回滚把文件写回来', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('data:/b.txt', 'orig-b');

    svc.beginTurn('sessA');
    await storage.delete('data:/b.txt');
    await svc.endTurn('sessA');
    expect(disk.has('data:/b.txt')).toBe(false);

    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(disk.get('data:/b.txt')).toBe('orig-b');
  });

  it('write-new：回滚删除新建文件，且不误删 checkpoint 自己的 blob', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('data:/a.txt', 'orig');

    svc.beginTurn('sessA');
    await storage.writeFile('data:/a.txt', 'changed'); // 覆盖（有 blob）
    await storage.writeFile('data:/new.txt', 'brand new'); // 新建
    await svc.endTurn('sessA');

    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deleted).toEqual(['data:/new.txt']);
    expect(disk.has('data:/new.txt')).toBe(false);
    expect(disk.get('data:/a.txt')).toBe('orig');
  });

  it('manifest 只记用户文件：不含指向 checkpoint 根的自指条目', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('data:/a.txt', 'orig');

    svc.beginTurn('sessA');
    await storage.writeFile('data:/a.txt', 'changed');
    await svc.endTurn('sessA');

    const turnId = soleTurnId(disk, 'sessA');
    const manifest = await svc.getManifest('sessA', turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['data:/a.txt']);

    const [summary] = await svc.listTurns('sessA');
    expect(summary?.fileCount).toBe(1);
    expect(summary?.filesPreview).toEqual(['data:/a.txt']);
  });

  it('同名前缀的兄弟目录是用户文件：照常快照与回滚，不被当成 checkpoint 自己的根', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('data:/checkpoints-old/a.txt', 'orig-sibling');
    disk.set('data:/a.txt', 'orig');

    svc.beginTurn('sessA');
    await storage.writeFile('data:/checkpoints-old/a.txt', 'changed');
    await storage.writeFile('data:/a.txt', 'changed');
    await svc.endTurn('sessA');

    const turnId = soleTurnId(disk, 'sessA');
    const manifest = await svc.getManifest('sessA', turnId);
    expect(manifest?.files.map(f => f.uri).sort()).toEqual(['data:/a.txt', 'data:/checkpoints-old/a.txt']);

    const result = await svc.rollback('sessA', turnId);
    expect(result.ok).toBe(true);
    expect(disk.get('data:/checkpoints-old/a.txt')).toBe('orig-sibling');
    expect(disk.get('data:/a.txt')).toBe('orig');
  });

  it('存量自指条目：旧 manifest 照样回滚，自指条目被跳过且不计入 listTurns', async () => {
    const { svc, disk } = makeService();
    disk.set('data:/a.txt', 'changed');

    // 手工铺一个旧版（带递归假账）的回合：假账 write-new 排在真实条目之前
    const turnId = 'legacy-turn';
    const turnDir = `${ROOT}/sessA/${turnId}`;
    disk.set(`${turnDir}/blobs/0.bin`, 'orig');
    const manifest: TurnManifest = {
      turnId,
      sessionId: 'sessA',
      startedAt: 1,
      endedAt: 2,
      files: [
        { uri: `${turnDir}/blobs/0.bin`, action: 'write-new' },
        { uri: 'data:/a.txt', action: 'write', originalSize: 4, blob: '0.bin' },
      ],
    };
    disk.set(`${turnDir}/manifest.json`, JSON.stringify(manifest));

    const result = await svc.rollback('sessA', turnId);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(disk.get('data:/a.txt')).toBe('orig');

    const [summary] = await svc.listTurns('sessA');
    expect(summary?.fileCount).toBe(1);
    expect(summary?.filesPreview).toEqual(['data:/a.txt']);
  });
});
