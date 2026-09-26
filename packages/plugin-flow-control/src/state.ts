// ----- 流控会话状态 + 限速计数 + TTL 清扫 -----

import type { FlowControlConfig } from './config.js';

export interface MutableFlowSessionState {
  /** 该 session 所属 platform（用于 per-scope 覆盖匹配与禁言落盘） */
  platform: string;
  /** 该 session 的 sessionType（如 group/private/channel）；用于 per-scope 覆盖匹配 */
  sessionType: string;
  /** 该 session 的目标 id（群号/用户号/频道号）；用于 per-scope 覆盖匹配 */
  targetId: string;
  mutedUntil: number;
  cooldownUntil: number;
  /** 滑动窗口内的回复时间戳（用于限速） */
  replyTimestamps: number[];
  /** 最近一次入站过闸或 agent 回复的时刻（TTL 清扫依据） */
  lastSeenAt: number;
}

export function createState(platform: string, sessionType = '', targetId = ''): MutableFlowSessionState {
  return {
    platform,
    sessionType,
    targetId,
    mutedUntil: 0,
    cooldownUntil: 0,
    replyTimestamps: [],
    lastSeenAt: Date.now(),
  };
}

export function rateLimitUsedNow(state: MutableFlowSessionState, cfg: FlowControlConfig): number {
  if (cfg.rateLimitWindow <= 0) return 0;
  const windowStart = Date.now() - cfg.rateLimitWindow * 1000;
  return state.replyTimestamps.filter(t => t > windowStart).length;
}

/** 会话状态的保留期：超过它未见且无挂起禁言/冷却即淘汰 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 删除无挂起禁言/冷却且超过 TTL 未见的会话状态，返回删除数 */
export function sweepStaleStates(states: Map<string, MutableFlowSessionState>, now: number): number {
  let cleaned = 0;
  for (const [sid, s] of states) {
    if (s.mutedUntil > now || s.cooldownUntil > now) continue;
    if (now - s.lastSeenAt > SESSION_TTL_MS) {
      states.delete(sid);
      cleaned++;
    }
  }
  return cleaned;
}
