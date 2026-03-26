// ===== 工具服务接口 =====

import type {
  RegisteredTool,
  ToolDefinition,
  ToolCallContext,
  ToolSummary,
  ToolGroupInfo,
  SafetyLevel,
} from './core.js';
import type { AuthorityService } from './authority.js';

/**
 * 工具服务接口
 *
 * 管理 AI 可调用的工具的注册、查询、执行。
 * 具体实现由 plugin-agent-tools 提供。
 */
export interface ToolService {
  register(
    tool: Omit<RegisteredTool, 'pluginName'>,
    pluginName: string,
  ): () => void;

  /**
   * 获取工具定义列表
   * @param filter 可选过滤条件
   *   - groups: 仅返回属于指定分组的工具（无 groups 的工具始终包含）
   */
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];

  getSummaries(): ToolSummary[];

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
  }>;

  execute(
    toolName: string,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<string>;

  unregisterByPlugin(pluginName: string): void;

  setAuthority(authority: AuthorityService): void;

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void;
  setOverride(name: string, override: { authority?: number; safety?: string }): void;
  removeOverride(name: string): void;
  getOverrides(): Record<string, { authority?: number; safety?: string }>;

  /** 注册工具分组 */
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
  /** 获取所有已注册的工具分组 */
  getGroups(): ToolGroupInfo[];
}
