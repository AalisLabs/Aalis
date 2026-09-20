import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import processLocal, { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 子进程生命周期：孙进程不再让 exec「安静地永不返回」。
//   1) 孙进程扣着同一对 pipe → 'close' 永不来，wait() 靠 'exit' + 短宽限返回；
//   2) 超时打的是整个进程组（detached 使子进程成为组长），孙进程同死；
//   3) detached 后 Ctrl+C 不再直达子进程 → 停机（app:stopping）由 killAll 按进程组收尸；
//      调用方显式 detached 的不登记。
// 均为 POSIX 语义，非 POSIX 平台跳过。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';

// spawn/wait 不用 storage（仅 makeTempDir 用）；测试传空桩。
const proc = new LocalProcessService({} as unknown as StorageService);

/** 唯一进程标记：配 `exec -a <标记>` 改写 argv[0]，用 pgrep -f 判存活。 */
const mark = (tag: string): string => `aalis-t-${tag}-${process.pid}-${Date.now()}`;

const alive = (marker: string): boolean => {
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false; // pgrep 无匹配时退出码 1
  }
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 轮询等待标记进程消失，最多 ms 毫秒 */
const waitGone = async (marker: string, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(marker)) return true;
    await sleep(50);
  }
  return !alive(marker);
};

describe('process-local 子进程生命周期', () => {
  it.skipIf(!posix)('孙进程扣着 pipe 时 wait() 仍在宽限后返回（不等孙进程退出）', async () => {
    const started = Date.now();
    const handle = proc.spawn('sh', ['-c', 'sleep 5 & echo hi'], {}); // 普通后台任务即可扣住 pipe（dash 也如此）
    const res = await handle.wait();
    const elapsed = Date.now() - started;
    expect(res.stdout).toContain('hi');
    expect(res.code).toBe(0);
    expect(elapsed).toBeLessThan(1000); // 未修复时要等满 sleep 5
  });

  it.skipIf(!posix)('超时杀整个进程组：signal=SIGKILL 且孙进程一并被杀', async () => {
    const marker = mark('grp');
    const started = Date.now();
    const handle = proc.spawn('bash', ['-c', `exec -a ${marker} sleep 30 & sleep 30`], { timeout: 300 });
    await sleep(150);
    expect(alive(marker)).toBe(true); // 防空跑：孙进程确实起来了
    const res = await handle.wait();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.signal).toBe('SIGKILL');
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('`cmd &` 留下的孙进程：直接子进程退了组仍在册，killAll 一并收尸', async () => {
    const marker = mark('orphan');
    const svc = new LocalProcessService({} as unknown as StorageService);
    const handle = svc.spawn('bash', ['-c', `exec -a ${marker} sleep 30 & echo hi`], {});
    const res = await handle.wait();
    expect(res.stdout).toContain('hi');
    expect(alive(marker)).toBe(true); // 防空跑：孙进程确实还活着
    svc.killAll();
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('调用方显式 detached 的进程不登记：killAll 不动它', async () => {
    const marker = mark('fnf');
    const svc = new LocalProcessService({} as unknown as StorageService);
    const handle = svc.spawn('bash', ['-c', `exec -a ${marker} sleep 30`], { detached: true, stdio: 'ignore' });
    handle.unref();
    await sleep(200);
    expect(alive(marker)).toBe(true);
    svc.killAll();
    await sleep(200);
    expect(alive(marker)).toBe(true);
    handle.kill('SIGKILL'); // 收拾
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('宿主停机：登记在册的存活子进程被杀', async () => {
    const marker = mark('dispose');
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.plugin(processLocal);
    await app.plugins.idle();
    const host = app.bind({ services });
    const service = host.services.get(processService);
    if (!service) throw new Error('process 服务未注册');
    service.spawn('bash', ['-c', `exec -a ${marker} sleep 30`], {});
    await sleep(200);
    expect(alive(marker)).toBe(true);
    await app.stop();
    expect(await waitGone(marker, 1000)).toBe(true);
  });
});
