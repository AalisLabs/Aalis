import type { Context, ConfigSchema, ToolCallContext, RegisteredTool } from '@aalis/core';
import { registerShellTools } from './tools/shell.js';
import { registerFileTools } from './tools/file.js';
import { registerSystemTools } from './tools/system.js';
import { registerHttpTools } from './tools/http.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tools-basic';
export const inject = {
  required: ['tools'],
};

export const configSchema: ConfigSchema = {
  workingDirectory: {
    type: 'string',
    label: '工作目录',
    description: '工具执行时的默认工作目录，留空则使用进程当前目录',
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
  workingDirectory: '',
  shell: { enabled: true, defaultTimeout: 30000, maxTimeout: 300000, maxOutputSize: 65536 },
  file: { enabled: true, maxReadSize: 1048576, maxWriteSize: 10485760 },
  system: { enabled: true },
  http: { enabled: true, defaultTimeout: 30000, maxResponseSize: 1048576 },
};

// ===== 配置类型 =====

export interface ToolsBasicConfig {
  workingDirectory: string;
  shell: { enabled: boolean; defaultTimeout: number; maxTimeout: number; maxOutputSize: number };
  file: { enabled: boolean; maxReadSize: number; maxWriteSize: number };
  system: { enabled: boolean };
  http: { enabled: boolean; defaultTimeout: number; maxResponseSize: number };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  const cwd = cfg.workingDirectory || process.cwd();

  // 注册各工具组
  if (cfg.shell.enabled) {
    registerShellTools(ctx, { cwd, ...cfg.shell });
    ctx.logger.info('Shell 工具已启用');
  }

  if (cfg.file.enabled) {
    registerFileTools(ctx, { cwd, ...cfg.file });
    ctx.logger.info('文件工具已启用');
  }

  if (cfg.system.enabled) {
    registerSystemTools(ctx, { cwd });
    ctx.logger.info('系统工具已启用');
  }

  if (cfg.http.enabled) {
    registerHttpTools(ctx, cfg.http);
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

  ctx.logger.info(`机器交互工具插件已启动 (工作目录: ${cwd})`);
}

// ===== 辅助函数 =====

function resolveConfig(config: Record<string, unknown>): ToolsBasicConfig {
  const shell = config.shell as Record<string, unknown> | undefined;
  const file = config.file as Record<string, unknown> | undefined;
  const system = config.system as Record<string, unknown> | undefined;
  const http = config.http as Record<string, unknown> | undefined;

  return {
    workingDirectory: (config.workingDirectory as string) ?? '',
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
