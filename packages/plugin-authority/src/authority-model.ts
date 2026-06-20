// ════════════════════════════════════════════════════════════
// authority-model —— 数字等级裁决引擎（纯函数，无副作用，便于单测）
//
// 单 owner 个人 bot 的「好管」权限：每个外部身份一个**整数等级**（越大越高，默认 0，
// 封禁=负数），每个操作一个**最低等级**（由 risk 派生、owner 可逐条覆盖成任意整数）。
// owner = ∞（不在等级轴上，靠 owners 列表归属），永不被任何门槛锁出。
// 裁决优先级（首个命中赢，对齐 Claude Code deny→allow 与老版数字等级）：
//   1. 全局硬禁 deniedCapabilities  → 拒（压过 owner，保 deny>owner 不变量；配置总闸，非 per-user）
//   2. owner                        → 放行
//   3. 等级 level >= 操作 minLevel   → 放行；否则拒（封禁=负数自然连 minLevel=0 都不过）
// 确认轴（confirm/HITL）正交，不在此函数（owner 也吃，防注入借权）。
// 内含 glob 工具 matchAnyCap（资源能力/硬禁匹配）。
// ════════════════════════════════════════════════════════════

/** owner 等级（∞）：不入等级轴，靠 owners 列表归属；任何有限门槛都压不过它（防自锁）。 */
export const OWNER_RANK = Number.POSITIVE_INFINITY;
/** 未登记外部身份的默认等级。 */
export const DEFAULT_AUTHORITY = 0;
/** 无 risk 声明、仅标 visibility:'restricted' 的操作的兜底最低等级（≈老版「受信」门槛）。 */
export const RESTRICTED_LEVEL = 2;

/** 风险 → 操作最低等级：safe→0 · sensitive→1 · dangerous→2（owner 可逐条覆盖成任意整数）。 */
export function riskToLevel(risk?: 'safe' | 'sensitive' | 'dangerous'): number {
  if (risk === 'dangerous') return 2;
  if (risk === 'sensitive') return 1;
  return DEFAULT_AUTHORITY; // safe / 未声明
}

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
  if (opts.risk) return riskToLevel(opts.risk);
  return opts.visibility === 'restricted' ? RESTRICTED_LEVEL : DEFAULT_AUTHORITY;
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

/**
 * auto 模式（owner 临时免 session 确认，类 Claude Code auto）是否激活。纯函数。
 * `until`：-1=一直；>now=截止前激活；其余(0/过期)=关。只影响确认轴，不动等级/deny；always 确认不被它跳过（调用方保证）。
 */
export function autoConfirmActive(until: number, now: number): boolean {
  return until === -1 || (until > 0 && now < until);
}
