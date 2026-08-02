import type { CapabilityConfirm, CapabilityRisk, CapabilityVisibility, ExecutionGuard } from '@aalis/api-authority';
import { capabilityMinLevel, riskDefaults } from '@aalis/api-authority';
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
 * 从栈里挑出**最严的那一份声明**，整份取用；不跨声明混轴。
 *
 * 栈顶决定「跑谁的实现」，但不该决定「谁能跑」——否则后注册者只要压一层就能放宽权限。
 *
 * ⚠️ **必须整份取，不能逐轴取严**。曾经的写法是 visibility / confirm / risk 三轴各自独立
 * 取最严，实测不单调：真正的裁决函数里 **risk 一旦存在就完全遮蔽 visibility**
 * （见 `capabilityMinLevel`），于是「未声明 risk」在合并时被当成最弱、在裁决时却代表更强的
 * visibility 兜底。给 `{visibility:'restricted'}` 的 /shutdown 压一层 `{risk:'safe'}`，
 * 门槛从 2 掉到 0，而 visibility 那一栏仍显示 restricted —— 提权成功，且比不修更糟：
 * 旧实现提权时 visibility 会明着翻成 public（可被审计发现），逐轴合并反而把症状藏了起来。
 *
 * 定级用契约包的 `capabilityMinLevel`（与 authority 实际裁决同一份实现），不自己复制一份口径。
 * 同级时取先注册者，保证结果与栈序无关（幂等）。
 */
function strictestDecl(decls: readonly Decl[]): Decl | undefined {
  let best: Decl | undefined;
  let bestLevel = -1;
  for (const d of decls) {
    const lvl = capabilityMinLevel({ risk: d.baseRisk, visibility: d.baseVisibility });
    if (lvl > bestLevel) {
      bestLevel = lvl;
      best = d;
    }
  }
  return best;
}

/**
 * confirm 轴单独取最严（always > session > 无），**不跟着 {@link strictestDecl} 的赢家走**。
 *
 * 上面那条「整份取最严」的纪律只适用于 visibility 与 risk：它俩一起进
 * `capabilityMinLevel`，而 risk 在里面会完全遮蔽 visibility，逐轴合并因此不单调。
 * confirm 不同 —— 它根本不参与定级（`capabilityMinLevel` 只读 risk 与 visibility），
 * 是 authority 的独立轴 B。让它跟着定级赢家走会出两种病，实测都能复现：
 * - 平局时先入者胜，于是 `profile.clear`（restricted，等级 2、无 confirm）压过
 *   `profile.clear.nuke`（dangerous，等级同为 2、confirm=session）——「清空所有用户档案」
 *   的二次确认整条消失；
 * - 后注册者声明 `{visibility:'restricted'}`（等级 2）即可盖过既有的 `{confirm:'always'}`
 *   （等级 0），**抹掉别人的确认闸**；反过来单独声明 confirm 想收紧又因等级不变而无效。
 *   对 owner（等级无上限）来说前者的净效果就是「确认闸没了」。
 *
 * 逐轴取严在这一轴上是安全的：它只会多要一次确认、不会少要，也不改变任何门槛等级。
 * 取值范围是**整条 dot path 上的全部声明**而非每节点的最严者——同一节点栈内平级时，
 * 只看每节点赢家同样会丢掉带 confirm 的那一份。
 */
function strictestConfirm(decls: readonly Decl[]): CapabilityConfirm | undefined {
  let best: CapabilityConfirm | undefined;
  for (const d of decls) {
    if (d.baseConfirm === 'always') return 'always';
    if (d.baseConfirm === 'session') best = 'session';
  }
  return best;
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
    //
    // 为什么不改成「同名直接拒绝」（曾评估过，结论是保留）：**本仓没有「内置指令」这个概念**
    // ——`/status` `/shutdown` `/restart` 是 plugin-commands 自己注册的，而它恰好也提供注册表，
    // 但注册表里没有 builtin 位、没有白名单、没有保护名单。所以同名注册是**平等插件之间的
    // 正常情况**，压栈让「谁的实现生效」有确定语义（后来者胜）且可逆（卸载复位）；改成拒绝
    // 等于「先加载的永久赢」，赢家由加载顺序决定，反倒随意，也就没有「插件可以替换另一个
    // 插件的指令」这个能力了。
    //
    // 安全性由「安全轴取全栈最严」保证——后来者只能收紧不能放宽（见 strictestDecl /
    // strictestConfirm）。回退还要改 149 行测试（含 commands-v2 里 7 处撞名别名用例）。
    //
    // **为什么安全轴不跟着「当前生效的实现」（栈顶）走**——这是个合理的疑问，答案在于两个
    // 方向的失败代价不对等：
    //   跟栈顶走 → 「注册一个同名指令」本身就成了提权原语。任何插件注册一个不带 meta 的
    //     `shutdown`，闸从 restricted 掉到 public，而这在加载那一刻**静默发生**、无人察觉。
    //   取全栈最严 → 最多是过度限制（B 用无害实现覆盖了 A 的高危指令，却仍卡在高门槛），
    //     而这条**有现成出口**：owner 在权限页把该能力的 `authorityOverrides` 设成任意整数
    //     即可（守卫里 authorityOverrides > risk > visibility，见 authority-manager 的 authorize）。
    // 一边是静默提权、另一边是可一键恢复的过严，所以保守。根本原因是注册表**无从判断**
    // B 的实现是否与 A 同样危险——它只看得见声明，看不见代码。
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
    // 栈空但仍有子节点 → 退回自动分组节点（`/parent` 仍可列出子指令），不删。
    if (stack.length === 0 && this.directChildren(name).length === 0) this.nodes.delete(name);
    // 别名按**剩余声明**重建，不是把摘掉那层的别名逐个 delete。
    // 后者会连坐：`alias()` 允许后注册者抢占已有别名（只 warn），于是 A 起了 `p`、B 也起
    // `p`、B 卸载时把 `p` 整条删掉，A 的别名再也回不来——与「覆盖者卸载把整个节点连根删掉」
    // 是同一个病，只是从指令节点挪到了别名表。而且删完 A 的 `Decl.aliases` 里仍留着 `p`，
    // `/help` 会展示一个解析不到的别名，注册表自相矛盾。
    for (const a of new Set(dropped.flatMap(d => d.aliases))) this.rebindAlias(a);
    // 回收随之变空的祖先分组。曾经只挂在 unregisterByPlugin 上，于是同一件事经管理面
    // （直接 unregister）做就留幽灵、经插件卸载做就干净——契约面不对称。放在早退之后，
    // 只有真摘到东西才扫。
    this.pruneEmptyGroups();
    this.logger.debug(`注销指令: ${this.prefix}${name} (来自 ${pluginName ?? '全部'})`);
  }

  /**
   * 把一个别名重新绑到**仍然声明着它**的指令上；没有人再声明就删除。
   *
   * 遍历全表看似浪费，但别名总数是「指令数」量级（当前全仓 0 个），而 unregister 只在
   * 插件装卸时发生——拿这点代价换「不必维护别名的引用计数」是划算的：引用计数是又一个
   * 要靠人肉维持的不变量，而本文件已经因为这类不变量栽过两次。
   */
  private rebindAlias(alias: string): void {
    for (const [cmdName, stack] of this.nodes) {
      if (stack.some(d => d.aliases.includes(alias))) {
        this.aliases.set(alias, cmdName);
        return;
      }
    }
    this.aliases.delete(alias);
  }

  unregisterByPlugin(pluginName: string): void {
    // 回收由 unregister 自己负责（见那里的注释），这里不再重复扫一遍。
    for (const name of [...this.nodes.keys()]) this.unregister(name, pluginName);
  }

  /**
   * 回收无主的空分组节点。
   *
   * 分组节点由 `ensureGroups` 自动创建（空栈、无 pluginName），因此**任何按插件名的摘除都
   * 匹配不到它们**——旧实现（`node.pluginName === pluginName`）与声明栈实现（空栈上
   * `dropped.length === 0` 直接返回）都漏，这不是重构引入的。
   *
   * 后果是用户可见的：卸载 `plugin-user-relation` 后 `relation` / `relation.cleanup` 留着，
   * `hasMatch('relation')` 仍为真，于是指令相位**吞掉** `/relation` 不放行给普通消息管道，
   * 回一段指向空节点的用法；`/help` 概览还会长出「`/relation` — 0 个子指令」。
   * 而 `relation` 正是全仓唯一的占位分组，卸载该插件必然踩到。
   *
   * 反复扫直到不动点：删掉 `relation.cleanup` 会让 `relation` 也变成无子节点的空壳。
   */
  private pruneEmptyGroups(): void {
    let removed = true;
    while (removed) {
      removed = false;
      for (const [name, stack] of [...this.nodes]) {
        if (stack.length === 0 && this.directChildren(name).length === 0) {
          this.nodes.delete(name);
          removed = true;
        }
      }
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
    // ⚠️ 这两步（分组用法、parseArgs 的报错）**先于守卫**返回，所以会把无权使用的指令列出来。
    // 最直观的样本是裸敲 `/relation`：它是 ensureGroups 自动建的无 handler 分组节点，
    // 于是把 `relation.cleanup.*` 那 5 条 restricted 子指令一并列给任何人。
    //
    // **已评估并决定不做过滤**（2026-08）。这是降噪而非防泄漏——开源项目里指令存在性本就
    // 公开（源码、文档、npm 包都写着）。而且只堵这里等于只堵一半：低权限用户直敲受限指令时，
    // authority 的拒绝文案照样暴露存在性，要真做得连那条通用文案一起改，而它同时服务 tools
    // 与 commands 两个注入点，牵动所有能力的拒绝语义，改动面大于收益。
    // 真要做的话两条一起：注入与执行侧同源的 authorize 判定，只取等级轴，明确排除 confirm
    // 与临时授予（前者是 async 且会真弹确认框、后者随会话漂移，都不适合用于列表渲染）。
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
    // 栈顶决定「跑谁的实现」；安全轴另算（见下）。
    const top = stack[stack.length - 1];

    // 安全轴 = **整条 dot path（含本节点）上最严的那份声明**。
    //
    // 曾经是「沿 path 向上逐级覆盖，最近声明的祖先胜，本节点可再覆盖」。那等于给每一级都
    // 开了一个放宽口：实测在 `admin`(restricted) 与 `admin.sys.shutdown` 之间插一层
    // `admin.sys` 声明 `risk:'safe'`，叶子的门槛就从 2 掉到 0；换成中间层声明
    // `visibility:'public'` 同样得 0。上一版只把「本节点 vs 继承值」取了严，祖先之间仍是
    // 逐级覆盖 —— 修了一处、漏了整条链。
    //
    // 现在没有「继承」这个中间概念了：把 path 上每个节点各自的最严声明收集起来，再整体取最
    // 严的那一份。少一层概念，也少一个能被插进去的缝。
    const chain: Decl[] = [];
    const everyDecl: Decl[] = [];
    const parts = name.split('.');
    for (let i = 1; i <= parts.length; i++) {
      const stack = this.nodes.get(parts.slice(0, i).join('.')) ?? [];
      everyDecl.push(...stack);
      const d = strictestDecl(stack);
      if (d) chain.push(d);
    }
    const effective = strictestDecl(chain);
    const visibility = effective?.baseVisibility ?? 'public';
    const risk = effective?.baseRisk;
    // confirm 走独立的一条，理由见 strictestConfirm 的注释（跟着定级赢家走会丢确认闸）。
    const confirm = strictestConfirm(everyDecl);

    return {
      name,
      pluginName: top?.pluginName ?? 'unknown',
      // 空栈 = 自动创建的分组节点，描述在此派生而非落字段（少存一份、不会陈旧）。
      description: top?.description ?? `${name} 命令组`,
      visibility,
      confirm,
      risk,
      // 别名 = 全栈声明过的 ∩ **当前真的解析回本指令的**。
      //
      // 两个方向都要：只取栈顶会漏掉底层声明但仍然可用的别名（rebindAlias 是按「剩余全部
      // 声明」重绑的，见 unregister）；而只取全栈又会印出已被别的指令抢走的那些——
      // `alias()` 允许后注册者抢占已有别名（只 warn），被抢者的 `Decl.aliases` 里仍留着它，
      // 于是 /help 会展示一个敲下去跑到别处的别名。按别名表回查即两头都真。
      aliases: [...new Set(stack.flatMap(d => d.aliases))].filter(a => this.aliases.get(a) === name),
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
