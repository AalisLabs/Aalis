// ----- 闲置触发调度器 -----
//
// session 范围：每会话一个 setTimeout，触发时合成 system 提示注入 gateway。
// platform 范围：跨平台一个 tick，挑"最久未联系"的 session 主动开聊。
// 到点时本插件不是生效的触发插件（trigger 服务胜者）就不开口：不注入，也不记为 bot 开口。

import type { FlowControlService } from '@aalis/api-flow-control';
import { type GatewayService, resolveEffectiveConfig } from '@aalis/api-gateway';
import type { Events, Logger, ServiceRef } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import type { TriggerPolicyConfig } from './config.js';
import { lastActivityOf, type TriggerSessionState } from './state.js';

/** 调度器用到的能力：日志、入站事件、网关引用、流控闸门（只读当前提供者），以及本插件此刻是否生效 */
export interface IdleCaps {
  logger: Logger;
  events: Events;
  gateway: ServiceRef<GatewayService>;
  flowControl: Pick<ServiceRef<FlowControlService>, 'current'>;
  isActive(): boolean;
}

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

async function injectIdle(caps: IdleCaps, msg: IncomingMessage): Promise<void> {
  const gateway = caps.gateway.current;
  if (gateway) {
    await gateway.ingressMessage(msg);
  } else {
    await caps.events.emit('inbound:message', msg);
  }
}

// ===== session 范围调度 =====

export function scheduleSessionIdle(
  caps: IdleCaps,
  cfg: TriggerPolicyConfig,
  state: TriggerSessionState,
  sessionId: string,
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
      // 本插件不生效、或禁言期（flow 相位也会吞，这里省掉一次注入）不开口：跳过本次并按原退避重排
      const skip = !caps.isActive() ? '触发策略未生效' : caps.flowControl.current?.isMuted(sessionId) ? '禁言中' : '';
      if (skip) {
        caps.logger.debug(`[trigger] 空闲触发跳过（${skip}）: session=${sessionId}`);
        reschedule();
        return;
      }
      caps.logger.info(`[trigger] 空闲触发: session=${sessionId} (退避 x${state.idleBackoff})`);
      if (cfg.idleTriggerStyle === 'exponential') {
        state.idleBackoff = Math.min(state.idleBackoff * 2, 64);
      }
      state.lastBotActivityAt = Date.now();
      await injectIdle(caps, buildIdleMessage(sessionId, state.platform, cfg.idleTriggerPrompt));
      reschedule();
    } catch (err) {
      caps.logger.warn(`空闲触发执行失败: ${err}`);
    }
  }, delayMs);

  caps.logger.debug(`[trigger] 空闲触发已调度: session=${sessionId}, ${Math.round(delayMs / 60_000)}分钟后`);
}

export function clearSessionIdle(state: TriggerSessionState): void {
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
    private readonly caps: IdleCaps,
    private readonly cfg: TriggerPolicyConfig,
    private readonly states: Map<string, TriggerSessionState>,
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
      const last = lastActivityOf(s);
      if (last > maxLast) maxLast = last;
    }
    // 没有任何活动记录（states 为空）≠「已达标」：直接返回 0 会让 schedule 退化成每秒一 tick
    // 的死转。改用 start() 时刻当基准——从启动起静默满一个阈值才算达标。
    const since = maxLast || this.startedAt || Date.now();
    const elapsed = Date.now() - since;
    return Math.max(0, thresholdMs - elapsed);
  }

  /** 选一个最适合主动开聊的会话（带该会话的有效提示词） */
  private pickTarget(): { sessionId: string; state: TriggerSessionState; lastActivity: number; prompt: string } | null {
    const flow = this.caps.flowControl.current;
    let best: { sessionId: string; state: TriggerSessionState; lastActivity: number; prompt: string } | null = null;
    for (const [sid, s] of this.states) {
      // 禁言会话选了也会被 flow 相位吞掉；冷却对闲置注入只在这里把关（flow 相位对内部注入不查冷却），限速在 flow 相位（作用域内）还会再查一次
      if (flow?.isMuted(sid) || flow?.isCoolingDown(sid) || flow?.isRateLimited(sid)) continue;
      const e = resolveEffectiveConfig(this.cfg, s.platform, s.sessionType, s.targetId);
      // per-scope 覆盖单独关掉（'off'）或改成 session 档的会话不能被 platform 档抓来开聊
      if (e.idleTriggerScope !== 'platform') continue;
      const lastActivity = lastActivityOf(s);
      if (!best || lastActivity < best.lastActivity) {
        best = { sessionId: sid, state: s, lastActivity, prompt: e.idleTriggerPrompt };
      }
    }
    return best;
  }

  /** 跑一次 tick（发没发出去都不影响重排间隔，故无返回值） */
  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.caps.isActive()) {
        this.caps.logger.debug('[trigger] platform idle tick: 触发策略未生效，跳过');
        return;
      }
      const target = this.pickTarget();
      if (!target) {
        this.caps.logger.debug('[trigger] platform idle tick: 无可发送候选，跳过');
        return;
      }
      this.caps.logger.info(
        `[trigger] platform idle tick: 主动开聊 → ${target.sessionId} ` +
          `(idle=${Math.round((Date.now() - target.lastActivity) / 60_000)}min)`,
      );
      // 注入即记为 bot 开口：agent 对闲置提示沉默时，下一轮也不会再挑中同一会话
      target.state.lastBotActivityAt = Date.now();
      await injectIdle(this.caps, buildIdleMessage(target.sessionId, target.state.platform, target.prompt));
    } catch (err) {
      this.caps.logger.warn(`[trigger] platform idle tick 失败: ${err}`);
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
      // 每轮之后**无条件**退避一个阈值量级：无候选时静默达标条件在 tick 之后仍然成立，
      // 照 delay===0→1s 重排就是 1 Hz 死转。发没发出去都一样等，语义是「每轮之间至少隔一个阈值量级」。
      this.schedule(Math.max(baseMs, IDLE_RETRY_MIN_MS));
    }, delay);
  }
}
