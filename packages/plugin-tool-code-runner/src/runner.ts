/**
 * 代码执行器 —— 编写临时脚本并运行
 *
 * 将代码写入临时文件后用对应解释器执行，避免 shell 转义问题。
 * 支持 Python / JavaScript (Node.js)。
 */

import { spawn } from 'node:child_process';
import { writeFile, unlink, rmdir, mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunnerConfig {
  defaultTimeout: number;
  maxTimeout: number;
  maxOutputSize: number;
  cwd: string;
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
  return truncated + `\n...[输出截断，超过 ${maxSize} 字节]`;
}

/**
 * 执行代码脚本
 *
 * @param interpreter 解释器路径 (python3 / node)
 * @param code        完整源代码
 * @param ext         临时文件扩展名 (.py / .mjs)
 * @param config      超时 / 输出限制
 * @param extraArgs   额外的解释器参数
 */
export async function runCode(
  interpreter: string,
  code: string,
  ext: string,
  config: RunnerConfig,
  timeout?: number,
  extraArgs: string[] = [],
): Promise<RunResult> {
  const effectiveTimeout = Math.min(
    Math.max(1000, timeout ?? config.defaultTimeout),
    config.maxTimeout,
  );

  // 创建临时目录 + 文件（统一放在 workspace/.tmp/code-runner/ 下）
  const baseDir = join(config.cwd, 'workspace', '.tmp', 'code-runner');
  await mkdir(baseDir, { recursive: true });
  const tmpDir = await mkdtemp(join(baseDir, 'run-'));
  const tmpFile = join(tmpDir, `script${ext}`);
  await writeFile(tmpFile, code, 'utf-8');

  try {
    return await new Promise<RunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = spawn(interpreter, [...extraArgs, tmpFile], {
        cwd: config.cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      }, effectiveTimeout);

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({
          exitCode: exitCode ?? -1,
          stdout: truncateOutput(stdout, config.maxOutputSize),
          stderr: truncateOutput(stderr, config.maxOutputSize),
          ...(killed ? { timedOut: true } : {}),
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          error: err.message,
          exitCode: -1,
          stdout: truncateOutput(stdout, config.maxOutputSize),
          stderr: truncateOutput(stderr, config.maxOutputSize),
        });
      });
    });
  } finally {
    // 清理临时文件和目录
    await unlink(tmpFile).catch(() => {});
    await rmdir(tmpDir).catch(() => {});
  }
}
