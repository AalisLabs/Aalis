import { defineService } from '@aalis/core';
// ----- 权限服务接口 + 执行守卫契约（数字等级模型）-----
//
// 模型：操作能力（capability）+ 用户数字等级（level，整数，越大越高）+ 操作最低等级（minLevel）。
//   - owner = ∞，可执行任意能力、可管理所有人的权限（不入等级表）。
//   - 裁决：deniedCapabilities（全局硬禁）> owner(∞) > 用户 level >= 操作 minLevel；
//     minLevel 由操作的 risk / visibility / config.authorityOverrides 派生。
//   - restricted：门槛较高的能力；等级不够即拒，没有别的放行口。
//   - 单 owner 终态：等级只由 owner 管理（无委托树 / 子委托）。
//
// 任何需要「执行前权限校验」的服务（plugin-tools / plugin-commands 等）从本包导入
// ExecutionGuard / ExecutionGuardContext；消费权限服务的插件导入 AuthorityService。

import type {} from '@aalis/api-host-config'; // declaration merging 锚点（下方 AalisConfig 增强）

/** 细粒度能力标识，如 tool:file.write、command:shutdown */
export type CapabilityId = string;

/**
 * 能力默认可见性（轴 A · 授权：谁默认能用）：
 * - public：所有人默认拥有（除非被显式 deny），如查天气、查状态。
 * - restricted：门槛较高，无 risk 声明时最低等级为 RESTRICTED_LEVEL，如关机、写 users.json。
 */
export type CapabilityVisibility = 'public' | 'restricted';

/**
 * 能力确认要求（轴 B · 确认：是否需「人确认」这一步，与 visibility 正交、owner 也生效）：
 * - 缺省/undefined：无需确认（不提醒）。
 * - 'session'：执行前需人确认；系统源（ExecutionGuardContext.skipConfirm）与 restrictedPolicy 白名单可免。
 * - 'always'：每次都需确认，什么都免不掉（最危险操作）。
 *
 * 怎么确认看操作是谁发起的：工具由模型调用，确认是 owner 审批（@aalis/api-approval）；指令由人亲手输入，
 * 确认是向发出者本人核对意图（ExecutionGuardContext.confirmIntent）。
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

/** 未登记外部身份的默认等级。 */
export const DEFAULT_AUTHORITY = 0;
/** 无 risk 声明、仅标 `visibility:'restricted'` 的操作的兜底最低等级。 */
export const RESTRICTED_LEVEL = 2;

/**
 * `(risk, visibility)` → 操作最低等级。**这是契约语义，不是某个实现的细节** —— 任何需要
 * 判断「两个能力声明谁更严」的地方都必须用它，否则会得到与实际裁决不一致的答案。
 *
 * 关键性质：**risk 一旦存在就完全遮蔽 visibility**。于是「未声明 risk」在合并两份声明时
 * 不能当成最弱 —— 对一个 `visibility:'restricted'` 的能力来说，不声明 risk 反而意味着更严
 * （兜底到 RESTRICTED_LEVEL），而补上一个 `risk:'safe'` 会把门槛降到 0。
 *
 * 曾按「visibility / confirm / risk 三轴各自独立取最严」来合并同名指令的多份声明，实测
 * 不单调：给 `{visibility:'restricted'}` 的 /shutdown 压一层 `{risk:'safe'}`，门槛从 2 掉到 0，
 * 而 visibility 那一栏仍显示 restricted —— 提权成功且症状被藏起来。正解是拿本函数给每份
 * 声明各自定级、取最严的**那一份**，不跨声明混轴。
 */
export function capabilityMinLevel(opts: { risk?: CapabilityRisk; visibility?: CapabilityVisibility }): number {
  if (opts.risk === 'dangerous') return 2;
  if (opts.risk === 'sensitive') return 1;
  if (opts.risk === 'safe') return DEFAULT_AUTHORITY;
  return opts.visibility === 'restricted' ? RESTRICTED_LEVEL : DEFAULT_AUTHORITY;
}

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
 * @param defaultVisibility 三者皆缺省时的兜底可见性（缺省 'public'）。
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

/**
 * 调用所在的入站回合（只由 agent 工具循环填写，指令与其他调用方没有）。守卫据它判发起回合的类别，
 * 类别决定需要确认的工具调用能不能产生 owner 审批。
 */
export interface InboundTurn {
  /** 同 IncomingMessage.source：真人消息为 undefined，内部注入为注入方标识 */
  source?: string;
  /**
   * 宿主通知延续某次工具调用时，那次调用的发言者（IncomingMessage.hostNotice.callerUserId）。
   * 那次调用是 owner 在自己会话里发起的，这一轮才是 owner 链的延续
   */
  callerUserId?: string;
  /** 同 IncomingMessage.messageId：入站消息的平台消息 id。转到后台的工具调用结束时，结束通知的回复据它引用这条消息 */
  messageId?: string;
}

/** 执行守卫上下文 —— 操作执行前权限检查的最小信息 */
export interface ExecutionGuardContext {
  /** 操作名称（指令名 / 工具名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 操作主能力的生效可见性（轴 A；注册时已由 resolveCapabilityPolicy 展开 risk/默认）。无 risk 时据它兜底 minLevel */
  visibility: CapabilityVisibility;
  /** 操作原始风险声明（透传，供 authority 派生 minLevel：safe→0 / sensitive→1 / dangerous→2）；缺省回退 visibility */
  risk?: CapabilityRisk;
  /** 操作的生效确认要求（轴 B，与 visibility/档位 正交、owner 也生效）；缺省=不确认 */
  confirm?: CapabilityConfirm;
  /** 会话 ID */
  sessionId: string;
  /** 来源平台（会话语义；等级判定见 actor） */
  platform: string;
  /** 用户 ID（物理发言者；等级判定见 actor） */
  userId?: string;
  /** 授权身份（缺省 = platform/userId 本身）：等级裁决（authorize）按它评估 */
  actor?: { platform: string; userId: string };
  /** 操作参数 */
  args?: Record<string, unknown>;
  /**
   * 系统/受信源（如 scheduler，无人能点交互确认）：仍走 authorize 评估调用者能力，**不**绕过它（防提权）。
   * 已授权时跳过非 always 的确认，always 照常确认。
   */
  skipConfirm?: boolean;
  /** 调用所在回合的 id（工具调用由 agent 工具循环填写）；审批随回合结束撤销 */
  turnId?: string;
  /** 这次工具调用的 id（同 ToolCallContext.callId）；审批卡据它挂到工具卡上 */
  callId?: string;
  /** 调用所在的入站回合；缺省 = 调用不在由入站消息驱动的回合里（编排的节点、mcp-server 等） */
  inbound?: InboundTurn;
  /**
   * 向发出者本人核对意图（指令用）：调用方能在同一会话里当面问到发出者时提供，resolve true 为发出者确认。
   * 需要确认的指令没有它（定时任务、编排注入的指令）就无从确认，按拒绝处理
   */
  confirmIntent?: () => Promise<boolean>;
  /** 调用方回合的中止信号：守卫等 owner 审批期间回合中止，审批即撤销 */
  signal?: AbortSignal;
}

/**
 * 执行守卫函数。返回 null 放行；返回 string 拦截（值为原因/提示）。
 * 由 plugin-authority 通过 setExecutionGuard() 注入。
 */
export type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;

// ============================================================
// 能力统一闸（裁决序：deniedCapabilities 硬禁 > owner(∞) > 用户 level >= 操作 minLevel）
// ============================================================

/**
 * 能力统一闸请求：一次敏感操作在边界处声明它触达的能力。
 *
 * tools / commands 的执行守卫在操作边界调用 authorize 过这道闸。
 */
export interface AuthorizeRequest {
  /** 操作主能力（tool:<name> / command:<name>） */
  capability: CapabilityId;
  /** 主能力的默认可见性（操作声明；无 risk 时据它兜底 minLevel） */
  visibility: CapabilityVisibility;
  /** 操作原始风险（透传，供 minLevel 派生；缺省回退 visibility） */
  risk?: CapabilityRisk;
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
   * 统一权限闸 —— tools / commands 的执行守卫在操作边界调用本方法。
   * 数字等级裁决：deniedCapabilities(全局硬禁) > owner(∞) > 用户 level >= 操作 minLevel；
   * minLevel 由 request.risk/visibility/config.authorityOverrides 派生。
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

  save(): void;
  listUsers(): AuthorityUserEntry[];
}

// ============================================================
// AalisConfig declaration merging —— authority 域业务字段
// ============================================================
//
// 配置文档契约只声明宿主层字段；authority 域业务字段经 declaration merging 注入，
// 让文档契约不知晓任何权限语义。
declare module '@aalis/api-host-config' {
  interface AalisConfig {
    /** owner 列表（owner = `*`，拥有一切） */
    owners?: UserIdentity[];
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
     * 免确认白名单：allow 列出不必确认的能力 glob（['*'] 全放）；duration 生效时长（秒，0=永久）。
     * 只免 confirm 为 session 的确认，always 照常确认；不放宽授权，等级不够的照样拒。
     * 运行时启用时点（enabledAt）不持久化，是 plugin-authority 运行时状态。
     */
    restrictedPolicy?: {
      allow?: string[];
      duration?: number;
    };
    /**
     * 网络出口闸（SSRF 防护，粗粒度高效）：限制由 LLM/用户 URL 触发的出口能连到哪，即 safeFetch，
     * 以及 tool-browser 开启 blockPrivate 时的浏览器网络闸（三项都遵循）。
     * 不影响你自己配置的固定本地服务（ollama/onebot daemon 走裸 fetch，不过 safeFetch）。
     */
    network?: {
      /** 拦私网/回环/链路本地/元数据段（默认 true）。 */
      blockPrivate?: boolean;
      /** 额外拒绝的 IPv4 CIDR，如 ["100.64.0.0/10"]。 */
      denyCidrs?: string[];
      /** 仅允许这些目标端口（非空生效），如 [80, 443]。 */
      allowedPorts?: number[];
    };
  }
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const authority = defineService<AuthorityService>('authority');
