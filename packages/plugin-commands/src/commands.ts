import type {
  CommandDefinition,
  RegisteredCommand,
  CommandContext,
  CommandService,
  CommandNodeInfo,
  SubcommandDefinition,
  SafetyLevel,
  ExecutionGuard,
  CommandArgumentDefinition,
  CommandOptionDefinition,
} from '@aalis/core';
import type { Logger } from '@aalis/core';

/** 内部解析结果：从根指令出发匹配 args 后，得到的最深节点及其链路上下文 */
interface ResolvedCommand {
  /** 根指令 */
  root: RegisteredCommand;
  /** 命中的节点（可能是根本身或某层子指令） */
  node: CommandDefinition | SubcommandDefinition;
  /** 完整路径，如 ['clear','nuke'] */
  path: string[];
  /** 消耗子指令名后剩余的 args（传给 action） */
  remainingArgs: string[];
  /** 应用 override + 父继承后的有效权限 */
  effectiveAuthority: number;
  /** 应用 override + 父继承后的有效安全级别 */
  effectiveSafety: SafetyLevel;
  /** 默认 command:<path> 加声明权限 */
  permissions: string[];
}

interface ParsedCommandArgs {
  args: string[];
  operands: Record<string, unknown>;
  options: Record<string, unknown>;
}

/**
 * 指令注册表 —— 管理用户可调用的斜杠指令的注册、解析、执行
 *
 * 由 plugin-commands 创建并注册为服务 'commands'，
 * 所有插件通过 ctx.command() 注册指令，通过 ctx.commands 访问。
 *
 * 子指令支持：
 * - CommandDefinition.subcommands 可递归嵌套（子、孙、…）
 * - 解析时按 args 顺序逐层匹配子指令名，命中即下沉一层
 * - Override 键为冒号拼接的完整路径：`clear:all`、`db:migrate:up`
 * - authority/safety 子节点未声明时继承父节点的有效值（含 override）
 */
export class CommandRegistry implements CommandService {
  private commands = new Map<string, RegisteredCommand>();
  private logger: Logger;
  private _guard?: ExecutionGuard;
  private overrides = new Map<string, { authority?: number; safety?: string }>();

  prefix = '/';

  constructor(logger: Logger) {
    this.logger = logger.child('commands');
  }

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void {
    this.overrides.clear();
    for (const [name, o] of Object.entries(overrides)) this.overrides.set(name, o);
  }

  setOverride(name: string, override: { authority?: number; safety?: string }): void {
    this.overrides.set(name, override);
  }

  removeOverride(name: string): void { this.overrides.delete(name); }

  getOverrides(): Record<string, { authority?: number; safety?: string }> {
    const result: Record<string, { authority?: number; safety?: string }> = {};
    for (const [name, o] of this.overrides) result[name] = o;
    return result;
  }

  setExecutionGuard(guard: ExecutionGuard): void { this._guard = guard; }

  parseCommand(input: string): { name: string; args: string[]; raw: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (this.prefix) {
      if (!trimmed.startsWith(this.prefix)) return null;
      const rest = trimmed.slice(this.prefix.length);
      const parts = tokenize(rest);
      const name = parts[0];
      if (!name) return null;
      return { name, args: parts.slice(1), raw: trimmed };
    }
    const parts = tokenize(trimmed);
    const name = parts[0];
    if (this.commands.has(name)) return { name, args: parts.slice(1), raw: trimmed };
    return null;
  }

  register(command: CommandDefinition, pluginName: string): () => void {
    const { name } = command;
    if (this.commands.has(name)) {
      this.logger.warn(`指令 "${this.prefix}${name}" 已存在，将被覆盖 (来自 ${pluginName})`);
    }
    const registered: RegisteredCommand = { ...command, pluginName };
    this.commands.set(name, registered);
    this.logger.debug(`注册指令: ${this.prefix}${name} (来自 ${pluginName})`);

    return () => {
      if (this.commands.get(name)?.pluginName === pluginName) {
        this.commands.delete(name);
        this.logger.debug(`注销指令: ${this.prefix}${name}`);
      }
    };
  }

  has(name: string): boolean { return this.commands.has(name); }

  get(name: string): RegisteredCommand | undefined { return this.commands.get(name); }

  /** 仅返回根指令，保持向后兼容（Dashboard 概览等旧调用方） */
  getAll(): RegisteredCommand[] { return [...this.commands.values()]; }

  /**
   * 沿 args 逐层匹配子指令，返回最深命中的节点及链路信息。
   * 未注册根指令返回 null；命中节点至少为根。
   */
  private resolve(name: string, args: string[]): ResolvedCommand | null {
    const root = this.commands.get(name);
    if (!root) return null;

    let node: CommandDefinition | SubcommandDefinition = root;
    const path: string[] = [name];
    let i = 0;

    // 初始有效值 = 根的 override ?? 根声明 ?? 默认
    const rootOvr = this.overrides.get(name);
    let effectiveAuthority = rootOvr?.authority ?? root.authority ?? 1;
    let effectiveSafety: SafetyLevel = (rootOvr?.safety as SafetyLevel) ?? root.safety ?? 'safe';
    const declaredPermissions = [...(root.permissions ?? [])];

    while (node.subcommands && node.subcommands.length > 0 && i < args.length) {
      const sub = node.subcommands.find(s => s.name === args[i]);
      if (!sub) break;
      node = sub;
      path.push(sub.name);
      i += 1;
      const ovr = this.overrides.get(path.join(':'));
      effectiveAuthority = ovr?.authority ?? sub.authority ?? effectiveAuthority;
      effectiveSafety = (ovr?.safety as SafetyLevel) ?? sub.safety ?? effectiveSafety;
      declaredPermissions.push(...(sub.permissions ?? []));
    }

    return {
      root,
      node,
      path,
      remainingArgs: args.slice(i),
      effectiveAuthority,
      effectiveSafety,
      permissions: unique([`command:${path.join(':')}`, ...declaredPermissions]),
    };
  }

  /** 扁平化所有节点供 UI / help 使用，深度优先 */
  getAllNodes(): CommandNodeInfo[] {
    const out: CommandNodeInfo[] = [];
    for (const root of this.commands.values()) {
      this.walkNode(root, [root.name], root.authority ?? 1, root.safety ?? 'safe', [], 0, root.pluginName, true, out);
    }
    return out;
  }

  getNode(path: string | string[]): CommandNodeInfo | undefined {
    const segs = Array.isArray(path) ? path : path.split(':').filter(Boolean);
    if (segs.length === 0) return undefined;
    return this.getAllNodes().find(n => n.path.length === segs.length && n.path.every((p, i) => p === segs[i]));
  }

  /** 递归遍历，传入父继承的有效值 */
  private walkNode(
    node: CommandDefinition | SubcommandDefinition,
    path: string[],
    parentEffectiveAuthority: number,
    parentEffectiveSafety: SafetyLevel,
    parentPermissions: string[],
    depth: number,
    pluginName: string,
    isRoot: boolean,
    out: CommandNodeInfo[],
  ): void {
    const key = path.join(':');
    const ovr = this.overrides.get(key);
    const baseAuthority = node.authority ?? parentEffectiveAuthority;
    const baseSafety: SafetyLevel = node.safety ?? parentEffectiveSafety;
    const basePermissions = node.permissions ?? [];
    const permissions = unique([`command:${key}`, ...parentPermissions, ...basePermissions]);
    const effAuthority = ovr?.authority ?? baseAuthority;
    const effSafety: SafetyLevel = (ovr?.safety as SafetyLevel) ?? baseSafety;
    out.push({
      path: [...path],
      key,
      name: path[path.length - 1],
      depth,
      description: node.description,
      authority: effAuthority,
      safety: effSafety,
      permissions,
      baseAuthority,
      baseSafety,
      basePermissions,
      overridden: !!ovr,
      isRoot,
      hasSubcommands: !!(node.subcommands && node.subcommands.length > 0),
      hasAction: typeof node.action === 'function',
      pluginName,
      arguments: node.arguments,
      options: node.options,
      usage: node.usage,
      examples: node.examples,
    });
    if (node.subcommands) {
      for (const sub of node.subcommands) {
        this.walkNode(sub, [...path, sub.name], effAuthority, effSafety, permissions, depth + 1, pluginName, false, out);
      }
    }
  }

  async execute(name: string, cmdCtx: CommandContext): Promise<string | undefined> {
    const resolved = this.resolve(name, cmdCtx.args);
    if (!resolved) return `未知指令: ${this.prefix}${name}。输入 ${this.prefix}help 查看帮助。`;

    const action = resolved.node.action;
    // 纯分组节点（无 action）：返回 usage 提示
    if (!action) {
      return this.formatUsage(resolved.node, resolved.path);
    }

    const parsed = this.parseArgsForNode(resolved.node, resolved.path, resolved.remainingArgs);
    if (typeof parsed === 'string') return parsed;

    if (this._guard) {
      const rejection = await this._guard({
        // 使用完整路径做权限标识；guard 内部以名称匹配高危白名单，建议白名单也用冒号路径
        name: resolved.path.join(':'),
        type: 'command',
        authority: resolved.effectiveAuthority,
        safety: resolved.effectiveSafety,
        permissions: resolved.permissions,
        sessionId: cmdCtx.sessionId,
        platform: cmdCtx.platform,
        userId: cmdCtx.userId,
        skipSafetyCheck: cmdCtx.skipSafetyCheck,
      });
      if (rejection) return rejection;
    }

    try {
      const subCtx: CommandContext = {
        ...cmdCtx,
        args: parsed.args,
        operands: parsed.operands,
        options: parsed.options,
      };
      const result = await action(subCtx);
      return result ?? undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`指令 ${this.prefix}${resolved.path.join(' ')} 执行失败: ${message}`);
      return `指令执行失败: ${message}`;
    }
  }

  private formatUsage(node: CommandDefinition | SubcommandDefinition, path: string[]): string {
    const head = `${this.prefix}${path.join(' ')}`;
    if (node.usage) return node.usage;
    const argText = node.arguments?.map(arg => {
      const body = arg.variadic ? `...${arg.name}` : arg.name;
      return arg.required ? `<${body}>` : `[${body}]`;
    }).join(' ');
    const optionText = node.options && node.options.length > 0 ? ' [options]' : '';
    const subText = node.subcommands && node.subcommands.length > 0 && !node.action ? ' <subcommand>' : '';
    const lines = [`用法: ${head}${subText}${argText ? ` ${argText}` : ''}${optionText}`, ''];
    lines.push(`${node.description}`);
    if (node.arguments && node.arguments.length > 0) {
      lines.push('', '参数：');
      for (const arg of node.arguments) {
        lines.push(`  ${arg.required ? '<' : '['}${arg.name}${arg.required ? '>' : ']'} — ${arg.description ?? arg.type}`);
      }
    }
    if (node.options && node.options.length > 0) {
      lines.push('', '选项：');
      for (const opt of node.options) {
        const aliases = toAliases(opt).map(a => a.length === 1 ? `-${a}` : `--${a}`).join(', ');
        const choices = opt.choices && opt.choices.length > 0 ? ` (${opt.choices.join('|')})` : '';
        lines.push(`  --${opt.name}${aliases ? `, ${aliases}` : ''} — ${opt.description ?? opt.type}${choices}`);
      }
    }
    if (node.subcommands && node.subcommands.length > 0) {
      lines.push('', '可用子指令：');
      for (const sub of node.subcommands) {
        lines.push(`  ${sub.name} — ${sub.description}`);
      }
    }
    if (node.examples && node.examples.length > 0) {
      lines.push('', '示例：');
      for (const example of node.examples) lines.push(`  ${example}`);
    }
    return lines.join('\n');
  }

  private parseArgsForNode(node: CommandDefinition | SubcommandDefinition, path: string[], rawArgs: string[]): ParsedCommandArgs | string {
    const optionDefs = node.options ?? [];
    const argumentDefs = node.arguments ?? [];
    const options = this.defaultOptions(optionDefs);
    const positionals: string[] = [];

    for (let i = 0; i < rawArgs.length; i++) {
      const token = rawArgs[i];
      if (token === '--') {
        positionals.push(...rawArgs.slice(i + 1));
        break;
      }
      if (token.startsWith('--') && token.length > 2) {
        const eq = token.indexOf('=');
        const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
        const negated = rawName.startsWith('no-');
        const name = negated ? rawName.slice(3) : rawName;
        const def = findOption(optionDefs, name);
        if (!def) return `未知选项: --${name}\n\n${this.formatUsage(node, path)}`;
        let rawValue = eq >= 0 ? token.slice(eq + 1) : undefined;
        if (def.type === 'boolean') {
          options[def.name] = negated ? false : rawValue === undefined ? true : parseBoolean(rawValue);
        } else {
          if (rawValue === undefined) {
            i += 1;
            rawValue = rawArgs[i];
          }
          if (rawValue === undefined) return `选项 --${name} 缺少取值`;
          options[def.name] = parseOptionValue(def, rawValue, options[def.name]);
        }
        continue;
      }
      if (token.startsWith('-') && token.length > 1) {
        const alias = token.slice(1);
        const def = findOption(optionDefs, alias);
        if (!def) return `未知选项: -${alias}\n\n${this.formatUsage(node, path)}`;
        if (def.type === 'boolean') {
          options[def.name] = true;
        } else {
          i += 1;
          const rawValue = rawArgs[i];
          if (rawValue === undefined) return `选项 -${alias} 缺少取值`;
          options[def.name] = parseOptionValue(def, rawValue, options[def.name]);
        }
        continue;
      }
      positionals.push(token);
    }

    for (const def of optionDefs) {
      if (def.required && options[def.name] === undefined) return `缺少必填选项: --${def.name}`;
    }

    const operands: Record<string, unknown> = {};
    let cursor = 0;
    for (const def of argumentDefs) {
      const values = def.variadic || def.type === 'text' ? positionals.slice(cursor) : positionals.slice(cursor, cursor + 1);
      if (values.length === 0) {
        if (def.required) return `缺少必填参数: ${def.name}`;
        continue;
      }
      operands[def.name] = parseArgumentValue(def, values);
      cursor += values.length;
    }

    return { args: positionals, operands, options };
  }

  private defaultOptions(optionDefs: CommandOptionDefinition[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const def of optionDefs) {
      if (def.default !== undefined) out[def.name] = def.default;
    }
    return out;
  }

  unregisterByPlugin(pluginName: string): void {
    for (const [name, cmd] of this.commands) {
      if (cmd.pluginName === pluginName) {
        this.commands.delete(name);
        this.logger.debug(`注销指令: ${this.prefix}${name} (插件 ${pluginName} 卸载)`);
      }
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

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

function toAliases(def: CommandOptionDefinition): string[] {
  if (!def.alias) return [];
  return Array.isArray(def.alias) ? def.alias : [def.alias];
}

function findOption(defs: CommandOptionDefinition[], nameOrAlias: string): CommandOptionDefinition | undefined {
  return defs.find(def => def.name === nameOrAlias || toAliases(def).includes(nameOrAlias));
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseOptionValue(def: CommandOptionDefinition, rawValue: string, previous: unknown): unknown {
  if (def.type === 'number') return Number(rawValue);
  if (def.type === 'boolean') return parseBoolean(rawValue);
  if (def.type === 'enum') {
    if (def.choices && !def.choices.includes(rawValue)) {
      throw new Error(`选项 --${def.name} 只能是: ${def.choices.join(', ')}`);
    }
    return rawValue;
  }
  if (def.type === 'string[]') {
    const current = Array.isArray(previous) ? previous as string[] : [];
    return [...current, ...rawValue.split(',').map(s => s.trim()).filter(Boolean)];
  }
  return rawValue;
}

function parseArgumentValue(def: CommandArgumentDefinition, values: string[]): unknown {
  const raw = def.variadic || def.type === 'text' ? values.join(' ') : values[0];
  if (def.type === 'number') return Number(raw);
  if (def.type === 'boolean') return parseBoolean(raw);
  return raw;
}
