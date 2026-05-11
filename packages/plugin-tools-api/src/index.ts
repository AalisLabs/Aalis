import type { ExecutionGuard, ExecutionGuardContext } from '@aalis/plugin-authority-api';
// ===== 工具服务接口 =====

import type {
  RegisteredTool,
  SafetyLevel,
  ToolCallContext,
  ToolDefinition,
  ToolGroupInfo,
  ToolSummary,
} from '@aalis/core';

/**
 * 工具服务接口
 *
 * 管理 AI 可调用的工具的注册、查询、执行。
 * 由 plugin-agent-tools 创建 ToolRegistry 并注册为服务。
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
