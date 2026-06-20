// ════════════════════════════════════════════════════════════
// tier-model —— 档位裁决引擎（纯函数，无副作用，便于单测）
//
// 单 owner 个人 bot 的「好管」权限：每个外部身份一个**有序档位**（单值），
// 每个操作一个**最低档**（由 risk 派生、owner 可逐条覆盖）。owner=∞。
// 纯档位单轴：每人一个档、每操作一个门槛，无 per-user 单条特批（杜绝跨轴撞车）。
// 裁决优先级（首个命中赢，对齐 Claude Code deny→allow 与 Koishi 等级）：
//   1. 全局硬禁 deniedCapabilities  → 拒（压过 owner，保 deny>owner 不变量；非 per-user，是配置总闸）
//   2. owner                        → 放行
//   3. 有效档 rank >= 操作 minTier   → 放行；否则拒（封禁 rank=-1 自然连 minTier=0 都不过）
// 确认轴（confirm/HITL）正交，不在此函数（owner 也吃，防注入借权）。
// 内含 glob 工具 matchAnyCap（资源能力/硬禁匹配）。
// ════════════════════════════════════════════════════════════

import type { TierName } from '@aalis/plugin-authority-api';

/** 档位（有序整数 rank；owner 不入表 = ∞）。档名 TierName 是契约（authority-api）。 */
export const TIERS = { banned: -1, visitor: 0, friend: 1, trusted: 2 } as const satisfies Record<TierName, number>;
export const OWNER_RANK = Number.POSITIVE_INFINITY;

/** 档名 → rank；未知名回退 visitor。 */
export function rankOf(name: TierName): number {
  return TIERS[name];
}
/** rank → 档名（owner 之外）；用于展示。 */
export function tierName(rank: number): TierName {
  if (rank <= TIERS.banned) return 'banned';
  if (rank >= TIERS.trusted) return 'trusted';
  if (rank >= TIERS.friend) return 'friend';
  return 'visitor';
}
export const TIER_LABEL: Record<TierName, string> = {
  banned: '封禁',
  visitor: '访客',
  friend: '朋友',
  trusted: '信任',
};

/** 风险 → 操作最低档：safe→访客 · sensitive→朋友 · dangerous→信任。 */
export function riskToTier(risk?: 'safe' | 'sensitive' | 'dangerous'): number {
  if (risk === 'dangerous') return TIERS.trusted;
  if (risk === 'sensitive') return TIERS.friend;
  return TIERS.visitor; // safe / 未声明
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
 * 操作最低档解析：tierOverrides[cap] > risk 派生 > visibility 兜底。
 * visibility 兜底仅在拿不到 risk 时用（public→访客 / restricted→信任）。
 */
export function resolveMinTier(
  capability: string,
  opts: {
    tierOverrides?: Record<string, number>;
    risk?: 'safe' | 'sensitive' | 'dangerous';
    visibility?: 'public' | 'restricted';
  },
): number {
  const ov = opts.tierOverrides?.[capability];
  if (ov !== undefined) return ov;
  if (opts.risk) return riskToTier(opts.risk);
  return opts.visibility === 'restricted' ? TIERS.trusted : TIERS.visitor;
}

/** 一次访问裁决的输入（纯档位单轴）。 */
interface AccessInput {
  /** 触发者有效档（owner→OWNER_RANK；= max(登记档, 访问器命中档)） */
  rank: number;
  /** 操作最低档 */
  minTier: number;
  isOwner: boolean;
  /** 全局硬禁 glob（config.deniedCapabilities，配置总闸，非 per-user） */
  denied?: readonly string[];
  /** 被裁决的能力串（command:x / tool:x / storage:...） */
  capability: string;
}

/** 档位裁决（见文件头优先级）。true=放行。 */
export function resolveAccess(input: AccessInput): boolean {
  if (matchAnyCap(input.denied ?? [], input.capability)) return false; // 1. 全局硬禁，压过 owner
  if (input.isOwner) return true; // 2. owner
  return input.rank >= input.minTier; // 3. 档位门槛（封禁 rank=-1 自然不过）
}
