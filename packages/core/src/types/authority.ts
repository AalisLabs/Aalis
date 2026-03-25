// ===== 权限服务接口 =====

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
}

/** 确认回调：返回 true 表示放行，false 表示拒绝 */
export type DangerousConfirmHandler = (request: DangerousConfirmRequest) => Promise<boolean>;

/**
 * 权限服务接口
 *
 * 负责用户权限等级管理、dangerous 操作确认等。
 * 具体实现由 plugin-authority 提供。
 */
export interface AuthorityService {
  getAuthority(platform: string, userId?: string): number;
  setAuthority(platform: string, userId: string, level: number): void;
  isOwner(platform: string, userId?: string): boolean;
  isDangerousAllowed(name: string): boolean;
  confirmDangerous(request: DangerousConfirmRequest): Promise<boolean>;
  save(): void;
  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void;
  listUsers(): Array<{ platform: string; userId: string; authority: number }>;
}
