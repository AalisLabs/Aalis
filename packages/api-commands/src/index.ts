// ===== 指令服务接口与契约类型（v2 — 链式 builder） =====
//
// 本包提供斜杠指令系统的全部"非实现"契约。
//
// 核心理念：
// - 单一 Command 类型，命令层级用 name 的点路径表达（'memory.clear.all'）
// - Builder API：commands.command(name).option().action()（`commands` 为本包导出的服务描述符，经 uses 声明）
// - inline DSL 声明位置参数：'memory.set <key:string> [value:text]'
// - 位置参数作为 handler 形参传入：(argv, key, value) => ...
//
// 实现见 @aalis/plugin-commands。

import type { CapabilityConfirm, CapabilityRisk, CapabilityVisibility, ExecutionGuard } from '@aalis/api-authority';
import { defineService } from '@aalis/core';

// ===== handler 接口 =====

/** Handler 收到的会话/选项视图（不含原始 args，位置参数走形参） */
export interface CommandArgv {
  session: {
    sessionId: string;
    platform: string;
    userId?: string;
    /** 平台类型名（透传自 IncomingMessage.sessionType） */
    sessionType?: string;
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
  /** 说明，帮助里列在参数后面；由 builder 的 argument 添加 */
  description?: string;
}

export type OptionValueType = 'string' | 'number' | 'boolean' | 'string[]';

/** 选项的一个取值；说明在帮助里列在取值后面 */
export interface OptionChoice {
  value: string;
  description?: string;
}

export interface OptionSpec {
  /** 长选项名 (--name) */
  name: string;
  /** 短选项别名 (-x)，可多个 */
  aliases: string[];
  /** 值类型；boolean 表示纯 flag */
  type: OptionValueType;
  /** 占位符名（用于 help 输出），如 'page' */
  valueName?: string;
  /** 值可选时（[val:type] 语法），flag 存在但无值给 true */
  valueOptional: boolean;
  description?: string;
  default?: unknown;
  required: boolean;
  /** 可选的取值，帮助里逐项列出。`string` 选项只收其中之一；`string[]` 不按它校验，由指令自己核 */
  choices?: readonly OptionChoice[];
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
  /** 主能力默认可见性（缺省 public）；可被 authority 配置的 authorityOverrides 调整 */
  visibility: CapabilityVisibility;
  /** 生效确认要求（轴 B，含从父分组继承）；缺省=不确认 */
  confirm?: CapabilityConfirm;
  /** 原始风险声明（透传，含沿点路径继承）；供 authority 派生 minTier：safe→访客/sensitive→朋友/dangerous→信任 */
  risk?: CapabilityRisk;
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
  /** 平台类型名（透传自 IncomingMessage.sessionType） */
  sessionType?: string;
  args: string[];
  raw: string;
  /**
   * 跳过指令声明的确认（confirm 为 always 的照常确认）；authorize 仍然生效。
   *
   * 供没人可问的受信任来源使用：scheduler 触发的指令（owner 建任务时已经授权，身份是创建时固化的 actor）、
   * runtime 一次性子命令（owner 在本机终端亲手输入）。**不**绕过 authorize（防提权）。
   */
  skipConfirm?: boolean;
  /**
   * 向发出者本人核对意图：调用方能在同一会话里当面问到发出者（人亲手输入的消息）时提供，resolve true 为确认。
   * 原样交给执行守卫（ExecutionGuardContext.confirmIntent）；需要确认的指令没有它就按拒绝处理
   */
  confirmIntent?: () => Promise<boolean>;
}

// ===== Builder =====

export interface OptionRegisterOptions {
  description?: string;
  default?: unknown;
  required?: boolean;
  /** 可选的取值：只写值，或带上说明 */
  choices?: readonly (string | OptionChoice)[];
}

export interface CommandBuilder {
  alias(name: string): CommandBuilder;
  /** 声明选项。`-h` 与 `--help` 是保留选项（回这条指令的用法），声明它们时抛错 */
  option(name: string, syntax: string, options?: OptionRegisterOptions): CommandBuilder;
  /** 给 DSL 里声明的位置参数加说明；名字不在 DSL 里时抛错 */
  argument(name: string, description: string): CommandBuilder;
  action(handler: CommandHandler): CommandBuilder;
  usage(text: string): CommandBuilder;
  example(line: string): CommandBuilder;
}

// ===== 服务接口 =====

/** 经 `commands` 描述符按激活绑定的门面调用 `service.command` 时携带 pluginName（激活 id）；插件侧不必传 */
export interface InternalCommandMeta extends CommandMeta {
  pluginName?: string;
}

export interface CommandService {
  prefix: string;

  /**
   * 启动 builder 注册一个命令。
   * @param name 完整点路径名，可含 inline DSL：`'memory.set <key:string> [value:text]'`
   * @param description 说明。第一句（到第一个句号、分号、问号、叹号或换行为止）是 /help 概览与子指令列表里的摘要，
   *   写成一句短话（24 字以内，过长会被截断），细节写在后面
   */
  command(name: string, description?: string, meta?: InternalCommandMeta): CommandBuilder;

  /**
   * 注销指令。
   * @param contextId 只摘该登记者的那一层声明，被它覆盖的声明会自动复位。
   *   **插件自己的清理必须传它**（`commands` 门面的退订已代传）；缺省会摘掉全部层（管理面用）。
   */
  unregister(name: string, contextId?: string): void;

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

  /** 注入执行守卫，用于能力裁决与确认；传 undefined 摘掉，需要更高等级或确认的指令退回 fail-closed */
  setExecutionGuard(guard: ExecutionGuard | undefined): void;
}

// ===== 指令 builder =====

type DeferredCall =
  | { kind: 'alias'; name: string }
  | { kind: 'option'; name: string; syntax: string; opts?: OptionRegisterOptions }
  | { kind: 'argument'; name: string; description: string }
  | { kind: 'action'; handler: CommandHandler }
  | { kind: 'usage'; text: string }
  | { kind: 'example'; line: string };

/** 一条指令登记：builder 调用按序记下，提供者在场时同步转发，换人时在新提供者上重建并重放 */
interface CommandEntry {
  /** 注册表按点路径建键（inline 位置参数 DSL 在注册时被切掉），注销与同名替换都用它 */
  key: string;
  name: string;
  description?: string;
  meta: InternalCommandMeta;
  calls: DeferredCall[];
  /** 当前提供者上的真 builder；撤回后清空 */
  real?: CommandBuilder;
}

function registerEntry(svc: CommandService, entry: CommandEntry): () => void {
  const real = svc.command(entry.name, entry.description, entry.meta);
  for (const c of entry.calls) {
    if (c.kind === 'alias') real.alias(c.name);
    else if (c.kind === 'option') real.option(c.name, c.syntax, c.opts);
    else if (c.kind === 'argument') real.argument(c.name, c.description);
    else if (c.kind === 'action') real.action(c.handler);
    else if (c.kind === 'usage') real.usage(c.text);
    else if (c.kind === 'example') real.example(c.line);
  }
  entry.real = real;
  return () => {
    entry.real = undefined;
    // 必须带上 contextId（meta.pluginName）：只摘自己那一层声明。不带的话会把同名指令的**全部**声明
    // 一起删掉——包括别的插件先注册的那份，且它不会重新出现。
    svc.unregister(entry.key, entry.meta.pluginName);
  };
}

function makeBuilder(entry: CommandEntry): CommandBuilder {
  const { calls } = entry;
  const self: CommandBuilder = {
    alias(n) {
      calls.push({ kind: 'alias', name: n });
      entry.real?.alias(n);
      return self;
    },
    option(n, syntax, opts) {
      calls.push({ kind: 'option', name: n, syntax, opts });
      entry.real?.option(n, syntax, opts);
      return self;
    },
    argument(n, description) {
      calls.push({ kind: 'argument', name: n, description });
      entry.real?.argument(n, description);
      return self;
    },
    action(handler) {
      calls.push({ kind: 'action', handler });
      entry.real?.action(handler);
      return self;
    },
    usage(text) {
      calls.push({ kind: 'usage', text });
      entry.real?.usage(text);
      return self;
    },
    example(line) {
      calls.push({ kind: 'example', line });
      entry.real?.example(line);
      return self;
    },
  };
  return self;
}

// ===== 服务描述符（按激活绑定）=====

/**
 * `commands` 的绑定接口：指令声明自动归属这次激活（每个激活一层声明，撤回时被覆盖的声明自动复位）。
 * 同一激活再登记同名指令替换先前那次；提供者换人时整体重挂，关闭时与原语同一拍撤回。
 */
export interface BoundCommands extends CommandService {
  /** 同 {@link CommandService.command}：描述的第一句是 /help 里的摘要 */
  command(name: string, description?: string, meta?: CommandMeta): CommandBuilder;
}

export const commands = defineService<CommandService, BoundCommands>('commands', port => {
  const entries = port.registrar<CommandEntry>({ key: entry => entry.key, register: registerEntry });
  return Object.assign(Object.create(port.provider) as BoundCommands, {
    command: (name: string, description?: string, meta?: CommandMeta) => {
      const entry: CommandEntry = {
        key: name.trim().split(/\s+/)[0],
        name,
        description,
        meta: { ...meta, pluginName: port.id },
        calls: [],
      };
      entries.add(entry);
      return makeBuilder(entry);
    },
  });
});
