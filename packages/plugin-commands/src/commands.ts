import type {
  CommandDefinition,
  RegisteredCommand,
  CommandContext,
  CommandService,
  SafetyLevel,
  ExecutionGuard,
} from '@aalis/core';
import type { Logger } from '@aalis/core';

/**
 * 指令注册表 —— 管理用户可调用的斜杠指令的注册、解析、执行
 *
 * 由 plugin-commands 创建并注册为服务 'commands'，
 * 所有插件通过 ctx.command() 注册指令，通过 ctx.commands 访问。
 */
export class CommandRegistry implements CommandService {
  private commands = new Map<string, RegisteredCommand>();
  private logger: Logger;
  private _guard?: ExecutionGuard;
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

  setExecutionGuard(guard: ExecutionGuard): void { this._guard = guard; }

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

    if (this._guard) {
      const override = this.overrides.get(name);
      const rejection = await this._guard({
        name,
        type: 'command',
        authority: override?.authority ?? cmd.authority ?? 1,
        safety: (override?.safety ?? cmd.safety ?? 'safe') as SafetyLevel,
        sessionId: cmdCtx.sessionId,
        platform: cmdCtx.platform,
        userId: cmdCtx.userId,
        skipSafetyCheck: cmdCtx.skipSafetyCheck,
      });
      if (rejection) return rejection;
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
