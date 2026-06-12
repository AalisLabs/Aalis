// ===== 指令服务接口与契约类型（v2 — chatluna 风格） =====
//
// 本包提供斜杠指令系统的全部"非实现"契约。
//
// 核心理念：
// - 单一 Command 类型，命令层级用 name 的点路径表达（'memory.clear.all'）
// - Builder API：useCommandService(ctx).command(name).option().action()
// - inline DSL 声明位置参数：'memory.set <key:string> [value:text]'
// - 位置参数作为 handler 形参传入：(argv, key, value) => ...
//
// 实现见 @aalis/plugin-commands。

import type { Context } from '@aalis/core';
import type { ExecutionGuard, PermissionId, SafetyLevel } from '@aalis/plugin-authority-api';

// ===== handler 接口 =====

/** Handler 收到的会话/选项视图（不含原始 args，位置参数走形参） */
export interface CommandArgv {
  session: {
    sessionId: string;
    platform: string;
    userId?: string;
    /** 原始输入文本（含前缀） */
    raw: string;
  };
  options: Record<string, unknown>;
}

/**
 * 命令执行函数。
 * @param argv 会话上下文 + 解析后的选项
 * @param positionals 按 inline DSL 顺序解析出的位置参数
 */
export type CommandHandler = (
  argv: CommandArgv,
  ...positionals: unknown[]
) => Promise<string | undefined> | string | undefined;

// ===== 已解析的参数 / 选项 spec =====

export type PositionalArgType = 'string' | 'number' | 'boolean' | 'text';

export interface PositionalArgSpec {
  name: string;
  type: PositionalArgType;
  required: boolean;
}

export type OptionValueType = 'string' | 'number' | 'boolean' | 'string[]';

export interface OptionSpec {
  /** 长选项名 (--name) */
  name: string;
  /** 短选项别名 (-x)，可多个 */
  aliases: string[];
  /** 值类型；boolean 表示纯 flag */
  type: OptionValueType;
  /** 占位符名（用于 help 输出），如 'page' */
  valueName?: string;
  /** 是否需要取值 */
  takesValue: boolean;
  /** 值可选时（[val:type] 语法），flag 存在但无值给 true */
  valueOptional: boolean;
  description?: string;
  default?: unknown;
  required: boolean;
  choices?: readonly string[];
}

// ===== 命令元数据 =====

/** 注册时的元数据 */
export interface CommandMeta {
  authority?: number;
  safety?: SafetyLevel;
  permissions?: PermissionId[];
  /** 自定义 usage 文本 */
  usage?: string;
  /** 示例 */
  examples?: string[];
}

/** 已注册命令（运行期完整态） */
export interface Command {
  /** 完整点路径名 */
  name: string;
  /** 注册插件名 */
  pluginName: string;
  description: string;
  /** 节点自身声明的 authority（缺省 1） */
  baseAuthority: number;
  /** 节点自身声明的 safety（缺省 'safe'） */
  baseSafety: SafetyLevel;
  /** 节点自身声明的权限标识（不含默认 command:<name>） */
  basePermissions: PermissionId[];
  /** 有效 authority */
  authority: number;
  /** 有效 safety */
  safety: SafetyLevel;
  /** 有效权限标识列表 */
  permissions: string[];
  /** 别名（完整点路径） */
  aliases: string[];
  positionalArgs: PositionalArgSpec[];
  options: OptionSpec[];
  usage?: string;
  examples?: string[];
  /** 执行函数；分组节点为 undefined */
  handler?: CommandHandler;
  /** 当前 name 是否被 override 命中 */
  overridden: boolean;
  /** 是否为自动创建的分组节点 */
  isGroup: boolean;
}

/** Authority override */
export interface AuthorityOverride {
  authority?: number;
  safety?: SafetyLevel;
}

/** 命令服务消费方（CLI / 适配器）传入的执行输入 */
export interface ExecutionInput {
  sessionId: string;
  platform: string;
  userId?: string;
  args: string[];
  raw: string;
  /**
   * 跳过 dangerous 确认弹窗（authority + permissionPolicy 仍然生效）。
   *
   * 供无法交互确认的受信任系统源（scheduler 等）使用：这些调用的身份来自
   * 创建时固化的 actor（IncomingMessage.actor），权限按 actor 的真实等级评估，
   * 只是 cron 上下文里没有人能点确认弹窗，故跳过该步。
   *
   * 历史：曾存在 bypassGuard 字段可完全绕过守卫（authority/permission/safety
   * 全跳），已废除——系统源现在通过 actor 身份走与用户一致的守卫评估。
   */
  skipSafetyCheck?: boolean;
}

// ===== Builder =====

export interface OptionRegisterOptions {
  description?: string;
  default?: unknown;
  required?: boolean;
  choices?: readonly string[];
}

export interface CommandBuilder {
  alias(name: string): CommandBuilder;
  option(name: string, syntax: string, options?: OptionRegisterOptions): CommandBuilder;
  action(handler: CommandHandler): CommandBuilder;
  usage(text: string): CommandBuilder;
  example(line: string): CommandBuilder;
}

// ===== 服务接口 =====

/** 仅供 useCommandService 内部使用：调用 service.command 时携带 pluginName 隐式参数 */
export interface InternalCommandMeta extends CommandMeta {
  pluginName?: string;
}

export interface CommandService {
  prefix: string;

  /**
   * 启动 builder 注册一个命令。
   * @param name 完整点路径名，可含 inline DSL：`'memory.set <key:string> [value:text]'`
   */
  command(name: string, description?: string, meta?: InternalCommandMeta): CommandBuilder;

  unregister(name: string): void;
  unregisterByPlugin(pluginName: string): void;

  execute(name: string, ctx: ExecutionInput): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;

  /**
   * 判断给定 head + tokens 是否能解析到任何已注册指令节点。
   * inbound middleware 用它区分"已识别的指令"和"碰巧带前缀但无人注册"，
   * 后者应被放行到普通消息管道（归档 / 触发等），而不是回显"未知指令"。
   */
  hasMatch(head: string, tokens?: string[]): boolean;

  /** 顶层段是否存在（含分组节点） */
  has(name: string): boolean;
  get(name: string): Command | undefined;
  getNode(name: string | string[]): Command | undefined;
  getAll(): Command[];

  loadOverrides(overrides: Record<string, AuthorityOverride>): void;
  setOverride(name: string, override: AuthorityOverride): void;
  removeOverride(name: string): void;
  getOverrides(): Record<string, AuthorityOverride>;

  setExecutionGuard(guard: ExecutionGuard): void;
}

// ===== useCommandService helper =====

export interface ScopedCommandService {
  command(name: string, description?: string, meta?: CommandMeta): CommandBuilder;
  readonly raw: CommandService | undefined;
}

export function useCommandService(ctx: Context): ScopedCommandService {
  const pluginName = ctx.id;
  return {
    command(name, description, meta) {
      return makeBuilder(ctx, name, description, { ...meta, pluginName });
    },
    get raw() {
      return ctx.getService<CommandService>('commands');
    },
  };
}

type DeferredCall =
  | { kind: 'alias'; name: string }
  | { kind: 'option'; name: string; syntax: string; opts?: OptionRegisterOptions }
  | { kind: 'action'; handler: CommandHandler }
  | { kind: 'usage'; text: string }
  | { kind: 'example'; line: string };

/**
 * 同时支持热转发与 bounce 重放的 builder：
 * - calls[] 是权威源：provider 每次上线的 cb 里重新创建 real builder 并重放。
 * - 同时保留 realBuilder 引用：有值时同步转发调用，与原快路径语义一致。
 */
function makeBuilder(
  ctx: Context,
  name: string,
  description: string | undefined,
  meta: InternalCommandMeta,
): CommandBuilder {
  const calls: DeferredCall[] = [];
  let realBuilder: CommandBuilder | undefined;

  ctx.whenService<CommandService>('commands', svc => {
    realBuilder = svc.command(name, description, meta);
    for (const c of calls) {
      if (c.kind === 'alias') realBuilder.alias(c.name);
      else if (c.kind === 'option') realBuilder.option(c.name, c.syntax, c.opts);
      else if (c.kind === 'action') realBuilder.action(c.handler);
      else if (c.kind === 'usage') realBuilder.usage(c.text);
      else if (c.kind === 'example') realBuilder.example(c.line);
    }
    return () => {
      svc.unregister(name);
      realBuilder = undefined;
    };
  });

  const self: CommandBuilder = {
    alias(n) {
      calls.push({ kind: 'alias', name: n });
      realBuilder?.alias(n);
      return self;
    },
    option(n, syntax, opts) {
      calls.push({ kind: 'option', name: n, syntax, opts });
      realBuilder?.option(n, syntax, opts);
      return self;
    },
    action(handler) {
      calls.push({ kind: 'action', handler });
      realBuilder?.action(handler);
      return self;
    },
    usage(text) {
      calls.push({ kind: 'usage', text });
      realBuilder?.usage(text);
      return self;
    },
    example(line) {
      calls.push({ kind: 'example', line });
      realBuilder?.example(line);
      return self;
    },
  };
  return self;
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    commands: CommandService;
  }
}
