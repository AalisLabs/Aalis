// ----- 权限服务接口 + 执行守卫契约（纯能力委托模型）-----
//
// 模型：能力（capability）+ 默认可见性 public/restricted + owner 授予加减。
//   - owner = `*`，可执行任意能力、可管理所有人的权限。
//   - 用户有效能力 = owner ? 全部 : (所有 public ∪ 被授予的 restricted) − 被禁用的；deny 优先。
//   - 单 owner 终态：权限只由 owner 管理（无委托树/子委托），故无子集约束。
//
// 任何需要「执行前权限校验」的服务（plugin-tools / plugin-commands 等）从本包导入
// ExecutionGuard / ExecutionGuardContext；消费权限服务的插件导入 AuthorityService。

import type {} from '@aalis/core'; // declaration merging 锚点（下方 AalisConfig/ServiceTypeMap 增强）

/** 细粒度能力标识，如 tool:file.write、command:shutdown、storage:path:data:/users.json:write */
export type CapabilityId = string;

/**
 * 能力默认可见性（轴 A · 授权：谁默认能用）：
 * - public：所有人默认拥有（除非被显式 deny），如查天气、查状态。
 * - restricted：默认禁止，须被 owner/上层委托授予，如关机、写 users.json。
 */
export type CapabilityVisibility = 'public' | 'restricted';

/**
 * 能力确认要求（轴 B · 确认：是否需「人确认」这一步，与 visibility 正交、owner 也生效）：
 * - 缺省/undefined：无需确认（不提醒）。
 * - 'session'：执行前需人确认；可「本会话」记住（回复 YS），会话内同能力不再追问。
 * - 'always'：每次都需确认，不接受会话记忆（最危险操作）。
 *
 * 与 visibility 正交：visibility 管「授权（能不能）」，confirm 管「意图确认（是不是你本人此刻要）/防注入减速带」。
 * 即便 owner=`*`，命中 confirm 的能力仍须确认 —— 抵御 owner 会话内提示注入借权静默调高危。
 */
export type CapabilityConfirm = 'session' | 'always';

/**
 * 能力风险等级（可选声明糖）：插件自分类风险，框架展开为 (visibility, confirm) 默认：
 * - safe       → (public,     无确认)    查天气/算术等
 * - sensitive  → (restricted, 无确认)    owner 顺手的中危
 * - dangerous  → (restricted, 'session') owner 也确认 —— shell / 写删 / 改系统 等
 *
 * 显式 visibility / confirm 覆盖 risk 推导值；三者皆不声明 → visibility 默认 public（保持向后兼容）。
 */
export type CapabilityRisk = 'safe' | 'sensitive' | 'dangerous';

/** 操作在注册时可声明的能力策略（可见性 / 确认 / 风险糖） */
export interface CapabilityPolicyDecl {
  visibility?: CapabilityVisibility;
  confirm?: CapabilityConfirm;
  risk?: CapabilityRisk;
}

const RISK_DEFAULTS: Record<CapabilityRisk, { visibility: CapabilityVisibility; confirm?: CapabilityConfirm }> = {
  safe: { visibility: 'public' },
  sensitive: { visibility: 'restricted' },
  dangerous: { visibility: 'restricted', confirm: 'session' },
};

/**
 * risk → 默认 (visibility, confirm)；无 risk 返回空对象。
 * 供需要保留「未声明=继承」语义的注册方（如 commands 沿 dot-path 继承）用 —— 不带兜底默认。
 */
export function riskDefaults(risk?: CapabilityRisk): {
  visibility?: CapabilityVisibility;
  confirm?: CapabilityConfirm;
} {
  return risk ? RISK_DEFAULTS[risk] : {};
}

/**
 * 把 (risk, visibility, confirm) 声明展开为生效的 (visibility, confirm)。纯函数。
 * 优先级：显式 visibility/confirm > risk 推导 > defaultVisibility。
 * @param defaultVisibility 三者皆缺省时的兜底可见性 —— tools/commands 传 'public'，
 *   WebUI actions 传 'restricted'（actions 默认拒，与 tool/command 相反）。
 */
export function resolveCapabilityPolicy(
  decl: CapabilityPolicyDecl,
  defaultVisibility: CapabilityVisibility = 'public',
): {
  visibility: CapabilityVisibility;
  confirm?: CapabilityConfirm;
} {
  const base = riskDefaults(decl.risk);
  return {
    visibility: decl.visibility ?? base.visibility ?? defaultVisibility,
    confirm: decl.confirm ?? base.confirm,
  };
}

// ============================================================
// 执行守卫（跨切面：commands / tools 服务通过 setExecutionGuard 注入）
// ============================================================

/** 执行守卫上下文 —— 操作执行前权限检查的最小信息 */
export interface ExecutionGuardContext {
  /** 操作名称（指令名 / 工具名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 操作主能力的生效可见性（轴 A；注册时已由 resolveCapabilityPolicy 展开 risk/默认）。无 risk 时作 minTier 兜底 */
  visibility: CapabilityVisibility;
  /** 操作原始风险声明（透传，供 authority 派生 minTier：safe→访客/sensitive→朋友/dangerous→信任）；缺省回退 visibility */
  risk?: CapabilityRisk;
  /** 操作的生效确认要求（轴 B，与 visibility/档位 正交、owner 也生效）；缺省=不确认 */
  confirm?: CapabilityConfirm;
  /** 操作额外触达的资源能力（如 storage:path:...:write）；其可见性由 restrictedCapabilities 决定 */
  permissions?: CapabilityId[];
  /** 会话 ID */
  sessionId: string;
  /** 来源平台 */
  platform: string;
  /** 用户 ID */
  userId?: string;
  /** 操作参数 */
  args?: Record<string, unknown>;
  /**
   * 系统/受信源（如 scheduler，无人能点交互确认）：仍走 authorize 评估调用者能力，
   * 仅跳过受限被拒后的交互确认弹窗（requestAccess）。**不**绕过 authorize（防提权）。
   */
  skipConfirm?: boolean;
}

/**
 * 执行守卫函数。返回 null 放行；返回 string 拦截（值为原因/提示）。
 * 由 plugin-authority 通过 setExecutionGuard() 注入。
 */
export type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;

// ============================================================
// 能力统一闸（委托图为唯一裁决：deny > owner(*) > public > granted）
// ============================================================

/**
 * 能力统一闸请求：一次敏感操作在边界处声明它触达的能力。
 *
 * 任何 surface（tool/command/WebUI action/REST/scheduler）的敏感操作都在操作边界
 * 调用 authorize 过同一闸。
 */
export interface AuthorizeRequest {
  /** 操作主能力（tool:<name> / command:<name>） */
  capability: CapabilityId;
  /** 主能力的默认可见性（操作声明；无 risk 时作 minTier 兜底） */
  visibility: CapabilityVisibility;
  /** 操作原始风险（透传，供 minTier 派生；缺省回退 visibility） */
  risk?: CapabilityRisk;
  /** 操作额外触达的资源能力（storage:... 等）；可见性由 restrictedCapabilities 配置判定 */
  resourceCapabilities?: CapabilityId[];
}

// ============================================================
// 临时能力委托（restricted 能力的时限/限次授予；替代旧"危险操作确认"）
// ============================================================

/** 用户触达未授予的 restricted 能力时，向 owner/确认回调发起的请求 */
export interface AccessRequest {
  /** 操作名称 */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 触达的（受限）能力 */
  capability: CapabilityId;
  /** 资源能力（如有） */
  resourceCapabilities?: CapabilityId[];
  args?: Record<string, unknown>;
  sessionId: string;
  platform: string;
  userId?: string;
  /**
   * 请求性质：
   * - 'grant'（缺省）：非 owner 触达未授予的 restricted 能力，确认=授予。
   * - 'confirm'：调用者已有权限（含 owner），仅因能力标了 confirm 轴需「意图确认」。
   * confirm='always' 时不接受会话记忆（每次都问）。
   */
  confirm?: CapabilityConfirm;
}

/** 批准后授予的临时委托范围：once 不持久；session 为当前会话短时授予 */
export interface TemporaryGrantSpec {
  scope: 'once' | 'session';
  /** 授予秒数，仅 scope=session 时有效 */
  durationSeconds?: number;
  /** 最大使用次数，仅 scope=session 时有效 */
  maxUses?: number;
}

export interface AccessDecision {
  allowed: boolean;
  grant?: TemporaryGrantSpec;
}

/** 一条生效中的临时能力委托 */
export interface TemporaryGrant {
  id: string;
  capability: CapabilityId;
  name: string;
  type: 'command' | 'tool';
  sessionId: string;
  platform: string;
  userId?: string;
  expiresAt: number;
  maxUses?: number;
  used: number;
  createdAt: number;
}

/** 确认回调：boolean 为最简允许/拒绝；对象可附带临时委托范围 */
export type AccessConfirmHandler = (request: AccessRequest) => Promise<boolean | AccessDecision>;

// ============================================================
// 会话确认协调器（共享状态机：pending / 超时 / Y-YS 解析 / 文案）
//
// 「确认层」对所有平台一致，只有**投递**与**拦截点**因平台而异（与流式输出等正交）：
//   - webui：投递走 WS type:'confirm'（流式友好），拦截在 WS-onmessage（发 inbound 前）。
//   - onebot/cli：投递走 gateway 总线 outbound，拦截在 inbound:confirm 相位。
// 各平台用同一个 coordinator，只注入自己的 deliver + 在自己的拦截点调 tryResolve。
// ============================================================

/** 把一条确认回复文本解析为决策（纯函数）：Y=本次、YS=本会话（always 不接受会话记忆）、其余=取消。 */
export function parseConfirmReply(
  replyText: string,
  always: boolean,
  sessionGrantSeconds: number,
): boolean | AccessDecision {
  const t = replyText.trim().toLowerCase();
  const yes = t === 'y' || t === 'yes';
  if (always) return yes || t === 'ys' ? { allowed: true } : false;
  if (t === 'ys') return { allowed: true, grant: { scope: 'session', durationSeconds: sessionGrantSeconds } };
  if (yes) return { allowed: true, grant: { scope: 'once' } };
  return false;
}

/** 组合确认提示文案（纯函数，所有平台一致）。 */
export function composeConfirmPrompt(request: AccessRequest, always: boolean, sessionGrantSeconds: number): string {
  const label = request.type === 'command' ? '指令' : '工具';
  const nameStr = request.type === 'command' ? `/${request.name}` : request.name;
  return always
    ? `⚠️ ${label} ${nameStr} 是高危操作，每次都需确认。回复 Y 确认执行本次；其他任意输入取消。`
    : `⚠️ ${label} ${nameStr} 是高危操作。回复 Y 仅允许本次；回复 YS 本会话 ${Math.round(sessionGrantSeconds / 60)} 分钟内放行；其他任意输入取消。`;
}

// ============================================================
// 用户身份
// ============================================================

/** 跨平台用户身份标识 */
export interface UserIdentity {
  platform: string;
  userId: string;
}

/** listUsers 返回的用户记录 */
export interface AuthorityUserEntry {
  platform: string;
  userId: string;
  /** owner = ∞，拥有一切 */
  isOwner: boolean;
  /** 用户等级（整数，越大越高；owner 不入表，此处为非 owner 外部身份的登记等级；缺省 0，封禁=负数） */
  level: number;
  /** 可选备注（这人是谁） */
  note?: string;
}

// ============================================================
// 权限服务接口
// ============================================================

export interface AuthorityService {
  /** 是否为 owner（owners 配置命中 → 拥有 `*`） */
  isOwner(platform: string, userId?: string): boolean;

  /**
   * 统一权限闸 —— 任何 surface 的敏感操作在边界调用本方法。
   * 数字等级裁决：deniedCapabilities(全局硬禁) > owner(∞) > 用户 level >= 操作 minLevel；
   * minLevel 由 request.risk/visibility/config.authorityOverrides 派生；资源能力按 restrictedCapabilities 系统层 fail-closed。
   * @returns null 放行；string 为拒绝原因（可直接展示）
   */
  authorize(identity: UserIdentity | { platform: string; userId?: string }, request: AuthorizeRequest): string | null;

  /**
   * 设置 target 外部身份的等级（覆盖式整数；level=0 默认值且无备注则清记录）。
   * 单 owner 终态：权限只由 owner 管理。调用方（WebUI action / CLI 指令）自行确保仅 owner 可达（防自授）。
   */
  setUserLevel(target: UserIdentity, level: number): void;

  /** 删除用户记录（等级一并清除，回退默认 0） */
  removeUser(platform: string, userId: string): void;

  // ── 临时能力委托（restricted 能力的时限/限次授予）──
  /** 用户触达未授予的 restricted 能力时，过临时委托流程（白名单策略 → 会话临时授予 → 确认回调） */
  requestAccess(request: AccessRequest): Promise<boolean>;
  listTemporaryGrants(): TemporaryGrant[];
  revokeTemporaryGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void;

  save(): void;
  listUsers(): AuthorityUserEntry[];
}

// ============================================================
// AalisConfig declaration merging —— authority 域业务字段
// ============================================================
//
// core 只声明基础设施字段；authority 域业务字段经 declaration merging 注入，
// 让 core 不知晓任何权限语义。
declare module '@aalis/core' {
  interface AalisConfig {
    /** owner 列表（owner = `*`，拥有一切） */
    owners?: UserIdentity[];
    /**
     * 受限能力清单（glob）：命中即默认 restricted（默认禁、需被授予/owner）。
     * 替代旧的数字提权 map。内置保护（写 data:/users.json、aalis:/* 等）+ 本清单叠加。
     */
    restrictedCapabilities?: string[];
    /** 全局能力封禁（glob）：命中即拒，连 owner 都压过（系统级硬禁用，慎用）。 */
    deniedCapabilities?: string[];
    /**
     * 管理员对单条操作的最低等级覆盖（能力键 `type:name`，如 `tool:weather` → 任意整数）。
     * 让 owner 调某操作的门槛等级，无需改插件声明；优先于 risk/visibility 派生。
     */
    authorityOverrides?: Record<string, number>;
    /**
     * 管理员对单条操作的确认要求覆盖（能力键 `type:name` → session/always/off）。
     * 'off' 强制关闭确认（即便插件声明了 confirm，便于自动化）；与等级正交，owner 也吃。
     */
    confirmOverrides?: Record<string, CapabilityConfirm | 'off'>;
    /**
     * 受限能力的临时放行策略（替代旧 dangerousPolicy）：
     * allow 列出自动放行的 restricted 能力/操作名 glob（['*'] 全放）；duration 放行时长（秒，0=永久）。
     * 运行时启用时点（enabledAt）不持久化，是 plugin-authority 运行时状态。
     */
    restrictedPolicy?: {
      allow?: string[];
      duration?: number;
    };
  }
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    authority: AuthorityService;
  }
}
