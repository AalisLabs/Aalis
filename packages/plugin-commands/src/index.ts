import type {
  Context,
  ToolService,
  AuthorityService,
  MemoryService,
  ConfigSchema,
  CommandDefinition,
  CommandContext,
  RegisteredCommand,
  CommandService,
  SafetyLevel,
  Logger,
  AppService,
} from '@aalis/core';

// ===== CommandRegistry 实现 =====

class CommandRegistry implements CommandService {
  private commands = new Map<string, RegisteredCommand>();
  private logger: Logger;
  private _authority?: AuthorityService;
  private overrides = new Map<string, { authority?: number; safety?: string }>();

  prefix = '/';
  onToolBridge?: (cmd: RegisteredCommand) => (() => void) | undefined;
  globalAsTools = false;

  constructor(logger: Logger) {
    this.logger = logger.child('commands');
  }

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void {
    this.overrides.clear();
    for (const [name, o] of Object.entries(overrides)) this.overrides.set(name, o);
  }

  setOverride(name: string, override: { authority?: number; safety?: string }): void {
    this.overrides.set(name, override);
  }

  removeOverride(name: string): void { this.overrides.delete(name); }

  getOverrides(): Record<string, { authority?: number; safety?: string }> {
    const result: Record<string, { authority?: number; safety?: string }> = {};
    for (const [name, o] of this.overrides) result[name] = o;
    return result;
  }

  setAuthority(authority: AuthorityService): void { this._authority = authority; }

  parseCommand(input: string): { name: string; args: string[]; raw: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (this.prefix) {
      if (!trimmed.startsWith(this.prefix)) return null;
      const rest = trimmed.slice(this.prefix.length);
      const parts = rest.split(/\s+/);
      const name = parts[0];
      if (!name) return null;
      return { name, args: parts.slice(1), raw: trimmed };
    }
    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    if (this.commands.has(name)) return { name, args: parts.slice(1), raw: trimmed };
    return null;
  }

  register(command: CommandDefinition, pluginName: string): () => void {
    const { name } = command;
    if (this.commands.has(name)) {
      this.logger.warn(`指令 "${this.prefix}${name}" 已存在，将被覆盖 (来自 ${pluginName})`);
    }
    const registered: RegisteredCommand = { ...command, pluginName };
    this.commands.set(name, registered);
    this.logger.debug(`注册指令: ${this.prefix}${name} (来自 ${pluginName})`);

    let toolDispose: (() => void) | undefined;
    if ((command.asTools || this.globalAsTools) && this.onToolBridge) {
      toolDispose = this.onToolBridge(registered);
    }

    return () => {
      if (this.commands.get(name)?.pluginName === pluginName) {
        this.commands.delete(name);
        toolDispose?.();
        this.logger.debug(`注销指令: ${this.prefix}${name}`);
      }
    };
  }

  has(name: string): boolean { return this.commands.has(name); }

  get(name: string): RegisteredCommand | undefined { return this.commands.get(name); }

  getAll(): RegisteredCommand[] { return [...this.commands.values()]; }

  async execute(name: string, cmdCtx: CommandContext): Promise<string | undefined> {
    const cmd = this.commands.get(name);
    if (!cmd) return `未知指令: ${this.prefix}${name}。输入 ${this.prefix}help 查看帮助。`;

    if (this._authority) {
      const userAuth = this._authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
      const override = this.overrides.get(name);
      const required = override?.authority ?? cmd.authority ?? 1;
      if (userAuth < required) {
        return `权限不足: 指令 ${this.prefix}${name} 需要权限等级 ${required}，您当前等级 ${userAuth}。`;
      }
      const safety = (override?.safety ?? cmd.safety ?? 'safe') as SafetyLevel;
      if (safety === 'dangerous' && !cmdCtx.skipSafetyCheck) {
        const confirmed = await this._authority.confirmDangerous({
          name,
          type: 'command',
          sessionId: cmdCtx.sessionId,
          platform: cmdCtx.platform,
        });
        if (!confirmed) return `已取消执行指令 ${this.prefix}${name}。`;
      }
    }

    try {
      const result = await cmd.action(cmdCtx);
      return result ?? undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`指令 ${this.prefix}${name} 执行失败: ${message}`);
      return `指令执行失败: ${message}`;
    }
  }

  unregisterByPlugin(pluginName: string): void {
    for (const [name, cmd] of this.commands) {
      if (cmd.pluginName === pluginName) {
        this.commands.delete(name);
        this.logger.debug(`注销指令: ${this.prefix}${name} (插件 ${pluginName} 卸载)`);
      }
    }
  }
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-commands';
export const provides = ['commands'];
export const inject = {
  optional: ['authority'],
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
  const commands = new CommandRegistry(ctx.logger);
  commands.prefix = (config.commandPrefix as string) ?? '/';
  commands.globalAsTools = (config.commandAsTools as boolean) ?? false;

  const cmdOverrides = ctx.config.get('commandOverrides');
  if (cmdOverrides) commands.loadOverrides(cmdOverrides);

  const authority = ctx.getService<AuthorityService>('authority');
  if (authority) commands.setAuthority(authority);

  ctx.on('service:registered', (svcName) => {
    if (svcName === 'authority') {
      const auth = ctx.getService<AuthorityService>('authority');
      if (auth) commands.setAuthority(auth);
    }
  });

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

  ctx.provide('commands', commands);

  // ===== 内置指令 =====

  // /help — 动态列出所有已注册指令
  ctx.command('help', '显示可用指令列表', async () => {
    const all = commands.getAll();
    const lines = ['**可用指令：**', ''];
    for (const cmd of all) {
      lines.push(`- \`${commands.prefix}${cmd.name}\` — ${cmd.description}`);
    }
    return lines.join('\n');
  });

  // /status — 显示系统状态
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

  // /shutdown — 关闭应用
  ctx.command('shutdown', '关闭应用', async () => {
    const app = ctx.getService<AppService>('app');
    if (!app) return '无法访问应用服务';
    setTimeout(async () => {
      await app.stop();
      process.exit(0);
    }, 500);
    return '正在关闭应用…';
  }, { authority: 5, safety: 'dangerous' });

  // /restart — 重启应用
  ctx.command('restart', '重启应用', async () => {
    const app = ctx.getService<AppService>('app');
    if (!app) return '无法访问应用服务';
    app.restart();
    return '正在重启应用…';
  }, { authority: 5, safety: 'dangerous' });

  // /clear — 清空记忆（支持子命令，子命令可通过 commandOverrides 独立配置权限）
  ctx.command('clear', '清空记忆 (可选: context/summary/vector/all/nuke)', async (cmdCtx) => {
    const scope = cmdCtx.args[0]?.toLowerCase() || 'all';
    const validScopes = ['all', 'context', 'summary', 'vector', 'nuke'];
    if (!validScopes.includes(scope)) {
      return `未知的清空范围: ${scope}。可用: ${validScopes.join(', ')}`;
    }

    const results: string[] = [];

    // nuke — 全局清空所有会话所有记忆
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

    // 清空上下文消息历史（当前会话）
    if (scope === 'all' || scope === 'context') {
      const memory = ctx.getService<MemoryService>('memory');
      if (memory) {
        await memory.clearSession(cmdCtx.sessionId);
        results.push('✅ 当前会话消息历史已清空');
      } else {
        results.push('⚠ 记忆服务不可用');
      }
    }

    // 清空摘要记忆（当前会话）
    if (scope === 'all' || scope === 'summary') {
      await ctx.emit('memory:clear-session', { sessionId: cmdCtx.sessionId, type: 'summary' });
      results.push('✅ 当前会话摘要记忆已清空');
    }

    // 清空向量记忆 + 归档（当前会话）
    if (scope === 'all' || scope === 'vector') {
      await ctx.emit('memory:clear-session', { sessionId: cmdCtx.sessionId, type: 'vector' });
      results.push('✅ 当前会话向量记忆已清空');
    }

    return results.join('\n');
  });
}
