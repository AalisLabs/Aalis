// ----- 闲置触发调度器 -----
//
// session 范围：每会话一个 setTimeout，触发时合成 system 提示注入 gateway。
// platform 范围：跨平台一个 tick，挑"最久未联系"的 session 主动开聊。

import type { Context, GatewayService, IncomingMessage } from '@aalis/core';
import type { FlowControlConfig } from './config.js';
import type { MutableFlowSessionState } from './state.js';

const DEFAULT_PROMPT = '当前会话已长时间无消息，请根据人设主动开启一个轻松的话题或问候。不要提及"系统提示"或表明你是被触发发言的。';

function buildIdleMessage(sessionId: string, platform: string, prompt: string): IncomingMessage {
  return {
    content: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT,
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
    delayMs = Math.min(
      cfg.idleTriggerMinutes * state.idleBackoff * 60 * 1000,
      cfg.idleTriggerMaxMinutes * 60 * 1000,
    );
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

export class PlatformIdleScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly ctx: Context,
    private readonly cfg: FlowControlConfig,
    private readonly states: Map<string, MutableFlowSessionState>,
  ) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 距离全部会话静默达标还需多少 ms（返回 0 = 已达标 / 无活跃会话） */
  private timeUntilAllQuiet(thresholdMs: number): number {
    let maxLast = 0;
    for (const s of this.states.values()) {
      const last = Math.max(s.lastMessageTime, s.lastReplyTime);
      if (last > maxLast) maxLast = last;
    }
    if (maxLast === 0) return 0;
    const elapsed = Date.now() - maxLast;
    return Math.max(0, thresholdMs - elapsed);
  }

  /** 选一个最适合主动开聊的 sessionId */
  private pickTarget(): { sessionId: string; lastActivity: number; platform: string } | null {
    const now = Date.now();
    let best: { sessionId: string; lastActivity: number; platform: string } | null = null;
    for (const [sid, s] of this.states) {
      if (s.mutedUntil > now) continue;
      if (s.cooldownUntil > now) continue;
      if (this.cfg.rateLimitWindow > 0 && this.cfg.rateLimitMaxReplies > 0) {
        const windowStart = now - this.cfg.rateLimitWindow * 1000;
        const used = s.replyTimestamps.filter(t => t > windowStart).length;
        if (used >= this.cfg.rateLimitMaxReplies) continue;
      }
      const lastActivity = Math.max(s.lastMessageTime, s.lastReplyTime);
      if (!best || lastActivity < best.lastActivity) {
        best = { sessionId: sid, lastActivity, platform: s.platform };
      }
    }
    return best;
  }

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
      await injectIdle(this.ctx, buildIdleMessage(target.sessionId, target.platform, this.cfg.idleTriggerPrompt));
    } catch (err) {
      this.ctx.logger.warn(`[flow] platform idle tick 失败: ${err}`);
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
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

    this.timer = setTimeout(async () => {
      if (this.cfg.idleTriggerStrategy === 'all-quiet') {
        const remaining = this.timeUntilAllQuiet(baseMs);
        if (remaining > 0) {
          this.schedule();
          return;
        }
      }
      await this.runOnce();
      this.schedule();
    }, delay);
  }
}
