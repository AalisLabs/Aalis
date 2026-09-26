import { flowControl } from '@aalis/api-flow-control';
import { extractTargetId, gateway, INBOUND_PHASE, isScopeEnabled, resolveEffectiveConfig } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { messageArchive } from '@aalis/api-message-archive';
import { persona } from '@aalis/api-persona';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import {
  type IncomingMessage,
  type OutgoingMessage,
  selfInitiatedActor,
  WellKnownNoticeTypes,
} from '@aalis/schema-message';
import { defaultTriggerPolicyConfig, resolveTriggerPolicyConfig, type TriggerPolicyConfig } from './config.js';
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
    description: '格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认 *:group。',
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
  triggerOnAt: { type: 'boolean', label: '检测 @ 提及', default: defaultTriggerPolicyConfig.triggerOnAt },
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
  gateway,
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
  uses,
  apply: run,
});

type TriggerKind = 'immediate' | 'interval' | 'swallow';

function run(caps: Caps): void {
  const { logger, events, hooks, lifecycle, persona, flowControl, messageArchive } = caps;
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

  function getOrCreate(
    sessionId: string,
    platform: string,
    sessionType: string,
    targetId: string,
  ): TriggerSessionState {
    let s = states.get(sessionId);
    if (!s) {
      s = createState(platform, sessionType, targetId);
      states.set(sessionId, s);
    }
    return s;
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
    const now = Date.now();
    applyScoreDecay(s, e);
    if (userId) {
      const prev = s.userInteractions.get(userId) ?? { count: 0, lastTime: 0 };
      s.userInteractions.set(userId, { count: prev.count + 1, lastTime: now });
    }
    s.lastMessageTime = now;
    s.messageCount++;
    s.activityScore += calculateScoreIncrement(s, e, userId);
  }

  /** 要不要开口：poke / @ / 名字直通为 immediate，否则按计数与评分判定 interval 或 swallow */
  function decide(
    message: IncomingMessage,
    e: TriggerPolicyConfig,
    s: TriggerSessionState,
    isPoke: boolean,
  ): TriggerKind {
    // 注意力动作（well-known noticeType=poke）默认视同 @ 直触发：能进到这里说明
    // adapter 已经判断过目标是 bot（私聊戳全转 inbound / 群聊戳仅 target=self 才转）。
    // triggerOnPoke 关闭时落回下方意愿评估，且**跳过 @/名字检测**：poke 的 content
    // 是合成文案（内嵌戳者昵称），昵称含 bot 名会被名字检测误判成提及——
    // 用户改个名就能让开关对自己失效（对抗审计实测），元数据不当发言评估。
    if (isPoke) {
      if (e.triggerOnPoke) return 'immediate';
    } else if (checkImmediateTrigger(persona, e, message.content)) {
      return 'immediate';
    }
    const fixedOk = s.messageCount >= e.fixedInterval;
    const dynamicOk = s.activityScore >= getCurrentThreshold(s, e);
    let trigger = false;
    switch (e.intervalMode) {
      case 'fixed':
        trigger = fixedOk;
        break;
      case 'dynamic':
        trigger = dynamicOk;
        break;
      case 'both':
        trigger = fixedOk || dynamicOk;
        break;
    }
    return trigger ? 'interval' : 'swallow';
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
  // 交给 flow 相位做节流硬闸（immediate 穿透冷却与限速）。
  hooks.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
    const { message } = data;
    if (message.source === 'idle-trigger') return next(); // 内部注入跳过策略

    // 不在触发策略作用域内（默认 *:group）：直接放行。
    // 必须在 mute 检查之前进行，否则 QQ 群的 mute 关键词会泄漏到 WebUI/私聊等不在 scope 内的会话。
    const tid = extractTargetId(message);
    if (!isScopeEnabled(cfg, message.platform, message.sessionType, tid)) return next();

    const sessionId = message.sessionId;
    const flow = flowControl.current;

    // 禁言期：不累计计数，已攒的计数与评分清零（关键词与平台禁言两种来源都在这里覆盖）；
    // 也不再识别禁言关键词，避免缩短平台禁言。放行给 flow 相位吞掉并归档。
    if (flow?.isMuted(sessionId)) {
      const s = states.get(sessionId);
      if (s) {
        s.messageCount = 0;
        s.activityScore = 0;
      }
      return next();
    }

    const e = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);
    const isPoke = message.noticeType === WellKnownNoticeTypes.Poke;

    // 禁言关键词：设置自禁言并吞掉。poke 的 content 是合成文案，与名字检测一样不当发言评估。
    if (!isPoke && checkMuteKeyword(e, message.content)) {
      logger.info(`[trigger] mute 关键词命中 → swallow + setMuted(${e.muteTimeSeconds}s): ${sessionId}`);
      flow?.setMuted(sessionId, e.muteTimeSeconds, message.platform);
      await shadowArchive(message);
      return; // swallow
    }

    const s = getOrCreate(sessionId, message.platform, message.sessionType ?? '', tid);
    recordIncoming(s, e, message.userId);
    // 真人活动：闲置退避复位，并从现在起重排 session 档 idle
    s.idleBackoff = 1;
    rescheduleIdle(sessionId);

    let kind: TriggerKind;
    try {
      kind = decide(message, e, s, isPoke);
    } catch (err) {
      // 名字检测会调外部 persona 提供者；判定抛错时放行而不是吞掉——失败放行优于失败静默
      logger.warn(`[trigger] 判定异常，默认放行: ${err}`);
      await next();
      return;
    }
    // 统一状态日志：让运维一眼看到"还差多少条/多少分会触发"
    const stateStr =
      `计数=${s.messageCount}/${e.fixedInterval} | ` +
      `指数=${s.activityScore.toFixed(3)} (阈值=${getCurrentThreshold(s, e).toFixed(3)})`;

    if (kind === 'swallow') {
      logger.debug(`[trigger] 未触发 → 吞噬 | session=${sessionId} | ${stateStr}`);
      await shadowArchive(message);
      return; // swallow
    }

    logger.debug(`[trigger] ${kind} → 触发 | session=${sessionId} | ${stateStr}`);
    // 判定放行即复位：之后若被 flow 相位的冷却/限速吞掉，这次触发作废
    s.messageCount = 0;
    s.activityScore = 0;
    s.lastTriggerTime = Date.now();
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

  lifecycle.onDispose(() => {
    clearInterval(sweepTimer);
    platformIdle.stop();
    for (const s of states.values()) clearSessionIdle(s);
    states.clear();
  });
}

export type { TriggerPolicyConfig };
