import { Buffer } from 'node:buffer';
import { expect } from 'vitest';
import { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';

/** checkpoint 根：非根级、无尾斜杠，钉住 isOwnUri 的补分隔符分支（生产默认在 data 根下，那里本就不快照） */
export const CHECKPOINT_ROOT = 'ws:/checkpoints';

/**
 * 一份内存「磁盘」+ 复刻 storage-local 写前快照钩子的 storage 假实现，配一个直接构造的 checkpoint 服务。
 * checkpoint 自己的 blob/manifest 与用户文件共用这块磁盘，以复现递归路径。
 * `unreadable` 里的 URI「存在但读不出来」：stat 成功、读取抛错；`warns` 收集服务记的告警。
 */
export function makeCheckpointService() {
  const disk = new Map<string, string>();
  const unreadable = new Set<string>();
  let svc: CheckpointServiceImpl;

  // storage-local 的 snapshot()：每次实际改动前调 beforeMutate，回合外的写入由它跳过
  const snapshot = async (uri: string, op: 'write' | 'delete' | 'rename', toUri?: string) => {
    await svc.beforeMutate(
      uri,
      op,
      async () => {
        // 复刻 storage-local：只有目录/不存在返回 null，其余读取失败抛出去
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
    // data / tmp / pluginData / logs 不记账；workspace 与用户自建的 custom 根记账
    listRoots: () => [
      { name: 'ws', kind: 'workspace' },
      { name: 'repo', kind: 'custom' },
      { name: 'data', kind: 'data' },
      { name: 'tmp', kind: 'tmp' },
      { name: 'plugs', kind: 'pluginData' },
      { name: 'lg', kind: 'logs' },
    ],
  };

  const warns: string[] = [];
  const logger = { debug() {}, info() {}, warn: (msg: string) => void warns.push(msg), error() {} };
  const cfg = { rootUri: CHECKPOINT_ROOT, maxFileSize: 1024 * 1024, keepSessions: 0, scopes: ['*'] };
  // 不注入 memory：commitTurn 跳过消息时间戳，仅凭文件改动判断是否落盘
  svc = new CheckpointServiceImpl(cfg, logger as never, storage as never);
  return { svc, disk, storage, unreadable, warns };
}

/** 取某会话唯一一个已落盘回合的 turnId */
export function soleTurnId(disk: Map<string, string>, sessionId: string): string {
  const prefix = `${CHECKPOINT_ROOT}/${sessionId}/`;
  const ids = [...disk.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0]);
  const uniq = [...new Set(ids)];
  expect(uniq).toHaveLength(1);
  return uniq[0] as string;
}

/** 某回合 manifest 里某个文件条目对应的备份内容 */
export function blobOf(disk: Map<string, string>, sessionId: string, turnId: string, uri: string): string | undefined {
  const manifest = JSON.parse(disk.get(`${CHECKPOINT_ROOT}/${sessionId}/${turnId}/manifest.json`) ?? 'null') as {
    files: Array<{ uri: string; blob?: string }>;
  } | null;
  const blob = manifest?.files.find(f => f.uri === uri)?.blob;
  return blob === undefined ? undefined : disk.get(`${CHECKPOINT_ROOT}/${sessionId}/${turnId}/blobs/${blob}`);
}
