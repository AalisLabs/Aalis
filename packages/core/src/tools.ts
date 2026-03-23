import type {
  RegisteredTool,
  ToolDefinition,
  ToolCallContext,
} from './types.js';
import type { Logger } from './logger.js';

/**
 * 工具注册表 —— 管理 AI 可调用的工具
 *
 * - 插件通过 ctx.tools.register() 注册工具
 * - Agent 通过 getDefinitions() 获取可用工具列表发送给 LLM
 * - Agent 通过 execute() 执行 LLM 返回的工具调用
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child('tools');
  }

  /**
   * 注册一个工具
   */
  register(
    tool: Omit<RegisteredTool, 'pluginName'>,
    pluginName: string,
  ): () => void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) {
      this.logger.warn(`工具 "${name}" 已存在，将被覆盖 (来自 ${pluginName})`);
    }
    this.tools.set(name, { ...tool, pluginName });
    this.logger.debug(`注册工具: ${name} (来自 ${pluginName})`);

    return () => {
      if (this.tools.get(name)?.pluginName === pluginName) {
        this.tools.delete(name);
        this.logger.debug(`注销工具: ${name}`);
      }
    };
  }

  /**
   * 获取所有可用工具的定义（发送给 LLM 的格式）
   */
  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => t.definition);
  }

  /**
   * 执行工具调用
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return JSON.stringify({ error: `工具 "${toolName}" 未找到` });
    }

    try {
      const result = await tool.handler(args, callCtx);
      this.logger.debug(`工具 ${toolName} 执行成功`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`工具 ${toolName} 执行失败: ${message}`);
      return JSON.stringify({ error: message });
    }
  }

  /**
   * 按插件名移除所有工具
   */
  unregisterByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName) {
        this.tools.delete(name);
        this.logger.debug(`注销工具: ${name} (插件 ${pluginName} 卸载)`);
      }
    }
  }
}
