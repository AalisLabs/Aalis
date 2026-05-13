/**
 * 系统工具组 —— 系统信息与环境感知
 *
 * 提供：
 * - system_info: 获取操作系统和运行时环境信息
 * - env_get: 读取环境变量
 * - system_time: 获取当前时间和时区信息
 * - cwd: 获取/修改当前工作目录
 */

import * as os from 'node:os';
import * as process from 'node:process';
import type { ScopedToolService } from '@aalis/plugin-tools-api';

interface SystemConfig {
  cwd: string;
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
    handler: async () => {
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
        cwd: config.cwd,
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'cwd',
        description: '获取当前工作目录路径。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async () => {
      return JSON.stringify({
        cwd: config.cwd,
      });
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
