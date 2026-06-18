import { describe, expect, it } from 'vitest';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// S1: wait() 累计缓冲上限 —— 失控输出边读边截断 + 杀进程，防 OOM
// ════════════════════════════════════════════════════════════

// spawn/wait 不用 storage（仅 makeTempDir 用）；测试传空桩。
const proc = new LocalProcessService({} as unknown as StorageService);

describe('process-local maxBuffer 输出上限（S1）', () => {
  it('输出超过 maxBuffer → 截断到上限 + truncated=true + 杀进程', async () => {
    const handle = proc.spawn('node', ['-e', "process.stdout.write('a'.repeat(50000))"], { maxBuffer: 1000 });
    const res = await handle.wait();
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.stdout, 'utf-8')).toBeLessThanOrEqual(1000);
  });

  it('输出在上限内 → 完整返回、不标 truncated', async () => {
    const handle = proc.spawn('node', ['-e', "process.stdout.write('hello')"], { maxBuffer: 1000 });
    const res = await handle.wait();
    expect(res.stdout).toBe('hello');
    expect(res.truncated).toBeUndefined();
  });
});
