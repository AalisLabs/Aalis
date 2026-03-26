import type {
  Context,
  AuthorityService,
  ToolService,
  RegisteredTool,
  ToolDefinition,
  ToolCallContext,
  ToolSummary,
  ToolGroupInfo,
  SafetyLevel,
  Logger,
} from '@aalis/core';

// ===== ToolRegistry 实现 =====

class ToolRegistry implements ToolService {
  private tools = new Map<string, RegisteredTool>();
  private _overrides = new Map<string, { authority?: number; safety?: string }>();
  private _groups = new Map<string, ToolGroupInfo>();
  private logger: Logger;
  private _authority?: AuthorityService;

  constructor(logger: Logger) {
    this.logger = logger.child('tools');
  }

  setAuthority(authority: AuthorityService): void { this._authority = authority; }

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

    if (this._authority) {
      const userAuth = this._authority.getAuthority(callCtx.platform ?? 'unknown', callCtx.userId);
      const override = this._overrides.get(toolName);
      const required = override?.authority ?? tool.authority ?? 1;
      if (userAuth < required) {
        return JSON.stringify({
          error: `权限不足: 工具 "${toolName}" 需要权限等级 ${required}，当前用户等级 ${userAuth}`,
        });
      }
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
          return JSON.stringify({ error: `用户已取消执行工具 "${toolName}"` });
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

  unregisterByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName) {
        this.tools.delete(name);
        this.logger.debug(`注销工具: ${name} (插件 ${pluginName} 卸载)`);
      }
    }
  }
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-agent-tools';
export const provides = ['tools'];
export const inject = {
  optional: ['authority'],
};

// ===== 插件入口 =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const tools = new ToolRegistry(ctx.logger);

  const toolOverrides = ctx.config.get('toolOverrides');
  if (toolOverrides) tools.loadOverrides(toolOverrides);

  const authority = ctx.getService<AuthorityService>('authority');
  if (authority) tools.setAuthority(authority);

  ctx.on('service:registered', (svcName) => {
    if (svcName === 'authority') {
      const auth = ctx.getService<AuthorityService>('authority');
      if (auth) tools.setAuthority(auth);
    }
  });

  ctx.provide('tools', tools);
}
