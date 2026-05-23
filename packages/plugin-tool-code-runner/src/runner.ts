/**
 * 代码执行器 —— 编写临时脚本并运行
 *
 * 临时目录通过 ProcessService.makeTempDir 在 storage tmp:/ 下分配，
 * 子进程通过 ProcessService.spawn 启动；不直接依赖 node:fs/child_process。
 */

import { Buffer } from 'node:buffer';
import type { ProcessService } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';

export interface RunnerConfig {
  defaultTimeout: number;
  maxTimeout: number;
  maxOutputSize: number;
  /** 子进程 cwd（已通过 storage.resolveLocalPath 解析的本地路径） */
  cwd: string;
  /** 透传给子进程的环境变量；不提供时由 ProcessService 默认合入 process.env */
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
}

function truncateOutput(output: string, maxSize: number): string {
  if (Buffer.byteLength(output, 'utf-8') <= maxSize) return output;
  const truncated = Buffer.from(output, 'utf-8').subarray(0, maxSize).toString('utf-8');
  return `${truncated}\n...[输出截断，超过 ${maxSize} 字节]`;
}

/**
 * 执行代码脚本
 *
 * @param proc        ProcessService 句柄
 * @param storage     StorageService（用于写脚本到 tmp）
 * @param interpreter 解释器路径 (python3 / node)
 * @param code        完整源代码
 * @param ext         临时文件扩展名 (.py / .mjs)
 * @param config      超时 / 输出限制
 * @param timeout     可选自定义超时
 * @param extraArgs   额外的解释器参数
 */
export async function runCode(
  proc: ProcessService,
  storage: StorageService,
  interpreter: string,
  code: string,
  ext: string,
  config: RunnerConfig,
  timeout?: number,
  extraArgs: string[] = [],
): Promise<RunResult> {
  const effectiveTimeout = Math.min(Math.max(1000, timeout ?? config.defaultTimeout), config.maxTimeout);
  const tmp = await proc.makeTempDir('code-runner');
  try {
    const scriptUri = `${tmp.uri}/script${ext}`;
    await storage.writeFile(scriptUri, Buffer.from(code, 'utf-8'));
    const scriptPath = `${tmp.path}/script${ext}`;

    try {
      const result = await proc.execFile(interpreter, [...extraArgs, scriptPath], {
        cwd: config.cwd,
        env: { ...(config.env ?? {}), PYTHONIOENCODING: 'utf-8' },
        timeout: effectiveTimeout,
      });
      return {
        exitCode: result.code ?? -1,
        stdout: truncateOutput(result.stdout, config.maxOutputSize),
        stderr: truncateOutput(result.stderr, config.maxOutputSize),
      };
    } catch (err) {
      // ProcessService.execFile 在非 0 退出时抛错，但会把 .result 挂上
      const e = err as Error & {
        result?: { code: number | null; signal: string | null; stdout: string; stderr: string };
      };
      if (e.result) {
        const timedOut = e.result.signal === 'SIGKILL';
        return {
          exitCode: e.result.code ?? -1,
          stdout: truncateOutput(e.result.stdout, config.maxOutputSize),
          stderr: truncateOutput(e.result.stderr, config.maxOutputSize),
          ...(timedOut ? { timedOut: true } : {}),
        };
      }
      return {
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: e.message,
      };
    }
  } finally {
    await tmp.cleanup();
  }
}
