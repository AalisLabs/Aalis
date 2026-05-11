// ===== 工具服务接口与契约类型 =====
//
// 本包提供工具系统的全部"非实现"契约：
// - 工具/分组数据结构（RegisteredTool / ToolGroupInfo / ToolSummary）
// - 工具调用上下文（ToolCallContext）—— 平台/会话语义，非 OpenAI 协议
// - 工具执行通知（ToolExecuteMessage）
// - 服务接口（ToolService）
// - Context 便捷方法的类型增强（ctx.registerTool / ctx.registerToolGroup）
// - 通过 declaration merging 向 AalisEvents 注入 'tool:execute'
//
// 实现见 @aalis/plugin-tools。

import type { Context, PermissionId, SafetyLevel, ToolDefinition } from '@aalis/core';
import type { ExecutionGuard } from '@aalis/plugin-authority-api';

// ----- 工具调用上下文（平台语义；core 仅提供 OpenAI 协议层的 ToolCall/ToolDefinition） -----

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
    authority?: number;
    safety?: SafetyLevel;
    permissions?: string[];
    groups?: string[];
  }>;

  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string>;

  /** 注入执行守卫，用于权限等级与 dangerous 二次确认 */
  setExecutionGuard(guard: ExecutionGuard): void;

  unregisterByPlugin(pluginName: string): void;

  /** 注册工具分组 */
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
  /** 获取所有已注册的工具分组 */
  getGroups(): ToolGroupInfo[];
}

// ===== Context 便捷方法增强 =====
//
// 实现由 @aalis/plugin-tools 在激活时通过 `Context.extend(...)` 注入到
// `Context.prototype`，本声明合并提供编译期类型签名。
declare module '@aalis/core' {
  interface Context {
    /**
     * 注册 AI 工具的便捷方法。
     *
     * 若 tools 服务尚不可用，会通过 `whenService` 自动延迟到服务就绪后注册。
     * 返回的 dispose 函数：未刷入前调用即取消缓冲；已刷入则从服务取消注册。
     *
     * @requires plugin-tools 已加载（提供该方法的运行时实现）
     */
    registerTool(tool: Omit<RegisteredTool, 'pluginName'>): () => void;

    /**
     * 注册工具分组的便捷方法。
     * 行为同 `registerTool`：服务未就绪时自动延迟。
     *
     * @requires plugin-tools 已加载
     */
    registerToolGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void;
  }
}
// 抑制"未使用"警告：Context 在 declare module 块中被引用
export type _ContextExtended = Context;

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
