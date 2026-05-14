/**
 * 系统工具组 —— 系统信息与环境感知
 *
 * 提供：
 * - system_info: 获取操作系统和运行时环境信息
 * - env_get: 读取环境变量
 * - system_time: 获取当前时间和时区信息
 * - cwd: 查询当前工作目录 + 列出所有可用 storage 根（unix `pwd` 的对应物）
 * - cd:  切换当前工作目录（unix `cd` 的对应物，per-session 内存状态）
 *
 * cwd/cd 的设计动机详见 ./cwd-state.ts 与 ./path-resolve.ts；简言之，让
 * agent 形成稳定的"我在哪"心智模型，并与 file_* 工具的相对路径解析共享。
 */

import * as os from 'node:os';
import * as process from 'node:process';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import type { CwdState } from './cwd-state.js';
import { parseStorageUri, resolveAgainstCwd } from './path-resolve.js';

interface SystemConfig {
  cwdState: CwdState;
  /** 用于 cwd 工具回显可用根清单与 cd 工具校验目标根存在性 */
  storage?: StorageService;
  skipTimeTool?: boolean;
}

export function registerSystemTools(tools: ScopedToolService, config: SystemConfig): void {
  // ==================== system_info ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'system_info',
        description:
          '获取当前系统的详细信息，包括操作系统、CPU、内存、Node.js 版本等。' + '用于了解运行环境以做出合适的决策。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async (_args, callCtx) => {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      return JSON.stringify({
        os: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          hostname: os.hostname(),
          type: os.type(),
        },
        cpu: {
          model: cpus[0]?.model ?? 'unknown',
          cores: cpus.length,
        },
        memory: {
          total: formatBytes(totalMem),
          free: formatBytes(freeMem),
          used: formatBytes(totalMem - freeMem),
          usagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        },
        runtime: {
          node: process.version,
          v8: process.versions.v8,
          pid: process.pid,
          uptime: `${Math.round(process.uptime())}s`,
        },
        user: {
          name: os.userInfo().username,
          shell: os.userInfo().shell ?? undefined,
        },
        cwd: config.cwdState.get(callCtx.sessionId),
      });
    },
  });

  // ==================== env_get ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'env_get',
        description: '读取一个或多个环境变量的值。不会返回敏感的密钥类变量。',
        parameters: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              description: '要查询的环境变量名列表',
              items: { type: 'string' },
            },
            pattern: {
              type: 'string',
              description: '使用前缀模式匹配环境变量（如 "NODE_" 返回所有 NODE_ 开头的变量）',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    authority: 5,
    safety: 'dangerous',
    permissions: ['tool:env.get', 'system:env.read'],
    handler: async args => {
      const names = args.names as string[] | undefined;
      const pattern = args.pattern as string | undefined;

      const sensitivePatterns = [
        /key/i,
        /secret/i,
        /password/i,
        /token/i,
        /credential/i,
        /auth/i,
        /private/i,
        /apikey/i,
        /api_key/i,
      ];

      function isSensitive(name: string): boolean {
        return sensitivePatterns.some(p => p.test(name));
      }

      const result: Record<string, string | null> = {};

      if (names && names.length > 0) {
        for (const name of names) {
          if (isSensitive(name)) {
            result[name] = '[REDACTED - 敏感变量]';
          } else {
            result[name] = process.env[name] ?? null;
          }
        }
      } else if (pattern) {
        for (const [key, value] of Object.entries(process.env)) {
          if (key.startsWith(pattern)) {
            result[key] = isSensitive(key) ? '[REDACTED]' : (value ?? null);
          }
        }
      } else {
        return JSON.stringify({ error: '请提供 names 或 pattern 参数' });
      }

      return JSON.stringify({ variables: result });
    },
  });

  // ==================== system_time ====================
  if (!config.skipTimeTool)
    tools.register({
      definition: {
        type: 'function',
        function: {
          name: 'system_time',
          description: '获取当前系统时间、时区和 Unix 时间戳。',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      },
      handler: async () => {
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const offsetParts =
          new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
            .formatToParts(now)
            .find(p => p.type === 'timeZoneName')?.value ?? '';
        return JSON.stringify({
          iso: now.toISOString(),
          local: now.toLocaleString('en-CA', { hour12: false }).replace(',', ''),
          timezone: tz,
          offset: offsetParts,
          utcOffsetHours: -now.getTimezoneOffset() / 60,
          unix: Math.floor(now.getTime() / 1000),
          unixMs: now.getTime(),
        });
      },
    });

  // ==================== cwd ====================
  // 设计为"廉价的发现入口"：调用一次就同时拿到当前目录 + 所有可用 storage 根。
  // 这样即便没有独立的 list_storage_roots 工具，agent 也不会瞎猜根名。
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'cwd',
        description:
          '查询当前工作目录，并返回所有可用 storage 根（含读写删权限标记）。' +
          '类似 unix `pwd`，但额外暴露根清单，让你一次性看清"我在哪、能去哪"。' +
          '所有 file_* 工具的相对路径都基于这个 cwd 解析；用 cd 工具切换。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async (_args, callCtx) => {
      const cwd = config.cwdState.get(callCtx.sessionId);
      const roots =
        config.storage?.listRoots().map(r => ({
          name: r.name,
          uri: `${r.name}:/`,
          label: r.label,
          kind: r.kind,
          readable: r.readable,
          writable: r.writable,
          deletable: r.deletable,
        })) ?? [];
      return JSON.stringify({
        cwd,
        initialCwd: config.cwdState.getInitial(),
        availableRoots: roots,
        hint: '用 cd("<root>:/path") 或 cd("相对路径") 切换；file_* 工具的相对路径基于 cwd 解析。',
      });
    },
  });

  // ==================== cd ====================
  // 仅修改 per-session 内存状态，不落盘配置。重启进程回到 initial。
  // 不做"切到目录是否真实存在"的强校验：留给后续 file_list/file_read 自然报错，
  // 因为某些 storage 根（如未来的 s3）可能 list 一个不存在前缀也是合法的。
  // 但会校验目标根是否在 storage 中注册且可读，避免误把 cwd 切到不存在的根。
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'cd',
        description:
          '切换当前工作目录（per-session，内存状态，进程重启失效；不写配置文件）。' +
          '接受完整 storage URI（如 aalis:/packages/core）或相对当前 cwd 的路径（如 ../plugin-tools）。' +
          '不接受宿主机绝对路径。可用的根请先调 cwd 查看。',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: '目标目录：完整 storage URI 或相对当前 cwd 的路径',
            },
          },
          required: ['target'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      try {
        const target = (args.target as string | undefined) ?? '';
        const current = config.cwdState.get(callCtx.sessionId);
        const next = resolveAgainstCwd(target, current);
        const nextRoot = parseStorageUri(next).root;

        // 校验目标根存在 + 可读（写/删权限是 file_write/file_delete 的事）
        const roots = config.storage?.listRoots() ?? [];
        if (roots.length > 0) {
          const root = roots.find(r => r.name === nextRoot);
          if (!root) {
            return JSON.stringify({
              error: `目标根 "${nextRoot}" 不存在。已注册根: ${roots.map(r => r.name).join(', ') || '(无)'}。调用 cwd 查看完整列表。`,
            });
          }
          if (!root.readable) {
            return JSON.stringify({ error: `根 "${nextRoot}" 不可读，无法 cd 进入。` });
          }
        }

        config.cwdState.set(callCtx.sessionId, next);
        return JSON.stringify({
          previousCwd: current,
          cwd: next,
          message: '已切换工作目录',
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}

// ===== 辅助函数 =====

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
