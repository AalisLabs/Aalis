// ----- 权限服务接口 -----

/** 高危操作确认请求信息 */
export interface DangerousConfirmRequest {
  /** 操作名称（指令名或工具名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 操作参数（工具调用时存在） */
  args?: Record<string, unknown>;
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
  isDangerousAllowed(name: string): boolean;
  confirmDangerous(request: DangerousConfirmRequest): Promise<boolean>;
  listDangerousGrants(): DangerousGrant[];
  revokeDangerousGrant(id: string): boolean;
  save(): void;
  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void;
  listUsers(): Array<{ platform: string; userId: string; authority: number }>;
}
