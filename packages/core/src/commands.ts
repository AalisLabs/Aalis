import type { CommandDefinition, CommandContext, RegisteredCommand } from './types.js';
import type { AuthorityManager } from './authority.js';
import type { Logger } from './logger.js';

/**
 * 指令注册表 —— 管理用户可调用的斜杠指令
 *
 * 设计参考 internal-framework 的 ctx.command() 模型：
 * - 插件通过 ctx.command() 注册指令
 * - 平台插件 (CLI, WebUI) 通过 commands.execute() 执行指令
 * - 插件卸载时自动清理其注册的指令
 * - 集成权限检查 (authority + dangerous 白名单)
 */
export class CommandRegistry {
  private commands = new Map<string, RegisteredCommand>();
  private logger: Logger;
  private _authority?: AuthorityManager;

  /** 管理员对单条指令的权限/安全等级覆盖 */
  private overrides = new Map<string, { authority?: number; safety?: string }>();

  /** 指令前缀，默认 '/'，可设为空字符串（纯关键词触发） */
  prefix = '/';

  /** 当指令声明 asTools 时，通知外部注册工具的回调 */
  onToolBridge?: (cmd: RegisteredCommand) => (() => void) | undefined;

  /** 全局开关：是否将所有指令自动注册为 AI 工具 */
  globalAsTools = false;

  constructor(logger: Logger) {
    this.logger = logger.child('commands');
  }

  /** 批量加载覆盖配置 */
  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void {
    this.overrides.clear();
    for (const [name, o] of Object.entries(overrides)) {
      this.overrides.set(name, o);
    }
  }

  /** 设置单条指令的覆盖 */
  setOverride(name: string, override: { authority?: number; safety?: string }): void {
    this.overrides.set(name, override);
  }

  /** 移除单条指令的覆盖 */
  removeOverride(name: string): void {
    this.overrides.delete(name);
  }

  /** 获取所有覆盖配置 */
  getOverrides(): Record<string, { authority?: number; safety?: string }> {
    const result: Record<string, { authority?: number; safety?: string }> = {};
    for (const [name, o] of this.overrides) {
      result[name] = o;
    }
    return result;
  }

  /** 设置权限管理器（由 App 初始化时注入） */
  setAuthority(authority: AuthorityManager): void {
    this._authority = authority;
  }

  /**
   * 尝试将用户输入解析为指令调用
   *
   * - 当 prefix 非空时，输入必须以 prefix 开头才视为指令
   * - 当 prefix 为空时，尝试用第一个词匹配已注册的指令名
   *
   * @returns 解析结果，null 表示非指令
   */
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    if (this.prefix) {
      // 前缀模式
      if (!trimmed.startsWith(this.prefix)) return null;
      const rest = trimmed.slice(this.prefix.length);
      const parts = rest.split(/\s+/);
      const name = parts[0];
      if (!name) return null;
      return { name, args: parts.slice(1), raw: trimmed };
    }

    // 无前缀模式：第一个词匹配已注册指令名
    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    if (this.commands.has(name)) {
      return { name, args: parts.slice(1), raw: trimmed };
    }
    return null;
  }

  /**
   * 注册一个指令
   */
  register(command: CommandDefinition, pluginName: string): () => void {
    const { name } = command;
    if (this.commands.has(name)) {
      this.logger.warn(`指令 "${this.prefix}${name}" 已存在，将被覆盖 (来自 ${pluginName})`);
    }
    const registered: RegisteredCommand = { ...command, pluginName };
    this.commands.set(name, registered);
    this.logger.debug(`注册指令: ${this.prefix}${name} (来自 ${pluginName})`);

    // asTools: 自动注册为 AI 工具（单指令 asTools 或全局 commandAsTools）
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

  /**
   * 是否已注册某指令
   */
  has(name: string): boolean {
    return this.commands.has(name);
  }

  /**
   * 获取单个指令定义
   */
  get(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * 获取所有已注册的指令
   */
  getAll(): RegisteredCommand[] {
    return [...this.commands.values()];
  }

  /**
   * 执行指令
   *
   * 权限检查流程:
   * 1. 检查用户 authority 是否 >= 指令要求
   * 2. 检查 dangerous 指令是否在白名单中
   *
   * @returns 指令返回的文本，或 undefined 表示指令自行处理了输出
   *          未找到指令时返回错误提示文本
   */
  async execute(name: string, cmdCtx: CommandContext): Promise<string | undefined> {
    const cmd = this.commands.get(name);
    if (!cmd) {
      return `未知指令: ${this.prefix}${name}。输入 ${this.prefix}help 查看帮助。`;
    }

    // 权限检查
    if (this._authority) {
      const userAuth = this._authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
      const override = this.overrides.get(name);
      const required = override?.authority ?? cmd.authority ?? 1;
      if (userAuth < required) {
        return `权限不足: 指令 ${this.prefix}${name} 需要权限等级 ${required}，您当前等级 ${userAuth}。`;
      }

      // dangerous 检查（skipSafetyCheck 时跳过，避免工具桥接双重确认）
      const safety = override?.safety ?? cmd.safety ?? 'safe';
      if (safety === 'dangerous' && !cmdCtx.skipSafetyCheck) {
        const confirmed = await this._authority.confirmDangerous({
          name,
          type: 'command',
          sessionId: cmdCtx.sessionId,
          platform: cmdCtx.platform,
        });
        if (!confirmed) {
          return `已取消执行指令 ${this.prefix}${name}。`;
        }
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

  /**
   * 按插件名移除所有指令
   */
  unregisterByPlugin(pluginName: string): void {
    for (const [name, cmd] of this.commands) {
      if (cmd.pluginName === pluginName) {
        this.commands.delete(name);
        this.logger.debug(`注销指令: ${this.prefix}${name} (插件 ${pluginName} 卸载)`);
      }
    }
  }
}
