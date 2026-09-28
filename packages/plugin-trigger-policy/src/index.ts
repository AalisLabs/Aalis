import { flowControl } from '@aalis/api-flow-control';
import { extractTargetId, gateway, INBOUND_PHASE, isScopeEnabled, resolveEffectiveConfig } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { messageArchive } from '@aalis/api-message-archive';
import { persona } from '@aalis/api-persona';
import { sessionManager } from '@aalis/api-session-manager';
import {
  archiveSwallowed,
  createBotNames,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  trigger,
} from '@aalis/api-trigger';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import type { OutgoingMessage } from '@aalis/schema-message';
import { configSchema, normalizeConfig, type TriggerPolicyConfig } from './config.js';
import { clearSessionIdle, type IdleCaps, PlatformIdleScheduler, scheduleSessionIdle } from './idle-scheduler.js';
import {
  applyScoreDecay,
  calculateScoreIncrement,
  createState,
  getCurrentThreshold,
  sweepStaleStates,
  type TriggerSessionState,
} from './state.js';

// ----- 元数据 -----

// ----- 入口 -----

const uses = {
  logger,
  events,
  hooks,
  lifecycle,
  config,
  provide,
  gateway,
  /**
   * trigger 由本插件自己提供，只能声明成 optional：写 required 会把激活闸架在自己的产出上。
   * 经它判断本插件是不是生效的触发插件（服务胜者）。
   */
  trigger: optional(trigger),
  // 缺席时不设禁言：关键词照样吞掉本条，但不会写入禁言期
  flowControl: optional(flowControl),
  persona: optional(persona),
  // 名字表按会话取人设：解析会话配置里的角色卡；缺席时取全局默认的卡
  sessionManager: optional(sessionManager),
  // 缺席时被吞掉的消息不进档，判定照常
  messageArchive: optional(messageArchive),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-trigger-policy',
  displayName: '触发策略',
  subsystem: 'scheduler',
  configSchema,
  provides: [trigger],
  uses,
  apply: run,
});

function run(caps: Caps): void {
  const { logger, events, hooks, lifecycle, provide, flowControl, messageArchive } = caps;
  const cfg = normalizeConfig(parseConfig(configSchema, caps.config, logger), logger);
  const states = new Map<string, TriggerSessionState>();
  /** 名字表：别名与全部人设按会话取的名字、昵称；某个人设读名字出错只跳过它的名字 */
  const botNames = createBotNames(caps.persona, caps.sessionManager, logger, '[trigger]');

  // 本插件在 trigger 服务里的实例：服务胜者是它时本插件生效，否则对每条消息直接放行、闲置也不开口
  const self: TriggerService = { label: '规则（计数/评分）' };
  provide(trigger, self, { label: self.label });
  const isActive = (): boolean => caps.trigger.current === self;

  const idleCaps: IdleCaps = { logger, gateway: caps.gateway, flowControl, isActive };
  const platformIdle = new PlatformIdleScheduler(idleCaps, cfg, states);

  /** 计数与活跃指数清零（禁言与判定放行时） */
  function resetCounters(s: TriggerSessionState): void {
    s.messageCount = 0;
    s.activityScore = 0;
  }

  /** 按会话重排 session 档 idle（非 session 档时只清定时器） */
  function rescheduleIdle(sessionId: string): void {
    const s = states.get(sessionId);
    if (!s) return;
    const e = resolveEffectiveConfig(cfg, s.platform, s.sessionType, s.targetId);
    scheduleSessionIdle(idleCaps, e, s, sessionId, () => rescheduleIdle(sessionId));
  }

  /** 记一条真人入站的计数：评分衰减、计数、评分增量、用户交互。衰减按上一条消息的时间算，须在 recordActivity 之前调用 */
  function recordIncoming(s: TriggerSessionState, e: TriggerPolicyConfig, userId: string | undefined): void {
    applyScoreDecay(s, e);
    if (userId) s.userInteractions.set(userId, (s.userInteractions.get(userId) ?? 0) + 1);
    s.messageCount++;
    s.activityScore += calculateScoreIncrement(s, e, userId);
  }

  /**
   * 记一次真人活动：最近消息时间、闲置退避复位为 1，并从现在起重排 session 档 idle。
   * 作用域内的真人消息都算，禁言期内与命中禁言关键词的也算（它们只是不计数）
   */
  function recordActivity(sessionId: string, s: TriggerSessionState): void {
    s.lastMessageTime = Date.now();
    s.idleBackoff = 1;
    rescheduleIdle(sessionId);
  }

  /** 要不要开口：点名直接开口，否则按会话此刻的计数与评分判定 */
  function decide(
    s: TriggerSessionState,
    e: TriggerPolicyConfig,
    addressed: boolean,
  ): { speak: boolean; reason: string } {
    if (addressed) return { speak: true, reason: '点名' };
    const threshold = getCurrentThreshold(s, e);
    const fixedOk = s.messageCount >= e.fixedInterval;
    const dynamicOk = s.activityScore >= threshold;
    let speak = false;
    switch (e.intervalMode) {
      case 'fixed':
        speak = fixedOk;
        break;
      case 'dynamic':
        speak = dynamicOk;
        break;
      case 'both':
        speak = fixedOk || dynamicOk;
        break;
    }
    // 让运维一眼看到"还差多少条/多少分会触发"
    const reason = `计数=${s.messageCount}/${e.fixedInterval} 指数=${s.activityScore.toFixed(3)} (阈值=${threshold.toFixed(3)})`;
    return { speak, reason };
  }

  logger.info(
    `[trigger] 已启用 (模式=${cfg.intervalMode}, 固定间隔=${cfg.fixedInterval}, ` +
      `阈值=${cfg.activityScoreLower}~${cfg.activityScoreUpper}, @提及=${cfg.triggerOnAt}, ` +
      `别名=${cfg.triggerNames.length}, mute关键词=${cfg.muteKeywords.length}, mute时长=${cfg.muteTimeSeconds}s, ` +
      `idle=${cfg.idleTriggerScope}/${cfg.idleTriggerStrategy}, scopes=${cfg.scopes.join('|') || '<空>'}, ` +
      `overrides=${cfg.overrides.length})`,
  );

  // ===== inbound:trigger 相位：要不要开口 =====
  // 由 plugin-gateway 在 inbound:command 之后、inbound:flow 之前触发。放行的消息写好 triggerType，
  // 交给 flow 相位做节流硬闸（immediate 穿透冷却与限速）。判定是同步的：记入站、判定、清零在同一拍做完，
  // 同一会话接连到达的消息按到达顺序逐条判定，放行顺序即到达顺序。
  hooks.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
    // 不是生效的触发插件：什么都不做（不计数、不识别、不归档），交给生效者或往下走
    if (!isActiveTrigger(data, caps.trigger, self)) return next();
    const { message } = data;
    // 内部注入（闲置触发、定时任务、workflow）都带 source，跳过策略：不计数、不改 triggerType。
    // 真人消息由平台适配器投递，不设 source。
    if (message.source) return next();

    // 不在触发策略作用域内（默认 *:group）：直接放行。
    // 必须在 mute 检查之前进行，否则 QQ 群的 mute 关键词会泄漏到 WebUI/私聊等不在 scope 内的会话。
    const tid = extractTargetId(message);
    if (!isScopeEnabled(cfg, message.platform, message.sessionType, tid)) return next();

    const sessionId = message.sessionId;
    const flow = flowControl.current;
    // 作用域内的真人消息都是会话活动，禁言期内的也是：会话还没有状态（如平台禁言先于任何消息）就在这里建
    let s = states.get(sessionId);
    if (!s) {
      s = createState(message.platform, message.sessionType, tid);
      states.set(sessionId, s);
    }

    // 禁言期：不累计计数，已攒的计数与评分清零（平台禁言只能在这里清：禁言期来消息时）；
    // 也不再识别禁言关键词，避免缩短平台禁言。仍记为真人活动，放行给 flow 相位吞掉并归档。
    if (flow?.isMuted(sessionId)) {
      resetCounters(s);
      recordActivity(sessionId, s);
      return next();
    }

    const e = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);

    // 禁言关键词：设置自禁言、计数与评分当场清零，记为真人活动，吞掉本条
    if (hitsMuteKeyword(message, e.muteKeywords)) {
      logger.info(`[trigger] mute 关键词命中 → swallow + setMuted(${e.muteTimeSeconds}s): ${sessionId}`);
      flow?.setMuted(sessionId, e.muteTimeSeconds, message.platform);
      resetCounters(s);
      recordActivity(sessionId, s);
      await archiveSwallowed(message, messageArchive, logger, '[trigger]');
      return; // swallow
    }

    recordIncoming(s, e, message.userId);
    recordActivity(sessionId, s);

    const addressed = isAddressed(message, botNames(e.triggerNames, message), e);
    const decision = decide(s, e, addressed);
    // 判定日志：不含消息正文
    logger.debug(
      `[trigger] 判定 | session=${sessionId} | speak=${decision.speak} | addressed=${addressed} | reason=${decision.reason}`,
    );
    if (!decision.speak) {
      await archiveSwallowed(message, messageArchive, logger, '[trigger]');
      return; // swallow
    }

    // 判定放行即复位：之后若被 flow 相位的冷却/限速吞掉，这次触发作废
    resetCounters(s);
    s.lastTriggerTime = Date.now();
    markTriggered(message, addressed);
    await next();
  });

  // agent 真实回复：记为 bot 开口并重排 session 档 idle。不复位退避——bot 回复闲置提示不算真人活动。
  // 不生效时不记（闲置也不开口）
  events.on('outbound:message', (msg: OutgoingMessage) => {
    if (msg.source !== 'agent' || !msg.sessionId || !isActive()) return;
    const s = states.get(msg.sessionId);
    if (!s) return;
    s.lastBotActivityAt = Date.now();
    rescheduleIdle(msg.sessionId);
  });

  // 平台级 idle 启动
  events.on('app:ready', () => {
    platformIdle.start();
  });

  // 长寿进程下避免 states 无限增长：每天扫描一次，清理 30 天无活动且无 idle 定时器的会话
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    const cleaned = sweepStaleStates(states, Date.now());
    if (cleaned > 0) logger.debug(`[trigger] TTL 清理已淘汰 ${cleaned} 个长期非活跃会话状态`);
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  lifecycle.onDispose(() => {
    clearInterval(sweepTimer);
    platformIdle.stop();
    for (const s of states.values()) clearSessionIdle(s);
    // 清表：session 档闲置注入要等整个 agent 回合，停用时可能还在途；回来时 rescheduleIdle 取不到状态，
    // 不再排定时器（判定是同步的，入站中间件在 await 之后不再读写状态表）
    states.clear();
  });
}

export type { TriggerPolicyConfig };
