// ============================================================
// sandbox.ts — OS 沙箱命令改写（纯逻辑，便于单测）
//
// 把不可信代码的子进程包到 OS 沙箱启动器里运行（仍 shell-free）：
//   - macOS → sandbox-exec -p '<SBPL>' env -i <allowlist> <cmd> <args>
//   - Linux → bwrap <flags> --clearenv --setenv ... -- <cmd> <args>
// v1 语义：读放开（解释器需系统库）、写限定 fsWrite、网络粗粒度开关、env 仅白名单（防 secrets 泄漏）。
// 后端探测（功能性 probe）在 index.ts 经 process 网关做；本文件只做纯生成。
// ============================================================

import type { SandboxPolicy } from '@aalis/plugin-code-sandbox-api';

export type SandboxBackend = 'seatbelt' | 'bwrap' | 'none';

/** 取 env 中非空键值对（保序），用于 --setenv / `env -i` */
function envPairs(env: Record<string, string | undefined>): Array<[string, string]> {
  return Object.entries(env).filter((e): e is [string, string] => e[1] != null);
}

/** SBPL 字符串字面量转义 */
function sbplQuote(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 生成 macOS Seatbelt (SBPL) profile：默认拒绝；放开 进程/读/常见系统调用；
 * 写仅限 fsWrite + /dev 标准设备；网络按 policy。
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow file-read*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow signal)',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (literal "/dev/urandom"))',
  ];
  for (const dir of policy.fsWrite) lines.push(`(allow file-write* (subpath ${sbplQuote(dir)}))`);
  lines.push(policy.network === 'allow' ? '(allow network*)' : '(deny network*)');
  return `${lines.join('\n')}\n`;
}

/** macOS：sandbox-exec -p profile env -i <allowlist> cmd args（env -i 清空 env 仅留白名单） */
export function buildSeatbeltArgs(
  policy: SandboxPolicy,
  cmd: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): { cmd: string; args: string[] } {
  const profile = buildSeatbeltProfile(policy);
  const envArgs = envPairs(env).map(([k, v]) => `${k}=${v}`);
  return { cmd: 'sandbox-exec', args: ['-p', profile, 'env', '-i', ...envArgs, cmd, ...args] };
}

/** Linux：bwrap 只读绑根（可读+取解释器/库）、rw 绑写白名单、清 env 仅留白名单、按 policy 隔离网络。 */
export function buildBwrapArgs(
  policy: SandboxPolicy,
  cmd: string,
  args: readonly string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
): { cmd: string; args: string[] } {
  const a: string[] = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp', // 私有可写 /tmp；写白名单的 bind 在其后，故 /tmp 下的真实临时目录会被重新暴露为可写
    '--unshare-all', // 含 net 命名空间隔离（断网）
    '--die-with-parent',
    '--new-session',
    '--clearenv',
  ];
  for (const [k, v] of envPairs(env)) a.push('--setenv', k, v);
  if (policy.network === 'allow') a.push('--share-net');
  for (const dir of policy.fsWrite) a.push('--bind', dir, dir);
  if (cwd) a.push('--chdir', cwd);
  a.push('--', cmd, ...args);
  return { cmd: 'bwrap', args: a };
}

/** 按后端把 (cmd,args) 改写为「经沙箱启动器运行」。backend==='none' 不应调用（调用方先 fail-closed）。 */
export function wrapForSandbox(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  cmd: string,
  args: readonly string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
): { cmd: string; args: string[] } {
  if (backend === 'seatbelt') return buildSeatbeltArgs(policy, cmd, args, env);
  if (backend === 'bwrap') return buildBwrapArgs(policy, cmd, args, cwd, env);
  throw new Error(`不支持的沙箱后端: ${backend}`);
}
