import type {
  Context,
  ToolService,
  ConfigSchema,
  AppService,
  MemoryService,
} from '@aalis/core';
import { CommandRegistry } from './commands.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-commands';
export const displayName = '内置指令';
export const provides = ['commands'];
export const inject = {
  optional: ['tools'],
};

export const configSchema: ConfigSchema = {
  commandPrefix: {
    type: 'string',
    label: '指令前缀',
    default: '/',
    description: '指令触发前缀，设为空字符串可使用纯关键词触发',
  },
  commandAsTools: {
    type: 'boolean',
    label: '指令注册为工具',
    default: false,
    description: '全局开关：将所有指令自动注册为 AI 工具',
  },
};

export const defaultConfig = {
  commandPrefix: '/',
  commandAsTools: false,
};

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  // 创建指令注册表并注册为服务
  const commands = new CommandRegistry(ctx.logger);

  // 加载指令覆盖配置
  const cmdOverrides = ctx.config.get('commandOverrides');
  if (cmdOverrides) commands.loadOverrides(cmdOverrides as Record<string, { authority?: number; safety?: string }>);

  // 配置指令系统
  commands.prefix = (config.commandPrefix as string) ?? '/';
  commands.globalAsTools = (config.commandAsTools as boolean) ?? false;

  // 注册服务
  ctx.provide('commands', commands);

  // 指令→工具桥接
  commands.onToolBridge = (cmd) => {
    const tools = ctx.getService<ToolService>('tools');
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

  // ===== 内置指令 =====

  ctx.command('help', '显示可用指令列表', async () => {
    const all = commands.getAll();
    const lines = ['**可用指令：**', ''];
    for (const cmd of all) {
      lines.push(`- \`${commands.prefix}${cmd.name}\` — ${cmd.description}`);
    }
    return lines.join('\n');
  });

  ctx.command('status', '显示系统状态', async () => {
    const lines = ['**系统状态：**', ''];
    const checks = [
      ['WebUI Server', ctx.hasService('webui-server')],
      ['CLI', ctx.hasService('cli')],
      ['LLM 服务', ctx.hasService('llm')],
      ['Agent', ctx.hasService('agent')],
      ['记忆服务', ctx.hasService('memory')],
      ['人格服务', ctx.hasService('persona')],
      ['Embedding', ctx.hasService('embedding')],
      ['向量库', ctx.hasService('vectorstore')],
    ] as const;
    for (const [label, ok] of checks) {
      lines.push(`- ${label}: ${ok ? '✅ 可用' : '❌ 不可用'}`);
    }
    const tools = ctx.getService<ToolService>('tools');
    lines.push(`- 已注册工具: ${tools ? tools.getDefinitions().length : 0} 个`);
    lines.push(`- 已注册指令: ${commands.getAll().length} 个`);
    return lines.join('\n');
  });

  ctx.command('shutdown', '关闭应用', async () => {
    const app = ctx.getService<AppService>('app');
    if (!app) return '无法访问应用服务';
    setTimeout(async () => {
      await app.stop();
      process.exit(0);
    }, 500);
    return '正在关闭应用…';
  }, { authority: 5, safety: 'dangerous' });

  ctx.command('restart', '重启应用', async () => {
    const app = ctx.getService<AppService>('app');
    if (!app) return '无法访问应用服务';
    app.restart();
    return '正在重启应用…';
  }, { authority: 5, safety: 'dangerous' });

  ctx.command('clear', '清空记忆 (可选: context/summary/vector/all/nuke)', async (cmdCtx) => {
    const scope = cmdCtx.args[0]?.toLowerCase() || 'all';
    const validScopes = ['all', 'context', 'summary', 'vector', 'nuke'];
    if (!validScopes.includes(scope)) {
      return `未知的清空范围: ${scope}。可用: ${validScopes.join(', ')}`;
    }

    const results: string[] = [];

    if (scope === 'nuke') {
      const memory = ctx.getService<MemoryService>('memory');
      if (memory?.clearAll) {
        await memory.clearAll();
        results.push('✅ 所有消息历史和对话归档已清空');
      } else if (memory) {
        results.push('⚠ 记忆服务不支持全局清空');
      } else {
        results.push('⚠ 记忆服务不可用');
      }
      await ctx.emit('memory:clear-all', {});
      results.push('✅ 所有摘要记忆已清空');
      results.push('✅ 所有向量记忆已清空');
      return results.join('\n');
    }

    if (scope === 'all' || scope === 'context') {
      const memory = ctx.getService<MemoryService>('memory');
      if (memory) {
        await memory.clearSession(cmdCtx.sessionId);
        results.push('✅ 当前会话消息历史已清空');
      } else {
        results.push('⚠ 记忆服务不可用');
      }
    }

    if (scope === 'all' || scope === 'summary') {
      await ctx.emit('memory:clear-session', { sessionId: cmdCtx.sessionId, type: 'summary' });
      results.push('✅ 当前会话摘要记忆已清空');
    }

    if (scope === 'all' || scope === 'vector') {
      await ctx.emit('memory:clear-session', { sessionId: cmdCtx.sessionId, type: 'vector' });
      results.push('✅ 当前会话向量记忆已清空');
    }

    return results.join('\n');
  });
}
