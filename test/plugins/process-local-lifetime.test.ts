import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExecResult, processService, type SpawnHandle } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, lifecycle, optional, services } from '../../packages/core/src/index.js';
import processLocal, {
  ABORT_KILL_GRACE_MS,
  killAll,
  LocalProcessService,
} from '../../packages/plugin-process-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 子进程生命周期：孙进程不再让 exec「安静地永不返回」。
//   1) 孙进程扣着同一对 pipe → 'close' 永不来，wait() 靠 'exit' + 短宽限返回；
//   2) 超时打的是整个进程组（detached 使子进程成为组长），孙进程同死；
//   3) detached 后 Ctrl+C 不再直达子进程 → 停机时由 killAll 按进程组收尸：先整组 SIGTERM，宽限后还有成员的整组 SIGKILL；
//      调用方显式 detached 的不登记。收在本插件自己的清理里：用 process 服务的插件先关完、先按自己的方式停下各自的子进程；
//      本插件单独停用、重启、卸载时同样收：它启动的进程组属于它，它关完时不留下还在跑的；
//   4) 直接子进程退出后组里的进程也都退了，即撤这个组的登记，停机不再对空出来、可能被复用的组号发信号；
//   5) 宿主没走完停机就退出（kill -9 等）时，宿主进程退出后由看门进程照停机的规矩收掉仍登记的组。
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

const groupAlive = (group: number): boolean => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

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
    expect(alive(marker)).toBe(true); // 防空跑：孙进程确实启动了
    const res = await handle.wait();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.signal).toBe('SIGKILL');
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('`cmd &` 留下的孙进程：直接子进程退了组仍在册，killAll 一并收尸', async () => {
    const marker = mark('orphan');
    const handle = proc.spawn('bash', ['-c', `exec -a ${marker} sleep 30 & echo hi`], {});
    const res = await handle.wait();
    expect(res.stdout).toContain('hi');
    expect(alive(marker)).toBe(true); // 防空跑：孙进程确实还活着
    killAll();
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('孙进程后来也退了：组空即撤登记，停机不再对这个组号发信号（它可能已被别的进程复用）', async () => {
    // 登记表与探测定时器是模块级的：另载一份模块，不接前面用例留下的、还在跑的探测定时器
    vi.resetModules();
    const fresh = await import('../../packages/plugin-process-local/src/index.js');
    // 只假探测用的 setInterval：组空之后手动走一轮探测，不等真实的间隔
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const kill = vi.spyOn(process, 'kill');
    try {
      const svc = new fresh.LocalProcessService({} as unknown as StorageService);
      // 孙进程要活过 wait() 在直接子进程退出后的关闭宽限（CLOSE_GRACE_MS），留足负载下的余量
      const handle = svc.spawn('sh', ['-c', 'sleep 2 & echo hi'], {});
      await handle.wait();
      const group = -handle.pid!;
      expect(() => process.kill(group, 0), '防空跑：直接子进程退出时组里还有 sleep').not.toThrow();
      await vi.waitFor(() => expect(() => process.kill(group, 0)).toThrow(), { timeout: 5000 });
      vi.runOnlyPendingTimers();
      kill.mockClear();
      await fresh.killAll();
      expect(kill.mock.calls.filter(([target]) => target === group)).toEqual([]);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.skipIf(!posix)('调用方显式 detached 的进程不登记：killAll 不动它', async () => {
    const marker = mark('fnf');
    const handle = proc.spawn('bash', ['-c', `exec -a ${marker} sleep 30`], { detached: true, stdio: 'ignore' });
    handle.unref();
    await sleep(200);
    expect(alive(marker)).toBe(true);
    killAll();
    await sleep(200);
    expect(alive(marker)).toBe(true);
    handle.kill('SIGKILL'); // 收拾
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('宿主停机：登记在册的存活子进程被杀', async () => {
    const marker = mark('dispose');
    const app = new App({ logLevel: 'error' });
    await app.plugin(processLocal);
    await app.plugins.idle();
    const host = app.bind({ services });
    const service = host.services.use.get(processService);
    if (!service) throw new Error('process 服务未注册');
    service.spawn('bash', ['-c', `exec -a ${marker} sleep 30`], {});
    await sleep(200);
    expect(alive(marker)).toBe(true);
    await app.stop();
    expect(await waitGone(marker, 1000)).toBe(true);
  });

  it.skipIf(!posix)('停机先整组 SIGTERM 让子进程收尾，忽略的宽限后整组 SIGKILL，停机等到收完', async () => {
    const marker = mark('graceful');
    const app = new App({ logLevel: 'error' });
    await app.plugin(processLocal);
    await app.plugins.idle();
    const service = app.bind({ services }).services.use.get(processService);
    if (!service) throw new Error('process 服务未注册');
    const politeRun = service.spawn('bash', ['-c', "trap 'echo bye; exit 0' TERM; echo ready; sleep 30 & wait"], {});
    const stubbornRun = service.spawn('bash', ['-c', `trap '' TERM; echo ready; exec -a ${marker} sleep 30`], {});
    const polite = politeRun.wait();
    const stubborn = stubbornRun.wait();
    // 装好 trap 才打出 ready，等到它再停机：只按时间等的话，负载下 trap 还没装好 SIGTERM 就到了
    await Promise.all([politeRun, stubbornRun].map(run => new Promise(ready => run.stdout?.once('data', ready))));
    const started = Date.now();
    await app.stop();
    const elapsed = Date.now() - started;
    expect((await polite).stdout).toBe('ready\nbye\n');
    expect((await stubborn).signal).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(ABORT_KILL_GRACE_MS);
    expect(await waitGone(marker, 500)).toBe(true);
  });

  // 用 process 服务的插件（optional 也算，同 tool-system、trigger-laya）整个关完，本插件才收尾：它们先在自己的收尾里按自己的
  // 方式停下子进程（这里是发退出命令、等它自己退出）。本插件先下手的话，执行器把停机时在跑的命令记成自己结束（退出码 -1，
  // 后台任务落成 failed）而不是已中止，托管侧车的插件把侧车的退出当成意外退出
  it.skipIf(!posix)(
    '停机：用 process 服务的插件先在自己的收尾里按自己的方式停下子进程，本插件之后才收剩下的',
    async () => {
      const app = new App({ logLevel: 'error' });
      let ended: Promise<ExecResult> | undefined;
      const consumer = definePlugin({
        name: 'zz-quit-consumer',
        uses: { lifecycle, proc: optional(processService) },
        apply({ lifecycle, proc }) {
          const handle = proc.use.spawn('sh', ['-c', 'read line; exit 0']);
          handle.stdin?.on('error', () => {});
          const exited = handle.wait();
          lifecycle.use.onDrain(async () => {
            handle.stdin?.end('quit\n');
            await exited;
          });
          ended = exited;
        },
      });
      await app.plugin(processLocal);
      await app.plugin(consumer);
      await app.plugins.idle();
      await app.stop();
      expect(await ended).toMatchObject({ code: 0, signal: null });
    },
  );

  // 可选依赖本插件的插件不随它重启：子进程被收掉，它从 wait() 拿到被信号结束的结果
  it.skipIf(!posix)(
    '本插件被 bounce：它启动的进程组随它的清理收掉，先整组 SIGTERM、等它收尾退出，重启完成时组里已没有进程',
    async () => {
      const app = new App({ logLevel: 'error' });
      let run: SpawnHandle | undefined;
      let applied = 0;
      const consumer = definePlugin({
        name: 'zz-spawn-consumer',
        uses: { lifecycle, proc: optional(processService) },
        apply({ lifecycle, proc }) {
          applied++;
          // 收尾要花一点时间：清理不等它的话，重启完成时组里还有进程
          run = proc.use.spawn('bash', ['-c', "trap 'sleep 0.3; echo bye; exit 0' TERM; echo ready; sleep 30 & wait"], {
            signal: lifecycle.use.signal,
          });
        },
      });
      await app.plugin(processLocal);
      await app.plugin(consumer);
      await app.plugins.idle();
      if (!run?.pid) throw new Error('子进程未能启动');
      const pid = run.pid;
      const ended = run.wait();
      await new Promise(ready => run?.stdout?.once('data', ready));
      try {
        await app.plugins.bounce(processLocal.name);
        await app.plugins.idle();
        expect(groupAlive(pid), '重启等到组里的进程都退出').toBe(false);
        expect((await ended).stdout).toBe('ready\nbye\n');
        expect(applied, '可选依赖方不随之重启').toBe(1);
      } finally {
        if (groupAlive(pid)) process.kill(-pid, 'SIGKILL');
        await app.stop();
      }
    },
  );
});

describe.skipIf(!posix)('process-local 宿主退出时收掉它启动的进程组', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const fixture = join(repoRoot, 'test', 'fixtures', 'process-host.ts');
  /** 用例没走完时在这里收掉宿主与它报出的组 */
  const leftovers: Array<() => void> = [];
  afterEach(() => {
    for (const kill of leftovers.splice(0)) kill();
  });

  /** 启动扮演宿主的进程，等它报出已启动进程组的组号 */
  async function startHost() {
    const host = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: repoRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.test.json') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    leftovers.push(() => host.kill('SIGKILL'));
    const exited = new Promise<void>(done => host.once('exit', () => done()));
    const line = await new Promise<string>((ready, fail) => {
      host.stdout.once('data', data => ready(String(data)));
      void exited.then(() => fail(new Error('宿主没报组号就退出了')));
    });
    const groups = line.trim().split(' ').map(Number);
    for (const group of groups) leftovers.push(() => groupAlive(group) && process.kill(-group, 'SIGKILL'));
    return { host, groups };
  }

  it('宿主被 kill -9：照停机的规矩收掉，忽略 SIGTERM 的宽限后被 SIGKILL', async () => {
    const { host, groups } = await startHost();
    const [plain, stubborn] = groups as [number, number];
    expect([groupAlive(plain), groupAlive(stubborn)]).toEqual([true, true]);
    host.kill('SIGKILL');
    await vi.waitFor(() => expect(groupAlive(plain)).toBe(false), { timeout: 1000 });
    expect(groupAlive(stubborn), '忽略 SIGTERM 的还在宽限里').toBe(true);
    await vi.waitFor(() => expect(groupAlive(stubborn)).toBe(false), { timeout: ABORT_KILL_GRACE_MS + 1000 });
  });
});
