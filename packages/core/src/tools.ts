import type {
  RegisteredTool,
  ToolDefinition,
  ToolCallContext,
  ToolSummary,
  SafetyLevel,
} from './types.js';
import type { AuthorityManager } from './authority.js';
import type { Logger } from './logger.js';

/**
 * 工具注册表 —— 管理 AI 可调用的工具
 *
 * - 插件通过 ctx.tools.register() 注册工具
 * - Agent 通过 getDefinitions() 获取可用工具列表发送给 LLM
 * - Agent 通过 execute() 执行 LLM 返回的工具调用
 * - 集成权限检查 (authority + dangerous 白名单)
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private _overrides = new Map<string, { authority?: number; safety?: string }>();
  private logger: Logger;
  private _authority?: AuthorityManager;

  constructor(logger: Logger) {
    this.logger = logger.child('tools');
  }

  /** 设置权限管理器（由 App 初始化时注入） */
  setAuthority(authority: AuthorityManager): void {
    this._authority = authority;
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
   * 获取所有工具的摘要信息（名称、描述、权限、安全级别）
   * 已应用覆盖
   */
  getSummaries(): ToolSummary[] {
    return [...this.tools.values()].map(t => {
      const name = t.definition.function.name;
      const o = this._overrides.get(name);
      return {
        name,
        description: t.definition.function.description,
        authority: o?.authority ?? t.authority ?? 1,
        safety: (o?.safety as SafetyLevel) ?? t.safety ?? 'safe',
      };
    });
  }

  /**
   * 获取所有已注册工具的详细信息（供权限管理 UI 使用）
   */
  getAll(): Array<{
    name: string;
    description: string;
    authority: number;
    safety: string;
    baseAuthority: number;
    baseSafety: string;
    overridden: boolean;
    pluginName: string;
  }> {
    return [...this.tools.values()].map(t => {
      const name = t.definition.function.name;
      const o = this._overrides.get(name);
      return {
        name,
        description: t.definition.function.description,
        authority: o?.authority ?? t.authority ?? 1,
        safety: o?.safety ?? t.safety ?? 'safe',
        baseAuthority: t.authority ?? 1,
        baseSafety: t.safety ?? 'safe',
        overridden: !!o,
        pluginName: t.pluginName,
      };
    });
  }

  // ---- 覆盖管理 ----

  setOverride(name: string, override: { authority?: number; safety?: string }): void {
    this._overrides.set(name, override);
  }

  removeOverride(name: string): void {
    this._overrides.delete(name);
  }

  getOverrides(): Record<string, { authority?: number; safety?: string }> {
    const result: Record<string, { authority?: number; safety?: string }> = {};
    for (const [name, o] of this._overrides) {
      result[name] = o;
    }
    return result;
  }

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void {
    this._overrides.clear();
    for (const [name, o] of Object.entries(overrides)) {
      this._overrides.set(name, o);
    }
  }

  /**
   * 执行工具调用
   *
   * 权限检查流程 (AI 继承调用者权限):
   * 1. 检查用户 authority >= 工具要求
   * 2. 检查 dangerous 工具是否在白名单中
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

    // 权限检查（覆盖优先）
    if (this._authority) {
      const userAuth = this._authority.getAuthority(
        callCtx.platform ?? 'unknown',
        callCtx.userId,
      );
      const override = this._overrides.get(toolName);
      const required = override?.authority ?? tool.authority ?? 1;
      if (userAuth < required) {
        return JSON.stringify({
          error: `权限不足: 工具 "${toolName}" 需要权限等级 ${required}，当前用户等级 ${userAuth}`,
        });
      }

      // dangerous 检查
      const effectiveSafety = override?.safety ?? tool.safety ?? 'safe';
      if (effectiveSafety === 'dangerous') {
        const confirmed = await this._authority.confirmDangerous({
          name: toolName,
          type: 'tool',
          args,
          sessionId: callCtx.sessionId,
          platform: callCtx.platform ?? 'unknown',
        });
        if (!confirmed) {
          return JSON.stringify({
            error: `拒绝执行: 工具 "${toolName}" 被标记为高危操作，需要用户确认后才能执行`,
          });
        }
      }
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
