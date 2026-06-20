// ===== 指令服务接口与契约类型（v2 — 链式 builder） =====
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
import type {
  CapabilityConfirm,
  CapabilityId,
  CapabilityRisk,
  CapabilityVisibility,
  ExecutionGuard,
} from '@aalis/plugin-authority-api';

// ===== handler 接口 =====

/** Handler 收到的会话/选项视图（不含原始 args，位置参数走形参） */
export interface CommandArgv {
  session: {
    sessionId: string;
    platform: string;
    userId?: string;
    /** 会话信道类型（适配器标注；私聊敏感指令如 /bind 据此设防） */
    sessionType?: 'group' | 'private' | 'channel';
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
  /** 主能力默认可见性（轴 A；缺省 public）；restricted 须被 owner/委托授予。子命令继承父分组声明 */
  visibility?: CapabilityVisibility;
  /** 确认要求（轴 B，与 visibility 正交、owner 也生效）：'session'/'always'；缺省=不确认。子命令继承父声明 */
  confirm?: CapabilityConfirm;
  /** 风险等级（声明糖）：展开为 (visibility, confirm) 默认；显式 visibility/confirm 覆盖 */
  risk?: CapabilityRisk;
  /** 额外触达的资源能力（如 storage:path:...:write），不含默认 command:<name> */
  permissions?: CapabilityId[];
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
  /** 主能力默认可见性（缺省 public）；可被 authority 配置的 tierOverrides 调整 */
  visibility: CapabilityVisibility;
  /** 生效确认要求（轴 B，含从父分组继承）；缺省=不确认 */
  confirm?: CapabilityConfirm;
  /** 有效资源能力列表（含默认 command:<name> + 从父分组继承的声明） */
  permissions: string[];
  /** 别名（完整点路径） */
  aliases: string[];
  positionalArgs: PositionalArgSpec[];
  options: OptionSpec[];
  usage?: string;
  examples?: string[];
  /** 执行函数；分组节点为 undefined */
  handler?: CommandHandler;
  /** 是否为自动创建的分组节点 */
  isGroup: boolean;
}

/** 命令服务消费方（CLI / 适配器）传入的执行输入 */
export interface ExecutionInput {
  sessionId: string;
  platform: string;
  userId?: string;
  /** 会话信道类型（透传自 IncomingMessage.sessionType） */
  sessionType?: 'group' | 'private' | 'channel';
  args: string[];
  raw: string;
  /**
   * 跳过受限被拒后的交互确认弹窗（requestAccess）；authorize 仍然生效。
   *
   * 供无法交互确认的受信任系统源（scheduler 等）使用：这些调用的身份来自
   * 创建时固化的 actor（IncomingMessage.actor），能力按 actor 真实持有评估，
   * 只是 cron 上下文里没有人能点确认弹窗，故跳过该步。**不**绕过 authorize（防提权）。
   */
  skipConfirm?: boolean;
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
