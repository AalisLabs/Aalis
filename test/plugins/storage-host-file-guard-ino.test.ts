import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStorageGateway,
  type StorageService,
  storage as storageService,
} from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// 宿主控制文件兜底按 (dev, ino) 认身份。Windows 的文件 ID 是 64 位（NTFS 高 16 位是序号），
// 超过 2^53 时转成 number 会丢低位，两个不同的文件可能撞成同一个号，无关文件被当成密钥文件挡下。
// 测试机造不出这样的 ID：只给登记过的 inode 换成两个只差 1 的大号，其余照真实实现。
// ════════════════════════════════════════════════════════════

const fakeIno = vi.hoisted(() => new Map<bigint, bigint>());
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    stat: async (path: Parameters<typeof fs.stat>[0], opts?: { bigint?: boolean }) => {
      const big = await fs.stat(path, { bigint: true });
      const ino = fakeIno.get(big.ino);
      if (opts?.bigint) {
        if (ino !== undefined) big.ino = ino;
        return big;
      }
      const num = await fs.stat(path);
      if (ino !== undefined) num.ino = Number(ino);
      return num;
    },
  };
});

/** 序号 64、记录号 1000 的文件 ID；加 1 后转成 number 与它相同 */
const BIG = (64n << 48n) + 1000n;
const realIno = (path: string) => statSync(path, { bigint: true }).ino;
const rw = { readable: true, writable: true, deletable: true };

describe('storage-local 宿主控制文件兜底：超过 2^53 的文件 ID', () => {
  let base: string;
  let home: string;
  let app: App;
  let storage: StorageService;

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-guard-ino-')));
    home = join(base, 'home');
    mkdirSync(join(base, 'other', 'sub'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(home, 'secrets.yaml'), 'key: SECRET-VALUE\n');
    writeFileSync(join(home, 'aalis.config.yaml'), 'name: T\n');
    writeFileSync(join(base, 'other', 'notes.txt'), 'hello');
    app = new App({ name: 'T', logLevel: 'error' });
    provideHostPaths(app, home);
    await app.plugin(storageLocal, { roots: [{ name: 'other', path: join(base, 'other'), ...rw }] });
    await app.plugins.idle();
    storage = createStorageGateway(app.bind({ storage: storageService }).storage);
  });

  afterEach(async () => {
    fakeIno.clear();
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('前提：替身生效，两个文件按 number 取 stat 撞号、按 bigint 取不撞', async () => {
    const secrets = join(home, 'secrets.yaml');
    const notes = join(base, 'other', 'notes.txt');
    fakeIno.set(realIno(secrets), BIG);
    fakeIno.set(realIno(notes), BIG + 1n);
    const { stat } = await import('node:fs/promises');
    const [a, b] = [await stat(secrets), await stat(notes)];
    expect([a.dev, a.ino]).toEqual([b.dev, b.ino]);
    expect((await stat(secrets, { bigint: true })).ino).not.toBe((await stat(notes, { bigint: true })).ino);
  });

  it('无关文件的号与密钥文件只差低位时照常可读', async () => {
    fakeIno.set(realIno(join(home, 'secrets.yaml')), BIG);
    fakeIno.set(realIno(join(base, 'other', 'notes.txt')), BIG + 1n);
    expect(await storage.readFile('other:/notes.txt', 'utf-8')).toBe('hello');
  });

  // 两个方向都要：祖先目录的号大 1 时，只有祖先一侧按 number 取（丢低位）才会撞上目标目录的号
  it.each([
    ['祖先目录的号小 1', BIG, BIG + 1n],
    ['祖先目录的号大 1', BIG + 1n, BIG],
  ])('无关目录的号与控制文件的祖先目录只差低位时照常可删：%s', async (_label, homeIno, subIno) => {
    fakeIno.set(realIno(home), homeIno);
    fakeIno.set(realIno(join(base, 'other', 'sub')), subIno);
    await storage.delete('other:/sub');
    expect((await storage.list('other:/')).entries.map(e => e.name)).toEqual(['notes.txt']);
  });
});
