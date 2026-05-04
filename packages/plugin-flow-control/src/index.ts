import type {
  Context,
  ConfigSchema,
  FlowControlService,
  FlowSessionStateSnapshot,
  GatewayService,
  MessageArchiveService,
  OutgoingMessage,
} from '@aalis/core';
import {
  type FlowControlConfig,
  defaultFlowControlConfig,
  isPlatformEnabled,
  resolveFlowControlConfig,
} from './config.js';
import {
  type MutableFlowSessionState,
  applyScoreDecay,
  calculateScoreIncrement,
  createState,
  getCurrentThreshold,
  rateLimitUsedNow,
  snapshot,
} from './state.js';
import {
  PlatformIdleScheduler,
  clearSessionIdle,
  scheduleSessionIdle,
} from './idle-scheduler.js';

// ----- 元数据 -----

export const name = '@aalis/plugin-flow-control';
export const displayName = '消息流控';
export const provides = ['flow-control'];
export const inject = {
  optional: ['gateway', 'message-archive'],
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用流控', default: defaultFlowControlConfig.enabled },
  platforms: { type: 'string', label: '生效平台（逗号分隔，空=全部）', default: '' },
  fixedInterval: { type: 'number', label: '固定间隔（每 N 条触发）', default: defaultFlowControlConfig.fixedInterval },
  activityScoreLower: { type: 'number', label: '活跃指数下限', default: defaultFlowControlConfig.activityScoreLower },
  activityScoreUpper: { type: 'number', label: '活跃指数上限', default: defaultFlowControlConfig.activityScoreUpper },
  activityDecayMinutes: { type: 'number', label: '阈值衰减分钟', default: defaultFlowControlConfig.activityDecayMinutes },
  scoreDecayMinutes: { type: 'number', label: '评分衰减分钟（0=不衰减）', default: defaultFlowControlConfig.scoreDecayMinutes },
  cooldownSeconds: { type: 'number', label: '回复后冷却（秒）', default: defaultFlowControlConfig.cooldownSeconds },
  muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）', default: defaultFlowControlConfig.muteTimeSeconds },
  rateLimitWindow: { type: 'number', label: '限速窗口（秒，0=关闭）', default: defaultFlowControlConfig.rateLimitWindow },
  rateLimitMaxReplies: { type: 'number', label: '窗口内最大回复数', default: defaultFlowControlConfig.rateLimitMaxReplies },
  idleTriggerScope: { type: 'string', label: '闲置触发范围（off/session/platform）', default: defaultFlowControlConfig.idleTriggerScope },
  idleTriggerStrategy: { type: 'string', label: '闲置触发策略（all-quiet/fixed）', default: defaultFlowControlConfig.idleTriggerStrategy },
  idleTriggerMinutes: { type: 'number', label: '闲置触发分钟', default: defaultFlowControlConfig.idleTriggerMinutes },
  idleTriggerStyle: { type: 'string', label: '闲置触发风格（exponential/fixed）', default: defaultFlowControlConfig.idleTriggerStyle },
  idleTriggerMaxMinutes: { type: 'number', label: '闲置触发上限分钟', default: defaultFlowControlConfig.idleTriggerMaxMinutes },
  idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动', default: defaultFlowControlConfig.idleTriggerJitter },
  idleTriggerPrompt: { type: 'string', label: '闲置触发系统提示', default: defaultFlowControlConfig.idleTriggerPrompt },
};

export const defaultConfig = defaultFlowControlConfig;

// ----- 入口 -----

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg = resolveFlowControlConfig(raw);
  const states = new Map<string, MutableFlowSessionState>();
  const platformIdle = new PlatformIdleScheduler(ctx, cfg, states);

  function getOrCreate(sessionId: string, platform: string): MutableFlowSessionState {
    let s = states.get(sessionId);
    if (!s) {
      s = createState(platform);
      states.set(sessionId, s);
    } else if (!s.platform && platform) {
      s.platform = platform;
    }
    return s;
  }

  function logStatus(sessionId: string, s: MutableFlowSessionState, label: string): void {
    const threshold = getCurrentThreshold(s, cfg);
    ctx.logger.debug(
      `[flow] ${label} | session=${sessionId} | ` +
      `计数=${s.messageCount}/${cfg.fixedInterval} | ` +
      `指数=${s.activityScore.toFixed(3)} (阈值=${threshold.toFixed(3)})`,
    );
  }

  /** 把"被流控吞掉"的入站消息归档到 message-archive，下次触发时作为上下文 */
  async function shadowArchive(message: import('@aalis/core').IncomingMessage): Promise<void> {
    const archive = ctx.getService<MessageArchiveService>('message-archive');
    if (!archive) return;
    try {
      await archive.archiveIncoming(message);
    } catch (err) {
      ctx.logger.warn(`[flow] shadow 归档失败: ${err}`);
    }
  }

  // ===== Service 实现 =====

  const service: FlowControlService = {
    ensureState(sessionId, platform) {
      getOrCreate(sessionId, platform);
    },
    getStateSnapshot(sessionId): FlowSessionStateSnapshot | undefined {
      const s = states.get(sessionId);
      return s ? snapshot(s, cfg) : undefined;
    },
    recordIncoming(sessionId, platform, userId) {
      const s = getOrCreate(sessionId, platform);
      const now = Date.now();
      applyScoreDecay(s, cfg);
      if (userId) {
        const prev = s.userInteractions.get(userId) ?? { count: 0, lastTime: 0 };
        s.userInteractions.set(userId, { count: prev.count + 1, lastTime: now });
      }
      s.lastMessageTime = now;
      s.messageCount++;
      s.activityScore += calculateScoreIncrement(s, cfg, userId);
    },
    recordTriggered(sessionId) {
      const s = states.get(sessionId);
      if (!s) return;
      s.messageCount = 0;
      s.activityScore = 0;
      s.lastReplyTime = Date.now();
      s.idleBackoff = 1;
    },
    recordReply(sessionId, platform) {
      const s = getOrCreate(sessionId, platform);
      if (cfg.cooldownSeconds > 0) {
        s.cooldownUntil = Date.now() + cfg.cooldownSeconds * 1000;
      }
      s.idleBackoff = 1;
      s.replyTimestamps.push(Date.now());
      this.rescheduleIdle(sessionId, platform);
    },
    isCoolingDown(sessionId) {
      const s = states.get(sessionId);
      return !!s && Date.now() < s.cooldownUntil;
    },
    isMuted(sessionId) {
      const s = states.get(sessionId);
      return !!s && Date.now() < s.mutedUntil;
    },
    isRateLimited(sessionId) {
      const s = states.get(sessionId);
      if (!s) return false;
      if (cfg.rateLimitWindow <= 0 || cfg.rateLimitMaxReplies <= 0) return false;
      return rateLimitUsedNow(s, cfg) >= cfg.rateLimitMaxReplies;
    },
    setMuted(sessionId, durationSec, platform) {
      let s = states.get(sessionId);
      if (!s && platform && durationSec > 0) {
        s = getOrCreate(sessionId, platform);
      }
      if (!s) return;
      if (durationSec <= 0) {
        s.mutedUntil = 0;
        ctx.logger.info(`[flow] 已解除自禁言: session=${sessionId}`);
        return;
      }
      s.mutedUntil = Date.now() + durationSec * 1000;
      s.messageCount = 0;
      s.activityScore = 0;
      clearSessionIdle(s);
      ctx.logger.info(`[flow] 已设置自禁言: session=${sessionId}, ${durationSec}s`);
    },
    getThreshold(sessionId) {
      const s = states.get(sessionId);
      return s ? getCurrentThreshold(s, cfg) : cfg.activityScoreLower;
    },
    rescheduleIdle(sessionId, platform) {
      const s = states.get(sessionId);
      if (!s) return;
      scheduleSessionIdle(ctx, cfg, s, sessionId, platform, () => this.rescheduleIdle(sessionId, platform));
    },
  };

  ctx.provide('flow-control', service);

  ctx.logger.info(
    `[flow] 已启用 (固定间隔=${cfg.fixedInterval}, 阈值=${cfg.activityScoreLower}~${cfg.activityScoreUpper}, ` +
    `冷却=${cfg.cooldownSeconds}s, 限速=${cfg.rateLimitWindow}s/${cfg.rateLimitMaxReplies}次, ` +
    `idle=${cfg.idleTriggerScope}/${cfg.idleTriggerStrategy}, 平台范围=${cfg.platforms.length === 0 ? '全部' : cfg.platforms.join(',')})`,
  );

  // ===== gateway:inbound 中间件：流控前置闸门 =====
  // priority=900 → 在 commands(1000) 之后、trigger-policy(700) 之前。
  // 设计取舍：流控只对群会话（sessionType=='group'）生效；
  // 私聊 / 频道 / CLI / WebUI 直接放行 —— 与历史 OneBot ChatFlow 行为一致，
  // 避免一对一直接对话被冷却 / 限速误伤。
  ctx.middleware('gateway:inbound', async (data, next) => {
    const { message } = data;
    if (!isPlatformEnabled(cfg, message.platform)) return next();
    if (message.source === 'idle-trigger') return next(); // 内部注入不再过流控
    if (message.sessionType !== 'group') return next();   // 非群会话跳过流控

    service.ensureState(message.sessionId, message.platform);
    service.recordIncoming(message.sessionId, message.platform, message.userId);

    const s = states.get(message.sessionId)!;

    if (service.isMuted(message.sessionId)) {
      // 禁言期不重置 idle timer：避免在禁言结束后被立即唤醒重复触发。
      logStatus(message.sessionId, s, '禁言中 → 吞噬');
      await shadowArchive(message);
      return; // swallow
    }
    if (service.isCoolingDown(message.sessionId)) {
      logStatus(message.sessionId, s, '冷却中 → 吞噬');
      await shadowArchive(message);
      service.rescheduleIdle(message.sessionId, message.platform);
      return; // swallow
    }
    if (service.isRateLimited(message.sessionId)) {
      logStatus(message.sessionId, s, '限速 → 吞噬');
      await shadowArchive(message);
      service.rescheduleIdle(message.sessionId, message.platform);
      return; // swallow
    }
    // 通过流控前置闸门：交给下一中间件（trigger-policy / agent）
    await next();
  }, 900);

  // 出站消息后记录冷却 / 重置退避（同样仅对群会话计入流控）
  ctx.on('outbound:message', (msg: OutgoingMessage) => {
    if (!msg.sessionId) return;
    if (msg.source !== 'agent') return; // 命令/系统回复不算"对话回复"
    const s = states.get(msg.sessionId);
    if (!s) return; // 没有 state 说明该 session 从未走过群流控（私聊/CLI 等），跳过
    service.recordReply(msg.sessionId, s.platform);
  });

  // 平台级 idle 启动
  ctx.on('ready', () => {
    platformIdle.start();
  });
  ctx.on('dispose', () => {
    platformIdle.stop();
    for (const s of states.values()) clearSessionIdle(s);
    states.clear();
  });
}

// 重新导出配置类型，方便其他插件使用
export type { FlowControlConfig };
