import { ToolRegistry } from '../tools.js';
import type { Context } from '../context.js';
import type { PluginModule } from '../plugin.js';

/**
 * 内置插件：工具注册表
 *
 * 提供 'tools' 服务，管理 AI 可调用的工具。
 * 依赖 authority 服务进行权限检查。
 */
const builtinTools: PluginModule = {
  name: '@aalis/builtin-tools',
  core: true,
  provides: ['tools'],
  inject: { required: ['authority'] },
  apply(ctx: Context) {
    const tools = new ToolRegistry(ctx.logger);

    // 加载管理员对工具的覆盖配置
    const toolOverrides = ctx.config.get('toolOverrides');
    if (toolOverrides) tools.loadOverrides(toolOverrides);

    // 注入权限管理器
    tools.setAuthority(ctx.authority);

    ctx.provide('tools', tools);
  },
};

export default builtinTools;
