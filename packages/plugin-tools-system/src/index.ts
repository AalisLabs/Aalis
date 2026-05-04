import type { Context, ConfigSchema, StorageService } from '@aalis/core';
import { registerShellTools } from './tools/shell.js';
import { registerFileTools } from './tools/file.js';
import { registerSystemTools } from './tools/system.js';
import { registerHttpTools } from './tools/http.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tools-system';
export const displayName = '系统工具';
export const inject = {
  optional: ['commands', 'persona', 'storage'],
};

export const configSchema: ConfigSchema = {
  workingDirectory: {
    type: 'string',
    label: '工作目录',
    default: 'workspace:/',
    description: 'Shell 等执行工具的默认逻辑目录。使用 storage URI，如 workspace:/ 或 tmp:/run；相对路径会解释为 workspace:/ 下路径。',
  },
  shell: {
    label: 'Shell 工具',
    fields: {
      enabled: { type: 'boolean', label: '启用 Shell 工具', default: true },
      defaultTimeout: { type: 'number', label: '默认超时 (ms)', default: 30000 },
      maxTimeout: { type: 'number', label: '最大超时 (ms)', default: 300000 },
      maxOutputSize: { type: 'number', label: '最大输出字节', default: 65536 },
    },
  },
  file: {
    label: '文件工具',
    fields: {
      enabled: { type: 'boolean', label: '启用文件工具', default: true },
      maxReadSize: { type: 'number', label: '最大读取字节', default: 1048576 },
      maxWriteSize: { type: 'number', label: '最大写入字节', default: 10485760 },
      defaultRoot: { type: 'string', label: '默认存储根', default: 'workspace', description: '普通相对路径会被解释到这个 storage 根' },
      allowedRoots: {
        type: 'multiselect',
        label: '允许访问的存储根',
        default: ['workspace', 'tmp'],
        options: [
          { label: 'Workspace', value: 'workspace' },
          { label: '临时目录', value: 'tmp' },
          { label: 'Data', value: 'data' },
          { label: '插件数据', value: 'pluginData' },
          { label: '日志', value: 'logs' },
        ],
        allowCustom: true,
      },
    },
  },
  system: {
    label: '系统工具',
    fields: {
      enabled: { type: 'boolean', label: '启用系统工具', default: true },
    },
  },
  http: {
    label: 'HTTP 工具',
    fields: {
      enabled: { type: 'boolean', label: '启用 HTTP 工具', default: true },
      defaultTimeout: { type: 'number', label: '默认超时 (ms)', default: 30000 },
      maxResponseSize: { type: 'number', label: '最大响应字节', default: 1048576 },
    },
  },
};

export const defaultConfig = {
  workingDirectory: 'workspace:/',
  shell: { enabled: true, defaultTimeout: 30000, maxTimeout: 300000, maxOutputSize: 65536 },
  file: { enabled: true, maxReadSize: 1048576, maxWriteSize: 10485760, defaultRoot: 'workspace', allowedRoots: ['workspace', 'tmp'] },
  system: { enabled: true },
  http: { enabled: true, defaultTimeout: 30000, maxResponseSize: 1048576 },
};

// ===== 配置类型 =====

export interface ToolsBasicConfig {
  workingDirectory: string;
  shell: { enabled: boolean; defaultTimeout: number; maxTimeout: number; maxOutputSize: number };
  file: { enabled: boolean; maxReadSize: number; maxWriteSize: number; defaultRoot: string; allowedRoots: string[] };
  system: { enabled: boolean };
  http: { enabled: boolean; defaultTimeout: number; maxResponseSize: number };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  const cwdUri = cfg.workingDirectory || 'workspace:/';

  /** 创建带分组标记的工具注册代理 */
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

  // 注册工具分组
  ctx.registerToolGroup({
    name: 'system',
    label: '系统工具',
    description: 'Shell 命令执行、文件操作、系统信息查询、HTTP 请求等系统级工具',
  });

  // 注册各工具组
  if (cfg.shell.enabled) {
    const storage = ctx.getService<StorageService>('storage');
    if (storage?.resolveLocalPath) {
      registerShellTools(ctxWithGroups(['system']), { cwdUri, storage, ...cfg.shell });
      ctx.logger.info('Shell 工具已启用');
    } else {
      ctx.logger.warn('Shell 工具需要 storage local-path 能力，已跳过注册');
    }
  }

  if (cfg.file.enabled) {
    const storage = ctx.getService<StorageService>('storage');
    if (storage) {
      registerFileTools(ctxWithGroups(['system']), { ...cfg.file, storage });
      ctx.logger.info('文件工具已启用');
    } else {
      ctx.logger.warn('文件工具需要 storage 服务，已跳过注册');
    }
  }

  if (cfg.system.enabled) {
    const persona = ctx.getService<{ isTimeInjectionEnabled?(): boolean }>('persona');
    const skipTimeTool = !!persona?.isTimeInjectionEnabled?.();
    registerSystemTools(ctxWithGroups(['system']), { cwd: cwdUri, skipTimeTool });
    ctx.logger.info('系统工具已启用' + (skipTimeTool ? '（已由 persona 注入时间，跳过 system_time）' : ''));
  }

  if (cfg.http.enabled) {
    const storage = ctx.getService<StorageService>('storage');
    registerHttpTools(ctxWithGroups(['system']), { ...cfg.http, storage });
    ctx.logger.info('HTTP 工具已启用');
  }

  // 注册 /tools 指令以查看可用工具
  ctx.command('tools', '列出所有已注册的机器交互工具', async () => {
    const groups = ['shell', 'file', 'system', 'http']
      .filter(g => (cfg as unknown as Record<string, { enabled?: boolean }>)[g]?.enabled !== false);
    const lines = [
      '📦 机器交互工具:',
      ...groups.map(g => `  ✅ ${g}`),
    ];
    return lines.join('\n');
  });

  ctx.logger.info(`机器交互工具插件已启动 (工作目录: ${cwdUri})`);
}

// ===== 辅助函数 =====

function resolveConfig(config: Record<string, unknown>): ToolsBasicConfig {
  const shell = config.shell as Record<string, unknown> | undefined;
  const file = config.file as Record<string, unknown> | undefined;
  const system = config.system as Record<string, unknown> | undefined;
  const http = config.http as Record<string, unknown> | undefined;

  return {
    workingDirectory: (config.workingDirectory as string) ?? 'workspace:/',
    shell: {
      enabled: (shell?.enabled as boolean) ?? true,
      defaultTimeout: (shell?.defaultTimeout as number) ?? 30000,
      maxTimeout: (shell?.maxTimeout as number) ?? 300000,
      maxOutputSize: (shell?.maxOutputSize as number) ?? 65536,
    },
    file: {
      enabled: (file?.enabled as boolean) ?? true,
      maxReadSize: (file?.maxReadSize as number) ?? 1048576,
      maxWriteSize: (file?.maxWriteSize as number) ?? 10485760,
      defaultRoot: (file?.defaultRoot as string) ?? 'workspace',
      allowedRoots: Array.isArray(file?.allowedRoots)
        ? (file.allowedRoots as unknown[]).filter((root): root is string => typeof root === 'string')
        : ['workspace', 'tmp'],
    },
    system: {
      enabled: (system?.enabled as boolean) ?? true,
    },
    http: {
      enabled: (http?.enabled as boolean) ?? true,
      defaultTimeout: (http?.defaultTimeout as number) ?? 30000,
      maxResponseSize: (http?.maxResponseSize as number) ?? 1048576,
    },
  };
}
