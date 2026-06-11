// ----- 权限服务接口 + 执行守卫契约 -----
//
// 任何需要"在指令/工具执行前进行权限校验"的服务实现（plugin-tools、plugin-commands 等）
// 都应从本包导入 `ExecutionGuard` / `ExecutionGuardContext`，
// 任何需要消费权限服务的插件应导入 `AuthorityService` 等接口。

import type { SafetyLevel } from '@aalis/core';

// ============================================================
// 执行守卫（跨切面：commands / tools 服务通过 setExecutionGuard 注入）
// ============================================================

/** 细粒度权限标识，如 tool:file.write、storage:workspace:read */
export type PermissionId = string;

/**
 * 执行守卫上下文 —— 在指令执行前进行权限检查的最小信息
 */
export interface ExecutionGuardContext {
  /** 操作名称（指令名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 声明的最低权限等级 */
  authority: number;
  /** 声明的安全等级 */
  safety: SafetyLevel;
  /** 细粒度权限标识 */
  permissions?: PermissionId[];
  /** 会话 ID */
  sessionId: string;
  /** 来源平台 */
  platform: string;
  /** 用户 ID */
  userId?: string;
  /** 操作参数 */
  args?: Record<string, unknown>;
  /** 是否跳过安全等级检查（指令的工具桥接等场景） */
  skipSafetyCheck?: boolean;
}

/**
 * 执行守卫函数
 *
 * 返回 null 表示放行，返回 string 表示拦截（值为拦截原因/提示消息）。
 * 由外部插件（如 plugin-authority）通过 setExecutionGuard() 注入。
 */
export type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;

// ============================================================
// 权限服务接口
// ============================================================

/** 高危操作确认请求信息 */
export interface DangerousConfirmRequest {
  /** 操作名称（指令名或工具名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 操作参数（工具调用时存在） */
  args?: Record<string, unknown>;
  /** 细粒度权限标识 */
  permissions?: string[];
  /** 会话 ID */
  sessionId: string;
  /** 来源平台 */
  platform: string;
  /** 用户 ID */
  userId?: string;
}

export interface DangerousGrantRequest {
  /** 授权范围：once 不会被持久记录；session 表示当前会话短时授权 */
  scope: 'once' | 'session';
  /** 授权秒数，仅 scope=session 时有效 */
  durationSeconds?: number;
  /** 最大使用次数，仅 scope=session 时有效 */
  maxUses?: number;
}

export interface DangerousConfirmResult {
  allowed: boolean;
  grant?: DangerousGrantRequest;
}

export interface DangerousGrant {
  id: string;
  name: string;
  type: 'command' | 'tool';
  /** 创建授权时绑定的权限集合 */
  permissions?: string[];
  sessionId: string;
  platform: string;
  userId?: string;
  expiresAt: number;
  maxUses?: number;
  used: number;
  createdAt: number;
}

/** 确认回调：boolean 为旧格式；对象格式可附带短时 grant */
export type DangerousConfirmHandler = (request: DangerousConfirmRequest) => Promise<boolean | DangerousConfirmResult>;

/** 权限服务接口 */
export interface AuthorityService {
  getAuthority(platform: string, userId?: string): number;
  setAuthority(platform: string, userId: string, level: number): void;
  isOwner(platform: string, userId?: string): boolean;
  /**
   * 计算一组细粒度权限标识所要求的最低权限等级（参数级动态提权）。
   *
   * 与工具/指令声明的静态 authority 取较大值后生效——只会提高门槛，
   * 永远不会低于声明值（单调提权，防止参数组合降低门槛）。
   * 内置敏感清单可被 config.permissionAuthority（glob→等级）覆盖/扩展。
   */
  requiredAuthorityFor(permissions: string[]): number;
  isDangerousAllowed(name: string, permissions?: string[]): boolean;
  confirmDangerous(request: DangerousConfirmRequest): Promise<boolean>;
  listDangerousGrants(): DangerousGrant[];
  revokeDangerousGrant(id: string): boolean;
  save(): void;
  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void;
  listUsers(): Array<{ platform: string; userId: string; authority: number }>;
}

// ============================================================
// 用户身份（cleanup-9 从 core 迁入）
// ============================================================

/** 跨平台用户身份标识 */
export interface UserIdentity {
  platform: string;
  userId: string;
}

// ============================================================
// AalisConfig declaration merging —— authority 域业务字段（cleanup-9）
// ============================================================
//
// core 的 AalisConfig 只声明基础设施字段（name / logLevel / plugins / ...），
// authority 域的业务字段通过 declaration merging 注入，避免 core 知晓任何
// 权限/危险操作的语义。
//
// 注意：dangerousPolicy.enabledAt 不在此声明 —— 它是 plugin-authority 的运行时
// 状态，不应被持久化到 config 文件。
declare module '@aalis/core' {
  interface AalisConfig {
    /** owner 列表 */
    owners?: UserIdentity[];
    /** 新用户默认权限等级（默认 1） */
    defaultAuthority?: number;
    /** owner 的权限等级（默认 5） */
    ownerAuthority?: number;
    /** dangerous 操作白名单策略 */
    dangerousPolicy?: {
      /** 允许的 dangerous 工具/指令名列表，['*'] 表示全部放行 */
      allow?: string[];
      /** 白名单有效时长（秒），0 = 永久 */
      duration?: number;
    };
    /** 细粒度权限策略：deny 优先；allow 为空表示默认放行 */
    permissionPolicy?: {
      allow?: string[];
      deny?: string[];
    };
    /**
     * 参数级动态提权：细粒度权限标识（glob）→ 所要求的最低权限等级。
     * 命中多个模式时取最大值，并与工具/指令声明的 authority 取较大者。
     * 用于让同一工具按参数要求不同等级（如写 data:/users.json 需 owner 等级）。
     * 同模式覆盖内置默认清单，新模式叠加。
     */
    permissionAuthority?: Record<string, number>;
    /** 管理员对单条指令的权限/安全等级覆盖 */
    commandOverrides?: Record<string, { authority?: number; safety?: string }>;
  }
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    authority: AuthorityService;
  }
}
