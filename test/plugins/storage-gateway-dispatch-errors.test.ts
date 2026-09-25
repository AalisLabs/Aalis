import { describe, expect, it } from 'vitest';
import {
  createStorageGateway,
  type StorageProviderEntry,
  type StorageRootInfo,
  type StorageService,
} from '../../packages/api-storage/src/index.js';
import type { ServiceRef } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 网关路由不到时的报错要说清原因：根名没注册是「未知存储根」；根已注册、只是没有提供者
// 满足所需能力（只读根上的写、没实现 resolveLocalPath / watch 的根）要点明缺哪项能力。
// 旧写法两种情形一律报「未知存储根」，根明明在列表里却说未知，排查时指错方向。
// ════════════════════════════════════════════════════════════

const root = (name: string, writable: boolean): StorageRootInfo => ({
  name,
  label: name,
  kind: 'workspace',
  browsable: true,
  readable: true,
  writable,
  deletable: writable,
});

/** 只挂一个根的提供者桩；extra 给出可选方法（resolveLocalPath / watch） */
function provider(info: StorageRootInfo, extra: Partial<StorageService> = {}): StorageProviderEntry {
  const instance = {
    listRoots: () => [info],
    writeFile: async () => undefined,
    ...extra,
  } as unknown as StorageService;
  return { instance, contextId: `stub/${info.name}` };
}

/** 网关只经 `all()` 枚举 entry */
function gatewayOf(...entries: StorageProviderEntry[]) {
  return createStorageGateway({ all: () => entries } as unknown as ServiceRef<StorageService>);
}

/** 网关的路由错误是同步抛出的；包一层 async 让两种抛法都落成 rejects */
const call = (fn: () => unknown): Promise<unknown> => (async () => fn())();

describe('存储网关：路由不到时的报错', () => {
  const local = provider(root('ws', true), { resolveLocalPath: async () => '/abs/ws/x' });
  const readonlyLocal = provider(root('ro', false), { resolveLocalPath: async () => '/abs/ro/x' });
  const remote = provider(root('remote', true));
  const gw = gatewayOf(local, readonlyLocal, remote);

  it('只读根上的写：报「不支持 write」，不说未知', async () => {
    await expect(call(() => gw.writeFile('ro:/a.txt', 'x'))).rejects.toThrow(/^存储根 ro 不支持 write$/);
  });

  it('提供者没实现 resolveLocalPath / watch：点明缺的能力', async () => {
    await expect(call(() => gw.resolveLocalPath('remote:/a'))).rejects.toThrow('存储根 remote 不支持 local-path');
    await expect(call(() => gw.watch('remote:/a', () => {}))).rejects.toThrow('存储根 remote 不支持 watch');
  });

  it('多项能力只报缺的那项：只读根上以写方式取本地路径 → 只缺 write', async () => {
    await expect(call(() => gw.resolveLocalPath('ro:/a', 'write'))).rejects.toThrow(/^存储根 ro 不支持 write$/);
  });

  it('能力齐全时照常路由到提供者', async () => {
    await expect(gw.resolveLocalPath('ws:/x', 'write')).resolves.toBe('/abs/ws/x');
    await expect(gw.resolveLocalPath('ro:/x')).resolves.toBe('/abs/ro/x');
  });

  it('根名没注册：仍报「未知存储根」并列出已注册根', async () => {
    await expect(call(() => gw.writeFile('nope:/a', 'x'))).rejects.toThrow(
      '未知存储根: nope（已注册根: ws, ro, remote）',
    );
  });
});
