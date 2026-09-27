import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult, ProcessService, SpawnHandle, SpawnOptions } from '../../packages/api-process/src/index.js';
import { type Sidecar, sidecarTarget, superviseSidecar } from '../../packages/plugin-trigger-laya/src/sidecar.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// plugin-trigger-laya 的托管侧车（sidecar.ts）：拉起参数、就绪行、退出后退避重启、首次拉起前地址已被占用、
// 没有 process 服务、启动超时、停止时先 SIGTERM 再 SIGKILL。process 服务是假的（不拉真进程），时钟用假时钟；
// 接进插件后的行为见 trigger-laya.test.ts「托管侧车」。
// ════════════════════════════════════════════════════════════

const DIR = '/opt/laya/listener-sidecar';

/** 一个假子进程：stdout / stderr 可写入，exit() 让 wait() 落定；kill 只记下信号，由用例决定何时退出 */
interface FakeChild {
  cmd: string;
  args: readonly string[];
  opts?: SpawnOptions;
  stdout: PassThrough;
  stderr: PassThrough;
  signals: NodeJS.Signals[];
  exit(code: number | null, signal?: NodeJS.Signals): void;
  fail(err: Error): void;
  ready(extra?: Record<string, unknown>): void;
}

function fakeProcess() {
  const children: FakeChild[] = [];
  const service: ProcessService = {
    spawn(cmd, args, opts) {
      const done = deferred<ExecResult>();
      const child: FakeChild = {
        cmd,
        args,
        opts,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signals: [],
        exit: (code, signal = undefined) => done.resolve({ code, signal: signal ?? null, stdout: '', stderr: '' }),
        fail: err => done.reject(err),
        ready: extra =>
          child.stdout.write(
            `${JSON.stringify({ ready: true, version: 'v-sc', port: 17878, pid: 4242, startup_s: 10.8, ...extra })}\n`,
          ),
      };
      children.push(child);
      const handle: SpawnHandle = {
        pid: 4242,
        stdin: null,
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () => done.promise,
        kill: signal => {
          child.signals.push(signal ?? 'SIGTERM');
          return true;
        },
        unref: () => {},
      };
      return handle;
    },
    execFile: () => Promise.reject(new Error('unused')),
    makeTempDir: () => Promise.reject(new Error('unused')),
    readExternalFile: () => Promise.reject(new Error('unused')),
  };
  return { service, children };
}

interface Harness {
  sc: Sidecar;
  children: FakeChild[];
  logs: Array<[level: string, msg: string]>;
  exits: Array<[reason: string, newRound: boolean]>;
  probe: { taken: boolean; calls: number };
  /** 拉起时给出的 process 服务；置为 undefined 模拟缺席 */
  current: { process: ProcessService | undefined };
}

function start(opts: { taken?: boolean; process?: ProcessService | null } = {}): Harness {
  const fake = fakeProcess();
  const h = {
    children: fake.children,
    logs: [] as Array<[string, string]>,
    exits: [] as Array<[string, boolean]>,
    probe: { taken: opts.taken ?? false, calls: 0 },
    current: { process: opts.process === null ? undefined : (opts.process ?? fake.service) },
  } as Harness;
  h.sc = superviseSidecar({
    process: () => h.current.process,
    dir: DIR,
    port: 17878,
    parentPid: 999,
    probe: async () => {
      h.probe.calls++;
      return h.probe.taken;
    },
    log: {
      info: m => h.logs.push(['info', m]),
      warn: m => h.logs.push(['warn', m]),
      debug: m => h.logs.push(['debug', m]),
    },
    onExit: (reason, newRound) => h.exits.push([reason, newRound]),
  });
  return h;
}

const infos = (h: Harness) => h.logs.filter(([l]) => l === 'info').map(([, m]) => m);

/** 让 probe → spawn 这段异步走完 */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('托管侧车：拉起与就绪', () => {
  it('按侧车目录的布局拉起：venv 的 python 以 -I 运行、模型取 models/current、端口与父进程 pid 作参数，工作目录是侧车目录', async () => {
    const h = start();
    expect(h.children, '先探地址，探完才拉起').toHaveLength(0);
    await settle();
    expect(h.children).toHaveLength(1);
    const [c] = h.children;
    expect(c.cmd).toBe(`${DIR}/.venv-run/bin/python`);
    expect(c.args).toEqual([
      '-I',
      '-u',
      `${DIR}/laya_listener.py`,
      '--model-dir',
      `${DIR}/models/current`,
      '--port',
      '17878',
      '--parent-pid',
      '999',
    ]);
    expect(c.opts, 'wait() 只用退出码，不替常驻进程攒输出').toEqual({ cwd: DIR, maxBuffer: 1 });
    expect(h.sc.state).toMatchObject({ kind: 'starting', restarts: 0 });
    expect(infos(h)).toEqual([`[laya] 正在拉起侧车（${DIR}，端口 17878），就绪前判定按兜底只回点名`]);
  });

  it('就绪行 → ready；就绪行之外的输出记 debug；就绪行跨块到达也认；多出的就绪行不重复记', async () => {
    const h = start();
    await settle();
    const [c] = h.children;
    c.stderr.write('{"event": "selftest_ok", "version": "v-sc"}\n');
    const line = `${JSON.stringify({ ready: true, version: 'v-sc', startup_s: 10.8 })}\n`;
    c.stdout.write(line.slice(0, 10));
    await settle();
    expect(h.sc.state.kind).toBe('starting');
    c.stdout.write(line.slice(10));
    await settle();
    expect(h.sc.state).toEqual({ kind: 'ready' });
    expect(h.logs).toContainEqual(['debug', '[laya] 侧车: {"event": "selftest_ok", "version": "v-sc"}']);
    c.ready();
    c.stdout.write('{"ready": true}\n');
    await settle();
    expect(infos(h).filter(m => m.startsWith('[laya] 侧车就绪'))).toEqual(['[laya] 侧车就绪（版本 v-sc，启动 10.8s）']);
  });

  it('没有换行的超长输出只留开头 64K 字符，行缓冲不无限增长', async () => {
    const h = start();
    await settle();
    const [c] = h.children;
    for (let i = 0; i < 4; i++) c.stderr.write('x'.repeat(50_000));
    c.stderr.write('\n');
    await settle();
    const line = h.logs.find(([, m]) => m.startsWith('[laya] 侧车: x'))?.[1] ?? '';
    expect(line.length).toBe('[laya] 侧车: '.length + 64 * 1024);
  });

  it('首次拉起前地址上已有侧车在答 /health：不拉起、不记「正在拉起」，记 warn，状态为 external', async () => {
    const h = start({ taken: true });
    await settle();
    expect(h.children).toHaveLength(0);
    expect(h.sc.state).toEqual({ kind: 'external' });
    expect(infos(h)).toEqual([]);
    expect(h.logs.filter(([l]) => l === 'warn').map(([, m]) => m)).toEqual([
      '[laya] 侧车端口 17878 上已有侧车在运行（系统服务或手动启动的），本插件不拉起，直接使用它；要改由本插件托管，' +
        '先停掉它（系统服务要卸载，直接结束进程会被系统拉回），再重启 Aalis 或把 trigger 偏好切走再切回',
    ]);
    await h.sc.stop();
    expect(infos(h), '没拉起过，停止时不记「已停掉」').toEqual([]);
  });
});

describe('托管侧车：退出与重启', () => {
  it('意外退出：原因带退出码的含义与标准错误最后一行，1s、2s、4s…翻倍重启，封顶 60s；重启不再探地址', async () => {
    const h = start();
    await settle();
    h.children[0].stderr.write('{"event": "self_heal_exit", "failures": 3, "code": 4}\n');
    await settle();
    h.children[0].exit(4);
    await settle();
    expect(h.exits).toEqual([
      [
        '侧车退出（退出码 4，自愈退出：推理连续失败；标准错误最后一行: {"event": "self_heal_exit", "failures": 3, "code": 4}），' +
          '1s 后重启',
        true,
      ],
    ]);
    expect(h.sc.state).toMatchObject({ kind: 'waiting', restarts: 1 });

    await vi.advanceTimersByTimeAsync(999);
    expect(h.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.children).toHaveLength(2);
    expect(h.probe.calls, '只在首次拉起前探地址').toBe(1);
    expect(h.sc.state).toMatchObject({ kind: 'starting', restarts: 1 });

    // 一直起不来：间隔 2、4、8、16、32、60、60，都属同一轮故障
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.children.at(-1)?.exit(2);
      await settle();
      delays.push(Number(/(\d+)s 后重启$/.exec(h.exits.at(-1)?.[0] ?? '')?.[1]));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60]);
    expect(h.exits.slice(1).every(([, newRound]) => !newRound)).toBe(true);
    expect(h.exits.at(-1)?.[0]).toContain('退出码 2，启动失败：加载模型或金样自检没过，或参数、脚本有误');
    // 早先退出的进程不再挨启动超时的 SIGKILL（计时器随退出清掉）
    expect(h.children.slice(0, -1).map(c => c.signals)).toEqual(h.children.slice(0, -1).map(() => []));

    h.children.at(-1)?.ready();
    await settle();
    expect(infos(h)).toContain('[laya] 侧车就绪（版本 v-sc，启动 10.8s，连续退出 8 次后重启成功）');
  });

  it('就绪后稳定运行满 60s 再退出：算新一轮故障（newRound），间隔回到 1s；不满 60s 的接着翻倍', async () => {
    const h = start();
    await settle();
    h.children[0].exit(3);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    h.children[1].ready();
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    h.children[1].exit(4);
    await settle();
    expect(h.exits.at(-1), '只跑了 59s').toEqual([expect.stringMatching(/2s 后重启$/), false]);

    await vi.advanceTimersByTimeAsync(2_000);
    h.children[2].ready();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    h.children[2].exit(4);
    await settle();
    expect(h.exits.at(-1), '稳定 60s').toEqual([expect.stringMatching(/1s 后重启$/), true]);
    expect(h.sc.state).toMatchObject({ kind: 'waiting', restarts: 1 });
  });

  it('被信号终止、拉起失败（wait 拒绝、spawn 抛错）都按意外退出重启', async () => {
    const h = start();
    await settle();
    h.children[0].exit(null, 'SIGSEGV');
    await settle();
    expect(h.exits.at(-1)?.[0]).toBe('侧车退出（被信号 SIGSEGV 终止），1s 后重启');
    await vi.advanceTimersByTimeAsync(1_000);
    h.children[1].fail(new Error('spawn ENOENT'));
    await settle();
    expect(h.exits.at(-1)?.[0]).toBe('拉起侧车失败（Error: spawn ENOENT），2s 后重启');

    const throwing = start({
      process: {
        ...fakeProcess().service,
        spawn: () => {
          throw new TypeError('bad cwd');
        },
      },
    });
    await settle();
    expect(throwing.exits).toEqual([['拉起侧车失败（TypeError: bad cwd），1s 后重启', true]]);
    await throwing.sc.stop();
  });

  it('拉起时没有 process 服务：按没能拉起处理、退避重试，服务回来后的下一次重试照常拉起', async () => {
    const h = start({ process: null });
    await settle();
    expect(h.exits).toEqual([['process 服务缺席，拉不起侧车，1s 后重启', true]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.exits.at(-1)).toEqual(['process 服务缺席，拉不起侧车，2s 后重启', false]);
    const later = fakeProcess();
    h.current.process = later.service;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(later.children).toHaveLength(1);
    expect(h.sc.state).toMatchObject({ kind: 'starting', restarts: 2 });
    const stopping = h.sc.stop();
    later.children[0].exit(null, 'SIGTERM');
    await stopping;
  });

  it('120s 内没有就绪：SIGKILL，按启动超时重启', async () => {
    const h = start();
    await settle();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.children[0].signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.children[0].signals).toEqual(['SIGKILL']);
    h.children[0].exit(null, 'SIGKILL');
    await settle();
    expect(h.exits).toEqual([['侧车退出（启动超时：120s 内没有就绪），1s 后重启', true]]);
  });

  it('就绪后不再有启动超时', async () => {
    const h = start();
    await settle();
    h.children[0].ready();
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.children[0].signals).toEqual([]);
    expect(h.sc.state.kind).toBe('ready');
  });
});

describe('托管侧车：停止', () => {
  it('先 SIGTERM，5s 内退出就不再 SIGKILL；等到退出才返回并记「已停掉」；之后不重启、不回调', async () => {
    const h = start();
    await settle();
    h.children[0].ready();
    await settle();
    let stopped = false;
    const stopping = h.sc.stop().then(() => {
      stopped = true;
    });
    expect(h.children[0].signals).toEqual(['SIGTERM']);
    expect(h.sc.state).toEqual({ kind: 'stopped' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(stopped).toBe(false);
    h.children[0].exit(null, 'SIGTERM');
    await stopping;
    expect(infos(h).at(-1)).toBe('[laya] 已停掉侧车');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.children[0].signals).toEqual(['SIGTERM']);
    expect(h.children).toHaveLength(1);
    expect(h.exits).toEqual([]);
    await h.sc.stop(); // 可重复调用
    expect(infos(h).filter(m => m === '[laya] 已停掉侧车')).toHaveLength(1);
  });

  it('SIGTERM 后 5s 还没退出：补 SIGKILL', async () => {
    const h = start();
    await settle();
    const stopping = h.sc.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    h.children[0].exit(null, 'SIGKILL');
    await stopping;
  });

  it('等重启期间停止：取消重启；探地址期间停止：不拉起；两者都没有子进程，不记「已停掉」', async () => {
    const waiting = start();
    await settle();
    waiting.children[0].exit(4);
    await settle();
    await waiting.sc.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting.children).toHaveLength(1);
    expect(infos(waiting)).not.toContain('[laya] 已停掉侧车');

    const probing = start();
    await probing.sc.stop();
    await settle();
    expect(probing.children).toHaveLength(0);
    expect(probing.sc.state).toEqual({ kind: 'stopped' });
    expect(infos(probing)).toEqual([]);
  });
});

describe('托管的目标', () => {
  it('侧车目录须为绝对路径；地址须为 http://127.0.0.1:<端口>（不带路径），端口取自地址', () => {
    expect(sidecarTarget(DIR, 'http://127.0.0.1:17878')).toEqual({ dir: DIR, port: 17878 });
    expect(sidecarTarget(DIR, 'http://127.0.0.1:17878/')).toEqual({ dir: DIR, port: 17878 });
    expect(sidecarTarget('models/listener-sidecar', 'http://127.0.0.1:17878')).toEqual({
      problem: 'sidecarDir 须为绝对路径（当前: models/listener-sidecar）',
    });
    for (const endpoint of [
      'http://localhost:17878',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:17878/prefix',
      'https://127.0.0.1:17878',
      'not a url',
    ]) {
      expect(sidecarTarget(DIR, endpoint), endpoint).toEqual({
        problem: `托管侧车时侧车地址须为 http://127.0.0.1:<端口>（不带路径），侧车只监听本机、端口取自这里（当前: ${endpoint}）`,
      });
    }
  });
});
