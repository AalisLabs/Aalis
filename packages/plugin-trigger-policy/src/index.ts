import { flowControl } from '@aalis/api-flow-control';
import { extractTargetId, gateway, INBOUND_PHASE, isScopeEnabled, resolveEffectiveConfig } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { messageArchive } from '@aalis/api-message-archive';
import { persona } from '@aalis/api-persona';
import {
  archiveSwallowed,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  trigger,
} from '@aalis/api-trigger';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type { OutgoingMessage } from '@aalis/schema-message';
import { defaultTriggerPolicyConfig, resolveTriggerPolicyConfig, type TriggerPolicyConfig } from './config.js';
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

const configSchema: ConfigSchema = {
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: defaultTriggerPolicyConfig.scopes,
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description:
      '格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认 *:group；默认作用域不含 WebUI/CLI，如需纳入，在这里显式添加。',
  },
  intervalMode: {
    type: 'select',
    label: '间隔模式',
    default: defaultTriggerPolicyConfig.intervalMode,
    options: [
      { label: 'fixed (仅按计数)', value: 'fixed' },
      { label: 'dynamic (仅按评分阈值)', value: 'dynamic' },
      { label: 'both (任一满足)', value: 'both' },
    ],
  },
  triggerOnAt: {
    type: 'boolean',
    label: '检测 @ 提及',
    default: defaultTriggerPolicyConfig.triggerOnAt,
    description: '@ 自己算"被点名"（戳一戳、名字同理）：点名直接开口，回合记为 immediate，点名者即授权主体。',
  },
  triggerOnPoke: {
    type: 'boolean',
    label: '戳一戳直触发',
    default: defaultTriggerPolicyConfig.triggerOnPoke,
    description: '戳一戳等注意力动作视同 @ 即时触发；关闭后此类动作落回正常意愿评估，不强制回复。',
  },
  triggerNames: { type: 'string', label: '触发名别名（逗号分隔）', default: '' },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号分隔）', default: '' },
  muteTimeSeconds: {
    type: 'number',
    label: '禁言关键词命中时长（秒）',
    default: defaultTriggerPolicyConfig.muteTimeSeconds,
  },
  fixedInterval: {
    type: 'number',
    label: '固定间隔（每 N 条触发）',
    default: defaultTriggerPolicyConfig.fixedInterval,
  },
  activityScoreLower: { type: 'number', label: '活跃指数下限', default: defaultTriggerPolicyConfig.activityScoreLower },
  activityScoreUpper: { type: 'number', label: '活跃指数上限', default: defaultTriggerPolicyConfig.activityScoreUpper },
  activityDecayMinutes: {
    type: 'number',
    label: '阈值衰减分钟',
    default: defaultTriggerPolicyConfig.activityDecayMinutes,
  },
  scoreDecayMinutes: {
    type: 'number',
    label: '评分衰减分钟（0=不衰减）',
    default: defaultTriggerPolicyConfig.scoreDecayMinutes,
  },
  idleTriggerScope: {
    type: 'select',
    label: '闲置触发范围',
    default: defaultTriggerPolicyConfig.idleTriggerScope,
    options: [
      { label: 'off (关闭)', value: 'off' },
      { label: 'session (每会话独立定时)', value: 'session' },
      { label: 'platform (跨会话选举)', value: 'platform' },
    ],
  },
  idleTriggerStrategy: {
    type: 'select',
    label: '闲置触发策略',
    default: defaultTriggerPolicyConfig.idleTriggerStrategy,
    options: [
      { label: 'all-quiet (所有会话都静默时)', value: 'all-quiet' },
      { label: 'fixed (固定间隔)', value: 'fixed' },
    ],
  },
  idleTriggerMinutes: {
    type: 'number',
    label: '闲置触发分钟',
    default: defaultTriggerPolicyConfig.idleTriggerMinutes,
  },
  idleTriggerStyle: {
    type: 'select',
    label: '闲置触发风格',
    default: defaultTriggerPolicyConfig.idleTriggerStyle,
    options: [
      { label: 'exponential (指数退避)', value: 'exponential' },
      { label: 'fixed (固定)', value: 'fixed' },
    ],
  },
  idleTriggerMaxMinutes: {
    type: 'number',
    label: '闲置触发上限分钟',
    default: defaultTriggerPolicyConfig.idleTriggerMaxMinutes,
  },
  idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动', default: defaultTriggerPolicyConfig.idleTriggerJitter },
  idleTriggerPrompt: {
    type: 'string',
    label: '闲置触发系统提示',
    default: defaultTriggerPolicyConfig.idleTriggerPrompt,
  },
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。写一条 override 自动启用该 scope。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      intervalMode: {
        type: 'select',
        label: '间隔模式',
        options: [
          { label: 'fixed', value: 'fixed' },
          { label: 'dynamic', value: 'dynamic' },
          { label: 'both', value: 'both' },
        ],
      },
      triggerOnAt: { type: 'boolean', label: '检测 @ 提及' },
      triggerOnPoke: { type: 'boolean', label: '戳一戳直触发' },
      triggerNames: { type: 'string', label: '触发名别名（逗号分隔）' },
      muteKeywords: { type: 'string', label: '禁言关键词（逗号分隔）' },
      muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）' },
      fixedInterval: { type: 'number', label: '固定间隔（每 N 条触发）' },
      activityScoreLower: { type: 'number', label: '活跃指数下限' },
      activityScoreUpper: { type: 'number', label: '活跃指数上限' },
      activityDecayMinutes: { type: 'number', label: '阈值衰减分钟' },
      scoreDecayMinutes: { type: 'number', label: '评分衰减分钟' },
      idleTriggerScope: {
        type: 'select',
        label: '闲置触发范围',
        options: [
          { label: 'off', value: 'off' },
          { label: 'session', value: 'session' },
          { label: 'platform', value: 'platform' },
        ],
      },
      idleTriggerMinutes: { type: 'number', label: '闲置触发分钟' },
      idleTriggerMaxMinutes: { type: 'number', label: '闲置触发上限分钟' },
      idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动' },
      idleTriggerPrompt: { type: 'string', label: '闲置触发系统提示' },
    },
  },
};

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
  const { logger, events, hooks, lifecycle, provide, persona, flowControl, messageArchive } = caps;
  const cfg = resolveTriggerPolicyConfig(caps.config);
  const states = new Map<string, TriggerSessionState>();

  // 本插件在 trigger 服务里的实例：服务胜者是它时本插件生效，否则对每条消息直接放行、闲置也不开口
  const self: TriggerService = { label: '规则（计数/评分）' };
  provide(trigger, self, { label: self.label });
  const isActive = (): boolean => caps.trigger.current === self;

  const idleCaps: IdleCaps = { logger, events, gateway: caps.gateway, flowControl, isActive };
  const platformIdle = new PlatformIdleScheduler(idleCaps, cfg, states);

  /** 计数与活跃指数清零（禁言与判定放行时） */
  function resetCounters(s: TriggerSessionState | undefined): void {
    if (!s) return;
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

  /** 记一条真人入站：评分衰减、计数、评分增量、用户交互 */
  function recordIncoming(s: TriggerSessionState, e: TriggerPolicyConfig, userId: string | undefined): void {
    applyScoreDecay(s, e);
    if (userId) s.userInteractions.set(userId, (s.userInteractions.get(userId) ?? 0) + 1);
    s.lastMessageTime = Date.now();
    s.messageCount++;
    s.activityScore += calculateScoreIncrement(s, e, userId);
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
  // 同一会话接连到达的消息逐条按计数判定。
  hooks.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
    // 不是生效的触发插件：什么都不做（不计数、不识别、不归档），交给生效者或往下走
    if (!isActiveTrigger(data, caps.trigger, self)) return next();
    const { message } = data;
    // 内部注入（闲置触发、定时任务、workflow、跨会话委派）都带 source，跳过策略：不计数、不改 triggerType。
    // 真人消息由平台适配器投递，不设 source。
    if (message.source) return next();

    // 不在触发策略作用域内（默认 *:group）：直接放行。
    // 必须在 mute 检查之前进行，否则 QQ 群的 mute 关键词会泄漏到 WebUI/私聊等不在 scope 内的会话。
    const tid = extractTargetId(message);
    if (!isScopeEnabled(cfg, message.platform, message.sessionType, tid)) return next();

    const sessionId = message.sessionId;
    const flow = flowControl.current;

    // 禁言期：不累计计数，已攒的计数与评分清零（平台禁言只能在这里清：禁言期来消息时）；
    // 也不再识别禁言关键词，避免缩短平台禁言。放行给 flow 相位吞掉并归档。
    if (flow?.isMuted(sessionId)) {
      resetCounters(states.get(sessionId));
      return next();
    }

    const e = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);

    // 禁言关键词：设置自禁言、计数与评分当场清零，吞掉本条
    if (hitsMuteKeyword(message, e.muteKeywords)) {
      logger.info(`[trigger] mute 关键词命中 → swallow + setMuted(${e.muteTimeSeconds}s): ${sessionId}`);
      flow?.setMuted(sessionId, e.muteTimeSeconds, message.platform);
      resetCounters(states.get(sessionId));
      await archiveSwallowed(message, messageArchive, logger);
      return; // swallow
    }

    let s = states.get(sessionId);
    if (!s) {
      s = createState(message.platform, message.sessionType, tid);
      states.set(sessionId, s);
    }
    recordIncoming(s, e, message.userId);
    // 真人活动：闲置退避复位，并从现在起重排 session 档 idle
    s.idleBackoff = 1;
    rescheduleIdle(sessionId);

    let addressed: boolean;
    try {
      addressed = isAddressed(message, persona, e);
    } catch (err) {
      // 名字检测会调外部 persona 提供者；抛错时放行而不是吞掉——失败放行优于失败静默
      logger.warn(`[trigger] 点名识别异常，默认放行: ${err}`);
      await next();
      return;
    }

    const decision = decide(s, e, addressed);
    // 判定日志：不含消息正文
    logger.debug(
      `[trigger] 判定 | session=${sessionId} | speak=${decision.speak} | addressed=${addressed} | reason=${decision.reason}`,
    );
    if (!decision.speak) {
      await archiveSwallowed(message, messageArchive, logger);
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
  });
}

export type { TriggerPolicyConfig };
