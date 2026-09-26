import { flowControl } from '@aalis/api-flow-control';
import { extractTargetId, gateway, INBOUND_PHASE, isScopeEnabled, resolveEffectiveConfig } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { media } from '@aalis/api-media';
import { messageArchive } from '@aalis/api-message-archive';
import { persona } from '@aalis/api-persona';
import { type TriggerDecision, type TriggerProvider, trigger } from '@aalis/api-trigger';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import {
  type IncomingMessage,
  type OutgoingMessage,
  selfInitiatedActor,
  WellKnownNoticeTypes,
} from '@aalis/schema-message';
import { defaultTriggerPolicyConfig, resolveTriggerPolicyConfig, type TriggerPolicyConfig } from './config.js';
import { type AttachmentRecognition, askProvider, createAttachmentRecognition } from './consult.js';
import { checkImmediateTrigger, checkMuteKeyword } from './detector.js';
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
    description:
      '@ 自己算"被点名"（戳一戳、名字同理）：规则判定据此直接开口；点名的回合记为 immediate，点名者即授权主体。判定模型在位时只决定类别与授权主体，不决定开不开口。',
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
  decisionTimeoutMs: {
    type: 'number',
    label: '判定截止时间（毫秒）',
    default: defaultTriggerPolicyConfig.decisionTimeoutMs,
    description: '每个触发提供者的判定上限，超时按弃权处理，转问下一个提供者。提供者等附件识别的时间不计入。',
  },
  mediaWaitMs: {
    type: 'number',
    label: '附件识别等待上限（毫秒）',
    default: defaultTriggerPolicyConfig.mediaWaitMs,
    description: '提供者要看附件描述时，等识别的上限；超时照常判定，识别在后台继续。规则判定不看附件，不受影响。',
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
   * trigger 由本插件自己提供（规则提供者），只能声明成 optional：写 required 会把激活闸架在
   * 自己的产出上。宿主经它按序问全部提供者。
   */
  trigger: optional(trigger),
  // 缺席时不设禁言：关键词照样吞掉本条，但不会写入禁言期
  flowControl: optional(flowControl),
  persona: optional(persona),
  // 缺席时被吞掉的消息不进档，判定照常
  messageArchive: optional(messageArchive),
  // 提供者要附件描述时宿主经它识别；缺席时直接返回，描述缺失
  media: optional(media),
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
  const idleCaps: IdleCaps = { logger, events, gateway: caps.gateway, flowControl };
  const platformIdle = new PlatformIdleScheduler(idleCaps, cfg, states);

  /** 把"被策略吞掉"的入站消息归档（与 flow-control 的 shadow 归档对齐） */
  async function shadowArchive(message: IncomingMessage): Promise<void> {
    const archive = messageArchive.current;
    if (!archive) return;
    try {
      await archive.archiveIncoming(message);
    } catch (err) {
      logger.warn(`[trigger] shadow 归档失败: ${err}`);
    }
  }

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

  /** 规则提供者：点名直接开口，否则按计数与评分判定。只读会话状态（宿主调用前已记好这条入站） */
  const ruleProvider: TriggerProvider = {
    async decide({ message, addressed }) {
      if (addressed) return { speak: true, reason: '点名' };
      const s = states.get(message.sessionId);
      if (!s) return null; // 宿主之外的调用：没有会话状态可判
      const e = resolveEffectiveConfig(cfg, message.platform, message.sessionType, extractTargetId(message));
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
      const reason =
        `计数=${s.messageCount}/${e.fixedInterval} 指数=${s.activityScore.toFixed(3)}` +
        ` (阈值=${threshold.toFixed(3)})`;
      return { speak, reason };
    },
  };
  provide(trigger, ruleProvider, { label: '规则（计数/评分）' });

  /** 按 trigger.all() 的顺序（偏好 > 优先级 > 注册顺序）逐个问，第一个不弃权的说了算 */
  async function consult(
    message: IncomingMessage,
    addressed: boolean,
    attachments: AttachmentRecognition,
  ): Promise<{ decision?: TriggerDecision; decider?: string; abstained: string[] }> {
    const abstained: string[] = [];
    for (const view of caps.trigger.all()) {
      const label = view.label ?? view.contextId;
      const answer = await askProvider(view.instance, { message, addressed }, attachments, cfg.decisionTimeoutMs);
      if (answer.decision) return { decision: answer.decision, decider: label, abstained };
      if (answer.abstain === '出错') logger.warn(`[trigger] 提供者 ${label} 判定出错，按弃权处理: ${answer.error}`);
      abstained.push(`${label}(${answer.abstain})`);
    }
    return { abstained };
  }

  logger.info(
    `[trigger] 已启用 (模式=${cfg.intervalMode}, 固定间隔=${cfg.fixedInterval}, ` +
      `阈值=${cfg.activityScoreLower}~${cfg.activityScoreUpper}, @提及=${cfg.triggerOnAt}, ` +
      `别名=${cfg.triggerNames.length}, mute关键词=${cfg.muteKeywords.length}, mute时长=${cfg.muteTimeSeconds}s, ` +
      `idle=${cfg.idleTriggerScope}/${cfg.idleTriggerStrategy}, scopes=${cfg.scopes.join('|') || '<空>'}, ` +
      `overrides=${cfg.overrides.length})`,
  );

  // ===== inbound:trigger 相位：要不要开口 =====
  // 由 plugin-gateway 在 inbound:command 之后、inbound:flow 之前触发。本插件是相位宿主：作用域、禁言、
  // 禁言关键词、记入站、点名识别、开口后的清零与 triggerType 都在这里；"要不要开口"逐个问 trigger
  // 服务的提供者（本插件自带的规则提供者兜底）。放行的消息写好 triggerType，交给 flow 相位做节流硬闸
  //（immediate 穿透冷却与限速）。
  hooks.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
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
    const isPoke = message.noticeType === WellKnownNoticeTypes.Poke;

    // 禁言关键词：设置自禁言、计数与评分当场清零，吞掉本条。poke 的 content 是合成文案，与名字检测一样不当发言评估。
    if (!isPoke && checkMuteKeyword(e, message.content)) {
      logger.info(`[trigger] mute 关键词命中 → swallow + setMuted(${e.muteTimeSeconds}s): ${sessionId}`);
      flow?.setMuted(sessionId, e.muteTimeSeconds, message.platform);
      resetCounters(states.get(sessionId));
      await shadowArchive(message);
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

    // 被点名：注意力动作（well-known noticeType=poke）默认视同 @：能进到这里说明 adapter 已经判断过
    // 目标是 bot（私聊戳全转 inbound / 群聊戳仅 target=self 才转）。triggerOnPoke 关闭时**跳过 @/名字检测**：
    // poke 的 content 是合成文案（内嵌戳者昵称），昵称含 bot 名会被名字检测误判成提及——
    // 用户改个名就能让开关对自己失效（对抗审计实测），元数据不当发言评估。
    let addressed: boolean;
    try {
      addressed = isPoke ? e.triggerOnPoke : checkImmediateTrigger(persona, e, message.content);
    } catch (err) {
      // 名字检测会调外部 persona 提供者；抛错时放行而不是吞掉——失败放行优于失败静默
      logger.warn(`[trigger] 点名识别异常，默认放行: ${err}`);
      await next();
      return;
    }

    const attachments = createAttachmentRecognition(message, caps.media, cfg.mediaWaitMs, logger);
    const started = Date.now();
    const verdict = await consult(message, addressed, attachments);
    // 全部弃权（规则提供者只在没有会话状态时弃权，正常不会走到）：与判定异常同一原则，失败放行
    const decision = verdict.decision ?? { speak: true, reason: '全部弃权，默认放行' };
    if (!verdict.decision) logger.warn(`[trigger] 触发提供者全部弃权，默认放行: session=${sessionId}`);
    // 判定日志：不含消息正文
    logger.debug(
      `[trigger] 判定 | session=${sessionId} | 决定者=${verdict.decider ?? '无'} | speak=${decision.speak} | ` +
        `addressed=${addressed} | reason=${decision.reason}` +
        `${decision.score === undefined ? '' : ` | score=${decision.score}`} | 耗时=${Date.now() - started}ms` +
        `${verdict.abstained.length > 0 ? ` | 弃权=${verdict.abstained.join(',')}` : ''}`,
    );

    // 放行与吞掉都不等判定期间启动的附件识别：agent 预处理器与归档对同一个消息对象调
    // processMessage，按对象记忆命中这次识别（在途则等它），不再识别第二遍
    if (!decision.speak) {
      await shadowArchive(message);
      return; // swallow
    }

    // 判定放行即复位（无论哪个提供者开口）：之后若被 flow 相位的冷却/限速吞掉，这次触发作废
    resetCounters(s);
    s.lastTriggerTime = Date.now();
    const kind = addressed ? 'immediate' : 'interval';
    message.triggerType = kind;
    // interval 回合无主发言者：授权身份回填为无主体，不让「恰好撞阈值的那个人」
    //（陌生人或 owner）的等级决定 AI 自发行为能调什么工具。immediate 是被点名，
    // 点名者就是主体，维持缺省（actor 回退到会话身份）。只对多人会话：scope 可配成
    // 把私聊纳入，私聊里的 interval 只是频率闸，发言者就是唯一主体，不存在歧义。
    if (kind === 'interval' && message.sessionType !== 'private' && !message.actor) {
      message.actor = selfInitiatedActor(message.platform);
    }
    await next();
  });

  // agent 真实回复：记为 bot 开口并重排 session 档 idle。不复位退避——bot 回复闲置提示不算真人活动。
  events.on('outbound:message', (msg: OutgoingMessage) => {
    if (msg.source !== 'agent' || !msg.sessionId) return;
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

  // 不清空 states：重载时在途的判定仍在旧状态上收尾（清空会让规则提供者读不到状态而弃权，
  // 在途消息落入「全部弃权、默认放行」）；表随这次激活的闭包一起回收
  lifecycle.onDispose(() => {
    clearInterval(sweepTimer);
    platformIdle.stop();
    for (const s of states.values()) clearSessionIdle(s);
  });
}

export type { TriggerPolicyConfig };
