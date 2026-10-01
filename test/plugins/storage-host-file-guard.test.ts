import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStorageGateway,
  type StorageService,
  storage as storageService,
} from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// storage-local 的宿主控制文件兜底：密钥文件读写都拒、主配置拒写，不管经哪个根进来。
// 用户根配错（覆盖了家目录）、硬链接或符号链接把它们带进别的根时都挡得住；
// 删除、移动一个含控制文件的目录，或把这类目录的本地路径交给别的工具，同样拒绝。
// ════════════════════════════════════════════════════════════

const rw = { readable: true, writable: true, deletable: true };

describe('storage-local 宿主控制文件兜底', () => {
  let base: string;
  let home: string;
  let app: App;
  let storage: StorageService;

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-guard-')));
    home = join(base, 'home');
    mkdirSync(join(base, 'other'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(home, 'secrets.yaml'), 'key: SECRET-VALUE\n');
    writeFileSync(join(home, 'aalis.config.yaml'), 'name: T\n');
    app = new App({ name: 'T', logLevel: 'error' });
    provideHostPaths(app, home);
    await app.plugin(storageLocal, {
      roots: [
        // 配错的用户根：直接盖住了家目录
        { name: 'everything', path: home, ...rw },
        { name: 'up', path: base, ...rw },
        { name: 'other', path: join(base, 'other'), ...rw },
      ],
    });
    await app.plugins.idle();
    storage = createStorageGateway(app.bind({ storage: storageService }).storage);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('读密钥文件被拒（读全文、区间读、流式读、交出本地路径都算）', async () => {
    await expect(storage.readFile('everything:/secrets.yaml', 'utf-8')).rejects.toThrow('密钥文件');
    await expect(storage.readFileRange?.('everything:/secrets.yaml', 0, 5)).rejects.toThrow('密钥文件');
    await expect(storage.createReadStream('everything:/secrets.yaml')).rejects.toThrow('密钥文件');
    await expect(storage.resolveLocalPath?.('everything:/secrets.yaml')).rejects.toThrow('密钥文件');
  });

  it('主配置可以读、不能写；密钥文件也不能写', async () => {
    expect(await storage.readFile('everything:/aalis.config.yaml', 'utf-8')).toBe('name: T\n');
    await expect(storage.writeFile('everything:/aalis.config.yaml', 'x')).rejects.toThrow('主配置');
    await expect(storage.writeFile('everything:/secrets.yaml', 'x')).rejects.toThrow('密钥文件');
    expect(readFileSync(join(home, 'aalis.config.yaml'), 'utf-8')).toBe('name: T\n');
    expect(readFileSync(join(home, 'secrets.yaml'), 'utf-8')).toBe('key: SECRET-VALUE\n');
  });

  it('硬链接到别的根里照样认得出来（按 dev 与 ino 比）', async () => {
    linkSync(join(home, 'secrets.yaml'), join(base, 'other', 'leak.txt'));
    await expect(storage.readFile('other:/leak.txt', 'utf-8')).rejects.toThrow('密钥文件');
  });

  it('符号链接指过去照样拒绝', async () => {
    symlinkSync(join(home, 'secrets.yaml'), join(base, 'other', 'link.txt'));
    await expect(storage.readFile('up:/other/link.txt', 'utf-8')).rejects.toThrow('密钥文件');
  });

  it('改名、移动、删除控制文件都拒绝', async () => {
    await expect(storage.rename('everything:/secrets.yaml', 'x.yaml')).rejects.toThrow('密钥文件');
    await expect(storage.move('everything:/aalis.config.yaml', 'everything:/old.yaml')).rejects.toThrow('主配置');
    await expect(storage.delete('everything:/secrets.yaml')).rejects.toThrow('密钥文件');
  });

  it('删除、移动、改名含控制文件的目录，或以写、删的方式交出它的本地路径，都按子树拒绝', async () => {
    await expect(storage.delete('up:/home')).rejects.toThrow('目录里有宿主的密钥文件或主配置');
    await expect(storage.move('up:/home', 'up:/moved')).rejects.toThrow('目录里有宿主的密钥文件或主配置');
    await expect(storage.rename('up:/home', 'renamed')).rejects.toThrow('目录里有宿主的密钥文件或主配置');
    await expect(storage.resolveLocalPath?.('up:/home', 'write')).rejects.toThrow('目录里有宿主的密钥文件或主配置');
    await expect(storage.resolveLocalPath?.('up:/', 'delete')).rejects.toThrow('目录里有宿主的密钥文件或主配置');
  });

  it('以读的方式交出目录不查子树：家目录的上级目录照样能当命令的工作目录（挡命令读文件是沙箱的事）', async () => {
    expect(await storage.resolveLocalPath?.('up:/')).toBe(base);
    expect(await storage.resolveLocalPath?.('up:/home')).toBe(home);
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync('/System/Volumes/Data/private'))(
    '经 macOS 的 firmlink（同一个目录的另一条路径）删家目录也拒绝：子树按目录身份比',
    async () => {
      const other = new App({ name: 'T2', logLevel: 'error' });
      provideHostPaths(other, home);
      await other.plugin(storageLocal, { roots: [{ name: 'alias', path: `/System/Volumes/Data${base}`, ...rw }] });
      await other.plugins.idle();
      try {
        const alias = createStorageGateway(other.bind({ storage: storageService }).storage);
        await expect(alias.delete('alias:/home')).rejects.toThrow('目录里有宿主的密钥文件或主配置');
        expect(existsSync(join(home, 'secrets.yaml'))).toBe(true);
      } finally {
        await other.stop();
      }
    },
  );

  it('密钥文件不在时：大小写不同的同名文件、它下面的路径也不许建', async () => {
    rmSync(join(home, 'secrets.yaml'));
    await expect(storage.writeFile('everything:/Secrets.yaml', 'x')).rejects.toThrow('密钥文件');
    await expect(storage.writeFile('everything:/secrets.yaml/x', 'x')).rejects.toThrow('密钥文件');
    await expect(storage.mkdir('everything:/secrets.yaml')).rejects.toThrow('密钥文件');
  });

  it('密钥文件不在时，往它的位置写也拒（按真实路径比）', async () => {
    rmSync(join(home, 'secrets.yaml'));
    await expect(storage.writeFile('everything:/secrets.yaml', 'x')).rejects.toThrow('密钥文件');
  });

  it('列目录、stat 照常；不含控制文件的目录照常交出、删除', async () => {
    const listed = await storage.list('everything:/');
    expect(listed.entries.map(e => e.name)).toContain('secrets.yaml');
    expect((await storage.stat('everything:/secrets.yaml')).size).toBeGreaterThan(0);
    await storage.writeFile('other:/a.txt', 'ok');
    expect(await storage.resolveLocalPath?.('other:/')).toBe(join(base, 'other'));
    await storage.delete('other:/a.txt');
  });
});
