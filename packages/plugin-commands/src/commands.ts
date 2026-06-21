import type { Logger } from '@aalis/core';
import type {
  CapabilityConfirm,
  CapabilityRisk,
  CapabilityVisibility,
  ExecutionGuard,
} from '@aalis/plugin-authority-api';
import { riskDefaults } from '@aalis/plugin-authority-api';
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
} from '@aalis/plugin-commands-api';

// ============================================================================
// 命令注册表（v2 — 链式 builder）
//
// 契约见 @aalis/plugin-commands-api
//
// - Map<fullDotName, Command>，name 即注册键
// - 注册 'memory.clear.all' 时自动创建 'memory' / 'memory.clear' 分组节点（无 handler）
// - 解析输入时按最长前缀匹配命中节点
// - 可见性（public/restricted）沿点路径继承：子节点未声明则取最近声明的祖先，缺省 public。
//   能力可见性的运行时覆盖在 authority 配置（authorityOverrides），不在本注册表。
// ============================================================================

const NAME_SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

/** 内部：构造 Command 时的可变 patches（builder 写入这里，最终 finalize 时合成有效值） */
interface CommandPatches {
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
  pluginName?: string;
  /** 是否由用户显式 .command() 声明过；自动分组保持 false */
  declared: boolean;
}

function emptyPatches(): CommandPatches {
  return {
    aliases: [],
    positionalArgs: [],
    options: [],
    examples: [],
    declared: false,
  };
}

export class CommandRegistry implements CommandService {
  private readonly nodes = new Map<string, CommandPatches>();
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

    let node = this.nodes.get(name);
    if (!node) {
      node = emptyPatches();
      this.nodes.set(name, node);
    } else if (node.declared) {
      this.logger.warn(`指令 ${this.prefix}${name} 已存在，将被覆盖（来自 ${meta?.pluginName ?? 'unknown'}）`);
      // 复用旧节点但清空可变字段
      node.aliases = [];
      node.positionalArgs = [];
      node.options = [];
      node.examples = [];
      node.handler = undefined;
    }

    node.declared = true;
    node.description = description ?? '';
    // 展开 risk 但保留「未声明=继承」语义（不套 public 兜底，由 materialize 末尾兜底）
    node.baseVisibility = meta?.visibility ?? riskDefaults(meta?.risk).visibility;
    node.baseConfirm = meta?.confirm ?? riskDefaults(meta?.risk).confirm;
    node.baseRisk = meta?.risk;
    node.positionalArgs = positionalArgs;
    node.usage = meta?.usage;
    if (meta?.examples) node.examples.push(...meta.examples);
    node.pluginName = meta?.pluginName ?? 'unknown';

    this.logger.debug(`注册指令: ${this.prefix}${name} (来自 ${node.pluginName})`);

    return this.makeBuilder(name);
  }

  private makeBuilder(name: string): CommandBuilder {
    const self: CommandBuilder = {
      alias: (aliasName: string) => {
        const segs = aliasName.split('.');
        for (const s of segs) validateNameSegment(s);
        const existing = this.aliases.get(aliasName);
        if (existing && existing !== name) {
          this.logger.warn(`别名 ${this.prefix}${aliasName} 已指向 ${existing}，将改指 ${name}`);
        }
        this.aliases.set(aliasName, name);
        const node = this.nodes.get(name);
        if (node && !node.aliases.includes(aliasName)) node.aliases.push(aliasName);
        return self;
      },
      option: (optName: string, syntax: string, opts?: OptionRegisterOptions) => {
        const spec = parseOptionSyntax(optName, syntax, opts);
        const node = this.nodes.get(name);
        if (node) node.options.push(spec);
        return self;
      },
      action: (handler: CommandHandler) => {
        const node = this.nodes.get(name);
        if (node) node.handler = handler;
        return self;
      },
      usage: (text: string) => {
        const node = this.nodes.get(name);
        if (node) node.usage = text;
        return self;
      },
      example: (line: string) => {
        const node = this.nodes.get(name);
        if (node) node.examples.push(line);
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
      if (!this.nodes.has(groupName)) {
        const patches = emptyPatches();
        patches.description = `${groupName} 命令组`;
        this.nodes.set(groupName, patches);
      }
    }
  }

  // ---- 注销 ----

  unregister(name: string): void {
    const node = this.nodes.get(name);
    if (!node) return;
    this.nodes.delete(name);
    for (const a of node.aliases) this.aliases.delete(a);
    this.logger.debug(`注销指令: ${this.prefix}${name}`);
  }

  unregisterByPlugin(pluginName: string): void {
    for (const [name, node] of [...this.nodes]) {
      if (node.pluginName === pluginName) this.unregister(name);
    }
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
    const node = this.nodes.get(name);
    if (!node) throw new Error(`internal: node ${name} missing`);

    // 父继承：沿 dot path 向上合并。可见性取「最近声明的祖先」，子节点可覆盖。
    let effVisibility: CapabilityVisibility = 'public';
    let effConfirm: CapabilityConfirm | undefined;
    let effRisk: CapabilityRisk | undefined;
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('.');
      const p = this.nodes.get(parent);
      if (p?.baseVisibility !== undefined) effVisibility = p.baseVisibility;
      if (p?.baseConfirm !== undefined) effConfirm = p.baseConfirm;
      if (p?.baseRisk !== undefined) effRisk = p.baseRisk;
    }

    const visibility = node.baseVisibility ?? effVisibility;
    const confirm = node.baseConfirm ?? effConfirm;
    const risk = node.baseRisk ?? effRisk;

    return {
      name,
      pluginName: node.pluginName ?? 'unknown',
      description: node.description ?? '',
      visibility,
      confirm,
      risk,
      aliases: [...node.aliases],
      positionalArgs: [...node.positionalArgs],
      options: [...node.options],
      usage: node.usage,
      examples: [...node.examples],
      handler: node.handler,
      isGroup: !node.declared,
    };
  }

  // ---- usage 自动格式化 ----

  private formatUsage(cmd: Command): string {
    if (cmd.usage) return cmd.usage;
    const head = `${this.prefix}${cmd.name.replace(/\./g, ' ')}`;
    const argText = cmd.positionalArgs
      .map(a => (a.required ? `<${a.name}:${a.type}>` : `[${a.name}:${a.type}]`))
      .join(' ');
    const optionText = cmd.options.length > 0 ? ' [options]' : '';
    const subs = this.directChildren(cmd.name);
    const subText = subs.length > 0 && !cmd.handler ? ' <subcommand>' : '';
    const lines: string[] = [`用法: ${head}${subText}${argText ? ` ${argText}` : ''}${optionText}`, ''];
    lines.push(cmd.description);
    if (cmd.positionalArgs.length > 0) {
      lines.push('', '参数：');
      for (const a of cmd.positionalArgs) {
        lines.push(`  ${a.required ? '<' : '['}${a.name}:${a.type}${a.required ? '>' : ']'}`);
      }
    }
    if (cmd.options.length > 0) {
      lines.push('', '选项：');
      for (const o of cmd.options) {
        const flags = [`--${o.name}`, ...o.aliases.map(a => `-${a}`)].join(', ');
        const val =
          o.type === 'boolean' ? '' : o.valueOptional ? ` [${o.valueName ?? o.name}]` : ` <${o.valueName ?? o.name}>`;
        const choices = o.choices && o.choices.length > 0 ? ` (${o.choices.join('|')})` : '';
        lines.push(`  ${flags}${val} — ${o.description ?? o.type}${choices}`);
      }
    }
    if (subs.length > 0) {
      lines.push('', '可用子指令：');
      for (const s of subs) {
        const child = this.materialize(s);
        lines.push(`  ${child.name.split('.').pop()} — ${child.description}`);
      }
    }
    if (cmd.examples && cmd.examples.length > 0) {
      lines.push('', '示例：');
      for (const e of cmd.examples) lines.push(`  ${e}`);
    }
    return lines.join('\n');
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
