/**
 * Shell 工具组 —— 命令行执行与进程管理
 *
 * 提供以下能力：
 * - exec: 执行 shell 命令并返回结果
 * - exec_background: 在后台启动长时间运行的进程
 * - process_list: 列出当前管理的后台进程
 * - process_read: 读取后台进程输出
 * - process_kill: 终止后台进程
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Context } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { toStorageUri } from '@aalis/plugin-tools-api';

interface ShellConfig {
  ctx: Context;
  cwdUri: string;
  storage?: StorageService;
  defaultTimeout: number;
  maxTimeout: number;
  maxOutputSize: number;
}

interface ManagedProcess {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  done: boolean;
}

// 每个 session 维护独立的后台进程列表
const backgroundProcesses = new Map<string, Map<string, ManagedProcess>>();

let processIdCounter = 0;

/** 每个 session 最多保留多少条已完成进程记录 */
const MAX_DONE_PROCESSES_PER_SESSION = 20;

function getSessionProcesses(sessionId: string): Map<string, ManagedProcess> {
  let map = backgroundProcesses.get(sessionId);
  if (!map) {
    map = new Map();
    backgroundProcesses.set(sessionId, map);
  }
  return map;
}

/** 清理 session 中已完成的旧进程，防止长时间运行后内存无限增长 */
function pruneDoneProcesses(processes: Map<string, ManagedProcess>): void {
  const done = [...processes.entries()].filter(([, p]) => p.done);
  if (done.length <= MAX_DONE_PROCESSES_PER_SESSION) return;
  // 按启动时间升序，删除最旧的超出部分
  done.sort(([, a], [, b]) => a.startedAt - b.startedAt);
  const toRemove = done.slice(0, done.length - MAX_DONE_PROCESSES_PER_SESSION);
  for (const [id] of toRemove) processes.delete(id);
}

function truncateOutput(output: string, maxSize: number): string {
  if (Buffer.byteLength(output, 'utf-8') <= maxSize) return output;
  const truncated = Buffer.from(output, 'utf-8').subarray(0, maxSize).toString('utf-8');
  return `${truncated}\n...[输出截断，超过 ${maxSize} 字节]`;
}

async function resolveCwd(config: ShellConfig, cwdArg: unknown): Promise<{ uri: string; localPath: string }> {
  if (!config.storage?.resolveLocalPath) {
    throw new Error('Shell 工具需要支持 local-path 能力的 storage 服务');
  }
  const uri = toStorageUri(typeof cwdArg === 'string' ? cwdArg : undefined, {
    fallback: config.cwdUri,
    errorContext: 'cwd',
  });
  return { uri, localPath: await config.storage.resolveLocalPath(uri, 'read') };
}

function safeEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function registerShellTools(tools: ScopedToolService, config: ShellConfig): void {
  const ctx = config.ctx;
  const isWin = platform() === 'win32';
  const shellCmd = isWin ? 'cmd' : '/bin/sh';
  const shellFlag = isWin ? '/c' : '-c';

  const platformName = isWin ? 'Windows' : platform() === 'darwin' ? 'macOS' : 'Linux';
  const shellName = isWin ? 'cmd.exe' : 'sh (POSIX shell)';
  const syntaxHint = isWin
    ? '使用 Windows cmd 语法（如 dir, type, copy, del）。若需 PowerShell，请以 powershell -Command "..." 调用。'
    : '使用 POSIX shell 语法（如 ls, cat, cp, rm）。bash 特性可通过 bash -c "..." 显式调用。';

  // ==================== exec ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'exec',
        description:
          `在本机 ${platformName} 系统的 ${shellName} 中执行命令并返回结果。${syntaxHint} ` +
          '适用于运行脚本、安装依赖、编译项目、git 操作、系统管理等。' +
          '命令在服务器本地执行，拥有当前进程的完整权限。' +
          '对于需要长时间运行的命令（如服务器、构建监视），请使用 exec_background。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令',
            },
            cwd: {
              type: 'string',
              description:
                '命令执行目录（可选）。使用 storage URI，如 workspace:/ 或 tmp:/build；相对路径会解释为 workspace:/ 下路径。',
            },
            timeout: {
              type: 'number',
              description: `命令超时毫秒数（可选，默认 ${config.defaultTimeout}，最大 ${config.maxTimeout}）`,
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    authority: 5,
    safety: 'dangerous',
    permissions: ['tool:shell.exec', 'system:process.exec'],
    handler: async (args, _callCtx) => {
      const command = args.command as string;
      const cwd = await resolveCwd(config, args.cwd);
      const timeout = Math.min(Math.max(1000, (args.timeout as number) || config.defaultTimeout), config.maxTimeout);

      ctx.logger.debug(`exec: ${command} (cwd: ${cwd.uri}, timeout: ${timeout}ms)`);

      return new Promise<string>(resolve => {
        let stdout = '';
        let stderr = '';
        let killed = false;

        const child = spawn(shellCmd, [shellFlag, command], {
          cwd: cwd.localPath,
          env: safeEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout,
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
        }, timeout);

        child.on('close', code => {
          clearTimeout(timer);
          const result = {
            exitCode: code ?? -1,
            stdout: truncateOutput(stdout, config.maxOutputSize),
            stderr: truncateOutput(stderr, config.maxOutputSize),
            ...(killed ? { timedOut: true } : {}),
          };
          resolve(JSON.stringify(result));
        });

        child.on('error', err => {
          clearTimeout(timer);
          resolve(
            JSON.stringify({
              error: err.message,
              exitCode: -1,
              stdout: truncateOutput(stdout, config.maxOutputSize),
              stderr: truncateOutput(stderr, config.maxOutputSize),
            }),
          );
        });
      });
    },
  });

  // ==================== exec_background ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'exec_background',
        description:
          `在本机 ${platformName} 系统的 ${shellName} 中后台启动一个长时间运行的进程（如开发服务器、文件监视器）。${syntaxHint} ` +
          '返回进程 ID，可通过 process_read 读取输出，通过 process_kill 终止进程。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要在后台执行的 shell 命令',
            },
            cwd: {
              type: 'string',
              description:
                '命令执行目录（可选）。使用 storage URI，如 workspace:/ 或 tmp:/build；相对路径会解释为 workspace:/ 下路径。',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    authority: 5,
    safety: 'dangerous',
    permissions: ['tool:shell.exec_background', 'system:process.exec', 'system:process.background'],
    handler: async (args, callCtx) => {
      const command = args.command as string;
      const cwd = await resolveCwd(config, args.cwd);
      const id = `proc_${++processIdCounter}`;
      const processes = getSessionProcesses(callCtx.sessionId);

      const child = spawn(shellCmd, [shellFlag, command], {
        cwd: cwd.localPath,
        env: safeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      const managed: ManagedProcess = {
        id,
        command,
        pid: child.pid!,
        startedAt: Date.now(),
        process: child,
        stdout: '',
        stderr: '',
        exitCode: null,
        done: false,
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        managed.stdout += chunk.toString();
        // 保持缓冲区在合理范围
        if (managed.stdout.length > config.maxOutputSize * 2) {
          managed.stdout = managed.stdout.slice(-config.maxOutputSize);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        managed.stderr += chunk.toString();
        if (managed.stderr.length > config.maxOutputSize * 2) {
          managed.stderr = managed.stderr.slice(-config.maxOutputSize);
        }
      });

      child.on('close', code => {
        managed.exitCode = code;
        managed.done = true;
      });

      child.on('error', err => {
        managed.stderr += `\n[进程错误] ${err.message}`;
        managed.done = true;
        managed.exitCode = -1;
      });

      processes.set(id, managed);
      ctx.logger.debug(`exec_background: ${command} -> ${id} (pid: ${child.pid})`);

      return JSON.stringify({
        processId: id,
        pid: child.pid,
        command,
        message: `后台进程已启动。使用 process_read 读取输出，process_kill 终止进程。`,
      });
    },
  });

  // ==================== process_list ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'process_list',
        description: '列出当前会话中所有受管理的后台进程及其状态。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    authority: 5,
    safety: 'dangerous',
    permissions: ['tool:process.list', 'system:process.read'],
    handler: async (_args, callCtx) => {
      const processes = getSessionProcesses(callCtx.sessionId);
      pruneDoneProcesses(processes);
      const list = [...processes.values()].map(p => ({
        processId: p.id,
        pid: p.pid,
        command: p.command,
        running: !p.done,
        exitCode: p.exitCode,
        startedAt: new Date(p.startedAt).toISOString(),
        uptime: p.done ? undefined : `${Math.round((Date.now() - p.startedAt) / 1000)}s`,
      }));
      return JSON.stringify({ processes: list, total: list.length });
    },
  });

  // ==================== process_read ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'process_read',
        description: '读取一个后台进程的最新输出（stdout 和 stderr）。',
        parameters: {
          type: 'object',
          properties: {
            processId: {
              type: 'string',
              description: '进程 ID（由 exec_background 返回）',
            },
            tail: {
              type: 'number',
              description: '仅返回最后 N 个字符的输出（可选，默认返回全部缓存）',
            },
          },
          required: ['processId'],
          additionalProperties: false,
        },
      },
    },
    authority: 5,
    safety: 'dangerous',
    permissions: ['tool:process.read', 'system:process.read'],
    handler: async (args, callCtx) => {
      const processId = args.processId as string;
      const tail = args.tail as number | undefined;
      const processes = getSessionProcesses(callCtx.sessionId);
      const managed = processes.get(processId);

      if (!managed) {
        return JSON.stringify({ error: `进程 "${processId}" 不存在` });
      }

      let stdout = managed.stdout;
      let stderr = managed.stderr;
      if (tail && tail > 0) {
        stdout = stdout.slice(-tail);
        stderr = stderr.slice(-tail);
      }

      return JSON.stringify({
        processId,
        running: !managed.done,
        exitCode: managed.exitCode,
        stdout: truncateOutput(stdout, config.maxOutputSize),
        stderr: truncateOutput(stderr, config.maxOutputSize),
      });
    },
  });

  // ==================== process_kill ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'process_kill',
        description: '终止一个后台进程。',
        parameters: {
          type: 'object',
          properties: {
            processId: {
              type: 'string',
              description: '进程 ID（由 exec_background 返回）',
            },
            signal: {
              type: 'string',
              description: '信号类型（可选，默认 SIGTERM，可用 SIGKILL 强制终止）',
            },
          },
          required: ['processId'],
          additionalProperties: false,
        },
      },
    },
    authority: 5,
    safety: 'dangerous',
    permissions: ['tool:process.kill', 'system:process.kill'],
    handler: async (args, callCtx) => {
      const processId = args.processId as string;
      const signal = (args.signal as string) || 'SIGTERM';
      const processes = getSessionProcesses(callCtx.sessionId);
      const managed = processes.get(processId);

      if (!managed) {
        return JSON.stringify({ error: `进程 "${processId}" 不存在` });
      }

      if (managed.done) {
        return JSON.stringify({
          processId,
          message: `进程已结束 (退出码: ${managed.exitCode})`,
          alreadyDone: true,
        });
      }

      try {
        managed.process.kill(signal as NodeJS.Signals);
        return JSON.stringify({
          processId,
          message: `已发送 ${signal} 信号到进程 (pid: ${managed.pid})`,
        });
      } catch (err) {
        return JSON.stringify({
          error: `无法终止进程: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  });

  // 清理：插件卸载时终止所有后台进程
  ctx.onDispose(async () => {
    for (const [, processes] of backgroundProcesses) {
      for (const [, managed] of processes) {
        if (!managed.done) {
          try {
            managed.process.kill('SIGTERM');
          } catch {}
        }
      }
    }
    backgroundProcesses.clear();
  });
}
