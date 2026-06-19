// ════════════════════════════════════════════════════════════
// 纯能力委托模型 —— feat/auth-capability 重构基石（纯函数，无副作用，便于单测）
//
// 用「能力 + 默认可见性 public/restricted + owner 授予加减」替代数字等级：
//   - 能力是 glob 标识（tool:x / command:x / storage:path:...:write / *）。
//   - 作者为每个操作声明默认可见性：public（默认所有人可用）/ restricted（默认禁，需授予）。
//   - 用户有效能力 = owner ? 全部 : (所有 public ∪ 被授予的 restricted) − 被禁用的；deny 优先。
//   - 单 owner 终态：权限只由 owner 管理（无委托树/子委托），故无子集约束。
// ════════════════════════════════════════════════════════════

/** 单条能力 glob 匹配：`*` 通配任意字符段。pattern 为 glob，value 为具体能力串。 */
export function capMatches(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** value 是否被 patterns 中任一 glob 命中。 */
export function matchAnyCap(patterns: readonly string[], value: string): boolean {
  for (const p of patterns) if (capMatches(p, value)) return true;
  return false;
}

/**
 * 用户的能力解析输入。
 * - publicCaps：全局声明为 public 的能力集（来自各操作声明，所有人默认拥有）。
 * - grants：该用户被授予的 restricted 能力 glob（委托加）。
 * - denies：该用户被禁用的能力 glob（委托减，最高优先）。
 * - isOwner：owner = `*`，拥有一切。
 */
export interface CapabilityResolution {
  isOwner: boolean;
  publicCaps: readonly string[];
  grants: readonly string[];
  denies: readonly string[];
}

/**
 * 用户对某具体能力是否有效。优先级：deny > owner(*) > public > granted(restricted)。
 * 注意 deny 高于 owner——owner 也可被显式 deny 某能力（如临时收回）。
 */
export function hasCapability(res: CapabilityResolution, cap: string): boolean {
  if (matchAnyCap(res.denies, cap)) return false;
  if (res.isOwner) return true;
  return matchAnyCap(res.publicCaps, cap) || matchAnyCap(res.grants, cap);
}
