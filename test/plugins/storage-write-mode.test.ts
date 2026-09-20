import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageGateway, type StorageService } from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// storage.writeFile 原子写的权限位回归（真 fs）。
//   tmp+rename 的副作用：tmp 以默认 mode 创建，rename 后目标继承之——
//   可执行脚本被 file_write/file_edit 覆盖一次就从 755 掉到 644。
// ════════════════════════════════════════════════════════════

const mode = (p: string) => statSync(p).mode & 0o777;

describe('storage.writeFile 权限位（真 fs）', () => {
  let base: string;
  let ws: string;
  let app: App;
  let storage: StorageService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wmode-'));
    ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocal, {
      roots: [
        {
          name: 'ws',
          path: ws,
          label: 'ws',
          kind: 'workspace',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    storage = createStorageGateway(app.ctx);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('覆盖可执行文件：保持 755，内容已更新', async () => {
    const abs = join(ws, 'run.sh');
    writeFileSync(abs, '#!/bin/sh\necho old\n');
    chmodSync(abs, 0o755);
    await storage.writeFile('ws:/run.sh', '#!/bin/sh\necho new\n');
    expect(mode(abs)).toBe(0o755);
    expect(readFileSync(abs, 'utf8')).toContain('echo new');
  });

  it('覆盖只读文件：保持 444（不因写入被放宽）', async () => {
    const abs = join(ws, 'ro.txt');
    writeFileSync(abs, 'old');
    chmodSync(abs, 0o444);
    await storage.writeFile('ws:/ro.txt', 'new');
    expect(mode(abs)).toBe(0o444);
  });

  it('新文件：走默认 mode（与 fs.writeFile 同 umask 结果一致）', async () => {
    const baseline = join(ws, 'baseline.txt');
    writeFileSync(baseline, 'x');
    await storage.writeFile('ws:/fresh.txt', 'x');
    expect(mode(join(ws, 'fresh.txt'))).toBe(mode(baseline));
  });

  it('并发覆盖同一路径：tmp 名互不相撞，写入全部成功且落盘内容是其中之一', async () => {
    const contents = Array.from({ length: 10 }, (_, i) => `v${i}`);
    await Promise.all(contents.map(c => storage.writeFile('ws:/c.txt', c)));
    expect(contents).toContain(readFileSync(join(ws, 'c.txt'), 'utf-8'));
  });
});
