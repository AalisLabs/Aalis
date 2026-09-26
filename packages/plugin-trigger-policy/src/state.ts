// ----- 触发会话状态 + 衰减/计数算法 + TTL 清扫 -----

import type { TriggerPolicyConfig } from './config.js';

export interface TriggerSessionState {
  /** 该 session 所属 platform（用于 per-scope 覆盖匹配与 idle 注入） */
  platform: string;
  /** 该 session 的 sessionType（如 group/private/channel）；用于 per-scope 覆盖匹配 */
  sessionType: string;
  /** 该 session 的目标 id（群号/用户号/频道号）；用于 per-scope 覆盖匹配 */
  targetId: string;
  messageCount: number;
  activityScore: number;
  lastMessageTime: number;
  /** 上次判定放行（immediate / interval）的时刻；动态阈值从这里开始衰减 */
  lastTriggerTime: number;
  /** bot 最近一次开口：agent 真实回复或 idle 注入的时刻 */
  lastBotActivityAt: number;
  userInteractions: Map<string, { count: number; lastTime: number }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleBackoff: number;
}

export function createState(platform: string, sessionType = '', targetId = ''): TriggerSessionState {
  return {
    platform,
    sessionType,
    targetId,
    messageCount: 0,
    activityScore: 0,
    lastMessageTime: 0,
    lastTriggerTime: 0,
    lastBotActivityAt: 0,
    userInteractions: new Map(),
    idleTimer: null,
    idleBackoff: 1,
  };
}

/** 会话最近一次活动：真人消息或 bot 开口，取较晚者 */
export function lastActivityOf(state: TriggerSessionState): number {
  return Math.max(state.lastMessageTime, state.lastBotActivityAt);
}

/** 当前阈值（动态衰减） */
export function getCurrentThreshold(state: TriggerSessionState, cfg: TriggerPolicyConfig): number {
  if (state.lastTriggerTime === 0) return cfg.activityScoreLower;
  const elapsed = Date.now() - state.lastTriggerTime;
  const decayMs = cfg.activityDecayMinutes * 60 * 1000;
  const factor = Math.max(0, 1 - elapsed / decayMs);
  return cfg.activityScoreLower + (cfg.activityScoreUpper - cfg.activityScoreLower) * factor;
}

/** 评分按距离上次消息的时间线性衰减（原地修改） */
export function applyScoreDecay(state: TriggerSessionState, cfg: TriggerPolicyConfig): void {
  if (cfg.scoreDecayMinutes <= 0 || state.activityScore <= 0 || state.lastMessageTime === 0) return;
  const elapsed = Date.now() - state.lastMessageTime;
  const decayMs = cfg.scoreDecayMinutes * 60 * 1000;
  const factor = Math.max(0, 1 - elapsed / decayMs);
  state.activityScore *= factor;
  if (state.activityScore < 0.001) state.activityScore = 0;
}

/** 计算单条入站对评分的增量（受用户交互权重影响） */
export function calculateScoreIncrement(state: TriggerSessionState, cfg: TriggerPolicyConfig, userId?: string): number {
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

/** 会话状态的保留期：超过它无活动且无 idle 定时器即淘汰 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 删除无 idle 定时器且超过 TTL 无活动的会话状态，返回删除数 */
export function sweepStaleStates(states: Map<string, TriggerSessionState>, now: number): number {
  let cleaned = 0;
  for (const [sid, s] of states) {
    if (s.idleTimer) continue;
    if (now - lastActivityOf(s) > SESSION_TTL_MS) {
      states.delete(sid);
      cleaned++;
    }
  }
  return cleaned;
}
