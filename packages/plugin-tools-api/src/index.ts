// ===== 工具服务接口与契约类型 =====
//
// 本包提供工具系统的全部"非实现"契约：
// - LLM 函数声明协议类型（ToolDefinition / ToolFunction）
// - 工具/分组数据结构（RegisteredTool / ToolGroupInfo / ToolSummary）
// - 工具调用上下文（ToolCallContext）—— 平台/会话语义
// - 工具执行通知（ToolExecuteMessage）
// - 服务接口（ToolService）
// - useToolService(ctx) helper（M2 后取代 ctx.registerTool mixin）
// - 通过 declaration merging 向 AalisEvents 注入 'tool:execute'
//
// 注：`ToolCall`（assistant 消息携带的调用载荷）位于 @aalis/plugin-message-api，
// 与 Message 同源同生命周期。本包不依赖 message-api（双向解耦）。
//
// 实现见 @aalis/plugin-tool-system。

import type { Context, PermissionId, SafetyLevel } from '@aalis/core';
import type { ExecutionGuard } from '@aalis/plugin-authority-api';

// ----- LLM 函数声明协议类型 -----
// 描述发给 LLM 的函数调用 wire format，被 RegisteredTool 包装为完整注册项。

export interface ToolFunction {
  name: string;
  strict?: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

// ----- 工具调用上下文（平台语义） -----

export interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  /** 当前平台启用的工具分组（供 search_tools 等工具过滤用） */
  enabledGroups?: string[];
}

/** 工具调用状态通知（WebUI 等前端订阅展示用） */
export interface ToolExecuteMessage {
  sessionId: string;
  platform?: string;
  /** 工具名称 */
  toolName: string;
  /** 传入工具的参数 */
  args: Record<string, unknown>;
  /** 'start' = 开始调用, 'end' = 调用完成 */
  phase: 'start' | 'end';
  /** 工具返回结果（仅在 phase='end' 时存在） */
  result?: string;
}

/**
 * 已注册的工具：函数声明 + 处理器 + 权限/安全/分组元信息。
 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
  pluginName: string;
  /** 最低权限等级 (默认 1) */
  authority?: number;
  /** 安全级别 (默认 'safe') */
  safety?: SafetyLevel;
  /** 静态权限标识，用于透明展示与策略匹配 */
  permissions?: PermissionId[];
  /** 根据工具参数解析动态权限，如 storage:workspace:write */
  resolvePermissions?: (
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ) => PermissionId[] | Promise<PermissionId[]>;
  /** 工具所属分组（用于按平台筛选，未设置时始终可用） */
  groups?: string[];
}

/** 工具摘要（不含 handler，用于搜索展示） */
export interface ToolSummary {
  name: string;
  description: string;
  groups?: string[];
  permissions?: PermissionId[];
}

/** 工具分组信息 */
export interface ToolGroupInfo {
  /** 分组标识（如 'system'、'onebot'、'search'） */
  name: string;
  /** 显示名称（如 '系统工具'、'OneBot 工具'） */
  label: string;
  /** 分组描述 */
  description?: string;
  /** 注册该分组的插件 */
  pluginName: string;
}

/**
 * 工具服务接口
 *
 * 管理 AI 可调用的工具的注册、查询、执行。
 * 由 plugin-tools 创建 ToolRegistry 并注册为服务。
 */
export interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, pluginName: string): () => void;

  /**
   * 获取工具定义列表
   * @param filter 可选过滤条件
   *   - groups: 仅返回属于指定分组的工具（无 groups 的工具始终包含）
   */
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];

  getSummaries(filter?: { groups?: string[] }): ToolSummary[];

  getAll(): Array<{
    name: string;
    description: string;
    pluginName: string;
    /** 生效的 authority（已叠加 override） */
    authority?: number;
    /** 生效的 safety（已叠加 override） */
    safety?: SafetyLevel;
    permissions?: string[];
    groups?: string[];
    /** 插件原始声明的 authority（未被 override 覆盖前的值） */
    baseAuthority?: number;
    /** 插件原始声明的 safety */
    baseSafety?: SafetyLevel;
    /** 是否有 override（UI 高亮用） */
    overridden?: boolean;
  }>;

  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string>;

  /** 注入执行守卫，用于权限等级与 dangerous 二次确认 */
  setExecutionGuard(guard: ExecutionGuard): void;

  // ---- 权限 override（与 CommandService 对齐）----
  /** 从配置一次性导入 override，会清空现有 */
  loadOverrides?(overrides: Record<string, { authority?: number; safety?: SafetyLevel }>): void;
  /** 设置某个工具的 override（按工具名） */
  setOverride?(name: string, override: { authority?: number; safety?: SafetyLevel }): void;
  /** 清除某个工具的 override */
  removeOverride?(name: string): void;
  /** 获取全部 override（持久化用） */
  getOverrides?(): Record<string, { authority?: number; safety?: SafetyLevel }>;

  unregisterByPlugin(pluginName: string): void;

  /** 注册工具分组 */
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
  /** 获取所有已注册的工具分组 */
  getGroups(): ToolGroupInfo[];
}

// ===== 领域便捷封装（M2：Mixin→Service 收编后的 API）=====
//
// useToolService(ctx) 是 plugin-tools-api 暴露给消费端的 helper：
// - 自动 inject 检查（找不到服务时抛出明确错误）
// - 自动用 ctx.id 填充 pluginName 字段
// - 仅做参数透传，零额外语义
//
// 这取代了原 `ctx.registerTool` / `ctx.registerToolGroup` mixin。
//
// 用法：
//   import { useToolService } from '@aalis/plugin-tools-api';
//   export function apply(ctx: Context) {
//     const tools = useToolService(ctx);
//     tools.register({ name: 'foo', ... });
//   }

/** ToolService 绑定到当前 Context 的便捷视图（pluginName 自动填充） */
export interface ScopedToolService {
  /** 注册工具。服务未就绪时通过 whenService 自动延迟到就绪后执行（与原 mixin 语义一致）。 */
  register(tool: Omit<RegisteredTool, 'pluginName'>): () => void;
  /** 注册工具分组。服务未就绪时通过 whenService 自动延迟。 */
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void;
  getDefinitions: ToolService['getDefinitions'];
  getSummaries: ToolService['getSummaries'];
  getAll: ToolService['getAll'];
  getGroups: ToolService['getGroups'];
  execute: ToolService['execute'];
  setExecutionGuard: ToolService['setExecutionGuard'];
  /** 原始 ToolService 引用（服务未就绪时为 undefined） */
  readonly raw: ToolService | undefined;
}

export function useToolService(ctx: Context): ScopedToolService {
  const svc = ctx.getService<ToolService>('tools');
  const pluginName = ctx.id;

  /** 用于读 API：服务未就绪时抛错。 */
  function need(): ToolService {
    const s = ctx.getService<ToolService>('tools');
    if (!s) {
      throw new Error(
        `useToolService: 'tools' 服务不可用。请在插件 manifest 的 inject 中声明 'tools'，或确认 plugin-agent-tools 已激活。`,
      );
    }
    return s;
  }

  return {
    register: tool =>
      svc ? svc.register(tool, pluginName) : ctx.whenService<ToolService>('tools', s => s.register(tool, pluginName)),
    registerGroup: group =>
      svc
        ? svc.registerGroup(group, pluginName)
        : ctx.whenService<ToolService>('tools', s => s.registerGroup(group, pluginName)),
    getDefinitions: (...args) => need().getDefinitions(...args),
    getSummaries: (...args) => need().getSummaries(...args),
    getAll: (...args) => need().getAll(...args),
    getGroups: (...args) => need().getGroups(...args),
    execute: (...args) => need().execute(...args),
    setExecutionGuard: (...args) => need().setExecutionGuard(...args),
    raw: svc,
  };
}

/**
 * 返回一个 ScopedToolService 的视图，其 `register` 会自动为工具
 * 追加给定 groups（合并而不是覆盖原 tool.groups）。
 *
 * 用于一组工具想共享相同分组的场景（如某游戏插件的 'game' 分组）。
 */
export function toolsWithGroups(tools: ScopedToolService, groups: string[]): ScopedToolService {
  return {
    ...tools,
    register: tool =>
      tools.register({
        ...tool,
        groups: [...(tool.groups ?? []), ...groups],
      }),
  };
}

// ===== AalisEvents 扩展（declaration merging） =====

declare module '@aalis/core' {
  interface AalisEvents {
    'tool:execute': [info: ToolExecuteMessage];
  }
}

export type { ToStorageUriOptions } from './utils.js';
// ===== 可复用 runtime 工具函数 =====
// 见 utils.ts —— 用于工具实现侧共享 storage URI 规范化与 SSRF 判定，
// 避免在多个工具插件里重复实现。
export {
  isPrivateHost,
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  toStorageUri,
} from './utils.js';
