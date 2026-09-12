// ----- 闲置触发调度器 -----
//
// session 范围：每会话一个 setTimeout，触发时合成 system 提示注入 gateway。
// platform 范围：跨平台一个 tick，挑"最久未联系"的 session 主动开聊。

import type { GatewayService } from '@aalis/api-gateway';
import type { Context } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { type FlowControlConfig, resolveEffectiveConfig } from './config.js';
import type { MutableFlowSessionState } from './state.js';

const DEFAULT_PROMPT =
  '当前会话已长时间无消息，请根据人设主动开启一个轻松的话题或问候。不要提及"系统提示"或表明你是被触发发言的。';

function buildIdleMessage(sessionId: string, platform: string, prompt: string): IncomingMessage {
  return {
    content: prompt?.trim() ? prompt : DEFAULT_PROMPT,
    sessionId,
    platform,
    source: 'idle-trigger',
    triggerType: 'idle',
  };
}

async function injectIdle(ctx: Context, msg: IncomingMessage): Promise<void> {
  const gateway = ctx.getService<GatewayService>('gateway');
  if (gateway) {
    await gateway.ingressMessage(msg);
  } else {
    await ctx.emit('inbound:message', msg);
  }
}

// ===== session 范围调度 =====

export function scheduleSessionIdle(
  ctx: Context,
  cfg: FlowControlConfig,
  state: MutableFlowSessionState,
  sessionId: string,
  platform: string,
  reschedule: () => void,
): void {
  clearSessionIdle(state);
  if (cfg.idleTriggerScope !== 'session') return;
  if (cfg.idleTriggerMinutes <= 0) return;

  let delayMs: number;
  if (cfg.idleTriggerStyle === 'exponential') {
    delayMs = Math.min(cfg.idleTriggerMinutes * state.idleBackoff * 60 * 1000, cfg.idleTriggerMaxMinutes * 60 * 1000);
  } else {
    delayMs = cfg.idleTriggerMinutes * 60 * 1000;
  }
  if (cfg.idleTriggerJitter) {
    const jitter = delayMs * (0.1 * (Math.random() * 2 - 1));
    delayMs = Math.max(60_000, delayMs + jitter);
  }

  state.idleTimer = setTimeout(async () => {
    try {
      ctx.logger.info(`[flow] 空闲触发: session=${sessionId} (退避 x${state.idleBackoff})`);
      if (cfg.idleTriggerStyle === 'exponential') {
        state.idleBackoff = Math.min(state.idleBackoff * 2, 64);
      }
      await injectIdle(ctx, buildIdleMessage(sessionId, platform, cfg.idleTriggerPrompt));
      reschedule();
    } catch (err) {
      ctx.logger.warn(`空闲触发执行失败: ${err}`);
    }
  }, delayMs);

  ctx.logger.debug(`[flow] 空闲触发已调度: session=${sessionId}, ${Math.round(delayMs / 60_000)}分钟后`);
}

export function clearSessionIdle(state: MutableFlowSessionState): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

// ===== platform 范围调度 =====

/** 两轮 tick 之间的最小间隔（阈值更长则按阈值） */
const IDLE_RETRY_MIN_MS = 60_000;

export class PlatformIdleScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** stop() 之后不再重排——tick 回调可能已在飞行中，回来时要认这面旗，否则留下僵尸定时器 */
  private stopped = false;
  /** start() 时刻——无任何活动记录时拿它当「最后一次活动」的基准 */
  private startedAt = 0;

  constructor(
    private readonly ctx: Context,
    private readonly cfg: FlowControlConfig,
    private readonly states: Map<string, MutableFlowSessionState>,
  ) {}

  start(): void {
    this.stopped = false;
    this.startedAt = Date.now();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 距离全部会话静默达标还需多少 ms（返回 0 = 已达标） */
  private timeUntilAllQuiet(thresholdMs: number): number {
    let maxLast = 0;
    for (const s of this.states.values()) {
      const last = Math.max(s.lastMessageTime, s.lastReplyTime);
      if (last > maxLast) maxLast = last;
    }
    // 没有任何活动记录（states 为空 / 全是恢复出来的空状态）≠「已达标」：直接返回 0 会让
    // schedule 退化成每秒一 tick 的死转。改用 start() 时刻当基准——从启动起静默满一个阈值
    // 才算达标。
    const since = maxLast || this.startedAt || Date.now();
    const elapsed = Date.now() - since;
    return Math.max(0, thresholdMs - elapsed);
  }

  /** 选一个最适合主动开聊的 sessionId（带该会话的有效提示词） */
  private pickTarget(): { sessionId: string; lastActivity: number; platform: string; prompt: string } | null {
    const now = Date.now();
    let best: { sessionId: string; lastActivity: number; platform: string; prompt: string } | null = null;
    for (const [sid, s] of this.states) {
      if (s.mutedUntil > now) continue;
      if (s.cooldownUntil > now) continue;
      const e = resolveEffectiveConfig(this.cfg, s.platform, s.sessionType, s.targetId);
      // per-scope 覆盖单独关掉（'off'）或改成 session 档的会话不能被 platform 档抓来开聊
      if (e.idleTriggerScope !== 'platform') continue;
      if (e.rateLimitWindow > 0 && e.rateLimitMaxReplies > 0) {
        const windowStart = now - e.rateLimitWindow * 1000;
        const used = s.replyTimestamps.filter(t => t > windowStart).length;
        if (used >= e.rateLimitMaxReplies) continue;
      }
      const lastActivity = Math.max(s.lastMessageTime, s.lastReplyTime);
      if (!best || lastActivity < best.lastActivity) {
        best = { sessionId: sid, lastActivity, platform: s.platform, prompt: e.idleTriggerPrompt };
      }
    }
    return best;
  }

  /** 跑一次 tick（发没发出去都不影响重排间隔，故无返回值） */
  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const target = this.pickTarget();
      if (!target) {
        this.ctx.logger.debug('[flow] platform idle tick: 无可发送候选，跳过');
        return;
      }
      this.ctx.logger.info(
        `[flow] platform idle tick: 主动开聊 → ${target.sessionId} ` +
          `(idle=${Math.round((Date.now() - target.lastActivity) / 60_000)}min)`,
      );
      await injectIdle(this.ctx, buildIdleMessage(target.sessionId, target.platform, target.prompt));
    } catch (err) {
      this.ctx.logger.warn(`[flow] platform idle tick 失败: ${err}`);
    } finally {
      this.running = false;
    }
  }

  private schedule(minDelayMs = 0): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.cfg.idleTriggerScope !== 'platform') return;
    if (this.cfg.idleTriggerMinutes <= 0) return;

    const baseMs = this.cfg.idleTriggerMinutes * 60_000;
    let delay: number;
    if (this.cfg.idleTriggerStrategy === 'fixed') {
      delay = baseMs;
    } else {
      delay = this.timeUntilAllQuiet(baseMs);
      if (delay === 0) delay = 1000;
    }
    if (delay < minDelayMs) delay = minDelayMs;

    this.timer = setTimeout(async () => {
      if (this.cfg.idleTriggerStrategy === 'all-quiet') {
        const remaining = this.timeUntilAllQuiet(baseMs);
        if (remaining > 0) {
          this.schedule();
          return;
        }
      }
      await this.runOnce();
      // 每轮之后**无条件**退避一个阈值量级：静默达标条件在 tick 之后仍然成立（发出去的那条
      // 消息要等被处理才会刷新活动时间，无候选时更是压根没变），照 delay===0→1s 重排就是
      // 1 Hz 死转。发没发出去都一样等，语义是「每轮之间至少隔一个阈值量级」。
      this.schedule(Math.max(baseMs, IDLE_RETRY_MIN_MS));
    }, delay);
  }
}
