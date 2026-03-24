import type { CommandDefinition, CommandContext, RegisteredCommand } from './types.js';
import type { Logger } from './logger.js';

/**
 * 指令注册表 —— 管理用户可调用的斜杠指令
 *
 * 设计参考 internal-framework 的 ctx.command() 模型：
 * - 插件通过 ctx.command() 注册指令
 * - 平台插件 (CLI, WebUI) 通过 commands.execute() 执行指令
 * - 插件卸载时自动清理其注册的指令
 */
export class CommandRegistry {
  private commands = new Map<string, RegisteredCommand>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child('commands');
  }

  /**
   * 注册一个指令
   */
  register(command: CommandDefinition, pluginName: string): () => void {
    const { name } = command;
    if (this.commands.has(name)) {
      this.logger.warn(`指令 "/${name}" 已存在，将被覆盖 (来自 ${pluginName})`);
    }
    this.commands.set(name, { ...command, pluginName });
    this.logger.debug(`注册指令: /${name} (来自 ${pluginName})`);

    return () => {
      if (this.commands.get(name)?.pluginName === pluginName) {
        this.commands.delete(name);
        this.logger.debug(`注销指令: /${name}`);
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
   * @returns 指令返回的文本，或 undefined 表示指令自行处理了输出
   *          未找到指令时返回错误提示文本
   */
  async execute(name: string, cmdCtx: CommandContext): Promise<string | undefined> {
    const cmd = this.commands.get(name);
    if (!cmd) {
      return `未知指令: /${name}。输入 /help 查看帮助。`;
    }

    try {
      const result = await cmd.action(cmdCtx);
      return result ?? undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`指令 /${name} 执行失败: ${message}`);
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
        this.logger.debug(`注销指令: /${name} (插件 ${pluginName} 卸载)`);
      }
    }
  }
}
