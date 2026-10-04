import { sessionManager } from '@aalis/api-session-manager';
import { tools } from '@aalis/api-tools';
import { definePlugin, logger, optional, provide } from '@aalis/core';
import { ToolRegistry } from './tools.js';

export default definePlugin({
  name: '@aalis/plugin-tools',
  displayName: '工具注册表',
  subsystem: 'agent',
  provides: [tools],
  /** 会话设置项「工具分组」登记在会话管理上；没有会话管理时各会话只拿到不属于任何分组的工具 */
  uses: { logger, provide, sessionManager: optional(sessionManager) },
  apply({ logger, provide, sessionManager }) {
    sessionManager.registerSetting({
      key: 'enabledToolGroups',
      field: {
        type: 'multiselect',
        label: '工具分组',
        dynamicOptions: 'toolGroups',
        allowCustom: true,
        description: '这个会话能用的工具分组，* 为全部；没设置或为空时只给不属于任何分组的工具',
      },
      appliesTo: ['owner', 'room', 'task'],
      prominence: 'common',
      order: 30,
      unset: '只给不属于任何分组的工具',
    });
    provide(tools, new ToolRegistry(logger));
  },
});
