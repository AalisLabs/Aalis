import type { CapabilityConfirm, CapabilityRisk, CapabilityVisibility, ExecutionGuard } from '@aalis/api-authority';
import { capabilityMinLevel, DEFAULT_AUTHORITY, resolveCapabilityPolicy } from '@aalis/api-authority';
import {
  type RegisteredTool,
  type ToolCallContext,
  type ToolDefinition,
  type ToolDisplay,
  type ToolExecutionResult,
  type ToolGroupInfo,
  type ToolService,
  type ToolSummary,
  takenBackgroundParams,
} from '@aalis/api-tools';
import type { Logger } from '@aalis/core';
import { type BackgroundTasks, DEFAULT_YIELD_SECONDS, inTurn, type Plan } from './background.js';
import { backgroundTaskTools } from './background-tools.js';

/** 登记项：工具、发给模型的声明（可转后台的补上两项参数）与让出时限（秒，可转后台的才有） */
interface Entry {
  tool: RegisteredTool;
  definition: ToolDefinition;
  yieldSeconds?: number;
}

/**
 * 工具注册表 —— 管理 AI 可调用工具的注册、查询、执行
 *
 * 由 @aalis/plugin-tools 创建并发布为服务 'tools'，
 * 消费方声明 @aalis/api-tools 的 `tools` 描述符，经绑定接口注册与查询。
 *
 * 与 plugin-commands/CommandRegistry 同属"中心 Registry 模式"：
 * - 一张登记表，name 全局唯一（重名警告并覆盖），另加四个自带的后台任务工具：它们的名字保留，同名登记被拒并告警
 * - register() 返回退订，退订按条目身份，由绑定门面在激活撤回时调用
 * - 通过 setExecutionGuard() 注入统一权限/安全检查钩子
 *
 * 声明了 background 的工具由执行器转后台（见 background.ts）；四个后台任务工具只在可见的工具里有可转后台的时才可见。
 */
export class ToolRegistry implements ToolService {
  private tools = new Map<string, Entry>();
  private readonly taskTools: Map<string, Entry>;
  private _groups = new Map<string, ToolGroupInfo>();
  private logger: Logger;
  private readonly tasks: BackgroundTasks;
  private _guard?: ExecutionGuard;

  constructor(logger: Logger, tasks: BackgroundTasks) {
    this.logger = logger.child('tools');
    this.tasks = tasks;
    this.taskTools = new Map(
      backgroundTaskTools(this.tasks).map(tool => [
        tool.definition.function.name,
        { tool: { ...tool, pluginName: '@aalis/plugin-tools' }, definition: tool.definition },
      ]),
    );
  }

  // ---- 注册 / 注销 ----

  register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void {
    const name = tool.definition.function.name;
    if (this.taskTools.has(name)) {
      this.logger.warn(`工具名 "${name}" 留给后台任务工具，${contextId} 的这个登记已忽略`);
      return () => {};
    }
    if (this.tools.has(name)) {
      this.logger.warn(`工具 "${name}" 已存在，将被覆盖 (来自 ${contextId})`);
    }
    const entry: Entry = { tool: { ...tool, pluginName: contextId }, ...this.declare(tool) };
    this.tools.set(name, entry);
    this.logger.debug(`注册工具: ${name} (来自 ${contextId})`);
    // 退订按条目引用比对：同名重注册后，旧退订闭包不得误删新登记（按 name + contextId 比对会）。
    // 这个登记在跑的调用随撤回一并中止（所属插件停用），不论它是否已被同名登记顶掉
    return () => {
      this.tasks.withdraw(entry, name);
      if (this.tools.get(name) !== entry) return;
      this.tools.delete(name);
      this.logger.debug(`注销工具: ${name}`);
    };
  }

  /** 发给模型的声明与让出时限：声明了 background、参数表里没有同名项的补上两项参数；有同名项的当作没声明 */
  private declare(tool: Omit<RegisteredTool, 'pluginName'>): Omit<Entry, 'tool'> {
    const fn = tool.definition.function;
    if (!tool.background) return { definition: tool.definition };
    const taken = takenBackgroundParams(fn.parameters);
    if (taken.length > 0) {
      this.logger.warn(`工具 "${fn.name}" 的参数表里已有 ${taken.join('、')}，当作不可转后台`);
      return { definition: tool.definition };
    }
    const yieldSeconds = tool.background.yieldSeconds ?? DEFAULT_YIELD_SECONDS;
    const max = this.tasks.limits.maxWaitSeconds;
    const properties = {
      ...fn.parameters.properties,
      runInBackground: {
        type: 'boolean',
        description:
          '立即转到后台：先回给你任务 id，不等结果，结束时会通知你。明知要很久的（构建、下载、长驻进程）用它',
      },
      waitSeconds: {
        type: 'number',
        description: `前台最多等多少秒，到时还没结束就转到后台（默认 ${Math.min(yieldSeconds, max)}，最多 ${max}）`,
      },
    };
    return {
      yieldSeconds,
      definition: { ...tool.definition, function: { ...fn, parameters: { ...fn.parameters, properties } } },
    };
  }

  // ---- 查询 ----

  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[] {
    return this.filtered(filter).map(e => e.definition);
  }

  getSummaries(filter?: { groups?: string[] }): ToolSummary[] {
    return this.filtered(filter).map(({ tool: t }) => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      groups: t.groups,
    }));
  }

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

  /**
   * 分组过滤：无分组的通用工具恒可见；带分组的只在命中 `groups` 时可见，`'*'` 表示全部分组。
   * 未指定（或为空）即只给通用工具——多人平台上 public 工具的可达性靠这道闸
   * （docs/concepts/security-model.md）；owner 专用平台由平台档显式给 `['*']`。
   * 可见的工具里有可转后台的，才连同四个后台任务工具
   */
  private filtered(filter?: { groups?: string[] }): Entry[] {
    const visible = [...this.tools.values()].filter(e => this.groupAllowed(e.tool, filter?.groups ?? []));
    return visible.some(e => e.yieldSeconds !== undefined) ? [...visible, ...this.taskTools.values()] : visible;
  }

  /** 后台任务工具：执行面与列举面同一判据；调用方没给 enabledGroups 时不过分组闸，有可转后台的工具即可用 */
  private taskTool(name: string, groups: readonly string[] | undefined): Entry | undefined {
    const entry = this.taskTools.get(name);
    if (!entry) return undefined;
    const available = [...this.tools.values()].some(
      e => e.yieldSeconds !== undefined && (!groups || this.groupAllowed(e.tool, groups)),
    );
    return available ? entry : undefined;
  }

  getAll(): Array<{
    name: string;
    description: string;
    pluginName: string;
    visibility: CapabilityVisibility;
    confirm?: CapabilityConfirm;
    risk?: CapabilityRisk;
    groups?: string[];
    display?: ToolDisplay;
  }> {
    return this.filtered({ groups: ['*'] }).map(({ tool: t }) => {
      const { visibility, confirm } = resolveCapabilityPolicy(t);
      return {
        name: t.definition.function.name,
        description: t.definition.function.description,
        pluginName: t.pluginName,
        visibility,
        confirm,
        risk: t.risk, // 原始风险透传：让 authority 区分 sensitive(朋友) / dangerous(信任)，否则二者都折成 restricted=信任
        groups: t.groups,
        display: t.display,
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

  setExecutionGuard(guard: ExecutionGuard | undefined): void {
    this._guard = guard;
  }

  /** 工具名未命中时，按下划线分词的 token 交集 + 子串关系给出近似建议（最多 3 个）。 */
  private suggestToolNames(query: string, enabledGroups?: readonly string[]): string[] {
    const q = query.toLowerCase();
    const qTokens = new Set(q.split(/[_\s-]+/).filter(Boolean));
    const scored: Array<{ name: string; score: number }> = [];
    for (const [name, { tool }] of this.tools) {
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
    const entry = this.tools.get(toolName) ?? this.taskTool(toolName, callCtx.enabledGroups);
    if (!entry) {
      // LLM 常臆造工具名（如把 send_attachment 叫成 send_image）。给出近似名建议，
      // 让模型本轮直接纠正调用，而不是再花一轮 search_tools 找正确名字。
      const suggestions = this.suggestToolNames(toolName, callCtx.enabledGroups);
      const hint = suggestions.length > 0 ? `，你是否想用：${suggestions.join(' / ')}` : '';
      return failure(`工具 "${toolName}" 未找到${hint}`);
    }
    const { tool } = entry;

    // 分组闸：此前只在列举面（filtered）生效，execute 按名直调完全不校验。被提示注入的
    // 模型可以叫出一个本回合没下发给它的名字（安全模型把 LLM 输出列为不可信），于是
    // onebot 群会话里未暴露分组的工具照样被执行——而「不在 enabledGroups 里故不可达」
    // 正是 http_request 等 public 破坏性工具在多人平台上的前提判据。
    // 只在调用方显式给出 enabledGroups 时生效：mcp-server / workflow 不传该字段，
    // 各自另有暴露面控制，行为不变。
    if (callCtx.enabledGroups && !this.groupAllowed(tool, callCtx.enabledGroups)) {
      // 与「未找到」同形：不向闸外的调用者确认该工具存在
      return failure(`工具 "${toolName}" 未找到`);
    }

    // 可转后台的工具：执行器的两项参数先取出，再做参数校验、过守卫、交给工具（审批事实里没有它们）
    let toolArgs = args;
    let plan: Plan | undefined;
    if (entry.yieldSeconds !== undefined) {
      const taken = takeFlags(args);
      if (typeof taken === 'string') return failure(taken);
      if (taken.runInBackground && !inTurn(callCtx)) {
        return failure('不在对话回合里的调用不能转后台：没有可以通知的对话');
      }
      toolArgs = taken.args;
      plan = {
        waitSeconds: Math.min(taken.waitSeconds ?? entry.yieldSeconds, this.tasks.limits.maxWaitSeconds),
        immediate: taken.runInBackground,
      };
    }

    // 参数 schema 校验：检测缺失必填项 / 多余未知键（LLM 写错参数名时给出明确提示）
    const schemaError = validateToolArgs(toolName, tool.definition, toolArgs);
    if (schemaError) {
      this.logger.warn(`工具 ${toolName} 参数校验失败: ${schemaError}`);
      return failure(schemaError);
    }

    // 同一会话里在跑的可转后台调用满了时，在过守卫之前就拒绝（不为执行不了的调用发审批）
    const call = plan && this.tasks.admit(callCtx, entry, plan);
    if (typeof call === 'string') return { content: call };
    // 占到的位置没交给 run 的（守卫拒绝或抛错、已中止）一律让出
    let handedOver = false;
    try {
      // 等审批期间这次调用可能已被中止（工具撤回登记、会话删除、执行器停用）
      const refused =
        (await this.guard(tool, toolArgs, callCtx)) ??
        (call?.controller.signal.aborted ? '调用已中止，未执行' : undefined);
      if (refused !== undefined) return failure(refused);

      if (resolveCapabilityPolicy(tool).visibility === 'restricted') {
        this.logger.info(
          `受限工具执行: ${toolName} session=${callCtx.sessionId} platform=${callCtx.platform ?? 'unknown'} args=${JSON.stringify(toolArgs)}`,
        );
      }
      if (!call) return this.invoke(tool, toolArgs, { ...callCtx, output: this.tasks.outputFor(callCtx) });
      handedOver = true;
      return this.tasks.run(call, {
        tool: toolName,
        args,
        ctx: callCtx,
        display: tool.display,
        invoke: ctx => this.invoke(tool, toolArgs, ctx),
      });
    } finally {
      if (call && !handedOver) this.tasks.release(call);
    }
  }

  /** 过执行守卫；拒绝时回原因。守卫可能等过一轮 owner 审批：期间回合若已中止（latest-wins / 手动 abort），不替死回合执行 */
  private async guard(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<string | undefined> {
    const toolName = tool.definition.function.name;
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
        turnId: callCtx.turnId,
        callId: callCtx.callId,
        inbound: callCtx.inbound,
        signal: callCtx.signal,
      });
      if (denied) {
        this.logger.warn(`工具 ${toolName} 被执行守卫拦截: ${denied}`);
        return denied;
      }
    } else if (confirm || capabilityMinLevel({ risk: tool.risk, visibility }) > DEFAULT_AUTHORITY) {
      // 没有守卫（未装权限插件）时 fail-closed：等同人人都是默认等级、没人能确认。
      // 需要更高等级或需要确认的工具一律拒绝，默认等级可用且无需确认的照常执行。
      const reason = `工具 "${toolName}" 需要权限校验或确认，但未安装权限插件 @aalis/plugin-authority，已拒绝执行`;
      this.logger.warn(reason);
      return reason;
    }
    return callCtx.signal?.aborted ? '回合已中止，未执行' : undefined;
  }

  /** 跑工具：字符串结果归一为统一形态，带图结果只保留非空 images（空数组等于没图）；抛错转成 { error }，不冒泡 */
  private async invoke(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolExecutionResult> {
    const toolName = tool.definition.function.name;
    try {
      const result = await tool.handler(args, ctx);
      this.logger.debug(`工具 ${toolName} 执行成功`);
      if (typeof result === 'string') return { content: result };
      return result.images && result.images.length > 0 ? result : { content: result.content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`工具 ${toolName} 执行失败: ${message}`);
      return failure(message);
    }
  }
}

const failure = (message: string): ToolExecutionResult => ({ content: JSON.stringify({ error: message }) });

/** 取出执行器的两项参数并核对类型：回剩下交给工具的参数，类型不对时回错误 */
function takeFlags(
  args: Record<string, unknown>,
): { args: Record<string, unknown>; runInBackground: boolean; waitSeconds?: number } | string {
  const { runInBackground, waitSeconds, ...rest } = args;
  if (runInBackground !== undefined && typeof runInBackground !== 'boolean') return 'runInBackground 要是布尔值';
  if (
    waitSeconds !== undefined &&
    !(typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds >= 0)
  ) {
    return 'waitSeconds 要是不小于 0 的秒数';
  }
  return {
    args: rest,
    runInBackground: runInBackground === true,
    ...(waitSeconds !== undefined ? { waitSeconds } : {}),
  };
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
