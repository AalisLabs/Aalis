import type {
  AuthorityService,
  CapabilityConfirm,
  CapabilityRisk,
  CapabilityVisibility,
  ExecutionGuard,
} from '@aalis/api-authority';
import { capabilityMinLevel, DEFAULT_AUTHORITY, riskDefaults } from '@aalis/api-authority';
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
import { type I18nService, localizeFor } from '@aalis/api-i18n';
import type { Logger, ServiceSelection } from '@aalis/core';
import { isTextRef, type Localized, TextError, type TextRef, textOf, toSource } from '@aalis/schema-i18n';
import { type Entry, type Localize, renderDetail, renderOverview } from './help.js';
import { t } from './texts.js';

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

/** 帮助按谁的等级过滤、按谁的语言渲染：执行时守卫裁决的同一个身份，与这条指令所在的会话 */
interface Caller {
  sessionId: string;
  platform: string;
  userId?: string;
}

/**
 * 一条指令声明。**节点持有的是一个声明栈**，不是单个格子。
 *
 * 每个名字只留一层（同名再注册就把这层就地清空并改写 `pluginName`）有两个实测后果：
 * 1. **提权** —— 后注册者不带 meta 时 `baseVisibility` 被写成 undefined，materialize 兜底成
 *    `public`，于是任何插件重注册一个 restricted 指令名就能把权限闸降掉。
 * 2. **破坏** —— 所有权被改写后，覆盖者卸载时按 `pluginName` 匹配到整个节点并删除，
 *    先注册者的指令一并消失且不会回来。
 *
 * 栈的语义：栈顶生效，卸载只摘自己那一层、下面的自动复位，而安全轴取全栈最严（见 `strictestPolicy`）——
 * 多压一层只能收紧、不能放宽。栈按登记方的位次叠放：位次靠前的在上（宿主的根是空串，最靠前；插件按实例 id 的
 * 码元序），同一位次后登记的在上。谁在栈顶不看登记发生的时刻，插件重启、装进应用的先后都不换人。
 */
interface Decl {
  description?: string | TextRef;
  /** 节点自身声明的可见性（未声明则继承祖先；缺省 public） */
  baseVisibility?: CapabilityVisibility;
  /** 节点自身声明的确认要求（轴 B；未声明则继承祖先） */
  baseConfirm?: CapabilityConfirm;
  /** 节点自身声明的原始风险（透传，未声明则继承祖先）；供 authority 区分 sensitive（等级 1）与 dangerous（等级 2） */
  baseRisk?: CapabilityRisk;
  positionalArgs: PositionalArgSpec[];
  options: OptionSpec[];
  usage?: string;
  examples: string[];
  handler?: CommandHandler;
  /** 声明者。卸载按它精确摘层。 */
  pluginName: string;
  /** 声明者的位次：栈里按它叠放 */
  seat: string;
}

/**
 * 从栈里挑出**最严的那一份声明**，整份取用；不跨声明混轴。
 *
 * 栈顶决定「跑谁的实现」，但不该决定「谁能跑」——否则位次靠前的插件只要压一层就能放宽权限。
 *
 * 注意：**必须整份取，不能逐轴取严**。visibility / confirm / risk 三轴各自独立取最严实测不单调：
 * 真正的裁决函数里 **risk 一旦存在就完全遮蔽 visibility**
 * （见 `capabilityMinLevel`），于是「未声明 risk」在合并时被当成最弱、在裁决时却代表更强的
 * visibility 兜底。给 `{visibility:'restricted'}` 的 /shutdown 压一层 `{risk:'safe'}`，
 * 门槛从 2 掉到 0，而 visibility 那一栏仍显示 restricted —— 提权成功且不露痕迹。
 *
 * 定级用契约包的 `capabilityMinLevel`（与 authority 实际裁决同一份实现），不自己复制一份口径。
 * 同级时取栈里最靠下的那层（位次最靠后的），结果只取决于在场的声明，与登记发生的时刻无关。
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
 * - 平局时排在前面的那份胜，于是 `profile.clear`（restricted，等级 2、无 confirm）压过
 *   `profile.clear.nuke`（dangerous，等级同为 2、confirm=session）——「清空所有用户档案」
 *   的二次确认整条消失；
 * - 另一个登记方声明 `{visibility:'restricted'}`（等级 2）即可盖过既有的 `{confirm:'always'}`
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
  /**
   * 名字 → 声明栈。空栈 = 自动创建的分组节点。
   *
   * 不变式：每个节点的全部祖先都在表中（`ensureGroups` 先建祖先，注销只删无子节点的叶子），
   * 所以「存在以 `x.` 开头的节点」蕴含「`x` 在表中」，查询只需 `nodes.has`。
   */
  private readonly nodes = new Map<string, Decl[]>();
  private readonly logger: Logger;
  /** 权限服务：帮助按它的 authorize 判调用者能用哪些指令，与执行守卫的等级裁决同一份 */
  private readonly authority: Pick<ServiceSelection<AuthorityService>, 'present' | 'use'>;
  /** 回复与帮助按读者的语言渲染；缺席时按原文 */
  private readonly i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>;
  /** i18n 渲染抛错时告警过了：之后再出错不再告警 */
  private renderWarned = false;
  private _guard?: ExecutionGuard;

  prefix = '/';

  constructor(
    logger: Logger,
    authority: Pick<ServiceSelection<AuthorityService>, 'present' | 'use'>,
    i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  ) {
    this.logger = logger.child('commands');
    this.authority = authority;
    this.i18n = i18n;
  }

  // ---- Guard ----

  setExecutionGuard(guard: ExecutionGuard | undefined): void {
    this._guard = guard;
  }

  // ---- Builder 入口 ----

  command(rawName: string, description?: string | TextRef, meta?: InternalCommandMeta): CommandBuilder {
    const parsed = parseCommandName(rawName);
    const { name, positionalArgs } = parsed;
    validateName(name);

    // 确保所有祖先分组节点存在
    this.ensureGroups(name);

    let stack = this.nodes.get(name);
    if (!stack) {
      stack = [];
      this.nodes.set(name, stack);
    }

    // 压栈而非就地改写：被压住的声明原样留着，栈顶卸载后它自动重新生效。
    //
    // 为什么不做「同名直接拒绝」：**本仓没有「内置指令」这个概念**
    // ——`/status` `/shutdown` `/restart` 是 plugin-commands 自己注册的，而它恰好也提供注册表，
    // 但注册表里没有 builtin 位、没有白名单、没有保护名单。所以同名注册是**平等插件之间的
    // 正常情况**，压栈让「谁的实现生效」有确定语义（位次靠前的生效）且可逆（卸载复位）；改成拒绝
    // 等于「先加载的永久赢」，赢家由加载顺序决定，反倒随意。
    //
    // 安全性由「安全轴取全栈最严」保证——多压一层只能收紧不能放宽（见 strictestDecl / strictestConfirm）。
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
      positionalArgs,
      options: [],
      usage: meta?.usage,
      examples: meta?.examples ? [...meta.examples] : [],
      pluginName: meta?.pluginName ?? 'unknown',
      seat: meta?.seat ?? meta?.pluginName ?? 'unknown',
    };
    const rival = stack[stack.length - 1];
    let at = stack.length;
    while (at > 0 && stack[at - 1].seat < decl.seat) at--;
    stack.splice(at, 0, decl);
    if (rival) {
      const top = stack[stack.length - 1];
      this.logger.warn(
        `指令 ${this.prefix}${name} 重名：${top.pluginName} 的声明生效，${(top === decl ? rival : decl).pluginName} 的声明被压住` +
          '（生效的卸载后顶上；权限取各层里最严的）',
      );
    }

    this.logger.debug(`注册指令: ${this.prefix}${name} (来自 ${decl.pluginName})`);

    return this.makeBuilder(name, decl);
  }

  /** builder 写入**自己那一层声明**（闭包持有，无需每次查表）。 */
  private makeBuilder(name: string, decl: Decl): CommandBuilder {
    const self: CommandBuilder = {
      option: (optName: string, syntax: string, opts?: OptionRegisterOptions) => {
        decl.options.push(parseOptionSyntax(optName, syntax, opts));
        return self;
      },
      argument: (argName: string, description: string | TextRef) => {
        const arg = decl.positionalArgs.find(a => a.name === argName);
        if (!arg) throw new Error(`指令 ${name} 没有位置参数 ${argName}`);
        arg.description = description;
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
   * @param contextId 只摘该激活的那一层声明——下面被它覆盖的声明会自动重新生效。
   *   缺省则摘掉全部层（管理面用；插件自己的 dispose 必须传名字，否则会连别人的一起删）。
   */
  unregister(name: string, contextId?: string): void {
    const stack = this.nodes.get(name);
    if (!stack) return;
    const dropped = contextId === undefined ? stack.splice(0) : removeWhere(stack, d => d.pluginName === contextId);
    if (dropped.length === 0) return;
    // 栈空但仍有子节点 → 退回自动分组节点（`/parent` 仍可列出子指令），不删。
    if (stack.length === 0 && this.directChildren(name).length === 0) this.nodes.delete(name);
    // 回收随之变空的祖先分组。放在早退之后，只有真摘到东西才扫。
    this.pruneEmptyGroups();
    this.logger.debug(`注销指令: ${this.prefix}${name} (来自 ${contextId ?? '全部'})`);
  }

  /**
   * 回收无主的空分组节点。
   *
   * 分组节点由 `ensureGroups` 自动创建（空栈、无 pluginName），因此**任何按插件名的摘除都
   * 匹配不到它们**——空栈上 `dropped.length === 0` 直接返回。
   *
   * 后果是用户可见的：一个插件只登记了 `a.b.c`，卸载后自动建的 `a` / `a.b` 留着，
   * `hasMatch('a')` 仍为真，于是指令相位**吞掉** `/a` 不放行给普通消息管道，回一段指向空节点的用法。
   *
   * 反复扫直到不动点：删掉 `a.b` 会让 `a` 也变成无子节点的空壳。
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
    if (!this.prefix && !this.nodes.has(head)) return null;
    return { name: head, args: parts.slice(1), raw: trimmed };
  }

  has(name: string): boolean {
    return this.nodes.has(name);
  }

  get(name: string): Command | undefined {
    return this.nodes.has(name) ? this.materialize(name) : undefined;
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
    if (!this.nodes.has(head)) return null;

    let current = head;
    let consumed = 0;
    for (let i = 0; i < tokens.length; i++) {
      const candidate = `${current}.${tokens[i]}`;
      if (this.nodes.has(candidate)) {
        current = candidate;
        consumed = i + 1;
      } else {
        break;
      }
    }
    return { name: current, remaining: tokens.slice(consumed) };
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
    return this.localize(await this.run(name, input), input);
  }

  /**
   * 同 {@link execute}，回复不渲染：文字对象原样交出。聊天回复用它，把文字对象交给网关按会话的语言渲染；
   * 帮助（裸敲分组、-h）照旧是按调用者所在会话的语言渲染好的字符串
   */
  async run(name: string, input: ExecutionInput): Promise<string | TextRef | undefined> {
    const resolved = this.resolve(name, input.args);
    if (!resolved) return t('unknownCommand', { command: `${this.prefix}${name}`, prefix: this.prefix });

    const cmd = this.materialize(resolved.name);
    // 裸敲分组与 -h、--help 回的都是 `/help <指令>` 那一段：调用者用不了的指令在帮助里当作不存在。
    // 直接执行用不了的指令由守卫拒绝，拒绝文案照旧点名指令
    if (!cmd.handler || asksHelp(resolved.remaining)) return this.detail(resolved.name.split('.'), input);

    const parsed = this.parseArgs(cmd, resolved.remaining, input);
    if (typeof parsed === 'string' || isTextRef(parsed)) return parsed;

    if (this._guard) {
      const verdict = await this._guard({
        name: cmd.name,
        type: 'command',
        visibility: cmd.visibility,
        confirm: cmd.confirm,
        risk: cmd.risk,
        sessionId: input.sessionId,
        platform: input.platform,
        userId: input.userId,
        // 参与者只有发出者：聊天入站已把授权身份并进 platform 与 userId，没有账号的是无主体
        participants: [{ platform: input.platform, userId: input.userId ?? '' }],
        skipConfirm: input.skipConfirm,
        confirmIntent: input.confirmIntent,
      });
      if (!verdict.ok) return verdict.reason;
    } else if (needsAuthority(cmd)) {
      return t('needsAuthority', { command: `${this.prefix}${cmd.name}` });
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
      // 处理函数抛的是中止原因（如所属插件停用、停机时随它这次激活的信号停下）：不是执行失败，回已中止，不记 error
      if (err instanceof Error && err.name === 'AbortError') {
        this.logger.debug(`指令 ${this.prefix}${cmd.name} 已中止`);
        return t('aborted', { command: `${this.prefix}${cmd.name}` });
      }
      const error = textOf(err);
      this.logger.error(`指令 ${this.prefix}${cmd.name} 执行失败: ${toSource(error)}`);
      return t('failed', { error });
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
    // 不能「沿 path 向上逐级覆盖，最近声明的祖先胜，本节点可再覆盖」。那等于给每一级都
    // 开了一个放宽口：实测在 `admin`(restricted) 与 `admin.sys.shutdown` 之间插一层
    // `admin.sys` 声明 `risk:'safe'`，叶子的门槛就从 2 掉到 0；换成中间层声明
    // `visibility:'public'` 同样得 0。只把「本节点 vs 继承值」取严也不够，祖先之间仍是
    // 逐级覆盖 —— 堵一处、漏整条链。
    //
    // 故不设「继承」这个中间概念：把 path 上每个节点各自的最严声明收集起来，再整体取最
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
      description: top?.description ?? t('group', { name }),
      visibility,
      confirm,
      risk,
      positionalArgs: [...(top?.positionalArgs ?? [])],
      options: [...(top?.options ?? [])],
      usage: top?.usage,
      examples: [...(top?.examples ?? [])],
      handler: top?.handler,
      isGroup: stack.length === 0,
    };
  }

  // ---- 帮助 ----

  /** `/help` 的概览：调用者看得见的顶层指令（help 自己不列） */
  overview(caller: Caller): string {
    const tops = [...this.nodes.keys()].filter(n => !n.includes('.') && n !== 'help').sort();
    return renderOverview(this.entries(tops, caller), this.prefix, value => this.localize(value, caller));
  }

  /**
   * `/help <指令>`、`<指令> -h` 与裸敲分组共用的回答。`/help` 问调用者看不见的指令，与问不存在的指令回同一句。
   * 指令登记了 usage 时整段用它。
   */
  detail(path: string[], caller: Caller): string {
    const cmd = this.getNode(path);
    if (!cmd || !this.visible(cmd.name, caller)) {
      return this.localize(t('noCommand', { path: path.join(' '), prefix: this.prefix }), caller);
    }
    return this.usageOf(cmd, caller);
  }

  /** 用法（同帮助，按调用者所在会话的语言渲染好）；给了 error 时报错在前，同一次渲染 */
  private usageOf(cmd: Command, caller: Caller, error?: TextRef): string {
    const localize: Localize = value => this.localize(value, caller);
    if (cmd.usage !== undefined) return error ? `${localize(error)}\n\n${cmd.usage}` : cmd.usage;
    return renderDetail(cmd, this.entries(this.directChildren(cmd.name), caller), this.prefix, localize, error);
  }

  /** 报错后附上用法；调用者看不见这条指令时只回报错 */
  private withUsage(error: TextRef, cmd: Command, caller: Caller): string | TextRef {
    return this.visible(cmd.name, caller) ? this.usageOf(cmd, caller, error) : error;
  }

  /**
   * 按调用者所在会话的语言渲染（i18n 缺席时按原文）。帮助一次要渲染几十段，整份交给这里一次，语言链只算一次；
   * i18n 渲染抛错时按原文，告警一次
   */
  private localize<T>(value: T, caller: Caller): Localized<T> {
    return localizeFor(
      this.i18n,
      value,
      { sessionId: caller.sessionId, platform: caller.platform },
      {
        onError: err => {
          if (this.renderWarned) return;
          this.renderWarned = true;
          this.logger.warn('按会话的语言渲染指令的回复与帮助出错，按原文交出（之后再出错不再告警）:', err);
        },
      },
    );
  }

  private entries(names: string[], caller: Caller): Entry[] {
    return names
      .filter(n => this.visible(n, caller))
      .map(n => ({
        cmd: this.materialize(n),
        children: this.directChildren(n).filter(c => this.visible(c, caller)).length,
      }));
  }

  /** 帮助里看得见：调用者能用的指令，或底下有看得见的指令的分组 */
  private visible(name: string, caller: Caller): boolean {
    const cmd = this.materialize(name);
    return cmd.handler ? this.permits(cmd, caller) : this.directChildren(name).some(c => this.visible(c, caller));
  }

  /**
   * 调用者能不能用这条指令：有权限服务时按它的 authorize（执行守卫的等级裁决就是它，确认不算），
   * 没有时按执行时同样的 fail-closed
   */
  private permits(cmd: Command, caller: Caller): boolean {
    if (!this.authority.present) return !needsAuthority(cmd);
    const request = { capability: `command:${cmd.name}`, visibility: cmd.visibility, risk: cmd.risk };
    return this.authority.use.authorize(caller, request) === null;
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
    caller: Caller,
  ): { positionals: unknown[]; options: Record<string, unknown> } | string | TextRef {
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
          // 先按全名找：选项名本身可以以 no- 开头（--no-llm）；找不到才当作反写（--no-cache 关掉 cache）
          const exact = findOption(cmd.options, rawName);
          const negated = !exact && rawName.startsWith('no-');
          const optName = negated ? rawName.slice(3) : rawName;
          const def = exact ?? (negated ? findOption(cmd.options, optName) : undefined);
          if (!def) return this.withUsage(t('unknownOption', { option: `--${rawName}` }), cmd, caller);
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
            if (rawValue === undefined) return t('missingValue', { option: `--${optName}` });
            options[def.name] = parseOptionValue(def, rawValue, options[def.name]);
          }
          continue;
        }
        if (token.startsWith('-') && token.length > 1) {
          const alias = token.slice(1);
          const def = findOption(cmd.options, alias);
          // 负数没有同名选项时是位置参数（/level <目标> -1 封禁）
          if (!def && /^\d/.test(alias)) {
            positionalTokens.push(token);
            continue;
          }
          if (!def) return this.withUsage(t('unknownOption', { option: `-${alias}` }), cmd, caller);
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
              return t('missingValue', { option: `-${alias}` });
            }
            options[def.name] = parseOptionValue(def, rawValue, options[def.name]);
          }
          continue;
        }
        positionalTokens.push(token);
      }

      for (const o of cmd.options) {
        if (o.required && options[o.name] === undefined) return t('missingOption', { option: `--${o.name}` });
      }

      // 有子指令、自身不收位置参数的指令，多出来的词是写错或不存在的子指令名，或是写多了的选项值
      // （`/clear -t context vector`）：报错并指向 /help，不忽略后执行本指令（否则 `/clear alll`
      // 会在确认后清掉当前会话）
      if (cmd.positionalArgs.length === 0 && positionalTokens.length > 0 && this.directChildren(cmd.name).length > 0) {
        return t('extraArgument', {
          token: positionalTokens[0],
          prefix: this.prefix,
          command: cmd.name.replace(/\./g, ' '),
        });
      }

      const positionals: unknown[] = [];
      let cursor = 0;
      for (const def of cmd.positionalArgs) {
        const values =
          def.type === 'text' ? positionalTokens.slice(cursor) : positionalTokens.slice(cursor, cursor + 1);
        if (values.length === 0) {
          if (def.required) return t('missingArgument', { name: def.name });
          positionals.push(undefined);
          continue;
        }
        positionals.push(parsePositionalValue(def, values));
        cursor += values.length;
      }

      return { positionals, options };
    } catch (err) {
      // 取值解析错误（数字非法 / choices 越界）→ 返回给人看的报错，而非抛出冒泡到命令管道。
      return textOf(err);
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

/** 写了 -h 或 --help（`--` 之后的是位置参数，不算）：要看用法，别的参数一概不管 */
function asksHelp(tokens: string[]): boolean {
  const end = tokens.indexOf('--');
  return (end < 0 ? tokens : tokens.slice(0, end)).some(t => t === '-h' || t === '--help');
}

/**
 * 没有权限插件时执行不了的指令：要比默认等级高，或要人确认。没有守卫时 fail-closed，口径与 plugin-tools 相同：
 * 等同人人都是默认等级、没人能确认
 */
function needsAuthority(cmd: Command): boolean {
  return (
    cmd.confirm !== undefined || capabilityMinLevel({ risk: cmd.risk, visibility: cmd.visibility }) > DEFAULT_AUTHORITY
  );
}

/** 按空白拆参数：引号里的整段是一个参数（空的引号是一个空参数），反斜杠转义下一个字符 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  /** 这个参数写过引号：空的也算一个 */
  let quoted = false;
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
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || quoted) {
        tokens.push(current);
        current = '';
        quoted = false;
      }
      continue;
    }
    current += ch;
  }
  if (current || quoted) tokens.push(current);
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
        if (m[1] === '<' ? m[4] !== '>' : m[4] !== ']') {
          throw new Error(`选项值括号不匹配: "${p}"`);
        }
      }
    }
  }

  if (name === 'help' || name === 'h' || aliases.includes('h') || aliases.includes('help')) {
    throw new Error(`-h 与 --help 是保留选项（回这条指令的用法），选项 ${name} 不能占用`);
  }

  return {
    name,
    aliases,
    type,
    valueName,
    valueOptional,
    description: opts?.description,
    default: opts?.default,
    required: opts?.required === true,
    choices: choicesOf(opts?.choices),
  };
}

/** 登记写的取值收成每次现取的函数，只写值的一项补成 { value } */
function choicesOf(choices: OptionRegisterOptions['choices']): OptionSpec['choices'] {
  if (!choices) return undefined;
  const list = typeof choices === 'function' ? choices : () => choices;
  return () => list().map(c => (typeof c === 'string' ? { value: c } : c));
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
    if (Number.isNaN(n)) throw new TextError(t('optionNumber', { option: `--${def.name}`, value: rawValue }));
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
  const choices = def.choices?.();
  if (choices && !choices.some(c => c.value === rawValue)) {
    throw new TextError(t('optionChoices', { option: `--${def.name}`, choices: choices.map(c => c.value).join(', ') }));
  }
  return rawValue;
}

function parsePositionalValue(def: PositionalArgSpec, values: string[]): unknown {
  const raw = def.type === 'text' ? values.join(' ') : values[0];
  if (def.type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new TextError(t('argumentNumber', { name: def.name, value: raw }));
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
