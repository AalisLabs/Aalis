// ============================================================
// @aalis/plugin-flow-control-api — 流控服务契约
//
// 仅包含纯类型，无运行时依赖。下游消费者（平台 adapter、trigger-policy
// 等）应当依赖本包而非 plugin-flow-control 具体实现，以避免对实现包的
// 硬耦合：实现包可被替换、可被禁用。
//
// FlowControlService 负责管理每会话的"流控状态"：
//   - 计数器/活跃指数（间隔触发依据）
//   - 冷却/禁言时段
//   - 限速窗口（防 DDoS）
//   - 闲置触发调度
//
// 服务名约定: 'flow-control'
//   ctx.getService<FlowControlService>('flow-control')
// ============================================================

/** 单会话的流控状态快照（只读视图，便于 trigger-policy 计算） */
export interface FlowSessionStateSnapshot {
  messageCount: number;
  activityScore: number;
  lastReplyTime: number;
  lastMessageTime: number;
  cooldownUntil: number;
  mutedUntil: number;
  idleBackoff: number;
  /** 当前限速窗口内已使用的回复槽 */
  rateLimitUsed: number;
  /** 限速窗口最大可回复次数（0 表示未启用限速） */
  rateLimitMax: number;
  /** 间隔触发使用的固定间隔阈值（供 trigger-policy 复用同一参数） */
  fixedInterval: number;
  /** 用户交互次数表（userId → count） */
  userInteractions: ReadonlyMap<string, { count: number; lastTime: number }>;
}

export interface FlowControlService {
  /** 获取或创建 session 状态（首次访问会初始化） */
  ensureState(sessionId: string, platform: string): void;
  /** 只读快照（trigger-policy 用） */
  getStateSnapshot(sessionId: string): FlowSessionStateSnapshot | undefined;

  /** 入站消息累加（messageCount, activityScore, lastMessageTime, userInteractions, 应用衰减） */
  recordIncoming(sessionId: string, platform: string, userId?: string): void;

  /** 触发后重置（messageCount=0, activityScore=0, lastReplyTime=now, idleBackoff=1） */
  recordTriggered(sessionId: string): void;
  /** 出站消息后处理：设置冷却 + 限速窗口记录 + 重置退避 + 重排 idle 调度 */
  recordReply(sessionId: string, platform: string): void;

  /** 当前是否在冷却 */
  isCoolingDown(sessionId: string): boolean;
  /** 当前是否在禁言 */
  isMuted(sessionId: string): boolean;
  /** 限速检查（返回 true 表示已超限） */
  isRateLimited(sessionId: string): boolean;

  /**
   * 设置自禁言（平台 mute 事件或关键词命中时调用）。
   * - durationSec > 0：mutedUntil = now + durationSec*1000
   * - durationSec <= 0：解除禁言（mutedUntil = 0）
   * 若状态未初始化但提供 platform，会自动创建。
   */
  setMuted(sessionId: string, durationSec: number, platform?: string): void;
  /** 计算当前阈值（动态衰减） */
  getThreshold(sessionId: string): number;

  /** 重新调度本会话的 idle trigger（在每次入站后调用） */
  rescheduleIdle(sessionId: string, platform: string): void;
}
