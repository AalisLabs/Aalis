// ════════════════════════════════════════════════════════════
// authority-model —— 等级与权限组的裁决引擎（纯函数，无副作用，便于单测）
//
// 单 owner 个人 bot 的「好管」权限：每个外部身份一个**整数等级**（越大越高，默认 0，
// 封禁=负数），每个操作一个**最低等级**（由 risk 派生、owner 可逐条覆盖成任意整数）；
// 另可属于任意几个**权限组**（具名的放行集合，只加放行，组之间合起来算）。
// owner = ∞（不在等级轴上，靠 owners 列表归属），永不被任何门槛锁出。
// 裁决优先级（首个命中即定，硬禁先于 owner 与等级放行）：
//   1. 全局硬禁 deniedCapabilities  → 拒（压过 owner，保 deny>owner 不变量；配置总闸，非 per-user）
//   2. owner                        → 放行
//   3. 封禁（等级小于 0）            → 拒（负数的门槛与权限组都不放行）
//   4. 等级 level >= 操作 minLevel   → 放行
//   5. 所属组里有条目覆盖这个操作    → 放行；否则拒
// 确认轴（confirm/HITL）正交，不在此函数（owner 也吃，防注入借权）。
// 内含 glob 工具 matchAnyCap（硬禁、白名单与组条目的匹配）、组名与条目的写法，以及工具调用发起回合的类别 originKind
// 与这一轮的主体 principalKind。
// ════════════════════════════════════════════════════════════

/** owner 等级（∞）：不入等级轴，靠 owners 列表归属；任何有限门槛都压不过它（防自锁）。 */
export const OWNER_RANK = Number.POSITIVE_INFINITY;

// 等级常量与 (risk,visibility)→门槛 的映射住在契约包 `@aalis/api-authority`：
// 判断「两份能力声明谁更严」的地方不止这里（plugin-commands 合并同名指令的多份声明时也要），
// 两份实现必然漂移 —— 曾因此漏掉「risk 遮蔽 visibility」这条性质，酿成一条提权面。
import type { OriginKind } from '@aalis/api-approval';
import { capabilityMinLevel, DEFAULT_AUTHORITY, type InboundTurn, type OriginTurn } from '@aalis/api-authority';
import { isUnsafeConfigKey } from '@aalis/schema-config';

export { DEFAULT_AUTHORITY };

// ── glob（`*` 通配任意字符段）──────────────
function capMatches(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(value);
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function matchAnyCap(patterns: readonly string[], value: string): boolean {
  for (const p of patterns) if (capMatches(p, value)) return true;
  return false;
}

/**
 * 操作最低等级解析：authorityOverrides[cap] > 操作声明的门槛（minLevel，如设置项的）> risk 派生 > visibility 兜底。
 * visibility 兜底仅在拿不到 risk 时用（public→0 / restricted→RESTRICTED_LEVEL）。
 */
export function resolveMinLevel(
  capability: string,
  opts: {
    authorityOverrides?: Record<string, number>;
    minLevel?: number;
    risk?: 'safe' | 'sensitive' | 'dangerous';
    visibility?: 'public' | 'restricted';
  },
): number {
  return opts.authorityOverrides?.[capability] ?? opts.minLevel ?? capabilityMinLevel(opts);
}

// ── 权限组的写法 ──────────────
/** 组的放行条目：tool:、command: 后接名字或通配，tool-group: 后接工具分组名（不是通配）；裸 `*` 与别的前缀不收 */
const GRANT_ENTRY = /^(?:(?:tool|command):\S+|tool-group:[^\s*]+)$/;
const TOOL_GROUP = 'tool-group:';

/** 放行条目的写法对不对：页面写入时据此当场报错，裁决时写法不对的条目不命中任何操作 */
export function isGrantEntry(entry: unknown): entry is string {
  return typeof entry === 'string' && GRANT_ENTRY.test(entry);
}

/**
 * 组名：字母、数字、连字符、下划线与中文，不以连字符开头（指令解析会把它当成选项）；不收空白与 `<>`，
 * 也不收落到原型链上的保留名（组名是配置里的键）
 */
export function isGroupName(name: string): boolean {
  return /^[A-Za-z0-9_\p{Script=Han}][A-Za-z0-9_\p{Script=Han}-]*$/u.test(name) && !isUnsafeConfigKey(name);
}

/** 所属组的放行条目里有没有一条覆盖这个操作：tool-group: 按工具的分组比，其余按能力串匹配（通配同 matchAnyCap） */
function grantsCover(granted: readonly string[], capability: string, toolGroups: readonly string[] = []): boolean {
  return granted.some(
    entry =>
      isGrantEntry(entry) &&
      (entry.startsWith(TOOL_GROUP)
        ? toolGroups.includes(entry.slice(TOOL_GROUP.length))
        : capMatches(entry, capability)),
  );
}

/** 一次访问裁决的输入。 */
interface AccessInput {
  /** 触发者有效等级（owner→OWNER_RANK；= 登记等级，缺省 DEFAULT_AUTHORITY） */
  level: number;
  /** 操作最低等级 */
  minLevel: number;
  isOwner: boolean;
  /** 全局硬禁 glob（config.deniedCapabilities，配置总闸，非 per-user） */
  denied?: readonly string[];
  /** 被裁决的能力串（command:x / tool:x） */
  capability: string;
  /** 触发者所属各组的放行条目合集（没有组即空）；写法不对的条目不命中任何操作 */
  granted: readonly string[];
  /** 被裁决的工具所属的工具分组（指令没有） */
  toolGroups?: readonly string[];
}

/** 等级与权限组裁决（见文件头优先级）。true=放行。 */
export function resolveAccess(input: AccessInput): boolean {
  if (matchAnyCap(input.denied ?? [], input.capability)) return false; // 1. 全局硬禁，压过 owner
  if (input.isOwner) return true; // 2. owner（∞）
  if (input.level < 0) return false; // 3. 封禁，负数的门槛也不放行
  if (input.level >= input.minLevel) return true; // 4. 等级门槛
  return grantsCover(input.granted, input.capability, input.toolGroups); // 5. 所属组覆盖
}

/** 判类别与主体要的那几项：起它的那一轮还原成的一轮没有会话 */
type Turn = Pick<OriginTurn, 'platform' | 'userId' | 'participants' | 'inbound'>;

/** 起它的那一轮还原成一轮 */
function turnOf({ platform, userId, participants, source, fromTurn }: NonNullable<InboundTurn['fromTurn']>): Turn {
  return { platform, userId, participants, inbound: { source, fromTurn } };
}

/**
 * 工具调用发起回合的类别（契约见 api-approval 的 OriginKind）：只看消息事实，不看会话类型与受众，不判是不是 owner，
 * 不读会话记录。按这一轮从哪里来判，不按授权身份判：owner 建的定时任务会把创建者回填成 actor，按 actor 判它就成了 owner 亲手。
 * - 不在由入站消息驱动的回合里（编排的节点、mcp-server 等）：没有人在这一轮亲手发起它，是 autonomous；
 * - 带起它的那一轮的续做与入站回合里派出的子任务，与起它的那一轮同一类别，不按通知或任务消息上的身份推；
 * - 其余带来源的注入（定时任务、编排、空闲与主动发言、不延续调用的宿主通知、平台请求事件，以及没带起它的那一轮的子任务）是
 *   autonomous；
 * - 人亲手发来的消息（不带来源，含群里没点名、被频率触发挑中的插话）的一轮是 hand，几条一起进来的也是；参与者都没有账号的
 *   （没有人的消息）是她自己开口，失败关闭为 autonomous。
 */
export function originKind(turn: Turn): OriginKind {
  const { inbound } = turn;
  if (!inbound) return 'autonomous';
  if (inbound.fromTurn) return originKind(turnOf(inbound.fromTurn));
  if (inbound.source !== undefined) return 'autonomous';
  return turn.participants.some(who => who.userId) ? 'hand' : 'autonomous';
}

/**
 * 这一轮的主体（契约见 api-authority 的 principalOf），是不是 owner 只在这里与审批服务按身份判：类别为 hand（含随起它的那一轮的
 * 续做与子任务）且参与者都是 owner 为 owner，其余为 other（owner 与别人同在的一轮也是）。参与者是这一轮交来的：续做与子任务的
 * 取起它的那一轮的，批过的调用是批的人
 */
export function principalKind(turn: Turn, isOwner: (platform: string, userId?: string) => boolean): 'owner' | 'other' {
  const { participants } = turn;
  return originKind(turn) === 'hand' &&
    participants.length > 0 &&
    participants.every(who => isOwner(who.platform, who.userId))
    ? 'owner'
    : 'other';
}
