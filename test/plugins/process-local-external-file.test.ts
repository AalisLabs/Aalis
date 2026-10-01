import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';

// ════════════════════════════════════════════════════════════
// readExternalFile 只收绝对路径或 file://：相对路径会按进程的 cwd 解析，而 cwd 不带语义（家目录由宿主解析），
// 同一个相对路径在不同目录启动时读到不同的文件。
// ════════════════════════════════════════════════════════════

const proc = new LocalProcessService({} as unknown as StorageService);

describe('process-local readExternalFile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('绝对路径与 file:// 照常读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-extfile-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'hi');
    expect(new TextDecoder().decode(await proc.readExternalFile(join(dir, 'a.txt')))).toBe('hi');
    expect(new TextDecoder().decode(await proc.readExternalFile(`file://${join(dir, 'a.txt')}`))).toBe('hi');
  });

  it('相对路径（含 file:// 后的相对路径）拒绝，不按 cwd 去读', async () => {
    await expect(proc.readExternalFile('package.json')).rejects.toThrow('外部文件路径必须是绝对路径');
    await expect(proc.readExternalFile('file://package.json')).rejects.toThrow('外部文件路径必须是绝对路径');
  });
});
