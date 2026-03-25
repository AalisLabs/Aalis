import { AuthorityManager } from '../authority.js';
import type { Context } from '../context.js';
import type { PluginModule } from '../plugin.js';

/**
 * 内置插件：权限管理器
 *
 * 提供 'authority' 服务，负责用户权限等级管理和高危操作确认。
 * 其他内置插件（commands, tools）依赖此服务进行权限检查。
 */
const builtinAuthority: PluginModule = {
  name: '@aalis/builtin-authority',
  core: true,
  provides: ['authority'],
  webuiPages: [
    { key: 'authority', label: '权限管理', icon: 'authority', order: 50 },
  ],
  apply(ctx: Context) {
    const authority = new AuthorityManager(ctx.config, ctx.logger);
    ctx.provide('authority', authority);
  },
};

export default builtinAuthority;
