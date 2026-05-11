// ===== 指令服务接口与契约类型 =====
//
// 本包提供斜杠指令系统的全部"非实现"契约：
// - 指令数据结构（CommandDefinition / SubcommandDefinition / RegisteredCommand 等）
// - 指令执行上下文（CommandContext）
// - 服务接口（CommandService）
// - Context 便捷方法的类型增强（ctx.command）
//
// 实现见 @aalis/plugin-commands。

import type { Context, PermissionId, SafetyLevel } from '@aalis/core';
import type { ExecutionGuard } from '@aalis/plugin-authority-api';

/** 指令执行上下文 */
export interface CommandContext {
  /** 会话 ID */
  sessionId: string;
  /** 平台标识 */
  platform: string;
  /** 用户 ID */
  userId?: string;
  /** 指令参数 (命令名之后的部分，按空格分割) */
  args: string[];
  /** 按指令声明解析出的具名位置参数 */
  operands?: Record<string, unknown>;
  /** 按指令声明解析出的选项参数 */
  options?: Record<string, unknown>;
  /** 原始输入文本 */
  raw: string;
  /** 跳过安全等级检查（用于工具桥接等已在上层完成检查的场景） */
  skipSafetyCheck?: boolean;
}

export type CommandValueType = 'string' | 'number' | 'boolean' | 'enum' | 'string[]';

export interface CommandArgumentDefinition {
  /** 位置参数名称 */
  name: string;
  /** 参数类型。text 会消费剩余所有参数并拼回文本 */
  type: 'string' | 'number' | 'boolean' | 'text';
  /** 参数描述 */
  description?: string;
  /** 是否必填 */
  required?: boolean;
  /** 是否消费剩余所有参数 */
  variadic?: boolean;
}

export interface CommandOptionDefinition {
  /** 长选项名，如 type 对应 --type */
  name: string;
  /** 短别名或额外长别名，如 t 对应 -t */
  alias?: string | string[];
  /** 选项类型 */
  type: CommandValueType;
  /** 选项描述 */
  description?: string;
  /** enum 可选值 */
  choices?: string[];
  /** 默认值 */
  default?: unknown;
  /** 是否必填 */
  required?: boolean;
}

/** 指令定义 */
export interface CommandDefinition {
  /** 指令名称 (不含前缀斜杠) */
  name: string;
  /** 指令描述 */
  description: string;
  /** 最低权限等级 (默认 1) */
  authority?: number;
  /** 安全级别 (默认 'safe') */
  safety?: SafetyLevel;
  /** 静态权限标识，用于透明展示与策略匹配 */
  permissions?: PermissionId[];
  /** 位置参数声明 */
  arguments?: CommandArgumentDefinition[];
  /** 选项声明 */
  options?: CommandOptionDefinition[];
  /** 自定义用法文本 */
  usage?: string;
  /** 示例 */
  examples?: string[];
  /**
   * 执行函数
   * @returns 返回字符串表示要回复给用户的文本，返回 void 表示指令自行处理了输出
   *
   * 当存在 subcommands 时，未匹配到任何子指令名的情况下回退到此 action（args 保持原样）。
   * 若希望"必须指定子指令"，可在此返回 usage 提示。
   */
  action: (ctx: CommandContext) => Promise<string | void>;
  /**
   * 子指令树（递归）。匹配规则：
   * - 解析时按 args 顺序逐层匹配子指令名，命中即下沉一层并消耗一个 arg
   * - 命中后调用对应节点的 action（args 为剩余部分）
   * - 任意一层未命中则停在当前节点，调用其 action
   *
   * 权限/安全等级继承：子节点未声明时，继承自其有效父节点（含 override）。
   * Override 键为冒号拼接的完整路径，如 `clear:all`、`db:migrate:up`。
   */
  subcommands?: SubcommandDefinition[];
}

/**
 * 子指令定义（递归）
 *
 * 与 CommandDefinition 类似，但：
 * - action 可选：仅作为分组节点（仅含 subcommands）时省略，调用即返回 usage 提示
 * - 子指令的 pluginName 隐式继承自根指令
 */
export interface SubcommandDefinition {
  /** 子指令名称（不含前缀） */
  name: string;
  /** 子指令描述 */
  description: string;
  /** 最低权限等级；未声明则继承父节点的有效值 */
  authority?: number;
  /** 安全级别；未声明则继承父节点的有效值 */
  safety?: SafetyLevel;
  /** 静态权限标识；会与父节点权限共同生效 */
  permissions?: PermissionId[];
  /** 位置参数声明 */
  arguments?: CommandArgumentDefinition[];
  /** 选项声明 */
  options?: CommandOptionDefinition[];
  /** 自定义用法文本 */
  usage?: string;
  /** 示例 */
  examples?: string[];
  /** 执行函数；省略时该节点仅作为分组，调用回退为 usage 提示 */
  action?: (ctx: CommandContext) => Promise<string | void>;
  /** 进一步的孙级子指令 */
  subcommands?: SubcommandDefinition[];
}

/** 已注册的指令 */
export interface RegisteredCommand extends CommandDefinition {
  /** 注册此指令的插件名 */
  pluginName: string;
}

/**
 * 指令树节点的扁平化视图（用于 WebUI 渲染、help 输出等）。
 *
 * 每个根指令及其所有递归后代都会产出一条记录，path 表示完整路径，
 * key = path.join(':') 同时也是 override 的查找键。
 */
export interface CommandNodeInfo {
  /** 完整路径，如 ['clear', 'all'] */
  path: string[];
  /** override 键 = path.join(':')，如 'clear:all' */
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
  /** 细粒度权限标识（含默认 command:<path> 与声明值） */
  permissions: string[];
  /** 节点本身声明的 authority；缺省时与父继承值相同 */
  baseAuthority: number;
  /** 节点本身声明的 safety；缺省时与父继承值相同 */
  baseSafety: SafetyLevel;
  /** 节点自身声明的权限标识（不含默认 command:<path>） */
  basePermissions: string[];
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
  /** 位置参数声明 */
  arguments?: CommandArgumentDefinition[];
  /** 选项声明 */
  options?: CommandOptionDefinition[];
  /** 自定义用法文本 */
  usage?: string;
  /** 示例 */
  examples?: string[];
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

  register(command: CommandDefinition, pluginName: string): () => void;
  unregisterByPlugin(pluginName: string): void;
  execute(name: string, ctx: CommandContext): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;
  has(name: string): boolean;
  get(name: string): RegisteredCommand | undefined;
  /** 仅返回根指令；保持向后兼容（如 Dashboard chip） */
  getAll(): RegisteredCommand[];
  /**
   * 返回所有节点的扁平化视图（含递归子指令），按深度优先顺序。
   * 主要供权限管理 UI、help、调试使用。
   */
  getAllNodes(): CommandNodeInfo[];
  /**
   * 根据路径解析具体节点，返回扁平视图。未命中返回 undefined。
   * 路径示例：'clear' 或 'clear:all' 或 ['clear','all']。
   */
  getNode(path: string | string[]): CommandNodeInfo | undefined;

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void;
  setOverride(name: string, override: { authority?: number; safety?: string }): void;
  removeOverride(name: string): void;
  getOverrides(): Record<string, { authority?: number; safety?: string }>;

  /** 设置执行守卫（由权限插件注入） */
  setExecutionGuard(guard: ExecutionGuard): void;
}

// ===== Context 便捷方法增强 =====
//
// 实现由 @aalis/plugin-commands 在激活时通过 `Context.extend(...)` 注入到
// `Context.prototype`，本声明合并提供编译期类型签名。
declare module '@aalis/core' {
  interface Context {
    /**
     * 注册斜杠指令的便捷方法。
     *
     * 若 commands 服务尚不可用，会通过 `whenService` 自动延迟到服务就绪后注册。
     *
     * @example
     * ctx.command('ping', '测试连通性', async () => 'pong!');
     *
     * @requires plugin-commands 已加载（提供该方法的运行时实现）
     */
    command(
      name: string,
      description: string,
      action: (ctx: CommandContext) => Promise<string | void>,
      options?: {
        authority?: number;
        safety?: SafetyLevel;
        permissions?: PermissionId[];
        /** 位置参数声明 */
        arguments?: CommandArgumentDefinition[];
        /** 选项声明 */
        options?: CommandOptionDefinition[];
        /** 自定义用法文本 */
        usage?: string;
        /** 示例 */
        examples?: string[];
        /** 子指令树（递归）。详见 CommandDefinition.subcommands */
        subcommands?: SubcommandDefinition[];
      },
    ): () => void;
  }
}
// 抑制"未使用"警告：Context 在 declare module 块中被引用
export type _ContextExtended = Context;
