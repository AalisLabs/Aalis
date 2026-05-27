// ----- FlowSessionState 内部实现 + 衰减/计数算法 -----

import type { FlowControlConfig } from './config.js';
import type { FlowSessionStateSnapshot } from './types.js';

export interface MutableFlowSessionState {
  messageCount: number;
  lastReplyTime: number;
  lastMessageTime: number;
  activityScore: number;
  cooldownUntil: number;
  mutedUntil: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleBackoff: number;
  userInteractions: Map<string, { count: number; lastTime: number }>;
  /** 滑动窗口内的回复时间戳（用于防 DDoS 限速） */
  replyTimestamps: number[];
  /** 该 session 所属 platform（首次记录时设置；用于 idle 调度找回） */
  platform: string;
  /** 该 session 的 sessionType（如 group/private/channel）；用于 per-scope 覆盖匹配 */
  sessionType: string;
  /** 该 session 的目标 id（群号/用户号/频道号）；用于 per-scope 覆盖匹配 */
  targetId: string;
}

export function createState(platform: string, sessionType = '', targetId = ''): MutableFlowSessionState {
  return {
    messageCount: 0,
    lastReplyTime: 0,
    lastMessageTime: 0,
    activityScore: 0,
    cooldownUntil: 0,
    mutedUntil: 0,
    idleTimer: null,
    idleBackoff: 1,
    userInteractions: new Map(),
    replyTimestamps: [],
    platform,
    sessionType,
    targetId,
  };
}

/** 当前阈值（动态衰减） */
export function getCurrentThreshold(state: MutableFlowSessionState, cfg: FlowControlConfig): number {
  if (state.lastReplyTime === 0) return cfg.activityScoreLower;
  const elapsed = Date.now() - state.lastReplyTime;
  const decayMs = cfg.activityDecayMinutes * 60 * 1000;
  const factor = Math.max(0, 1 - elapsed / decayMs);
  return cfg.activityScoreLower + (cfg.activityScoreUpper - cfg.activityScoreLower) * factor;
}

/** 评分按距离上次消息的时间线性衰减（原地修改） */
export function applyScoreDecay(state: MutableFlowSessionState, cfg: FlowControlConfig): void {
  if (cfg.scoreDecayMinutes <= 0 || state.activityScore <= 0 || state.lastMessageTime === 0) return;
  const elapsed = Date.now() - state.lastMessageTime;
  const decayMs = cfg.scoreDecayMinutes * 60 * 1000;
  const factor = Math.max(0, 1 - elapsed / decayMs);
  state.activityScore *= factor;
  if (state.activityScore < 0.001) state.activityScore = 0;
}

/** 计算单条入站对评分的增量（受用户交互权重影响） */
export function calculateScoreIncrement(
  state: MutableFlowSessionState,
  cfg: FlowControlConfig,
  userId?: string,
): number {
  const base = 1.0 / Math.max(1, cfg.fixedInterval);
  let userWeight = 1.0;
  if (userId) {
    const interaction = state.userInteractions.get(userId);
    if (interaction) {
      userWeight = 1.0 + 0.5 * Math.min(interaction.count / 10, 1.0);
    }
  }
  return base * userWeight;
}

export function rateLimitUsedNow(state: MutableFlowSessionState, cfg: FlowControlConfig): number {
  if (cfg.rateLimitWindow <= 0) return 0;
  const windowStart = Date.now() - cfg.rateLimitWindow * 1000;
  return state.replyTimestamps.filter(t => t > windowStart).length;
}

export function snapshot(state: MutableFlowSessionState, cfg: FlowControlConfig): FlowSessionStateSnapshot {
  return {
    messageCount: state.messageCount,
    activityScore: state.activityScore,
    lastReplyTime: state.lastReplyTime,
    lastMessageTime: state.lastMessageTime,
    cooldownUntil: state.cooldownUntil,
    mutedUntil: state.mutedUntil,
    idleBackoff: state.idleBackoff,
    rateLimitUsed: rateLimitUsedNow(state, cfg),
    rateLimitMax: cfg.rateLimitMaxReplies,
    fixedInterval: cfg.fixedInterval,
    userInteractions: state.userInteractions,
  };
}
