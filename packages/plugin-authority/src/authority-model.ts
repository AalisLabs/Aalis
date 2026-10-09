// ════════════════════════════════════════════════════════════
// authority-model —— 数字等级裁决引擎（纯函数，无副作用，便于单测）
//
// 单 owner 个人 bot 的「好管」权限：每个外部身份一个**整数等级**（越大越高，默认 0，
// 封禁=负数），每个操作一个**最低等级**（由 risk 派生、owner 可逐条覆盖成任意整数）。
// owner = ∞（不在等级轴上，靠 owners 列表归属），永不被任何门槛锁出。
// 裁决优先级（首个命中即定，硬禁先于 owner 与等级放行）：
//   1. 全局硬禁 deniedCapabilities  → 拒（压过 owner，保 deny>owner 不变量；配置总闸，非 per-user）
//   2. owner                        → 放行
//   3. 等级 level >= 操作 minLevel   → 放行；否则拒（封禁=负数自然连 minLevel=0 都不过）
// 确认轴（confirm/HITL）正交，不在此函数（owner 也吃，防注入借权）。
// 内含 glob 工具 matchAnyCap（资源能力/硬禁匹配），以及工具调用发起回合的类别 originKind。
// ════════════════════════════════════════════════════════════

/** owner 等级（∞）：不入等级轴，靠 owners 列表归属；任何有限门槛都压不过它（防自锁）。 */
export const OWNER_RANK = Number.POSITIVE_INFINITY;

// 等级常量与 (risk,visibility)→门槛 的映射住在契约包 `@aalis/api-authority`：
// 判断「两份能力声明谁更严」的地方不止这里（plugin-commands 合并同名指令的多份声明时也要），
// 两份实现必然漂移 —— 曾因此漏掉「risk 遮蔽 visibility」这条性质，酿成一条提权面。
import type { OriginKind } from '@aalis/api-approval';
import { capabilityMinLevel, DEFAULT_AUTHORITY, type ExecutionGuardContext } from '@aalis/api-authority';
import { roomClass, type SessionInfo } from '@aalis/api-session-manager';

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
 * 操作最低等级解析：authorityOverrides[cap] > risk 派生 > visibility 兜底。
 * visibility 兜底仅在拿不到 risk 时用（public→0 / restricted→RESTRICTED_LEVEL）。
 */
export function resolveMinLevel(
  capability: string,
  opts: {
    authorityOverrides?: Record<string, number>;
    risk?: 'safe' | 'sensitive' | 'dangerous';
    visibility?: 'public' | 'restricted';
  },
): number {
  const ov = opts.authorityOverrides?.[capability];
  if (ov !== undefined) return ov;
  return capabilityMinLevel(opts);
}

/** 一次访问裁决的输入（纯数字单轴）。 */
interface AccessInput {
  /** 触发者有效等级（owner→OWNER_RANK；= 登记等级，缺省 DEFAULT_AUTHORITY） */
  level: number;
  /** 操作最低等级 */
  minLevel: number;
  isOwner: boolean;
  /** 全局硬禁 glob（config.deniedCapabilities，配置总闸，非 per-user） */
  denied?: readonly string[];
  /** 被裁决的能力串（command:x / tool:x / storage:...） */
  capability: string;
}

/** 数字等级裁决（见文件头优先级）。true=放行。 */
export function resolveAccess(input: AccessInput): boolean {
  if (matchAnyCap(input.denied ?? [], input.capability)) return false; // 1. 全局硬禁，压过 owner
  if (input.isOwner) return true; // 2. owner（∞）
  return input.level >= input.minLevel; // 3. 等级门槛（封禁=负数自然不过）
}

type IsOwner = (platform: string, userId?: string) => boolean;

/**
 * 工具调用发起回合的类别（契约见 api-approval 的 OriginKind），只有 owner 与 owner-chain 能产生审批。
 * 按回合的来源判，不按授权身份判：owner 建的定时任务会把创建者回填成 actor，按 actor 判它就成了 owner。
 * lookup 按 id 取会话管理里的记录，房间类别按记下的字段判（api-session-manager 的 roomClass）。
 * - 不在由入站消息驱动的回合里（编排的节点、mcp-server 等）：没有人在这一轮亲手发起它，是 autonomous；
 * - 子任务回合是 subtask；房间里的回合（多方的聊天窗口，或对端不是 owner 的一对一，子会话按根会话算）是 room，
 *   不论谁发言；
 * - 真人消息：带 actor 的是触发器把这一轮记成了自发的（群里的频率触发），是 autonomous；
 *   否则受众只有 owner 的会话（owner-only）里发言者是 owner 为 owner，其余为 other：受众判不出的会话（internal，
 *   如按 id 兜底建档的、会话管理不在时）失败关闭；
 * - 宿主通知延续某次工具调用：在 owner-only 的会话里、那次调用的发言者与授权身份都是 owner 才是 owner-chain，否则 other；
 * - 其余注入（定时任务、编排、空闲与主动发言、不延续调用的宿主通知）是 autonomous。
 */
export function originKind(
  turn: Pick<ExecutionGuardContext, 'sessionId' | 'platform' | 'userId' | 'actor' | 'inbound'>,
  isOwner: IsOwner,
  lookup: (sessionId: string) => SessionInfo | undefined,
): OriginKind {
  const { inbound, actor } = turn;
  if (!inbound) return 'autonomous';
  if (inbound.source === 'subtask') return 'subtask';
  const room = roomClass(lookup(turn.sessionId), lookup, isOwner);
  if (room === 'room') return 'room';
  const ownerOnly = room === 'owner-only';
  if (inbound.source === undefined) {
    if (actor) return 'autonomous';
    return ownerOnly && isOwner(turn.platform, turn.userId) ? 'owner' : 'other';
  }
  if (inbound.callerUserId !== undefined) {
    const chained =
      ownerOnly && isOwner(turn.platform, inbound.callerUserId) && !!actor && isOwner(actor.platform, actor.userId);
    return chained ? 'owner-chain' : 'other';
  }
  return 'autonomous';
}
