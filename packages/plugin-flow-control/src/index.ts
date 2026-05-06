import type {
  Context,
  ConfigSchema,
  FlowControlService,
  FlowSessionStateSnapshot,
  MessageArchiveService,
  OutgoingMessage,
} from '@aalis/core';
import { INBOUND_PHASE } from '@aalis/core';
import {
  type FlowControlConfig,
  defaultFlowControlConfig,
  isScopeEnabled,
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
  required: ['gateway'],
  optional: ['message-archive'],
};

export const configSchema: ConfigSchema = {
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: defaultFlowControlConfig.scopes,
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description: '格式 platform:sessionType，支持通配 *；onebot:group / onebot:* / *:group / *。默认 *:group 与历史 OneBot 行为一致。',
  },
  fixedInterval: { type: 'number', label: '固定间隔（每 N 条触发）', default: defaultFlowControlConfig.fixedInterval },
  activityScoreLower: { type: 'number', label: '活跃指数下限', default: defaultFlowControlConfig.activityScoreLower },
  activityScoreUpper: { type: 'number', label: '活跃指数上限', default: defaultFlowControlConfig.activityScoreUpper },
  activityDecayMinutes: { type: 'number', label: '阈值衰减分钟', default: defaultFlowControlConfig.activityDecayMinutes },
  scoreDecayMinutes: { type: 'number', label: '评分衰减分钟（0=不衰减）', default: defaultFlowControlConfig.scoreDecayMinutes },
  cooldownSeconds: { type: 'number', label: '回复后冷却（秒）', default: defaultFlowControlConfig.cooldownSeconds },
  muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）', default: defaultFlowControlConfig.muteTimeSeconds },
  rateLimitWindow: { type: 'number', label: '限速窗口（秒，0=关闭）', default: defaultFlowControlConfig.rateLimitWindow },
  rateLimitMaxReplies: { type: 'number', label: '窗口内最大回复数', default: defaultFlowControlConfig.rateLimitMaxReplies },
  idleTriggerScope: {
    type: 'select', label: '闲置触发范围', default: defaultFlowControlConfig.idleTriggerScope,
    options: [
      { label: 'off (关闭)', value: 'off' },
      { label: 'session (每会话独立定时)', value: 'session' },
      { label: 'platform (跨会话选举)', value: 'platform' },
    ],
  },
  idleTriggerStrategy: {
    type: 'select', label: '闲置触发策略', default: defaultFlowControlConfig.idleTriggerStrategy,
    options: [
      { label: 'all-quiet (所有会话都静默时)', value: 'all-quiet' },
      { label: 'fixed (固定间隔)', value: 'fixed' },
    ],
  },
  idleTriggerMinutes: { type: 'number', label: '闲置触发分钟', default: defaultFlowControlConfig.idleTriggerMinutes },
  idleTriggerStyle: {
    type: 'select', label: '闲置触发风格', default: defaultFlowControlConfig.idleTriggerStyle,
    options: [
      { label: 'exponential (指数退避)', value: 'exponential' },
      { label: 'fixed (固定)', value: 'fixed' },
    ],
  },
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
    `idle=${cfg.idleTriggerScope}/${cfg.idleTriggerStrategy}, scopes=${cfg.scopes.join('|') || '<空>'})`,
  );

  // ===== inbound:flow 相位：流控前置闸门 =====
  // 由 plugin-gateway 在 inbound:command 之后、inbound:trigger 之前触发。
  // 设计取舍：流控默认只对群会话（sessionTypes=['group']）生效，
  // 与历史 OneBot ChatFlow 行为一致；可通过配置扩展到 channel/guild 等。
  ctx.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
    const { message } = data;
    if (!isScopeEnabled(cfg, message.platform, message.sessionType)) return next();
    if (message.source === 'idle-trigger') return next(); // 内部注入不再过流控

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
    // 通过流控前置闸门：交给下一相位（inbound:trigger → inbound:dispatch）
    await next();
  });

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

  // 长寿进程下避免 states 无限增长：每天扫描一次，清理 30 天未活动且无禁言/冷却挂起的会话
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sid, s] of states) {
      const lastActive = Math.max(s.lastMessageTime, s.lastReplyTime);
      const hasPending = s.mutedUntil > now || s.cooldownUntil > now || !!s.idleTimer;
      if (!hasPending && lastActive > 0 && now - lastActive > SESSION_TTL_MS) {
        clearSessionIdle(s);
        states.delete(sid);
        cleaned++;
      }
    }
    if (cleaned > 0) ctx.logger.debug(`[flow] TTL 清理已淘汰 ${cleaned} 个长期非活跃会话状态`);
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  ctx.on('dispose', () => {
    clearInterval(sweepTimer);
    platformIdle.stop();
    for (const s of states.values()) clearSessionIdle(s);
    states.clear();
  });
}

// 重新导出配置类型，方便其他插件使用
export type { FlowControlConfig };
