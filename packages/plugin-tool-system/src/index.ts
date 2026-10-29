import { commands } from '@aalis/api-commands';
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, logger, optional } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { textLines } from '@aalis/schema-i18n';
import { t } from './texts.js';
import { CwdState } from './tools/cwd-state.js';
import { registerFileTools } from './tools/file.js';
import { registerHttpTools } from './tools/http.js';
import { registerShellTools } from './tools/shell.js';
import { registerSystemTools } from './tools/system.js';

const configSchema = defineConfig({
  workingDirectory: {
    type: 'string',
    label: t('workingDirectoryLabel'),
    default: 'workspace:/',
    onInvalid: 'error',
    description: t('workingDirectoryDescription'),
  },
  shell: {
    label: t('shellLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('shellEnabledLabel'), default: true, onInvalid: 'error' },
      maxOutputSize: { type: 'number', label: t('maxOutputSizeLabel'), default: 65536 },
    },
  },
  file: {
    label: t('fileLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('fileEnabledLabel'), default: true, onInvalid: 'error' },
      maxReadSize: { type: 'number', label: t('maxReadSizeLabel'), default: 1048576 },
      maxSearchBytes: { type: 'number', label: t('maxSearchBytesLabel'), default: 1048576 },
      maxWriteSize: { type: 'number', label: t('maxWriteSizeLabel'), default: 10485760 },
      allowedRoots: {
        type: 'multiselect',
        label: t('allowedRootsLabel'),
        default: ['workspace', 'tmp'],
        onInvalid: 'error',
        description: t('allowedRootsDescription'),
        options: [
          { label: t('rootAllReadable'), value: '*' },
          { label: 'Workspace', value: 'workspace' },
          { label: t('rootTmp'), value: 'tmp' },
          { label: 'Data', value: 'data' },
          { label: t('rootPluginData'), value: 'pluginData' },
          { label: t('rootLogs'), value: 'logs' },
        ],
        allowCustom: true,
      },
    },
  },
  system: {
    label: t('displayName'),
    fields: {
      enabled: { type: 'boolean', label: t('systemEnabledLabel'), default: true, onInvalid: 'error' },
    },
  },
  http: {
    label: t('httpLabel'),
    fields: {
      enabled: { type: 'boolean', label: t('httpEnabledLabel'), default: true, onInvalid: 'error' },
      defaultTimeout: {
        type: 'number',
        label: t('defaultTimeoutLabel'),
        default: 30000,
        description: t('defaultTimeoutDescription'),
      },
      maxResponseSize: { type: 'number', label: t('maxResponseSizeLabel'), default: 1048576 },
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
  storage: optional(storage),
  process: optional(processService),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-tool-system',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  uses,
  apply: registerSystemToolset,
});

function registerSystemToolset(caps: Caps): void {
  const { tools, logger } = caps;
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
    label: t('displayName'),
    summary: t('groupSummary'),
    description: 'Shell 命令执行、文件操作、系统信息查询、HTTP 请求等系统级工具',
  });

  // 业务句柄每次调用打到当时选中的那一家，四个工具组共用一份即可
  const storage = caps.storage.present ? caps.storage.use : undefined;

  // 注册各工具组；/tools 列这里真正注册了的组（开关开着、缺服务而跳过的不算）
  const registered: string[] = [];
  if (cfg.shell.enabled) {
    if (storage && caps.process.present) {
      registerShellTools(systemTools, {
        logger: logger.use,
        cwdUri,
        storage,
        proc: caps.process.use,
        maxOutputSize: cfg.shell.maxOutputSize,
      });
      registered.push('shell');
      logger.use.info('Shell 工具已启用');
    } else {
      logger.use.warn('Shell 工具需要 storage 与 process 服务，已跳过注册');
    }
  }

  if (cfg.file.enabled) {
    if (storage) {
      registerFileTools(systemTools, { ...cfg.file, storage, cwdState });
      registered.push('file');
      logger.use.info('文件工具已启用');
    } else {
      logger.use.warn('文件工具需要 storage 服务，已跳过注册');
    }
  }

  if (cfg.system.enabled) {
    registerSystemTools(systemTools, { cwdState, storage });
    registered.push('system');
    logger.use.info('系统工具已启用');
  }

  if (cfg.http.enabled) {
    registerHttpTools(systemTools, { ...cfg.http, storage });
    registered.push('http');
    logger.use.info('HTTP 工具已启用');
  }

  // 注册 /tools 指令以查看可用工具
  caps.commands.use
    .command('tools', t('toolsDescription'))
    .action(async () => textLines([t('toolsHeading'), ...registered.map(g => `  ${g}`)]));

  logger.use.info(`机器交互工具插件已启动 (工作目录: ${cwdUri})`);
}
