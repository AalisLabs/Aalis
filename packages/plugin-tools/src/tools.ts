import type { CapabilityConfirm, CapabilityRisk, CapabilityVisibility, ExecutionGuard } from '@aalis/api-authority';
import { resolveCapabilityPolicy } from '@aalis/api-authority';
import type {
  RegisteredTool,
  ToolCallContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolGroupInfo,
  ToolService,
  ToolSummary,
} from '@aalis/api-tools';
import type { Logger } from '@aalis/core';
/**
 * 工具注册表 —— 管理 AI 可调用工具的注册、查询、执行
 *
 * 由 @aalis/plugin-tools 创建并注册为服务 'tools'，
 * 插件通过 useToolService(ctx) 注册与查询工具（服务名 'tools'）。
 *
 * 与 plugin-commands/CommandRegistry 同属"中心 Registry 模式"：
 * - 单一 Map<name, Registered> 存储，name 全局唯一（重名警告并覆盖）
 * - register() 返回 disposer，Context 拆卸时按 contextId 自动注销
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

  register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) {
      this.logger.warn(`工具 "${name}" 已存在，将被覆盖 (来自 ${contextId})`);
    }
    const entry: RegisteredTool = { ...tool, pluginName: contextId };
    this.tools.set(name, entry);
    this.logger.debug(`注册工具: ${name} (来自 ${contextId})`);
    // 退订按条目引用比对：同名重注册后，旧退订闭包不得误删新登记（按 name + contextId 比对会）
    return () => {
      if (this.tools.get(name) !== entry) return;
      this.tools.delete(name);
      this.logger.debug(`注销工具: ${name}`);
    };
  }

  // ---- 查询 ----

  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[] {
    return this.filtered(filter).map(t => t.definition);
  }

  getSummaries(filter?: { groups?: string[] }): ToolSummary[] {
    return this.filtered(filter).map(t => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      groups: t.groups,
    }));
  }

  /**
   * 分组过滤：无分组的通用工具恒可见；带分组的只在命中 `groups` 时可见，`'*'` 表示全部分组。
   * 未指定（或为空）即只给通用工具——多人平台上 public 工具的可达性靠这道闸
   * （docs/concepts/security-model.md）；owner 专用平台由平台档显式给 `['*']`。
   */
  /**
   * 某工具是否对「这组已启用分组」可见。列举面与执行面共用同一判据。
   *
   * 无分组的通用工具恒可见；`'*'` 放开全部分组。
   */
  private groupAllowed(tool: { groups?: readonly string[] }, groups: readonly string[]): boolean {
    if (!tool.groups?.length) return true;
    if (groups.includes('*')) return true;
    return tool.groups.some(g => groups.includes(g));
  }

  private filtered(filter?: { groups?: string[] }): RegisteredTool[] {
    const tools = [...this.tools.values()];
    const enabled = new Set(filter?.groups);
    if (enabled.has('*')) return tools;
    return tools.filter(t => !t.groups?.length || t.groups.some(g => enabled.has(g)));
  }

  getAll(): Array<{
    name: string;
    description: string;
    pluginName: string;
    visibility: CapabilityVisibility;
    confirm?: CapabilityConfirm;
    risk?: CapabilityRisk;
    groups?: string[];
  }> {
    return [...this.tools.values()].map(t => {
      const { visibility, confirm } = resolveCapabilityPolicy(t);
      return {
        name: t.definition.function.name,
        description: t.definition.function.description,
        pluginName: t.pluginName,
        visibility,
        confirm,
        risk: t.risk, // 原始风险透传：让 authority 区分 sensitive(朋友) / dangerous(信任)，否则二者都折成 restricted=信任
        groups: t.groups,
      };
    });
  }

  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, contextId: string): () => void {
    const info: ToolGroupInfo = { ...group, pluginName: contextId };
    this._groups.set(group.name, info);
    this.logger.debug(`注册工具分组: ${group.name} (来自 ${contextId})`);
    return () => {
      if (this._groups.get(group.name) !== info) return;
      this._groups.delete(group.name);
      this.logger.debug(`注销工具分组: ${group.name}`);
    };
  }

  getGroups(): ToolGroupInfo[] {
    return [...this._groups.values()];
  }

  // ---- 执行 ----

  setExecutionGuard(guard: ExecutionGuard): void {
    this._guard = guard;
  }

  /** 工具名未命中时，按下划线分词的 token 交集 + 子串关系给出近似建议（最多 3 个）。 */
  private suggestToolNames(query: string, enabledGroups?: readonly string[]): string[] {
    const q = query.toLowerCase();
    const qTokens = new Set(q.split(/[_\s-]+/).filter(Boolean));
    const scored: Array<{ name: string; score: number }> = [];
    for (const [name, tool] of this.tools) {
      // 不把本会话未暴露分组的工具名建议回模型：那等于替它把闸外的名字念一遍
      if (enabledGroups && !this.groupAllowed(tool, enabledGroups)) continue;
      const n = name.toLowerCase();
      let score = 0;
      if (n.includes(q) || q.includes(n)) score += 2;
      for (const t of n.split(/[_\s-]+/)) if (t && qTokens.has(t)) score += 1;
      if (score > 0) scored.push({ name, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.name);
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      // LLM 常臆造工具名（如把 send_attachment 叫成 send_image）。给出近似名建议，
      // 让模型本轮直接纠正调用，而不是再花一轮 search_tools 找正确名字。
      const suggestions = this.suggestToolNames(toolName, callCtx.enabledGroups);
      const hint = suggestions.length > 0 ? `，你是否想用：${suggestions.join(' / ')}` : '';
      return { content: JSON.stringify({ error: `工具 "${toolName}" 未找到${hint}` }) };
    }

    // 分组闸：此前只在列举面（filtered）生效，execute 按名直调完全不校验。被提示注入的
    // 模型可以叫出一个本回合没下发给它的名字（安全模型把 LLM 输出列为不可信），于是
    // onebot 群会话里未暴露分组的工具照样被执行——而「不在 enabledGroups 里故不可达」
    // 正是 http_request 等 public 破坏性工具在多人平台上的前提判据。
    // 只在调用方显式给出 enabledGroups 时生效：mcp-server / workflow 不传该字段，
    // 各自另有暴露面控制，行为不变。
    if (callCtx.enabledGroups && !this.groupAllowed(tool, callCtx.enabledGroups)) {
      // 与「未找到」同形：不向闸外的调用者确认该工具存在
      return { content: JSON.stringify({ error: `工具 "${toolName}" 未找到` }) };
    }

    // 参数 schema 校验：检测缺失必填项 / 多余未知键（LLM 写错参数名时给出明确提示）
    const schemaError = validateToolArgs(toolName, tool.definition, args);
    if (schemaError) {
      this.logger.warn(`工具 ${toolName} 参数校验失败: ${schemaError}`);
      return { content: JSON.stringify({ error: schemaError }) };
    }

    const { visibility, confirm } = resolveCapabilityPolicy(tool);
    if (this._guard) {
      const denied = await this._guard({
        name: toolName,
        type: 'tool',
        visibility,
        confirm,
        risk: tool.risk,
        sessionId: callCtx.sessionId,
        platform: callCtx.platform ?? 'unknown',
        userId: callCtx.userId,
        actor: callCtx.actor,
        args,
        signal: callCtx.signal,
      });
      if (denied) {
        this.logger.warn(`工具 ${toolName} 被执行守卫拦截: ${denied}`);
        return { content: JSON.stringify({ error: denied }) };
      }
    }
    // 守卫可能等过一轮人工确认：期间回合若已中止（latest-wins / 手动 abort），不替死回合执行
    if (callCtx.signal?.aborted) return { content: JSON.stringify({ error: '回合已中止，未执行' }) };

    try {
      if (visibility === 'restricted') {
        this.logger.info(
          `受限工具执行: ${toolName} session=${callCtx.sessionId} platform=${callCtx.platform ?? 'unknown'} args=${JSON.stringify(args)}`,
        );
      }
      const result = await tool.handler(args, callCtx);
      this.logger.debug(`工具 ${toolName} 执行成功`);
      // 字符串结果归一为统一形态；带图结果只保留非空 images（空数组等于没图）
      if (typeof result === 'string') return { content: result };
      return result.images && result.images.length > 0 ? result : { content: result.content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`工具 ${toolName} 执行失败: ${message}`);
      return { content: JSON.stringify({ error: message }) };
    }
  }

  unregisterByPlugin(contextId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === contextId) {
        this.tools.delete(name);
        this.logger.debug(`注销工具: ${name} (Context ${contextId} 拆卸)`);
      }
    }
    for (const [name, group] of this._groups) {
      if (group.pluginName === contextId) {
        this._groups.delete(name);
      }
    }
  }
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
