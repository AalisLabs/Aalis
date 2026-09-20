import { tools } from '@aalis/api-tools';
import { definePlugin, logger, provide } from '@aalis/core';
import { ToolRegistry } from './tools.js';

export default definePlugin({
  name: '@aalis/plugin-tools',
  displayName: '工具注册表',
  subsystem: 'agent',
  provides: [tools],
  uses: { logger, provide },
  apply({ logger, provide }) {
    provide(tools, new ToolRegistry(logger));
  },
});
