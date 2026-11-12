import { describe, expect, it } from 'vitest';
import type { CodeSandboxService } from '../../packages/api-code-sandbox/src/index.js';
import type { ExecResult, ProcessService, SpawnOptions } from '../../packages/api-process/src/index.js';
import type { LifecycleCap, Logger, Provide } from '../../packages/core/src/index.js';
import codeSandboxOs from '../../packages/plugin-code-sandbox-os/src/index.js';
import { absentDoctor, fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 沙箱里跑的命令接调用方的中止信号（SandboxRunRequest.signal）与本插件这次激活的：调用方没中止、code-sandbox-os 停用或重启
// 时，包好的启动器命令同样由 process 服务停掉，run 与调用方中止时一样按被信号结束拒绝、错误对象带上已有的输出（.result）。
// process 服务是替身：探测立即以 0 退出，execFile 记下收到的中止信号、在它断开时按被 SIGTERM 结束拒绝（与 process 服务停掉
// 进程组后一样）；不启动真实子进程。平台固定为 macOS（探测命令是 sandbox-exec）。
// ════════════════════════════════════════════════════════════

const EXITED: ExecResult = { code: 0, signal: null, stdout: '', stderr: '' };

async function onDarwin<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: 'darwin' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('code-sandbox-os 的 run 随中止停下', () => {
  it('调用方没中止、本插件停用：交给 execFile 的中止信号随之断开，run 按被信号结束拒绝、带上输出', async () => {
    const runs: Array<AbortSignal | undefined> = [];
    const proc = {
      spawn: (_cmd: string, _args: readonly string[], _opts: SpawnOptions) => ({ wait: async () => EXITED }),
      execFile: (_cmd: string, _args: readonly string[], opts: SpawnOptions = {}) => {
        runs.push(opts.signal);
        return new Promise<never>((_, reject) =>
          opts.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('killed'), { result: { ...EXITED, code: null, signal: 'SIGTERM' } })),
            { once: true },
          ),
        );
      },
    } as unknown as ProcessService;
    const activation = new AbortController();
    let provided: CodeSandboxService | undefined;
    let running: Promise<ExecResult> | undefined;
    const provide = ((_descriptor: unknown, implementation: CodeSandboxService) => {
      provided = implementation;
      return () => {};
    }) as unknown as Provide;
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger } as unknown as Logger;
    const lifecycle: LifecycleCap = {
      id: codeSandboxOs.name,
      signal: activation.signal,
      onReady: () => () => {},
      onDrain: () => () => {},
      onDispose: () => () => {},
    };
    await onDarwin(async () => {
      await codeSandboxOs.apply({
        processService: ref([{ instance: proc, contextId: 'zz-proc', priority: 0 }]),
        doctor: absentDoctor(),
        logger: fixedRef(logger),
        provide: fixedRef(provide),
        lifecycle: fixedRef(lifecycle),
      });
      if (!provided?.available) throw new Error('沙箱后端没有就绪');
      running = provided.run({
        cmd: 'python3',
        args: ['/zz/script.py'],
        policy: { fsRead: [], fsWrite: [], network: 'deny' },
        signal: new AbortController().signal,
      });
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.aborted).toBe(false);
    activation.abort();
    expect(runs[0]?.aborted).toBe(true);
    await expect(running).rejects.toMatchObject({ result: { signal: 'SIGTERM' } });
  });
});
