import type {
  RegisteredTool,
  ToolDefinition,
  ToolCallContext,
  ToolSummary,
  ToolGroupInfo,
  SafetyLevel,
  ToolService,
  ExecutionGuard,
} from '@aalis/core';
import type { Logger } from '@aalis/core';

/**
 * 工具注册表 —— 管理 AI 可调用工具的注册、查询、执行
 *
 * 由 plugin-agent-tools 创建并注册为服务 'tools'，
 * 所有插件通过 ctx.registerTool() 注册工具，通过 ctx.tools 访问。
 */
export class ToolRegistry implements ToolService {
  private tools = new Map<string, RegisteredTool>();
  private _overrides = new Map<string, { authority?: number; safety?: string }>();
  private _groups = new Map<string, ToolGroupInfo>();
  private logger: Logger;
  private _guard?: ExecutionGuard;

  constructor(logger: Logger) {
    this.logger = logger.child('tools');
  }

  setExecutionGuard(guard: ExecutionGuard): void { this._guard = guard; }

  register(tool: Omit<RegisteredTool, 'pluginName'>, pluginName: string): () => void {
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

  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[] {
    const tools = [...this.tools.values()];
    if (filter?.groups && filter.groups.length > 0) {
      const enabledGroups = new Set(filter.groups);
      return tools
        .filter(t => !t.groups || t.groups.length === 0 || t.groups.some(g => enabledGroups.has(g)))
        .map(t => t.definition);
    }
    return tools.map(t => t.definition);
  }

  getSummaries(): ToolSummary[] {
    return [...this.tools.values()].map(t => {
      const name = t.definition.function.name;
      const o = this._overrides.get(name);
      return {
        name,
        description: t.definition.function.description,
        authority: o?.authority ?? t.authority ?? 1,
        safety: (o?.safety as SafetyLevel) ?? t.safety ?? 'safe',
        groups: t.groups,
      };
    });
  }

  getAll(): Array<{
    name: string;
    description: string;
    authority: number;
    safety: string;
    baseAuthority: number;
    baseSafety: string;
    overridden: boolean;
    pluginName: string;
    groups?: string[];
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
        groups: t.groups,
      };
    });
  }

  setOverride(name: string, override: { authority?: number; safety?: string }): void {
    this._overrides.set(name, override);
  }

  removeOverride(name: string): void { this._overrides.delete(name); }

  getOverrides(): Record<string, { authority?: number; safety?: string }> {
    const result: Record<string, { authority?: number; safety?: string }> = {};
    for (const [name, o] of this._overrides) result[name] = o;
    return result;
  }

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void {
    this._overrides.clear();
    for (const [name, o] of Object.entries(overrides)) this._overrides.set(name, o);
  }

  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void {
    const info: ToolGroupInfo = { ...group, pluginName };
    this._groups.set(group.name, info);
    this.logger.debug(`注册工具分组: ${group.name} (来自 ${pluginName})`);
    return () => {
      if (this._groups.get(group.name)?.pluginName === pluginName) {
        this._groups.delete(group.name);
        this.logger.debug(`注销工具分组: ${group.name}`);
      }
    };
  }

  getGroups(): ToolGroupInfo[] {
    return [...this._groups.values()];
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) return JSON.stringify({ error: `工具 "${toolName}" 未找到` });

    if (this._guard) {
      const override = this._overrides.get(toolName);
      const rejection = await this._guard({
        name: toolName,
        type: 'tool',
        authority: override?.authority ?? tool.authority ?? 1,
        safety: (override?.safety ?? tool.safety ?? 'safe') as SafetyLevel,
        sessionId: callCtx.sessionId,
        platform: callCtx.platform ?? 'unknown',
        userId: callCtx.userId,
        args,
      });
      if (rejection) return JSON.stringify({ error: rejection });
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

  unregisterByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName) {
        this.tools.delete(name);
        this.logger.debug(`注销工具: ${name} (插件 ${pluginName} 卸载)`);
      }
    }
    for (const [name, group] of this._groups) {
      if (group.pluginName === pluginName) {
        this._groups.delete(name);
      }
    }
  }
}
