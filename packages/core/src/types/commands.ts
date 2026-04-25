// ===== 指令服务接口 =====

import type { CommandDefinition, RegisteredCommand, CommandContext, SubcommandDefinition, ExecutionGuard, SafetyLevel } from './core.js';

/**
 * 指令树节点的扁平化视图（用于 WebUI 渲染、help 输出等）。
 *
 * 每个根指令及其所有递归后代都会产出一条记录，path 表示完整路径，
 * key = path.join(':') 同时也是 override 的查找键。
 */
export interface CommandNodeInfo {
  /** 完整路径，如 ['clear', 'nuke'] */
  path: string[];
  /** override 键 = path.join(':')，如 'clear:nuke' */
  key: string;
  /** 节点自身的名字（path 末段） */
  name: string;
  /** 嵌套深度，根为 0 */
  depth: number;
  /** 描述 */
  description: string;
  /** 有效权限等级（已应用 override + 父节点继承） */
  authority: number;
  /** 有效安全级别 */
  safety: SafetyLevel;
  /** 节点本身声明的 authority；缺省时与父继承值相同 */
  baseAuthority: number;
  /** 节点本身声明的 safety；缺省时与父继承值相同 */
  baseSafety: SafetyLevel;
  /** 当前键是否存在 override 配置 */
  overridden: boolean;
  /** 是否为根指令 */
  isRoot: boolean;
  /** 是否含有子指令 */
  hasSubcommands: boolean;
  /** 是否提供了 action（无 action 的纯分组节点调用时返回 usage） */
  hasAction: boolean;
  /** 注册此根指令的插件名（同根的所有后代共用） */
  pluginName: string;
}

/**
 * 指令服务接口
 *
 * 管理用户可调用的斜杠指令的注册、解析、执行。
 * 由 plugin-commands 创建 CommandRegistry 并注册为服务。
 */
export interface CommandService {
  /** 指令前缀 */
  prefix: string;
  /** 全局开关：是否将所有指令自动注册为 AI 工具 */
  globalAsTools: boolean;
  /** 指令→工具桥接回调（仅对根指令生效） */
  onToolBridge?: (cmd: RegisteredCommand) => (() => void) | undefined;

  register(command: CommandDefinition, pluginName: string): () => void;
  unregisterByPlugin(pluginName: string): void;
  execute(name: string, ctx: CommandContext): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;
  has(name: string): boolean;
  get(name: string): RegisteredCommand | undefined;
  /** 仅返回根指令；保持向后兼容（如工具桥接、Dashboard chip） */
  getAll(): RegisteredCommand[];
  /**
   * 返回所有节点的扁平化视图（含递归子指令），按深度优先顺序。
   * 主要供权限管理 UI、help、调试使用。
   */
  getAllNodes(): CommandNodeInfo[];
  /**
   * 根据路径解析具体节点，返回扁平视图。未命中返回 undefined。
   * 路径示例：'clear' 或 'clear:nuke' 或 ['clear','nuke']。
   */
  getNode(path: string | string[]): CommandNodeInfo | undefined;

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void;
  setOverride(name: string, override: { authority?: number; safety?: string }): void;
  removeOverride(name: string): void;
  getOverrides(): Record<string, { authority?: number; safety?: string }>;

  /** 设置执行守卫（由权限插件注入） */
  setExecutionGuard(guard: ExecutionGuard): void;
}

// 重新导出便于消费方一处引入
export type { SubcommandDefinition };
