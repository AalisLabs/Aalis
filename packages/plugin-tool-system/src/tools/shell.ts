/**
 * Shell 工具 —— exec：在本机 shell 里执行命令并返回结果
 *
 * exec 声明可转后台（RegisteredTool.background）：在前台等满让出时限还没结束，执行器把它登记成后台任务、先回给模型，
 * 结束时通知起它的会话；查看输出、等待与停止都经执行器的后台任务工具。命令的输出边跑边写进执行器给的输出口
 * （ToolCallContext.output），停只认执行器给这次调用的中止信号（ToolCallContext.signal），不另设超时。
 */

import type { ProcessService, SpawnHandle } from '@aalis/api-process';
import type { StorageService } from '@aalis/api-storage';
import { resolveAgainstCwd } from '@aalis/api-storage';
import type { BoundTools } from '@aalis/api-tools';
import type { Logger } from '@aalis/core';

interface ShellConfig {
  logger: Logger;
  cwdUri: string;
  proc: ProcessService;
  storage?: StorageService;
  maxOutputSize: number;
}

function truncateOutput(output: string, maxSize: number): string {
  if (Buffer.byteLength(output, 'utf-8') <= maxSize) return output;
  const truncated = Buffer.from(output, 'utf-8').subarray(0, maxSize).toString('utf-8');
  return `${truncated}\n...[输出截断，超过 ${maxSize} 字节]`;
}

/** 把命令的 stdout 与 stderr 按到达顺序写进输出口。两路各自流式解码，多字节字符被拆在两次读取之间也不出乱码 */
function writeOutput(child: SpawnHandle, output: (text: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new TextDecoder();
    stream?.on('data', (chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text) output(text);
    });
  }
}

async function resolveCwd(config: ShellConfig, cwdArg: unknown): Promise<{ uri: string; localPath: string }> {
  if (!config.storage?.resolveLocalPath) {
    throw new Error('Shell 工具需要支持 local-path 能力的 storage 服务');
  }
  const uri = resolveAgainstCwd(typeof cwdArg === 'string' ? cwdArg : undefined, config.cwdUri);
  return { uri, localPath: await config.storage.resolveLocalPath(uri, 'read') };
}

export function registerShellTools(tools: BoundTools, config: ShellConfig): void {
  const logger = config.logger;
  const proc = config.proc;
  const isWin = process.platform === 'win32';
  const shellCmd = isWin ? 'cmd' : '/bin/sh';
  const shellFlag = isWin ? '/c' : '-c';

  const platformName = isWin ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const shellName = isWin ? 'cmd.exe' : 'sh (POSIX shell)';
  const syntaxHint = isWin
    ? '使用 Windows cmd 语法（如 dir, type, copy, del）。若需 PowerShell，请以 powershell -Command "..." 调用。'
    : '使用 POSIX shell 语法（如 ls, cat, cp, rm）。bash 特性可通过 bash -c "..." 显式调用。';

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'exec',
        description:
          `在本机 ${platformName} 系统的 ${shellName} 中执行命令并返回结果。${syntaxHint} ` +
          '适用于运行脚本、安装依赖、编译项目、git 操作、系统管理等。' +
          '命令在服务器本地执行，拥有当前进程的完整权限。' +
          '要跑很久的命令（构建、测试、开发服务器、文件监视）同样用它：到时没结束会转到后台。' +
          '命令按前台写法给出，不要再加 & 或 nohup：命令自己放到后台的子进程在 shell 退出后不受管理，停不掉，也没有结束通知。' +
          '长驻进程正常运行时不会结束，也就没有结束通知，是否就绪看它的输出。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令',
            },
            cwd: {
              type: 'string',
              description: `命令执行目录（可选）。使用 storage URI，如 workspace:/ 或 tmp:/build；相对路径基于本工具配置的工作目录 ${config.cwdUri} 解析（不受 cd 影响）。`,
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    // 任意 shell 命令是最强的 confused-deputy 向量 → owner 也要审批
    confirm: 'session',
    display: { kind: 'command', fields: { command: 'command', cwd: 'cwd' }, result: { exitCode: 'exitCode' } },
    background: {},
    handler: async (args, callCtx) => {
      const command = args.command as string;
      const cwd = await resolveCwd(config, args.cwd);

      logger.debug(`exec: ${command} (cwd: ${cwd.uri})`);

      // 不自起无上限累加器：直接用 process-local wait() 内部有 maxBuffer 上限的 result.stdout/stderr。
      // 自起 `stdout += chunk` 无上限——「超限只停累积不杀进程」语义下会无界增长 → OOM。
      try {
        // exec 继承宿主完整环境（含代理与密钥类变量）——owner 工具的既定取舍（2026-08-23 拍板，
        // 曾有的 env 白名单从未生效、已删）。需要环境隔离的执行走 code-sandbox-os（env -i 真清）。
        // 中止（前台时随回合，转后台之后随停止、撤回与停用）经 signal 由 process 服务按进程组停掉命令；已中止时 spawn 同步抛出。
        const child = proc.spawn(shellCmd, [shellFlag, command], { cwd: cwd.localPath, signal: callCtx.signal });
        // wait() 与输出转写在同一拍挂上监听，开头的输出两边都收得到
        const exited = child.wait();
        if (callCtx.output) writeOutput(child, callCtx.output);
        const result = await exited;
        const output = {
          exitCode: result.code ?? -1,
          stdout: truncateOutput(result.stdout, config.maxOutputSize),
          stderr: truncateOutput(result.stderr, config.maxOutputSize),
        };
        if (callCtx.signal?.aborted) {
          // 被信号结束的才说命令被中止。中止前已正常退出（含孙进程占着管道的收尾窗口）或 Windows 下强制结束
          // （signal 可能为 null）的按实际退出回报：这条结果随工具调用落库，下一轮看到「已中止」可能把已经生效的命令再跑一遍
          if (result.signal !== null) return JSON.stringify({ aborted: true, message: '命令已中止', ...output });
          return JSON.stringify({ ...output, note: '调用已中止' });
        }
        return JSON.stringify(output);
      } catch (err) {
        // spawn 失败与已中止时 spawn 同步抛出落这里（此时无输出可留）；中止运行中的命令不走此分支。
        if (callCtx.signal?.aborted) {
          return JSON.stringify({ aborted: true, message: '命令已中止', exitCode: -1 });
        }
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          exitCode: -1,
        });
      }
    },
  });
}
