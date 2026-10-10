import { commands } from '@aalis/api-commands';
import { persona } from '@aalis/api-persona';
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, logger, optional } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { CwdState } from './tools/cwd-state.js';
import { registerFileTools } from './tools/file.js';
import { registerHttpTools } from './tools/http.js';
import { registerShellTools } from './tools/shell.js';
import { registerSystemTools } from './tools/system.js';

const configSchema = defineConfig({
  workingDirectory: {
    type: 'string',
    label: '初始工作目录',
    default: 'workspace:/',
    onInvalid: 'error',
    description:
      '进程启动时的初始 cwd（unix 心智模型）。agent 可用 cd 工具在会话内切换，不会写回本配置。' +
      'shell 以本项初始值为基准、不受 cd 影响；code-runner 使用它自己的 workingDirectory 配置。',
  },
  shell: {
    label: 'Shell 工具',
    fields: {
      enabled: { type: 'boolean', label: '启用 Shell 工具', default: true, onInvalid: 'error' },
      maxOutputSize: { type: 'number', label: '最大输出字节', default: 65536 },
    },
  },
  file: {
    label: '文件工具',
    fields: {
      enabled: { type: 'boolean', label: '启用文件工具', default: true, onInvalid: 'error' },
      maxReadSize: { type: 'number', label: '最大读取字节', default: 1048576 },
      maxSearchBytes: { type: 'number', label: '单次搜索最大扫描字节', default: 1048576 },
      maxWriteSize: { type: 'number', label: '最大写入字节', default: 10485760 },
      allowedRoots: {
        type: 'multiselect',
        label: '允许访问的存储根',
        default: ['workspace', 'tmp'],
        onInvalid: 'error',
        description:
          '默认仅 agent 工作区（workspace/tmp），不含 data 等系统根（防裸读 data:/users.json 等）。' +
          '设为 * 放开全部 readable 根；也可显式列出根名。写入/删除仍受各根自身权限限制。',
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
      enabled: { type: 'boolean', label: '启用系统工具', default: true, onInvalid: 'error' },
    },
  },
  http: {
    label: 'HTTP 工具',
    fields: {
      enabled: { type: 'boolean', label: '启用 HTTP 工具', default: true, onInvalid: 'error' },
      defaultTimeout: {
        type: 'number',
        label: '默认超时 (ms)',
        default: 30000,
        description: 'http_request 的默认超时；http_download 不另设超时，等多久由工具执行器的让出时限管',
      },
      maxResponseSize: { type: 'number', label: '最大响应字节', default: 1048576 },
    },
  },
});

// ===== 配置类型 =====

// ===== 插件入口 =====

const uses = {
  tools: optional(tools),
  logger,
  config,
  commands: optional(commands),
  persona: optional(persona),
  storage: optional(storage),
  process: optional(processService),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-tool-system',
  displayName: '系统工具',
  subsystem: 'tools',
  configSchema,
  uses,
  apply: registerSystemToolset,
});

function registerSystemToolset(caps: Caps): void {
  const { tools, logger, persona } = caps;
  const parsed = parseConfig(configSchema, caps.config.use, logger.use);
  const cfg = {
    ...parsed,
    file: {
      ...parsed.file,
      allowedRoots: parsed.file.allowedRoots.length ? parsed.file.allowedRoots : ['workspace', 'tmp'],
    },
  };
  const cwdUri = cfg.workingDirectory || 'workspace:/';
  // 全局唯一的 cwd 状态：system.cwd / system.cd / file_* 都共享同一个 CwdState 实例，
  // 这是"shell 心智模型一致性"的唯一保证。per-session 在 CwdState 内部按 sessionId 分桶。
  const cwdState = new CwdState(cwdUri);

  const systemTools = withToolGroups(tools.use, ['system']);

  // 注册工具分组
  tools.use.registerGroup({
    name: 'system',
    label: '系统工具',
    description: 'Shell 命令执行、文件操作、系统信息查询、HTTP 请求等系统级工具',
  });

  // 业务句柄每次调用打到当时选中的那一家，四个工具组共用一份即可
  const storage = caps.storage.present ? caps.storage.use : undefined;

  // 注册各工具组
  if (cfg.shell.enabled) {
    if (storage && caps.process.present) {
      registerShellTools(systemTools, {
        logger: logger.use,
        cwdUri,
        storage,
        proc: caps.process.use,
        maxOutputSize: cfg.shell.maxOutputSize,
      });
      logger.use.info('Shell 工具已启用');
    } else {
      logger.use.warn('Shell 工具需要 storage 与 process 服务，已跳过注册');
    }
  }

  if (cfg.file.enabled) {
    if (storage) {
      registerFileTools(systemTools, { ...cfg.file, storage, cwdState });
      logger.use.info('文件工具已启用');
    } else {
      logger.use.warn('文件工具需要 storage 服务，已跳过注册');
    }
  }

  if (cfg.system.enabled) {
    const skipTimeTool = persona.present && !!persona.use.isTimeInjectionEnabled?.();
    registerSystemTools(systemTools, { cwdState, storage, skipTimeTool });
    logger.use.info(`系统工具已启用${skipTimeTool ? '（已由 persona 注入时间，跳过 system_time）' : ''}`);
  }

  if (cfg.http.enabled) {
    registerHttpTools(systemTools, { ...cfg.http, storage });
    logger.use.info('HTTP 工具已启用');
  }

  // 注册 /tools 指令以查看可用工具
  caps.commands.use.command('tools', '列出所有已注册的机器交互工具').action(async () => {
    const groups = (['shell', 'file', 'system', 'http'] as const).filter(g => cfg[g].enabled);
    const lines = ['📦 机器交互工具:', ...groups.map(g => `  ✅ ${g}`)];
    return lines.join('\n');
  });

  logger.use.info(`机器交互工具插件已启动 (工作目录: ${cwdUri})`);
}
