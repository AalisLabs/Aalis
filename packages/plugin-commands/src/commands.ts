import type { CapabilityConfirm, CapabilityRisk, CapabilityVisibility, ExecutionGuard } from '@aalis/api-authority';
import { riskDefaults } from '@aalis/api-authority';
import type {
  Command,
  CommandArgv,
  CommandBuilder,
  CommandHandler,
  CommandService,
  ExecutionInput,
  InternalCommandMeta,
  OptionRegisterOptions,
  OptionSpec,
  OptionValueType,
  PositionalArgSpec,
  PositionalArgType,
} from '@aalis/api-commands';
import type { Logger } from '@aalis/core';
import { renderDetail } from './help.js';

// ============================================================================
// 命令注册表（v2 — 链式 builder）
//
// 契约见 @aalis/api-commands
//
// - Map<fullDotName, Command>，name 即注册键
// - 注册 'memory.clear.all' 时自动创建 'memory' / 'memory.clear' 分组节点（无 handler）
// - 解析输入时按最长前缀匹配命中节点
// - 可见性（public/restricted）沿点路径继承：子节点未声明则取最近声明的祖先，缺省 public。
//   能力可见性的运行时覆盖在 authority 配置（authorityOverrides），不在本注册表。
// ============================================================================

const NAME_SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 一条指令声明。**节点持有的是一个声明栈**，不是单个格子。
 *
 * 旧实现每个名字只有一层：同名再注册就把这层就地清空并改写 `pluginName`。两个后果都实测过：
 * 1. **提权** —— 后注册者不带 meta 时 `baseVisibility` 被写成 undefined，materialize 兜底成
 *    `public`，于是任何插件重注册一个 restricted 指令名就能把权限闸降掉。
 * 2. **破坏** —— 所有权被改写后，覆盖者卸载时按 `pluginName` 匹配到整个节点并删除，
 *    先注册者的指令一并消失且不会回来。
 *
 * 改成栈之后：栈顶生效（**保持「后来者胜」的既有语义**），卸载只摘自己那一层、下面的自动
 * 复位，而安全轴取全栈最严（见 `strictestPolicy`）——后来者只能收紧、不能放宽。
 */
interface Decl {
  description?: string;
  /** 节点自身声明的可见性（未声明则继承祖先；缺省 public） */
  baseVisibility?: CapabilityVisibility;
  /** 节点自身声明的确认要求（轴 B；未声明则继承祖先） */
  baseConfirm?: CapabilityConfirm;
  /** 节点自身声明的原始风险（透传，未声明则继承祖先）；供 authority 区分 sensitive(朋友)/dangerous(信任) */
  baseRisk?: CapabilityRisk;
  aliases: string[];
  positionalArgs: PositionalArgSpec[];
  options: OptionSpec[];
  usage?: string;
  examples: string[];
  handler?: CommandHandler;
  /** 声明者。卸载按它精确摘层。 */
  pluginName: string;
}

/**
 * 安全轴取全栈**最严**，而不是取栈顶。
 *
 * 栈顶决定「跑谁的 handler」，但不该决定「谁能跑」——否则后注册者只要不声明 meta 就能把
 * 已有的 restricted 指令降成 public（实测存在的提权路径）。取最严则后来者只能收紧。
 * 纯函数，便于单测。
 */
function strictestPolicy(decls: readonly Decl[]): {
  visibility?: CapabilityVisibility;
  confirm?: CapabilityConfirm;
  risk?: CapabilityRisk;
} {
  const CONFIRM_ORDER: CapabilityConfirm[] = ['session', 'always'];
  const RISK_ORDER: CapabilityRisk[] = ['safe', 'sensitive', 'dangerous'];
  let visibility: CapabilityVisibility | undefined;
  let confirm: CapabilityConfirm | undefined;
  let risk: CapabilityRisk | undefined;
  for (const d of decls) {
    if (d.baseVisibility === 'restricted') visibility = 'restricted';
    else if (d.baseVisibility === 'public' && visibility === undefined) visibility = 'public';
    if (d.baseConfirm && (!confirm || CONFIRM_ORDER.indexOf(d.baseConfirm) > CONFIRM_ORDER.indexOf(confirm))) {
      confirm = d.baseConfirm;
    }
    if (d.baseRisk && (!risk || RISK_ORDER.indexOf(d.baseRisk) > RISK_ORDER.indexOf(risk))) risk = d.baseRisk;
  }
  return { visibility, confirm, risk };
}

export class CommandRegistry implements CommandService {
  /** 名字 → 声明栈。空栈 = 自动创建的分组节点。 */
  private readonly nodes = new Map<string, Decl[]>();
  /** 别名映射：aliasName → realName */
  private readonly aliases = new Map<string, string>();
  private readonly logger: Logger;
  private _guard?: ExecutionGuard;

  prefix = '/';

  constructor(logger: Logger) {
    this.logger = logger.child('commands');
  }

  // ---- Guard ----

  setExecutionGuard(guard: ExecutionGuard): void {
    this._guard = guard;
  }

  // ---- Builder 入口 ----

  command(rawName: string, description?: string, meta?: InternalCommandMeta): CommandBuilder {
    const parsed = parseCommandName(rawName);
    const { name, positionalArgs } = parsed;
    validateName(name);

    // 确保所有祖先分组节点存在
    this.ensureGroups(name);

    let stack = this.nodes.get(name);
    if (!stack) {
      stack = [];
      this.nodes.set(name, stack);
    } else if (stack.length > 0) {
      this.logger.warn(
        `指令 ${this.prefix}${name} 已由 ${stack[stack.length - 1].pluginName} 注册，` +
          `${meta?.pluginName ?? 'unknown'} 的声明将覆盖其行为（卸载后自动复位；权限只会更严不会更松）`,
      );
    }

    // 压栈而非就地改写：旧声明原样留着，覆盖者卸载后它自动重新生效。
    const decl: Decl = {
      description: description ?? '',
      // 展开 risk 但保留「未声明=继承」语义（不套 public 兜底，由 materialize 末尾兜底）
      baseVisibility: meta?.visibility ?? riskDefaults(meta?.risk).visibility,
      baseConfirm: meta?.confirm ?? riskDefaults(meta?.risk).confirm,
      baseRisk: meta?.risk,
      aliases: [],
      positionalArgs,
      options: [],
      usage: meta?.usage,
      examples: meta?.examples ? [...meta.examples] : [],
      pluginName: meta?.pluginName ?? 'unknown',
    };
    stack.push(decl);

    this.logger.debug(`注册指令: ${this.prefix}${name} (来自 ${decl.pluginName})`);

    return this.makeBuilder(name, decl);
  }

  /** builder 写入**自己那一层声明**（闭包持有，无需每次查表）。 */
  private makeBuilder(name: string, decl: Decl): CommandBuilder {
    const self: CommandBuilder = {
      alias: (aliasName: string) => {
        const segs = aliasName.split('.');
        for (const s of segs) validateNameSegment(s);
        const existing = this.aliases.get(aliasName);
        if (existing && existing !== name) {
          this.logger.warn(`别名 ${this.prefix}${aliasName} 已指向 ${existing}，将改指 ${name}`);
        }
        this.aliases.set(aliasName, name);
        if (!decl.aliases.includes(aliasName)) decl.aliases.push(aliasName);
        return self;
      },
      option: (optName: string, syntax: string, opts?: OptionRegisterOptions) => {
        decl.options.push(parseOptionSyntax(optName, syntax, opts));
        return self;
      },
      action: (handler: CommandHandler) => {
        decl.handler = handler;
        return self;
      },
      usage: (text: string) => {
        decl.usage = text;
        return self;
      },
      example: (line: string) => {
        decl.examples.push(line);
        return self;
      },
    };
    return self;
  }

  /** 自动创建祖先分组节点（不替换已存在节点） */
  private ensureGroups(name: string): void {
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const groupName = parts.slice(0, i).join('.');
      if (!this.nodes.has(groupName)) this.nodes.set(groupName, []);
    }
  }

  // ---- 注销 ----

  /**
   * 注销。
   *
   * @param pluginName 只摘该插件的那一层声明——下面被它覆盖的声明会自动重新生效。
   *   缺省则摘掉全部层（管理面用；插件自己的 dispose 必须传名字，否则会连别人的一起删）。
   */
  unregister(name: string, pluginName?: string): void {
    const stack = this.nodes.get(name);
    if (!stack) return;
    const dropped = pluginName === undefined ? stack.splice(0) : removeWhere(stack, d => d.pluginName === pluginName);
    if (dropped.length === 0) return;
    for (const d of dropped) for (const a of d.aliases) this.aliases.delete(a);
    // 栈空但仍有子节点 → 退回自动分组节点（`/parent` 仍可列出子指令），不删。
    if (stack.length === 0 && this.directChildren(name).length === 0) this.nodes.delete(name);
    this.logger.debug(`注销指令: ${this.prefix}${name} (来自 ${pluginName ?? '全部'})`);
  }

  unregisterByPlugin(pluginName: string): void {
    for (const name of [...this.nodes.keys()]) this.unregister(name, pluginName);
  }

  // ---- 解析输入 ----

  parseCommand(input: string): { name: string; args: string[]; raw: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    let body = trimmed;
    if (this.prefix) {
      if (!trimmed.startsWith(this.prefix)) return null;
      body = trimmed.slice(this.prefix.length);
    }
    const parts = tokenize(body);
    const head = parts[0];
    if (!head) return null;
    // 无前缀模式下，只有命中已知命令首段才认为是命令
    if (!this.prefix && !this.hasTopSegment(head)) return null;
    return { name: head, args: parts.slice(1), raw: trimmed };
  }

  has(name: string): boolean {
    return this.hasTopSegment(name);
  }

  private hasTopSegment(name: string): boolean {
    if (this.nodes.has(name) || this.aliases.has(name)) return true;
    // 也许是 'memory.x' 的 'memory' 顶层段
    for (const k of this.nodes.keys()) {
      if (k === name || k.startsWith(`${name}.`)) return true;
    }
    return false;
  }

  get(name: string): Command | undefined {
    const real = this.aliases.get(name) ?? name;
    if (!this.nodes.has(real)) return undefined;
    return this.materialize(real);
  }

  getNode(path: string | string[]): Command | undefined {
    const name = Array.isArray(path) ? path.join('.') : path;
    return this.get(name);
  }

  getAll(): Command[] {
    return [...this.nodes.keys()].sort().map(n => this.materialize(n));
  }

  // ---- 解析与执行 ----

  /**
   * 沿层级最长匹配。tokens 是 parseCommand 后的 args（即 head 之后的部分）；
   * head 是 parseCommand 返回的 name。
   *
   * 返回命中节点的完整 dotName 与剩余 tokens。
   */
  private resolve(head: string, tokens: string[]): { name: string; remaining: string[] } | null {
    const realHead = this.aliases.get(head) ?? head;
    // 不存在 realHead 节点也不存在以 realHead 开头：未命中
    if (!this.nodes.has(realHead) && !this.findNodesPrefixed(realHead)) return null;

    let current = realHead;
    let consumed = 0;
    for (let i = 0; i < tokens.length; i++) {
      const candidate = `${current}.${tokens[i]}`;
      // 候选要么本身存在，要么作为更深节点的前缀存在
      if (this.nodes.has(candidate) || this.findNodesPrefixed(candidate)) {
        current = candidate;
        consumed = i + 1;
      } else {
        break;
      }
    }
    // 若当前不是真实节点（仅是别名首段而无 head 顶级节点），不应发生（已 ensure）
    if (!this.nodes.has(current)) return null;
    return { name: current, remaining: tokens.slice(consumed) };
  }

  private findNodesPrefixed(prefix: string): boolean {
    for (const k of this.nodes.keys()) {
      if (k.startsWith(`${prefix}.`)) return true;
    }
    return false;
  }

  /**
   * 判断 head + tokens 是否能匹配到任何已注册的指令节点。
   * 用于 inbound middleware 区分"未匹配指令"和"已命中"。
   * 未匹配时调用方可决定走普通消息管道，而不是回显"未知指令"。
   */
  hasMatch(head: string, tokens: string[] = []): boolean {
    return this.resolve(head, tokens) !== null;
  }

  async execute(name: string, input: ExecutionInput): Promise<string | undefined> {
    const resolved = this.resolve(name, input.args);
    if (!resolved) return `未知指令: ${this.prefix}${name}。输入 ${this.prefix}help 查看帮助。`;

    const cmd = this.materialize(resolved.name);
    if (!cmd.handler) {
      return this.formatUsage(cmd);
    }

    const parsed = this.parseArgs(cmd, resolved.remaining);
    if (typeof parsed === 'string') return parsed;

    if (this._guard) {
      const rejection = await this._guard({
        name: cmd.name,
        type: 'command',
        visibility: cmd.visibility,
        confirm: cmd.confirm,
        risk: cmd.risk,
        sessionId: input.sessionId,
        platform: input.platform,
        userId: input.userId,
        skipConfirm: input.skipConfirm,
      });
      if (rejection) return rejection;
    }

    try {
      const argv: CommandArgv = {
        session: {
          sessionId: input.sessionId,
          platform: input.platform,
          userId: input.userId,
          sessionType: input.sessionType,
          raw: input.raw,
        },
        options: parsed.options,
      };
      const result = await cmd.handler(argv, ...parsed.positionals);
      return result ?? undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`指令 ${this.prefix}${cmd.name} 执行失败: ${message}`);
      return `指令执行失败: ${message}`;
    }
  }

  // ---- 内部：把 patches 合成有效 Command（含父级可见性 + 权限继承） ----

  private materialize(name: string): Command {
    const stack = this.nodes.get(name);
    if (!stack) throw new Error(`internal: node ${name} missing`);
    // 栈顶决定「跑谁的实现」；安全轴取全栈最严（后来者只能收紧，见 strictestPolicy）。
    const top = stack[stack.length - 1];
    const policy = strictestPolicy(stack);

    // 父继承：沿 dot path 向上合并。可见性取「最近声明的祖先」，子节点可覆盖。
    let effVisibility: CapabilityVisibility = 'public';
    let effConfirm: CapabilityConfirm | undefined;
    let effRisk: CapabilityRisk | undefined;
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('.');
      const pp = strictestPolicy(this.nodes.get(parent) ?? []);
      if (pp.visibility !== undefined) effVisibility = pp.visibility;
      if (pp.confirm !== undefined) effConfirm = pp.confirm;
      if (pp.risk !== undefined) effRisk = pp.risk;
    }

    const visibility = policy.visibility ?? effVisibility;
    const confirm = policy.confirm ?? effConfirm;
    const risk = policy.risk ?? effRisk;

    return {
      name,
      pluginName: top?.pluginName ?? 'unknown',
      // 空栈 = 自动创建的分组节点，描述在此派生而非落字段（少存一份、不会陈旧）。
      description: top?.description ?? `${name} 命令组`,
      visibility,
      confirm,
      risk,
      aliases: [...(top?.aliases ?? [])],
      positionalArgs: [...(top?.positionalArgs ?? [])],
      options: [...(top?.options ?? [])],
      usage: top?.usage,
      examples: [...(top?.examples ?? [])],
      handler: top?.handler,
      isGroup: stack.length === 0,
    };
  }

  // ---- usage 自动格式化 ----

  /**
   * 单条指令的用法详情。与 `/help <指令>` 共用同一个渲染器（help.ts 的
   * renderDetail）——裸调用分组、未知选项报错、help 详情三条路径一处修全部好。
   */
  private formatUsage(cmd: Command): string {
    if (cmd.usage) return cmd.usage;
    return renderDetail(
      cmd,
      this.directChildren(cmd.name).map(n => this.materialize(n)),
      this.prefix,
    );
  }

  private directChildren(parent: string): string[] {
    const prefix = `${parent}.`;
    const out: string[] = [];
    for (const k of this.nodes.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        if (!rest.includes('.')) out.push(k);
      }
    }
    return out.sort();
  }

  // ---- 选项 + 位置参数 解析 ----

  private parseArgs(
    cmd: Command,
    rawArgs: string[],
  ): { positionals: unknown[]; options: Record<string, unknown> } | string {
    const options = this.defaultOptions(cmd.options);
    const positionalTokens: string[] = [];

    try {
      for (let i = 0; i < rawArgs.length; i++) {
        const token = rawArgs[i];
        if (token === '--') {
          positionalTokens.push(...rawArgs.slice(i + 1));
          break;
        }
        if (token.startsWith('--') && token.length > 2) {
          const eq = token.indexOf('=');
          const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
          const negated = rawName.startsWith('no-');
          const optName = negated ? rawName.slice(3) : rawName;
          const def = findOption(cmd.options, optName);
          if (!def) return `未知选项: --${optName}\n\n${this.formatUsage(cmd)}`;
          let rawValue = eq >= 0 ? token.slice(eq + 1) : undefined;
          if (def.type === 'boolean') {
            options[def.name] = negated ? false : rawValue === undefined ? true : parseBoolean(rawValue);
          } else {
            if (rawValue === undefined) {
              if (def.valueOptional) {
                options[def.name] = true;
                continue;
              }
              i += 1;
              rawValue = rawArgs[i];
            }
            if (rawValue === undefined) return `选项 --${optName} 缺少取值`;
            options[def.name] = parseOptionValue(def, rawValue, options[def.name]);
          }
          continue;
        }
        if (token.startsWith('-') && token.length > 1) {
          const alias = token.slice(1);
          const def = findOption(cmd.options, alias);
          if (!def) return `未知选项: -${alias}\n\n${this.formatUsage(cmd)}`;
          if (def.type === 'boolean') {
            options[def.name] = true;
          } else {
            i += 1;
            const rawValue = rawArgs[i];
            if (rawValue === undefined) {
              if (def.valueOptional) {
                options[def.name] = true;
                continue;
              }
              return `选项 -${alias} 缺少取值`;
            }
            options[def.name] = parseOptionValue(def, rawValue, options[def.name]);
          }
          continue;
        }
        positionalTokens.push(token);
      }

      for (const o of cmd.options) {
        if (o.required && options[o.name] === undefined) return `缺少必填选项: --${o.name}`;
      }

      const positionals: unknown[] = [];
      let cursor = 0;
      for (const def of cmd.positionalArgs) {
        const values =
          def.type === 'text' ? positionalTokens.slice(cursor) : positionalTokens.slice(cursor, cursor + 1);
        if (values.length === 0) {
          if (def.required) return `缺少必填参数: ${def.name}`;
          positionals.push(undefined);
          continue;
        }
        positionals.push(parsePositionalValue(def, values));
        cursor += values.length;
      }

      return { positionals, options };
    } catch (err) {
      // 取值解析错误（数字非法 / choices 越界）→ 返回可读错误串，而非抛出冒泡到命令管道。
      return err instanceof Error ? err.message : String(err);
    }
  }

  private defaultOptions(opts: OptionSpec[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const o of opts) if (o.default !== undefined) out[o.name] = o.default;
    return out;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 解析命令名字符串：
 *   'memory.clear.all <key:string> [value:text]'
 *   →  name = 'memory.clear.all'
 *      positionalArgs = [{name:'key', type:'string', required:true}, {name:'value', type:'text', required:false}]
 */
function parseCommandName(raw: string): { name: string; positionalArgs: PositionalArgSpec[] } {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/);
  const name = parts[0];
  const positionalArgs: PositionalArgSpec[] = [];
  for (const part of parts.slice(1)) {
    const m = part.match(/^([<[])([a-z][a-z0-9-]*)(?::([a-z]+))?([>\]])$/i);
    if (!m) throw new Error(`无法解析位置参数: "${part}"，期望 <name:type> 或 [name:type]`);
    const required = m[1] === '<';
    const argName = m[2];
    const type = (m[3] ?? 'string') as PositionalArgType;
    if (m[1] === '<' ? m[4] !== '>' : m[4] !== ']') {
      throw new Error(`位置参数括号不匹配: "${part}"`);
    }
    if (!isPositionalType(type)) throw new Error(`未知位置参数类型: "${type}"`);
    positionalArgs.push({ name: argName, type, required });
  }
  return { name, positionalArgs };
}

function isPositionalType(t: string): t is PositionalArgType {
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'text';
}

function validateName(name: string): void {
  const parts = name.split('.');
  for (const p of parts) validateNameSegment(p);
}

function validateNameSegment(seg: string): void {
  if (!NAME_SEGMENT_RE.test(seg)) {
    throw new Error(`非法命令名段: "${seg}"。期望小写字母开头，仅含 [a-z0-9-]`);
  }
}

/**
 * 解析选项 syntax：
 *   '-v'                    → boolean flag, alias='v'
 *   '-p <page:number>'      → number 选项, alias='p', 必带值, valueName='page'
 *   '-p [page:number]'      → number 选项, alias='p', 值可选
 *   '<page:number>'         → 仅长名，必带值
 *   ''                      → boolean flag, 仅长名
 */
function parseOptionSyntax(name: string, syntax: string, opts?: OptionRegisterOptions): OptionSpec {
  validateNameSegment(name);
  const trimmed = (syntax ?? '').trim();
  const aliases: string[] = [];
  let type: OptionValueType = 'boolean';
  let valueName: string | undefined;
  let takesValue = false;
  let valueOptional = false;

  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    for (const p of parts) {
      // 别名：-x 或 --foo
      if (p.startsWith('--') && p.length > 2) {
        aliases.push(p.slice(2));
        continue;
      }
      if (p.startsWith('-') && p.length > 1 && !/^[<[]/.test(p)) {
        aliases.push(p.slice(1));
        continue;
      }
      // 值占位符
      const m = p.match(/^([<[])([a-z][a-z0-9-]*)(?::([a-z]+(?:\[\])?))?([>\]])$/i);
      if (m) {
        valueOptional = m[1] === '[';
        valueName = m[2];
        const declared = (m[3] ?? 'string').toLowerCase();
        if (declared !== 'string' && declared !== 'number' && declared !== 'boolean' && declared !== 'string[]') {
          throw new Error(`未知选项值类型: "${declared}"`);
        }
        type = declared as OptionValueType;
        takesValue = true;
        if (m[1] === '<' ? m[4] !== '>' : m[4] !== ']') {
          throw new Error(`选项值括号不匹配: "${p}"`);
        }
      }
    }
  }

  return {
    name,
    aliases,
    type,
    valueName,
    takesValue,
    valueOptional,
    description: opts?.description,
    default: opts?.default,
    required: opts?.required === true,
    choices: opts?.choices,
  };
}

function findOption(defs: OptionSpec[], nameOrAlias: string): OptionSpec | undefined {
  return defs.find(o => o.name === nameOrAlias || o.aliases.includes(nameOrAlias));
}

function parseBoolean(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseOptionValue(def: OptionSpec, rawValue: string, previous: unknown): unknown {
  if (def.type === 'number') {
    const n = Number(rawValue);
    if (Number.isNaN(n)) throw new Error(`选项 --${def.name} 需要数字，收到「${rawValue}」`);
    return n;
  }
  if (def.type === 'boolean') return parseBoolean(rawValue);
  if (def.type === 'string[]') {
    const current = Array.isArray(previous) ? (previous as string[]) : [];
    return [
      ...current,
      ...rawValue
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ];
  }
  // string
  if (def.choices && !def.choices.includes(rawValue)) {
    throw new Error(`选项 --${def.name} 只能是: ${def.choices.join(', ')}`);
  }
  return rawValue;
}

function parsePositionalValue(def: PositionalArgSpec, values: string[]): unknown {
  const raw = def.type === 'text' ? values.join(' ') : values[0];
  if (def.type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`参数 ${def.name} 需要数字，收到「${raw}」`);
    return n;
  }
  if (def.type === 'boolean') return parseBoolean(raw);
  return raw;
}

/** 原地移除满足谓词的元素，返回被移除的那些。 */
function removeWhere<T>(arr: T[], pred: (item: T) => boolean): T[] {
  const removed: T[] = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) removed.unshift(...arr.splice(i, 1));
  }
  return removed;
}
