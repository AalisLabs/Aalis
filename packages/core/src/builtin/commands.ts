import { CommandRegistry } from '../commands.js';
import type { ToolRegistry } from '../tools.js';
import type { Context } from '../context.js';
import type { PluginModule } from '../plugin.js';

/**
 * 内置插件：指令注册表
 *
 * 提供 'commands' 服务，管理用户可调用的斜杠指令。
 * 依赖 authority 服务进行权限检查，可选使用 tools 服务做指令→工具桥接。
 */
const builtinCommands: PluginModule = {
  name: '@aalis/builtin-commands',
  core: true,
  provides: ['commands'],
  inject: { required: ['authority'] },
  apply(ctx: Context) {
    const commands = new CommandRegistry(ctx.logger);
    commands.prefix = ctx.config.get('commandPrefix') ?? '/';
    commands.globalAsTools = ctx.config.get('commandAsTools') ?? false;

    // 加载管理员对指令的覆盖配置
    const cmdOverrides = ctx.config.get('commandOverrides');
    if (cmdOverrides) commands.loadOverrides(cmdOverrides);

    // 注入权限管理器
    commands.setAuthority(ctx.authority);

    // 指令 → 工具桥接: 当指令声明 asTools 时自动注册为 AI 工具（延迟查找 tools 服务）
    commands.onToolBridge = (cmd) => {
      const tools = ctx.getService<ToolRegistry>('tools');
      if (!tools) return undefined;
      return tools.register(
        {
          definition: {
            type: 'function' as const,
            function: {
              name: `cmd_${cmd.name}`,
              description: `[指令] ${cmd.description}`,
              parameters: {
                type: 'object',
                properties: {
                  args: { type: 'string', description: '指令参数(空格分隔)' },
                },
                required: [],
              },
            },
          },
          handler: async (args, callCtx) => {
            const argsStr = typeof args.args === 'string' ? args.args : '';
            const result = await commands.execute(cmd.name, {
              args: argsStr ? argsStr.split(/\s+/) : [],
              raw: `${commands.prefix}${cmd.name}${argsStr ? ' ' + argsStr : ''}`,
              sessionId: callCtx.sessionId,
              platform: callCtx.platform ?? 'unknown',
              userId: callCtx.userId,
              skipSafetyCheck: true,
            });
            return result ?? '(指令已执行)';
          },
          safety: cmd.safety,
          authority: cmd.authority,
        },
        cmd.pluginName,
      );
    };

    ctx.provide('commands', commands);
  },
};

export default builtinCommands;
