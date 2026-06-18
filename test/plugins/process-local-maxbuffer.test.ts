import { describe, expect, it } from 'vitest';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// wait() 累计缓冲上限：失控输出边读边截断防 OOM；超限停止累积但不杀进程
// （后台进程需长跑，杀掉会误伤）。
// ════════════════════════════════════════════════════════════

// spawn/wait 不用 storage（仅 makeTempDir 用）；测试传空桩。
const proc = new LocalProcessService({} as unknown as StorageService);

describe('process-local maxBuffer 输出上限', () => {
  it('输出超过 maxBuffer → 截断到上限 + truncated=true，且进程不被杀', async () => {
    // 写超量后延迟正常退出码 7；若 wait() 仍 SIGKILL，code 会是 null/带信号而非 7。
    const handle = proc.spawn(
      'node',
      ['-e', "process.stdout.write('a'.repeat(50000)); setTimeout(() => process.exit(7), 50)"],
      { maxBuffer: 1000 },
    );
    const res = await handle.wait();
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.stdout, 'utf-8')).toBeLessThanOrEqual(1000);
    expect(res.code).toBe(7); // 进程正常跑完退出，未被 maxBuffer 杀掉
  });

  it('输出在上限内 → 完整返回、不标 truncated', async () => {
    const handle = proc.spawn('node', ['-e', "process.stdout.write('hello')"], { maxBuffer: 1000 });
    const res = await handle.wait();
    expect(res.stdout).toBe('hello');
    expect(res.truncated).toBeUndefined();
  });
});
