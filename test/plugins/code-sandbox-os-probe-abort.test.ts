import { afterEach, describe, expect, it } from 'vitest';
import type { CodeSandboxService } from '../../packages/api-code-sandbox/src/index.js';
import {
  type ExecResult,
  type ProcessService,
  processService,
  type SpawnHandle,
  type SpawnOptions,
} from '../../packages/api-process/src/index.js';
import { App, type LifecycleCap, type Logger, type Provide, provide } from '../../packages/core/src/index.js';
import codeSandboxOs from '../../packages/plugin-code-sandbox-os/src/index.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// code-sandbox-os 的启动探测接 lifecycle.signal：启动器挂住时，停用与停机随 abort 落定，不拖满停机宽限、
// 也不被判「未在宽限内停止」。被中止时一律抛出，不落成「没有沙箱后端」的 warn。
//
// process 服务用替身，只实现探测用到的 spawn；句柄的 wait 按用例给的行为落定。探测命令按平台分支，
// 替身不起真实进程，停用与失败的用例在有探测分支的平台（macOS、Linux）上跑，后端选择的用例改写 process.platform 两个都测。
// ════════════════════════════════════════════════════════════

/** 本机平台有探测分支；其余平台直接按无后端，不起探测进程 */
const probes = process.platform === 'darwin' || process.platform === 'linux';

const GRACE_MS = 200;

const EXITED: ExecResult = { code: 0, signal: null, stdout: '', stderr: '' };

type Behaviour = {
  /** spawn 收到调用时执行，可同步抛错 */
  spawn?: (opts: SpawnOptions) => void;
  wait: (opts: SpawnOptions) => Promise<ExecResult>;
};

/** 替身 process 服务：记下每次 spawn 的命令、参数与选项 */
function fakeProcess(behaviour: Behaviour) {
  const calls: Array<{ cmd: string; args: readonly string[]; opts: SpawnOptions }> = [];
  const service = {
    spawn(cmd: string, args: readonly string[], opts: SpawnOptions = {}): SpawnHandle {
      calls.push({ cmd, args, opts });
      behaviour.spawn?.(opts);
      return {
        pid: undefined,
        stdin: null,
        stdout: null,
        stderr: null,
        wait: () => behaviour.wait(opts),
        kill: () => false,
        unref: () => {},
      };
    },
  } as unknown as ProcessService;
  return { service, calls };
}

/** wait 一直挂着，只在 opts.signal 中止时以 SIGTERM 落定（没传 signal 就永不落定） */
const hangUntilAbort = (opts: SpawnOptions): Promise<ExecResult> =>
  new Promise(resolve => {
    opts.signal?.addEventListener('abort', () => resolve({ ...EXITED, code: null, signal: 'SIGTERM' }), {
      once: true,
    });
  });

function recorder() {
  const lines: Array<{ level: string; text: string }> = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push({ level, text: args.map(String).join(' ') });
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, lines };
}

async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

/** 直接调插件的 apply：lifecycle 的 signal 由用例给，返回在飞的 apply、日志与提供的服务 */
function applyWith(proc: ProcessService, signal: AbortSignal) {
  const { logger, lines } = recorder();
  let provided: CodeSandboxService | undefined;
  const provideStub = ((_descriptor: unknown, implementation: CodeSandboxService) => {
    provided = implementation;
    return () => {};
  }) as unknown as Provide;
  const lifecycle: LifecycleCap = {
    id: codeSandboxOs.name,
    signal,
    onDrain: () => () => {},
    onDispose: () => () => {},
  };
  const applying = Promise.resolve(
    codeSandboxOs.apply({
      processService: ref([{ instance: proc, contextId: 'zz-slice1', priority: 0 }]),
      logger,
      provide: provideStub,
      lifecycle,
    }),
  );
  return { applying, lines, provided: () => provided };
}

/** 在改写过的 process.platform 下执行，结束后还原 */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

describe('code-sandbox-os 探测随 lifecycle.signal 中止', () => {
  it.skipIf(!probes)(
    '安全：启动器挂住时停用，探测随 abort 落定：条目转 disabled，不记「未在宽限内停止」，停用在 1 秒内返回',
    async () => {
      const { service, calls } = fakeProcess({ wait: hangUntilAbort });
      const { logger, lines } = recorder();
      const app = new App({ name: 'T', logger, disposeTimeoutMs: GRACE_MS });
      apps.push(app);
      app.bind({ provide }).provide(processService, service);
      const registering = app.plugin(codeSandboxOs);
      await until(() => calls.length === 1, '探测起进程');

      const started = Date.now();
      expect(await app.plugins.disable(codeSandboxOs.name)).toBe(true);
      const elapsed = Date.now() - started;
      await registering;
      await app.plugins.idle();

      // 没有 error（未在宽限内停止），也没有 warn（被中止不落成「没有沙箱后端」）
      expect(lines).toEqual([]);
      expect(app.plugins.getPlugin(codeSandboxOs.name)?.state).toBe('disabled');
      expect(elapsed, '停用应在 1 秒内返回').toBeLessThan(1000);
      expect(calls[0].opts.signal?.aborted, '探测进程收到的是这次激活的 signal').toBe(true);
    },
  );

  it.skipIf(!probes).each([
    [
      'wait 在中止时被拒',
      (ac: AbortController): Behaviour => ({
        wait: opts =>
          new Promise((_, reject) => {
            opts.signal?.addEventListener('abort', () => reject(new Error('zz-slice1 替身：进程随中止出错')), {
              once: true,
            });
            queueMicrotask(() => ac.abort());
          }),
      }),
    ],
    [
      'spawn 时已中止、同步抛出',
      (ac: AbortController): Behaviour => {
        ac.abort();
        return { spawn: opts => opts.signal?.throwIfAborted(), wait: async () => EXITED };
      },
    ],
  ] as const)('安全：%s：探测抛出这次中止，不记「没有沙箱后端」的 warn', async (_case, behaviour) => {
    const ac = new AbortController();
    const { service, calls } = fakeProcess(behaviour(ac));
    const { applying, lines, provided } = applyWith(service, ac.signal);

    const outcome = await applying.then(
      () => '探测没有抛出',
      (err: unknown) => err,
    );
    expect(ac.signal.aborted).toBe(true);
    expect(outcome).toBe(ac.signal.reason);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
    expect(provided()).toBeUndefined();
  });
});

describe('code-sandbox-os 探测失败与后端选择', () => {
  it.skipIf(!probes).each([
    ['退出码非 0', { wait: async () => ({ ...EXITED, code: 1 }) }],
    [
      'spawn 同步抛错',
      {
        spawn: () => {
          throw new Error('zz-slice1 替身：spawn 失败');
        },
        wait: async () => EXITED,
      },
    ],
    [
      'wait 被拒（启动器不存在）',
      { wait: () => Promise.reject(Object.assign(new Error('zz-slice1 替身：ENOENT'), { code: 'ENOENT' })) },
    ],
  ] as Array<[string, Behaviour]>)('%s（未中止）：后端为 none，记一条 warn', async (_case, behaviour) => {
    const { service, calls } = fakeProcess(behaviour);
    const { applying, lines, provided } = applyWith(service, new AbortController().signal);
    await applying;

    expect(calls).toHaveLength(1);
    expect(provided()?.backend).toBe('none');
    expect(provided()?.available).toBe(false);
    expect(lines.map(line => line.level)).toEqual(['warn']);
  });

  it.each([
    ['darwin', 'seatbelt', 'sandbox-exec'],
    ['linux', 'bwrap', 'bwrap'],
  ] as const)('%s 上探测退出码为 0：后端为 %s，探测命令 %s 带 ignore、5 秒超时与这次激活的 signal', async (platform, backend, cmd) => {
    const { service, calls } = fakeProcess({ wait: async () => EXITED });
    const signal = new AbortController().signal;
    const { lines, provided } = await onPlatform(platform, async () => {
      const run = applyWith(service, signal);
      await run.applying;
      return run;
    });

    expect(provided()?.backend).toBe(backend);
    expect(lines).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(cmd);
    expect(calls[0].opts).toMatchObject({ stdio: 'ignore', timeout: 5000 });
    expect(calls[0].opts.signal).toBe(signal);
  });
});
