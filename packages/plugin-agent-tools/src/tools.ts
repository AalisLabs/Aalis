import type { RegisteredTool, ToolDefinition, ToolCallContext, ToolSummary, ToolGroupInfo, ExecutionGuard } from '@aalis/core';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { Logger } from '@aalis/core';

/**
 * 工具注册表 —— 管理 AI 可调用工具的注册、查询、执行
 *
 * 由 plugin-agent-tools 创建并注册为服务 'tools'，
 * 所有插件通过 ctx.registerTool() 注册工具，通过 ctx.getService<ToolService>('tools') 访问。
 *
 * 与 plugin-commands/CommandRegistry 同属"中心 Registry 模式"：
 * - 单一 Map<name, Registered> 存储，name 全局唯一（重名警告并覆盖）
 * - register() 返回 disposer，插件 dispose 时按 pluginName 自动注销
 * - 通过 setExecutionGuard() 注入统一权限/安全检查钩子
 *
 * 与 LLM/Storage/Platform 路由器（同名 facade 模式）的差异：
 * - 这里没有"多个底层 provider"概念——所有工具都直接落到这个 Map
 * - 因此不需要 ctx.getAllServices('tools') 枚举，也不需要 'router' capability
 */
export class ToolRegistry implements ToolService {
  private tools = new Map<string, RegisteredTool>();
  private _groups = new Map<string, ToolGroupInfo>();
  private logger: Logger;
  private _guard?: ExecutionGuard;

  constructor(logger: Logger) {
    this.logger = logger.child('tools');
  }

  // ---- 注册 / 注销 ----

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

  // ---- 查询 ----

  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[] {
    const tools = [...this.tools.values()];
    if (filter?.groups && filter.groups.length > 0) {
      const enabledGroups = new Set(filter.groups);
      return tools
        .filter(t => !t.groups || t.groups.length === 0 || t.groups.some(g => enabledGroups.has(g)))
        .map(t => t.definition);
    }
    // 未指定分组时，只返回无分组（通用）工具；有分组的工具需要显式启用
    return tools
      .filter(t => !t.groups || t.groups.length === 0)
      .map(t => t.definition);
  }

  getSummaries(filter?: { groups?: string[] }): ToolSummary[] {
    let tools = [...this.tools.values()];
    if (filter?.groups && filter.groups.length > 0) {
      const enabledGroups = new Set(filter.groups);
      tools = tools.filter(t => !t.groups || t.groups.length === 0 || t.groups.some(g => enabledGroups.has(g)));
    } else {
      // 未指定分组时，只返回无分组（通用）工具
      tools = tools.filter(t => !t.groups || t.groups.length === 0);
    }
    return tools.map(t => {
      return {
        name: t.definition.function.name,
        description: t.definition.function.description,
        groups: t.groups,
        permissions: this.getStaticPermissions(t),
      };
    });
  }

  getAll(): Array<{
    name: string;
    description: string;
    pluginName: string;
    authority?: number;
    safety?: import('@aalis/core').SafetyLevel;
    permissions?: string[];
    groups?: string[];
  }> {
    return [...this.tools.values()].map(t => {
      return {
        name: t.definition.function.name,
        description: t.definition.function.description,
        pluginName: t.pluginName,
        authority: t.authority,
        safety: t.safety,
        permissions: this.getStaticPermissions(t),
        groups: t.groups,
      };
    });
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

  // ---- 执行 ----

  setExecutionGuard(guard: ExecutionGuard): void {
    this._guard = guard;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) return JSON.stringify({ error: `工具 "${toolName}" 未找到` });

    // 参数 schema 校验：检测缺失必填项 / 多余未知键（LLM 写错参数名时给出明确提示）
    const schemaError = validateToolArgs(toolName, tool.definition, args);
    if (schemaError) {
      this.logger.warn(`工具 ${toolName} 参数校验失败: ${schemaError}`);
      return JSON.stringify({ error: schemaError });
    }

    const authority = tool.authority ?? 1;
    const safety = tool.safety ?? 'safe';
    let permissions: string[];
    try {
      permissions = await this.resolvePermissions(tool, args, callCtx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`工具 ${toolName} 权限解析失败: ${message}`);
      return JSON.stringify({ error: message });
    }
    if (this._guard) {
      const denied = await this._guard({
        name: toolName,
        type: 'tool',
        authority,
        safety,
        permissions,
        sessionId: callCtx.sessionId,
        platform: callCtx.platform ?? 'unknown',
        userId: callCtx.userId,
        args,
      });
      if (denied) {
        this.logger.warn(`工具 ${toolName} 被执行守卫拦截: ${denied}`);
        return JSON.stringify({ error: denied });
      }
    }

    try {
      if (safety === 'dangerous') {
        this.logger.info(`危险工具执行: ${toolName} session=${callCtx.sessionId} platform=${callCtx.platform ?? 'unknown'} args=${JSON.stringify(args)}`);
      }
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

  // ---- 内部 ----

  private getStaticPermissions(tool: RegisteredTool): string[] {
    return unique([`tool:${tool.definition.function.name}`, ...(tool.permissions ?? [])]);
  }

  private async resolvePermissions(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<string[]> {
    const dynamic = tool.resolvePermissions ? await tool.resolvePermissions(args, callCtx) : [];
    return unique([...this.getStaticPermissions(tool), ...dynamic]);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 轻量工具参数校验：
 * - 检测 required 字段是否缺失
 * - 当 additionalProperties === false 时，检测不在 properties 里的多余键
 *
 * 返回错误字符串（有问题时），或 null（通过）。
 */
function validateToolArgs(toolName: string, definition: ToolDefinition, args: Record<string, unknown>): string | null {
  const params = definition.function.parameters;
  if (!params || typeof params !== 'object') return null;

  const properties = params.properties as Record<string, unknown> | undefined;
  const required = params.required as string[] | undefined;
  const noExtra = params.additionalProperties === false;

  const errors: string[] = [];

  // 必填项缺失
  if (required && properties) {
    for (const key of required) {
      if (!(key in args)) {
        errors.push(`缺少必填参数 "${key}"`);
      }
    }
  }

  // 多余/未知参数（仅在 additionalProperties: false 时）
  if (noExtra && properties) {
    const knownKeys = Object.keys(properties);
    const extraKeys = Object.keys(args).filter(k => !knownKeys.includes(k));
    if (extraKeys.length > 0) {
      errors.push(
        `包含未知参数 ${extraKeys.map(k => `"${k}"`).join(', ')}。` +
        `工具 ${toolName} 支持的参数: ${knownKeys.map(k => `"${k}"`).join(', ')}`,
      );
    }
  }

  return errors.length > 0 ? errors.join('；') : null;
}
