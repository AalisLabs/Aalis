import type { ConfigSchema, Context } from '@aalis/core';
import { useCommandService } from '@aalis/plugin-commands-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import { toolsWithGroups, useToolService } from '@aalis/plugin-tools-api';
import { CwdState } from './tools/cwd-state.js';
import { registerFileTools } from './tools/file.js';
import { registerHttpTools } from './tools/http.js';
import { registerShellTools } from './tools/shell.js';
import { registerSystemTools } from './tools/system.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-system';
export const displayName = '系统工具';
export const subsystem = 'tools';
export const inject = {
  optional: ['commands', 'persona', 'storage'],
};

export const configSchema: ConfigSchema = {
  workingDirectory: {
    type: 'string',
    label: '初始工作目录',
    default: 'workspace:/',
    description:
      '进程启动时的初始 cwd（unix 心智模型）。agent 可用 cd 工具在会话内切换，不会写回本配置。' +
      'shell/code-runner 仍使用各自独立的 workingDirectory 配置，不受 cd 影响。',
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
      maxSearchBytes: { type: 'number', label: '单次搜索最大扫描字节', default: 1048576 },
      maxWriteSize: { type: 'number', label: '最大写入字节', default: 10485760 },
      allowedRoots: {
        type: 'multiselect',
        label: '允许访问的存储根',
        default: ['*'],
        description:
          '设为 * 时允许访问 storage 中全部 readable 根；也可以显式列出根名。写入/删除仍受各根自身权限限制。',
        options: [
          { label: '全部可读根', value: '*' },
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
  file: {
    enabled: true,
    maxReadSize: 1048576,
    maxSearchBytes: 1048576,
    maxWriteSize: 10485760,
    allowedRoots: ['*'],
  },
  system: { enabled: true },
  http: { enabled: true, defaultTimeout: 30000, maxResponseSize: 1048576 },
};

// ===== 配置类型 =====

export interface ToolsBasicConfig {
  workingDirectory: string;
  shell: { enabled: boolean; defaultTimeout: number; maxTimeout: number; maxOutputSize: number };
  file: {
    enabled: boolean;
    maxReadSize: number;
    maxSearchBytes: number;
    maxWriteSize: number;
    allowedRoots: string[];
  };
  system: { enabled: boolean };
  http: { enabled: boolean; defaultTimeout: number; maxResponseSize: number };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  const cwdUri = cfg.workingDirectory || 'workspace:/';
  // 全局唯一的 cwd 状态：system.cwd / system.cd / file_* 都共享同一个 CwdState 实例，
  // 这是"shell 心智模型一致性"的唯一保证。per-session 在 CwdState 内部按 sessionId 分桶。
  const cwdState = new CwdState(cwdUri);

  const tools = useToolService(ctx);
  const systemTools = toolsWithGroups(tools, ['system']);

  // 注册工具分组
  tools.registerGroup({
    name: 'system',
    label: '系统工具',
    description: 'Shell 命令执行、文件操作、系统信息查询、HTTP 请求等系统级工具',
  });

  const hasStorage = ctx.getAllServices<StorageService>('storage').length > 0;

  // 注册各工具组
  if (cfg.shell.enabled) {
    if (hasStorage) {
      const storage = createStorageGateway(ctx);
      registerShellTools(systemTools, { ctx, cwdUri, storage, ...cfg.shell });
      ctx.logger.info('Shell 工具已启用');
    } else {
      ctx.logger.warn('Shell 工具需要 storage 服务，已跳过注册');
    }
  }

  if (cfg.file.enabled) {
    if (hasStorage) {
      const storage = createStorageGateway(ctx);
      registerFileTools(systemTools, { ...cfg.file, storage, cwdState });
      ctx.logger.info('文件工具已启用');
    } else {
      ctx.logger.warn('文件工具需要 storage 服务，已跳过注册');
    }
  }

  if (cfg.system.enabled) {
    const persona = ctx.getService<{ isTimeInjectionEnabled?(): boolean }>('persona');
    const skipTimeTool = !!persona?.isTimeInjectionEnabled?.();
    const storage = hasStorage ? createStorageGateway(ctx) : undefined;
    registerSystemTools(systemTools, { cwdState, storage, skipTimeTool });
    ctx.logger.info(`系统工具已启用${skipTimeTool ? '（已由 persona 注入时间，跳过 system_time）' : ''}`);
  }

  if (cfg.http.enabled) {
    const storage = hasStorage ? createStorageGateway(ctx) : undefined;
    registerHttpTools(systemTools, { ...cfg.http, storage });
    ctx.logger.info('HTTP 工具已启用');
  }

  // 注册 /tools 指令以查看可用工具
  useCommandService(ctx)
    .command('tools', '列出所有已注册的机器交互工具')
    .action(async () => {
      const groups = ['shell', 'file', 'system', 'http'].filter(
        g => (cfg as unknown as Record<string, { enabled?: boolean }>)[g]?.enabled !== false,
      );
      const lines = ['📦 机器交互工具:', ...groups.map(g => `  ✅ ${g}`)];
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
  const configuredAllowedRoots = Array.isArray(file?.allowedRoots)
    ? (file.allowedRoots as unknown[]).filter((root): root is string => typeof root === 'string')
    : [];

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
      maxSearchBytes: (file?.maxSearchBytes as number) ?? 1048576,
      maxWriteSize: (file?.maxWriteSize as number) ?? 10485760,
      allowedRoots: configuredAllowedRoots.length ? configuredAllowedRoots : ['*'],
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
