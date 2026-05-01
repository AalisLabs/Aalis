import type { Context, ConfigSchema, StorageService } from '@aalis/core';
import { runCode, type RunnerConfig } from './runner.js';
import { platform } from 'node:os';
import path from 'node:path';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-code-runner';
export const displayName = '代码执行器';
export const inject = {
  required: [{ service: 'storage', capabilities: ['local-path'] }],
};

export const configSchema: ConfigSchema = {
  python: {
    label: 'Python',
    fields: {
      enabled: { type: 'boolean', label: '启用 run_python', default: true },
      interpreter: {
        type: 'string',
        label: '解释器路径',
        default: 'python3',
        description: 'Python 解释器路径或命令名，如 python3、/usr/bin/python3',
      },
    },
  },
  javascript: {
    label: 'JavaScript (Node.js)',
    fields: {
      enabled: { type: 'boolean', label: '启用 run_javascript', default: true },
      interpreter: {
        type: 'string',
        label: '解释器路径',
        default: 'node',
        description: 'Node.js 解释器路径或命令名',
      },
    },
  },
  defaultTimeout: {
    type: 'number',
    label: '默认超时 (ms)',
    default: 60000,
    description: '脚本执行默认超时时间',
  },
  maxTimeout: {
    type: 'number',
    label: '最大超时 (ms)',
    default: 300000,
    description: '允许指定的最大超时时间',
  },
  maxOutputSize: {
    type: 'number',
    label: '最大输出字节',
    default: 131072,
    description: 'stdout/stderr 各自的最大输出字节数',
  },
  workingDirectory: {
    type: 'string',
    label: '逻辑工作目录',
    default: 'workspace:/',
    description: '脚本执行时的 storage URI 工作目录，如 workspace:/ 或 tmp:/run；相对路径会解释为 workspace:/ 下路径。',
  },
};

export const defaultConfig = {
  python: { enabled: true, interpreter: 'python3' },
  javascript: { enabled: true, interpreter: 'node' },
  defaultTimeout: 60000,
  maxTimeout: 300000,
  maxOutputSize: 131072,
  workingDirectory: 'workspace:/',
};

// ===== 配置解析 =====

interface CodeRunnerConfig {
  python: { enabled: boolean; interpreter: string };
  javascript: { enabled: boolean; interpreter: string };
  defaultTimeout: number;
  maxTimeout: number;
  maxOutputSize: number;
  workingDirectory: string;
}

function resolveConfig(config: Record<string, unknown>): CodeRunnerConfig {
  const py = config.python as Record<string, unknown> | undefined;
  const js = config.javascript as Record<string, unknown> | undefined;
  return {
    python: {
      enabled: (py?.enabled as boolean) ?? true,
      interpreter: (py?.interpreter as string) || 'python3',
    },
    javascript: {
      enabled: (js?.enabled as boolean) ?? true,
      interpreter: (js?.interpreter as string) || 'node',
    },
    defaultTimeout: (config.defaultTimeout as number) ?? 60000,
    maxTimeout: (config.maxTimeout as number) ?? 300000,
    maxOutputSize: (config.maxOutputSize as number) ?? 131072,
    workingDirectory: (config.workingDirectory as string) ?? 'workspace:/',
  };
}

function toStorageUri(input: string | undefined, fallback: string): string {
  const value = (input || fallback).trim();
  if (!value) return 'workspace:/';
  if (/^[a-zA-Z]:[\\/]/.test(value)) throw new Error('代码执行器工作目录必须使用 storage URI 或相对 workspace 的路径，不能使用宿主机绝对路径');
  if (/^[a-zA-Z][a-zA-Z0-9_-]*:\//.test(value)) return value;
  if (path.isAbsolute(value)) throw new Error('代码执行器工作目录必须使用 storage URI 或相对 workspace 的路径，不能使用宿主机绝对路径');
  return `workspace:/${value.replace(/^\/+/, '')}`;
}

function safeEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function createRunnerConfig(ctx: Context, cfg: CodeRunnerConfig): Promise<RunnerConfig> {
  const storage = ctx.getService<StorageService>('storage');
  if (!storage?.resolveLocalPath) throw new Error('代码执行器需要支持 local-path 能力的 storage 服务');
  const cwdUri = toStorageUri(cfg.workingDirectory, 'workspace:/');
  return {
    defaultTimeout: cfg.defaultTimeout,
    maxTimeout: cfg.maxTimeout,
    maxOutputSize: cfg.maxOutputSize,
    cwd: await storage.resolveLocalPath(cwdUri, 'read'),
    tmpDir: await storage.resolveLocalPath('tmp:/code-runner', 'write'),
    env: safeEnv(),
  };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  const cwdUri = toStorageUri(cfg.workingDirectory, 'workspace:/');

  // 创建带分组标记的注册代理
  function ctxWithGroups(groups: string[]): Context {
    return new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'registerTool') {
          return (tool: Parameters<Context['registerTool']>[0]) =>
            target.registerTool({ ...tool, groups });
        }
        return Reflect.get(target, prop, target);
      },
    }) as Context;
  }

  const groupCtx = ctxWithGroups(['code-runner']);

  // 注册工具分组
  ctx.registerToolGroup({
    name: 'code-runner',
    label: '代码执行',
    description: '编写并运行 Python / JavaScript 代码来解决计算、分析、文件处理等问题',
  });

  const osName = platform() === 'darwin' ? 'macOS' : platform() === 'win32' ? 'Windows' : 'Linux';

  // ==================== run_python ====================
  if (cfg.python.enabled) {
    groupCtx.registerTool({
      definition: {
        type: 'function',
        function: {
          name: 'run_python',
          description:
            `在本机 ${osName} 系统上编写并执行一段 Python 脚本，返回 stdout 和 stderr。` +
            '代码会保存到临时文件后执行，无需担心转义问题，可以编写任意多行代码。\n\n' +
            '**适用场景（请在合适时主动使用）：**\n' +
            '- 复杂数学计算、方程求解、符号推导（math / sympy / numpy / scipy）\n' +
            '- 数据统计分析、CSV/JSON 数据处理（pandas / json / csv）\n' +
            '- 批量文件解析与文本处理（正则匹配、格式转换、批量重命名）\n' +
            '- 编码转换、加解密、哈希计算（base64 / hashlib）\n' +
            '- 日期 / 时间计算（datetime / calendar）\n' +
            '- 需要精确结果而非近似回答的任何计算问题\n' +
            '- 生成结构化输出（表格、Markdown、LaTeX）\n\n' +
            '**使用技巧：**\n' +
            '- 将最终结果通过 print() 输出，该输出会作为工具返回值\n' +
            '- 可使用标准库和已安装的第三方库（如 numpy, sympy, pandas 等）\n' +
            '- 处理多个文件时，在一个脚本内循环处理并汇总输出，效率远高于多次调用\n' +
            '- 若需读写文件，请优先使用相对于逻辑工作目录的路径；不要依赖宿主机绝对路径',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: '完整的 Python 脚本源代码',
              },
              timeout: {
                type: 'number',
                description: `超时毫秒数（可选，默认 ${cfg.defaultTimeout}，最大 ${cfg.maxTimeout}）`,
              },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
      },
      authority: 5,
      safety: 'dangerous',
      permissions: ['tool:code.python', 'system:process.exec', 'runtime:python'],
      handler: async (args) => {
        const code = args.code as string;
        const timeout = args.timeout as number | undefined;
        ctx.logger.debug(`run_python: ${code.length} 字符`);
        const runnerConfig = await createRunnerConfig(ctx, cfg);
        const result = await runCode(
          cfg.python.interpreter,
          code,
          '.py',
          runnerConfig,
          timeout,
        );
        return JSON.stringify(result);
      },
    });

    ctx.logger.info(`Python 代码执行工具已启用 (解释器: ${cfg.python.interpreter})`);
  }

  // ==================== run_javascript ====================
  if (cfg.javascript.enabled) {
    groupCtx.registerTool({
      definition: {
        type: 'function',
        function: {
          name: 'run_javascript',
          description:
            `在本机 ${osName} 系统上编写并执行一段 JavaScript (Node.js) 脚本，返回 stdout 和 stderr。` +
            '代码会保存为 .mjs 文件（ESM 模块）后执行，支持 top-level await。\n\n' +
            '**适用场景（请在合适时主动使用）：**\n' +
            '- JSON 数据处理与转换\n' +
            '- 正则表达式测试与文本处理\n' +
            '- Node.js API 调用、文件系统操作\n' +
            '- HTTP 请求与 API 测试（fetch）\n' +
            '- 需要 JavaScript 运行时特性的验证和计算\n\n' +
            '**使用技巧：**\n' +
            '- 通过 console.log() 输出结果\n' +
            '- 使用 ESM import 语法导入模块\n' +
            '- 支持 top-level await，可直接使用 await fetch(...) 等',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: '完整的 JavaScript (Node.js ESM) 脚本源代码',
              },
              timeout: {
                type: 'number',
                description: `超时毫秒数（可选，默认 ${cfg.defaultTimeout}，最大 ${cfg.maxTimeout}）`,
              },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
      },
      authority: 5,
      safety: 'dangerous',
      permissions: ['tool:code.javascript', 'system:process.exec', 'runtime:javascript'],
      handler: async (args) => {
        const code = args.code as string;
        const timeout = args.timeout as number | undefined;
        ctx.logger.debug(`run_javascript: ${code.length} 字符`);
        const runnerConfig = await createRunnerConfig(ctx, cfg);
        const result = await runCode(
          cfg.javascript.interpreter,
          code,
          '.mjs',
          runnerConfig,
          timeout,
        );
        return JSON.stringify(result);
      },
    });

    ctx.logger.info(`JavaScript 代码执行工具已启用 (解释器: ${cfg.javascript.interpreter})`);
  }

  ctx.logger.info(`代码执行器插件已启动 (工作目录: ${cwdUri})`);
}
