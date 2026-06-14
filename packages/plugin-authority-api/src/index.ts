// ----- 权限服务接口 + 执行守卫契约（纯能力委托模型）-----
//
// 模型：能力（capability）+ 默认可见性 public/restricted + 委托加减。
//   - owner = `*`，可执行任意能力、可委托一切。
//   - 用户有效能力 = owner ? 全部 : (所有 public ∪ 被授予的 restricted) − 被禁用的；deny 优先。
//   - 委托树：每个用户可建下层用户并授予能力，但只能授予「自己持有的」（子集约束，
//     单调递减，孙 ⊆ 子 ⊆ owner），grantedBy 记录委托父，天然防越权。
//
// 任何需要「执行前权限校验」的服务（plugin-tools / plugin-commands 等）从本包导入
// ExecutionGuard / ExecutionGuardContext；消费权限服务的插件导入 AuthorityService。

import type {} from '@aalis/core'; // declaration merging 锚点（下方 AalisConfig/ServiceTypeMap 增强）

/** 细粒度能力标识，如 tool:file.write、command:shutdown、storage:path:data:/users.json:write */
export type CapabilityId = string;

/**
 * 能力默认可见性：
 * - public：所有人默认拥有（除非被显式 deny），如查天气、查状态。
 * - restricted：默认禁止，须被 owner/上层委托授予，如关机、写 users.json。
 */
export type CapabilityVisibility = 'public' | 'restricted';

// ============================================================
// 执行守卫（跨切面：commands / tools 服务通过 setExecutionGuard 注入）
// ============================================================

/** 执行守卫上下文 —— 操作执行前权限检查的最小信息 */
export interface ExecutionGuardContext {
  /** 操作名称（指令名 / 工具名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 操作主能力的默认可见性（操作声明；未标默认 public） */
  visibility: CapabilityVisibility;
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
  /** 操作主能力（tool:<name> / command:<name> / action:<plugin>:<method>） */
  capability: CapabilityId;
  /** 主能力的默认可见性（操作声明） */
  visibility: CapabilityVisibility;
  /** 操作额外触达的资源能力（storage:... 等）；可见性由 restrictedCapabilities 配置判定 */
  resourceCapabilities?: CapabilityId[];
}

/**
 * 用户的能力委托（覆盖式）。glob 模式，按 {@link CapabilityId} 匹配。
 * - grant：授予的 restricted 能力（委托加）。
 * - deny：禁用的能力（委托减，最高优先，连 owner / public 都压过）。
 */
export interface UserCapabilityOverrides {
  grant?: string[];
  deny?: string[];
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
  /** owner = `*`，拥有一切 */
  isOwner: boolean;
  /** 被授予的 restricted 能力（委托加） */
  grant?: string[];
  /** 被禁用的能力（委托减） */
  deny?: string[];
  /** 委托父身份键（如 "webui:admin"；owner 直接委托或顶层则空） */
  grantedBy?: string;
  /** 是否存在密码凭据（凭据本身永不返回） */
  hasPassword?: boolean;
  /** 本账户绑定的平台身份键（如 "onebot:12345"；仅主账户有） */
  links?: string[];
  /** 本身份被绑定到的主账户键（如 "webui:alice"；仅被绑平台身份有） */
  linkedTo?: string;
}

// ============================================================
// 权限服务接口
// ============================================================

export interface AuthorityService {
  /** 是否为 owner（owners 配置命中 → 拥有 `*`） */
  isOwner(platform: string, userId?: string): boolean;

  /**
   * 能力统一闸 —— 任何 surface 的敏感操作在边界调用本方法。
   * 逐能力裁决 deny > owner(*) > public > granted；全部通过才放行。
   * 主能力按 request.visibility 判可见性；资源能力按 config.restrictedCapabilities 判。
   * @returns null 放行；string 为拒绝原因（可直接展示）
   */
  authorize(identity: UserIdentity | { platform: string; userId?: string }, request: AuthorizeRequest): string | null;

  /**
   * 委托：设置 target 用户的能力 grant/deny（覆盖式；两表皆空则清记录）。
   * granter 非 owner 时校验子集——只能授予「自己当前有效持有」的能力，越权抛 Error
   * （message 可回显）。granter 为 null 表示系统/owner 上下文（不校验）。
   * 记录 grantedBy=granter 身份键，形成委托树。
   */
  setUserCapabilities(granter: UserIdentity | null, target: UserIdentity, caps: UserCapabilityOverrides): void;

  /** 删除用户记录（能力委托/密码一并清除；其下层用户的 grantedBy 链需调用方另行处理或保留） */
  removeUser(platform: string, userId: string): void;

  /** 列出某 granter 直接委托的下层用户（委托树展开用；owner 传 null 列顶层非 owner 用户） */
  listDelegatees(granter: UserIdentity | null): AuthorityUserEntry[];

  // ── 临时能力委托（restricted 能力的时限/限次授予）──
  /** 用户触达未授予的 restricted 能力时，过临时委托流程（白名单策略 → 会话临时授予 → 确认回调） */
  requestAccess(request: AccessRequest): Promise<boolean>;
  listTemporaryGrants(): TemporaryGrant[];
  revokeTemporaryGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void;

  // ── 密码（登录凭据，PBKDF2-SHA256）──
  /** 设置/更新账户密码。WebUI 账户为 platform='webui' + userId=用户名。只拒空密码，策略由调用方管。 */
  setPassword(platform: string, userId: string, password: string): Promise<void>;
  /** 校验密码；无凭据或不匹配均 false（恒定时间比较） */
  verifyPassword(platform: string, userId: string, password: string): Promise<boolean>;
  /** 该身份是否存在密码凭据 */
  hasPassword(platform: string, userId: string): boolean;

  // ── 跨平台身份绑定（运行时零合并 + 绑时一次性合并）──
  /** 生成跨平台绑定码（一次性、约 5 分钟有效；同账户重生成作废旧码）。发起者须为 webui 主账户。 */
  createBindCode(platform: string, userId: string): { code: string; expiresAt: number };
  /** 消费绑定码：把 identity（外部平台身份，拒绝 webui/cli）绑定到码的发起账户。失败抛 Error。 */
  consumeBindCode(code: string, identity: UserIdentity): UserIdentity;
  /** 解绑平台身份（按被绑身份键）；返回是否存在该绑定。 */
  unlinkIdentity(platform: string, userId: string): boolean;

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
     * 管理员对单条操作的可见性覆盖（操作名 → public/restricted）。
     * 让 owner 临时把某操作放开/收紧，无需改插件声明。
     */
    visibilityOverrides?: Record<string, CapabilityVisibility>;
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
