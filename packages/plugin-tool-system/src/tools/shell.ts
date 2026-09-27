/**
 * Shell 工具组 —— 命令行执行与进程管理
 *
 * 提供以下能力：
 * - exec: 执行 shell 命令并返回结果
 * - exec_background: 在后台启动长时间运行的进程；对话回合里起的进程自行退出时，向起它的会话注入一条宿主通知
 * - process_list: 列出当前管理的后台进程
 * - process_read: 读取后台进程输出
 * - process_kill: 终止后台进程（不确认，只能终止自己起的，owner 除外）
 */

import type { ExecResult, ProcessService } from '@aalis/api-process';
import type {} from '@aalis/api-session-manager'; // declaration merging：session:deleted 事件
import type { StorageService } from '@aalis/api-storage';
import { resolveAgainstCwd } from '@aalis/api-storage';
import type { BoundTools, ToolCallContext } from '@aalis/api-tools';
import type { Events, LifecycleCap, Logger } from '@aalis/core';
import { type IncomingMessage, selfInitiatedActor } from '@aalis/schema-message';

/** 授权身份（同 ToolCallContext.actor） */
interface Identity {
  platform: string;
  userId: string;
}

interface ShellConfig {
  logger: Logger;
  /** 这次激活：signal 随停用、bounce 按中止契约收掉后台进程，也挡住此后的结束通知 */
  lifecycle: LifecycleCap;
  /** 注入结束通知，收听会话删除与停机 */
  events: Events;
  /** process_kill 放行 owner 终止别人起的进程；没有 authority 服务时恒为 false，只认同一身份 */
  isOwner: (identity: Identity) => boolean;
  cwdUri: string;
  proc: ProcessService;
  storage?: StorageService;
  defaultTimeout: number;
  maxTimeout: number;
  maxOutputSize: number;
}

/** 结束时把通知送回哪里、按谁的身份：起进程那次工具调用上下文的快照 */
interface ExitNoticeTarget {
  sessionId: string;
  platform: string;
  actor: Identity;
  callerUserId?: string;
}

interface ManagedProcess {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  done: boolean;
  /** wait() 落定（成功与出错都算）：process_kill 等它确认进程已停 */
  settled: Promise<void>;
  /** 起进程那次调用的有效授权身份：process_kill 只放行同一身份与 owner */
  starter: Identity;
  /** 终止这个进程（process_kill、会话删除）；停用插件经 lifecycle.signal 走同一条中止路径 */
  stop: AbortController;
  /** undefined 为结束时不通知：不在对话回合里起的、由结束通知开的回合里起的、已被终止的、会话已删除的 */
  notice?: ExitNoticeTarget;
}

// 每个 session 维护独立的后台进程列表
const backgroundProcesses = new Map<string, Map<string, ManagedProcess>>();

let processIdCounter = 0;
/** 本次启动的标识：进程 id 带上它，Aalis 重启后不会与历史里的旧 id 撞号 */
const RUN_TAG = Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString('hex');

const EXIT_NOTICE_KIND = 'exec-background';
const EXIT_NOTICE_SOURCE_PREFIX = 'exec-bg:';
/** process_kill 等进程落定的上限：中止契约在宽限后整组强制结束（process-local 为 2000ms），再留 1000ms 收尾 */
const KILL_WAIT_MS = 3000;

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

/** 调用的有效授权身份，与 authority 守卫同一口径 */
function identityOf(ctx: ToolCallContext): Identity {
  return ctx.actor ?? { platform: ctx.platform ?? '', userId: ctx.userId ?? '' };
}

/**
 * 结束通知的目标。只有 agent 回合里的调用（带 inbound、有 platform）才有可回的对话；由结束通知开的回合里起的进程
 * 不再通知，链只延续一层。身份跟链源头：platform、actor 与 callerUserId 都取这次调用，通知回合的权限不高于它。
 */
function exitNoticeTarget(ctx: ToolCallContext): ExitNoticeTarget | undefined {
  const { inbound, platform, userId } = ctx;
  if (!inbound || !platform || inbound.source?.startsWith(EXIT_NOTICE_SOURCE_PREFIX)) return undefined;
  return {
    sessionId: ctx.sessionId,
    platform,
    actor: ctx.actor ?? (userId !== undefined ? { platform, userId } : selfInitiatedActor(platform)),
    ...(userId !== undefined ? { callerUserId: userId } : {}),
  };
}

/** 用时：不到 1 秒、N 秒、M 分 S 秒、H 小时 M 分 */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return '不到 1 秒';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

/**
 * 结束通知只放宿主取得的事实：进程 id、结局、用时。命令由模型写出（可能受过注入），输出受外部内容左右，
 * 都不进通知（通知以 system 呈现且会归档）；输出由模型用 process_read 取，以 tool 角色进上下文。
 * result 为 undefined 表示 wait() 出错落定。
 */
function composeExitNotice(
  p: ManagedProcess,
  target: ExitNoticeTarget,
  result: ExecResult | undefined,
  endedAt: number,
): IncomingMessage {
  const took = `用时 ${formatDuration(endedAt - p.startedAt)}`;
  const ending = !result
    ? `出错结束，${took}`
    : result.signal
      ? `被信号 ${result.signal} 结束，${took}`
      : `已退出：退出码 ${result.code ?? '未知'}，${took}`;
  return {
    content: `后台进程 ${p.id} ${ending}。它最近的输出用 process_read 查看。`,
    sessionId: target.sessionId,
    platform: target.platform,
    source: `${EXIT_NOTICE_SOURCE_PREFIX}${p.id}`,
    actor: target.actor,
    hostNotice: {
      kind: EXIT_NOTICE_KIND,
      id: p.id,
      ...(target.callerUserId !== undefined ? { callerUserId: target.callerUserId } : {}),
    },
  };
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
              description: `命令执行目录（可选）。使用 storage URI，如 workspace:/ 或 tmp:/build；相对路径基于本工具配置的工作目录 ${config.cwdUri} 解析（不受 cd 影响）。`,
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
    visibility: 'restricted',
    // 任意 shell 命令是最强的 confused-deputy 向量 → owner 也需确认（本会话记住）
    confirm: 'session',
    handler: async (args, callCtx) => {
      const command = args.command as string;
      const cwd = await resolveCwd(config, args.cwd);
      const timeout = Math.min(Math.max(1000, (args.timeout as number) || config.defaultTimeout), config.maxTimeout);

      logger.debug(`exec: ${command} (cwd: ${cwd.uri}, timeout: ${timeout}ms)`);

      // 不自起无上限累加器：直接用 process-local wait() 内部有 maxBuffer 上限的 result.stdout/stderr。
      // 自起 `stdout += chunk` 无上限——「超限只停累积不杀进程」语义下会无界增长 → OOM。
      // 超时是 wait() 正常返回(带 SIGKILL 信号)、非抛错，故 result 在超时路径仍可用、带(已截断的)部分输出。
      try {
        // exec 继承宿主完整环境（含代理与密钥类变量）——owner 工具的既定取舍（2026-08-23 拍板，
        // 曾有的 env 白名单从未生效、已删）。需要环境隔离的执行走 code-sandbox-os（env -i 真清）。
        // 回合中止（停止键等）经 signal 由 process 服务按进程组停掉命令；回合已中止时 spawn 同步抛出。
        const child = proc.spawn(shellCmd, [shellFlag, command], {
          cwd: cwd.localPath,
          timeout,
          signal: callCtx.signal,
        });
        const result = await child.wait();
        const output = {
          exitCode: result.code ?? -1,
          stdout: truncateOutput(result.stdout, config.maxOutputSize),
          stderr: truncateOutput(result.stderr, config.maxOutputSize),
        };
        if (callCtx.signal?.aborted) {
          // 被信号结束的才说命令被中止。中止前已正常退出（含孙进程占着管道的收尾窗口）或 Windows 下强制结束
          // （signal 可能为 null）的按实际退出回报：这条结果随工具调用落库，下一轮看到「已中止」可能把已经生效的命令再跑一遍
          if (result.signal !== null) return JSON.stringify({ aborted: true, message: '命令已随回合中止', ...output });
          return JSON.stringify({ ...output, note: '回合已中止' });
        }
        const timedOut = result.signal === 'SIGKILL' || result.signal === 'SIGTERM';
        return JSON.stringify({ ...output, ...(timedOut ? { timedOut: true } : {}) });
      } catch (err) {
        // spawn 失败与回合已中止时 spawn 同步抛出落这里（此时无输出可留）；超时与中止运行中的命令不走此分支。
        if (callCtx.signal?.aborted) {
          return JSON.stringify({ aborted: true, message: '命令已随回合中止', exitCode: -1 });
        }
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          exitCode: -1,
        });
      }
    },
  });

  // 本次激活收到 app:stopping 之后不再通知：process-local 在那一刻整组 SIGKILL，早于本插件的 lifecycle.signal
  let stopping = false;
  config.events.on('app:stopping', () => {
    stopping = true;
  });

  // 会话删除即终止它的后台进程、删掉整个桶：删除之后没有会话能管这些进程，重建的房间也不该看到删除之前的输出
  config.events.on('session:deleted', sessionId => {
    const processes = backgroundProcesses.get(sessionId);
    if (!processes) return;
    backgroundProcesses.delete(sessionId);
    let running = 0;
    for (const p of processes.values()) {
      p.notice = undefined;
      if (!p.done) {
        p.stop.abort();
        running++;
      }
    }
    if (running > 0) logger.info(`会话 ${sessionId} 已删除，终止它的 ${running} 个后台进程`);
  });

  /** 进程落定：标为已结束；该通知的注入一条宿主通知（至多一次，不重试） */
  const settle = (p: ManagedProcess, result: ExecResult | undefined): void => {
    p.done = true;
    const target = p.notice;
    p.notice = undefined;
    if (!target || config.lifecycle.signal.aborted || stopping) return;
    logger.info(`后台进程 ${p.id} 已结束，结束通知注入会话 ${target.sessionId}`);
    config.events.emit('inbound:message', composeExitNotice(p, target, result, Date.now())).catch(err => {
      logger.warn(`后台进程 ${p.id} 的结束通知注入失败，不重试: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // ==================== exec_background ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'exec_background',
        description:
          `在本机 ${platformName} 系统的 ${shellName} 中后台启动一个长时间运行的进程（如开发服务器、文件监视器、耗时的构建与测试）。${syntaxHint} ` +
          '命令按前台写法给出，不要再加 & 或 nohup：进程已由本工具放在后台管理，自己放到后台的子进程在 shell 退出后不受 process_kill 管理。' +
          '在对话回合里起的进程退出（包括出错退出）时会收到一条宿主通知，带退出码与用时，不必轮询；' +
          '长驻进程正常运行时不会退出，也就没有通知，是否就绪用 process_read 看输出。' +
          '插件停用或 Aalis 停机时进程随之终止，不发通知。' +
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
              description: `命令执行目录（可选）。使用 storage URI，如 workspace:/ 或 tmp:/build；相对路径基于本工具配置的工作目录 ${config.cwdUri} 解析（不受 cd 影响）。`,
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    confirm: 'session',
    handler: async (args, callCtx) => {
      const command = args.command as string;
      const cwd = await resolveCwd(config, args.cwd);
      const notice = exitNoticeTarget(callCtx);
      const stop = new AbortController();

      // 不接回合的中止信号：停止键不杀后台进程。停用插件、process_kill、会话删除都按中止契约收整组
      const child = proc.spawn(shellCmd, [shellFlag, command], {
        cwd: cwd.localPath,
        signal: AbortSignal.any([config.lifecycle.signal, stop.signal]),
      });
      if (child.pid === undefined) {
        // 创建失败（cwd 不存在、shell 起不来等）：Node 下一拍才发 'error'，等它落定后直接回错，不登记、不通知
        const reason = await child.wait().then(
          () => '未知原因',
          err => (err instanceof Error ? err.message : String(err)),
        );
        return JSON.stringify({ error: `后台进程启动失败：${reason}` });
      }

      const id = `proc_${RUN_TAG}_${++processIdCounter}`;
      const settled = child.wait().then(
        result => {
          managed.exitCode = result.code;
          settle(managed, result);
        },
        err => {
          managed.stderr += `\n[进程错误] ${err instanceof Error ? err.message : String(err)}`;
          managed.exitCode = -1;
          settle(managed, undefined);
        },
      );
      const managed: ManagedProcess = {
        id,
        command,
        pid: child.pid,
        startedAt: Date.now(),
        stdout: '',
        stderr: '',
        exitCode: null,
        done: false,
        settled,
        starter: identityOf(callCtx),
        stop,
        notice,
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        managed.stdout += typeof chunk === 'string' ? chunk : chunk.toString();
        // 保持缓冲区在合理范围
        if (managed.stdout.length > config.maxOutputSize * 2) {
          managed.stdout = managed.stdout.slice(-config.maxOutputSize);
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        managed.stderr += typeof chunk === 'string' ? chunk : chunk.toString();
        if (managed.stderr.length > config.maxOutputSize * 2) {
          managed.stderr = managed.stderr.slice(-config.maxOutputSize);
        }
      });

      getSessionProcesses(callCtx.sessionId).set(id, managed);
      logger.debug(`exec_background: ${command} -> ${id} (pid: ${child.pid})`);

      let message = '后台进程已启动。使用 process_read 读取输出，process_kill 终止进程。';
      if (notice) {
        message =
          '后台进程已启动。本次运行期间它退出（包括出错退出）时会通知你；长驻进程正常运行时不会退出，也就不会通知，' +
          '是否就绪用 process_read 看输出。停掉用 process_kill。';
      } else if (callCtx.inbound?.source?.startsWith(EXIT_NOTICE_SOURCE_PREFIX)) {
        message =
          '后台进程已启动。这一轮由后台进程的结束通知开启，它退出时不再通知，结局用 process_list 查看；' +
          '中途看输出用 process_read，停掉用 process_kill。';
      }
      return JSON.stringify({ processId: id, pid: child.pid, command, message });
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
    visibility: 'restricted',
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
    visibility: 'restricted',
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
        // 会话压缩后历史里可能没有那次 exec_background 调用了，带上命令才对得上号
        command: managed.command,
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
        description:
          '终止本会话里用 exec_background 起的一个后台进程，连同它的进程组：先 SIGTERM，宽限后强制结束，返回时说明是否已停。' +
          '只能终止与本轮同一身份起的进程（owner 除外）。被这里终止的进程不再发结束通知。',
        parameters: {
          type: 'object',
          properties: {
            processId: {
              type: 'string',
              description: '进程 ID（由 exec_background 返回）',
            },
          },
          required: ['processId'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    // 不要确认：只能终止本会话里 exec_background 起的、与调用者同一身份起的进程组（起的时候已确认过），只发终止，
    // 没有别的信号可选；owner 让她停时她直接停。要恢复确认，在 authority 的 confirmOverrides 里配。
    handler: async (args, callCtx) => {
      const processId = args.processId as string;
      const managed = getSessionProcesses(callCtx.sessionId).get(processId);

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

      const caller = identityOf(callCtx);
      const sameStarter = caller.platform === managed.starter.platform && caller.userId === managed.starter.userId;
      if (!sameStarter && !config.isOwner(caller)) {
        return JSON.stringify({ error: `只能终止自己起的后台进程："${processId}" 不是以当前身份起的` });
      }

      // 先摘通知目标再终止：被这里终止的不通知。等它落定再如实回报
      const notice = managed.notice;
      managed.notice = undefined;
      managed.stop.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        managed.settled,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, KILL_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!managed.done) {
        // 宽限之后仍在跑（无权发信号、Windows 结束进程树较慢等）：通知目标放回去，它之后结束照常通知
        if (backgroundProcesses.get(callCtx.sessionId)?.get(processId) === managed) managed.notice = notice;
        return JSON.stringify({
          processId,
          running: true,
          message: `已发出终止，进程仍在运行 (pid: ${managed.pid})；${managed.notice ? '它之后结束时会通知你，' : ''}可以用 process_list 查看`,
        });
      }
      return JSON.stringify({
        processId,
        stopped: true,
        exitCode: managed.exitCode,
        message: `进程已停止 (pid: ${managed.pid})`,
      });
    },
  });

  // 停用、bounce：后台进程随 lifecycle.signal 按中止契约整组收掉（见 exec_background 的 spawn），这里只清登记表
  config.lifecycle.onDispose(() => {
    backgroundProcesses.clear();
  });
}
