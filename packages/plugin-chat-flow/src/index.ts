import type {
  Context,
  IncomingMessage,
  MemoryService,
  PersonaService,
  ConfigSchema,
  PluginModule,
} from '@aalis/core';
import type { Logger } from '@aalis/core';

// ────────────────── 配置类型 ──────────────────

/** 单个平台配置 profile（类似 onebot 适配器的"连接"） */
interface ChatFlowProfile {
  /** 作用于的平台列表，空数组 = 默认/兜底规则 */
  platforms: string[];  /** 作用于的会话类型，空数组 = 不限制（group / private / channel） */
  sessionTypes: string[];
  /** 间隔模式: fixed=固定条数, dynamic=动态评分, both=两者满足其一即触发 */
  intervalMode: 'fixed' | 'dynamic' | 'both';
  /** 固定间隔：每 N 条消息触发一次回复 */
  fixedInterval: number;

  /** 动态评分阈值 */
  activityScoreLower: number;
  activityScoreUpper: number;
  activityDecayMinutes: number;

  /** 是否在消息包含 @bot 时立刻触发 */
  triggerOnAt: boolean;
  /** 回复后冷却时间（秒） */
  cooldownSeconds: number;

  /** 打字延迟 */
  typingEnabled: boolean;
  typingDelayPerChar: number;
  typingMaxDelay: number;

  /** 空闲触发 */
  enableIdleTrigger: boolean;
  idleTriggerMinutes: number;
  idleTriggerStyle: 'exponential' | 'fixed';
  idleTriggerMaxMinutes: number;
  idleTriggerJitter: boolean;

  /** 禁言 */
  muteKeywords: string[];
  muteTimeSeconds: number;
}

/** 顶层配置（profiles + 全局设置） */
interface ChatFlowConfig {
  profiles: ChatFlowProfile[];
  /** 触发词（AI 的昵称等），全局共享，出现在消息中立刻触发 */
  triggerNames: string[];
}

// ────────────────── Session 状态 ──────────────────

interface SessionState {
  /** 自上次回复以来的消息计数 */
  messageCount: number;
  /** 上次 AI 回复的时间戳 */
  lastReplyTime: number;
  /** 上次收到消息的时间戳 */
  lastMessageTime: number;
  /** 当前动态活跃度分数 */
  activityScore: number;
  /** 冷却到期时间戳 */
  cooldownUntil: number;
  /** 禁言到期时间戳 */
  mutedUntil: number;
  /** 空闲触发定时器 */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 空闲触发退避倍数 */
  idleBackoff: number;
  /** 每个用户的交互统计 */
  userInteractions: Map<string, { count: number; lastTime: number }>;
  /** 该 session 消息来源的平台 */
  platform: string;
  /** 该 session 的会话类型 */
  sessionType?: string;
}

// ────────────────── 内部标识 ──────────────────

/** 空闲触发使用的特殊标识，允许绕过拦截 */
const IDLE_TRIGGER_MARKER = '__chat_flow_idle_trigger__';

// ────────────────── 工具函数 ──────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseStringList(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  if (typeof val === 'string' && val.trim()) {
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function resolveProfile(raw: Record<string, unknown>): ChatFlowProfile {
  return {
    platforms: parseStringList(raw.platforms),
    sessionTypes: parseStringList(raw.sessionTypes),
    intervalMode: (raw.intervalMode as ChatFlowProfile['intervalMode']) ?? 'both',
    fixedInterval: (raw.fixedInterval as number) ?? 5,
    activityScoreLower: (raw.activityScoreLower as number) ?? 0.3,
    activityScoreUpper: (raw.activityScoreUpper as number) ?? 0.85,
    activityDecayMinutes: (raw.activityDecayMinutes as number) ?? 10,
    triggerOnAt: (raw.triggerOnAt as boolean) ?? true,
    cooldownSeconds: (raw.cooldownSeconds as number) ?? 10,
    typingEnabled: (raw.typingEnabled as boolean) ?? true,
    typingDelayPerChar: (raw.typingDelayPerChar as number) ?? 50,
    typingMaxDelay: (raw.typingMaxDelay as number) ?? 5000,
    enableIdleTrigger: (raw.enableIdleTrigger as boolean) ?? false,
    idleTriggerMinutes: (raw.idleTriggerMinutes as number) ?? 180,
    idleTriggerStyle: (raw.idleTriggerStyle as ChatFlowProfile['idleTriggerStyle']) ?? 'exponential',
    idleTriggerMaxMinutes: (raw.idleTriggerMaxMinutes as number) ?? 1440,
    idleTriggerJitter: (raw.idleTriggerJitter as boolean) ?? true,
    muteKeywords: parseStringList(raw.muteKeywords),
    muteTimeSeconds: (raw.muteTimeSeconds as number) ?? 60,
  };
}

function resolveConfig(raw: Record<string, unknown>): ChatFlowConfig {
  const rawProfiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  return {
    profiles: rawProfiles.map(p =>
      resolveProfile((p && typeof p === 'object') ? p as Record<string, unknown> : {}),
    ),
    triggerNames: parseStringList(raw.triggerNames),
  };
}

/** 根据平台名 + 会话类型查找匹配的 profile，优先精确匹配，其次回退到默认 profile（platforms 为空） */
function getProfileForPlatform(config: ChatFlowConfig, platform: string, sessionType?: string): ChatFlowProfile | null {
  let defaultProfile: ChatFlowProfile | null = null;
  let platformOnlyMatch: ChatFlowProfile | null = null;
  for (const profile of config.profiles) {
    const platformMatch = profile.platforms.length === 0 || profile.platforms.includes(platform);
    const typeMatch = profile.sessionTypes.length === 0 || (sessionType != null && profile.sessionTypes.includes(sessionType));

    if (!platformMatch) continue;

    // 完全匹配（平台 + 会话类型都指定且匹配）
    if (profile.platforms.length > 0 && profile.sessionTypes.length > 0 && typeMatch) {
      return profile;
    }
    // 仅平台匹配（sessionTypes 未指定）
    if (profile.platforms.length > 0 && profile.sessionTypes.length === 0 && !platformOnlyMatch) {
      platformOnlyMatch = profile;
    }
    // 默认 profile（平台未指定）
    if (profile.platforms.length === 0 && profile.sessionTypes.length === 0 && !defaultProfile) {
      defaultProfile = profile;
    }
  }
  return platformOnlyMatch ?? defaultProfile;
}

// ────────────────── 插件主体 ──────────────────

function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const config = resolveConfig(rawConfig);
  const logger: Logger = ctx.logger.child('chat-flow');
  const sessions = new Map<string, SessionState>();

  const profileSummary = config.profiles.length === 0
    ? '无 profile 配置（流控未生效）'
    : config.profiles.map(p => {
        const parts: string[] = [];
        if (p.platforms.length > 0) parts.push(p.platforms.join(','));
        if (p.sessionTypes.length > 0) parts.push(`[${p.sessionTypes.join(',')}]`);
        return parts.length > 0 ? parts.join(' ') : '默认';
      }).join(' | ');
  logger.info(`聊天流控已启用 (profiles: ${profileSummary})`);

  // ────── 获取/创建 session 状态 ──────

  function getSession(sessionId: string, platform: string, sessionType?: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        messageCount: 0,
        lastReplyTime: 0,
        lastMessageTime: 0,
        activityScore: 0,
        cooldownUntil: 0,
        mutedUntil: 0,
        idleTimer: null,
        idleBackoff: 1,
        userInteractions: new Map(),
        platform,
        sessionType,
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  // ────── 从 persona 获取 bot 名称用于触发检测 ──────

  function getBotNames(): string[] {
    const names = [...config.triggerNames];
    const persona = ctx.getService<PersonaService>('persona');
    if (persona) {
      const personaName = persona.getPersonaName();
      if (personaName && !names.includes(personaName)) {
        names.push(personaName);
      }
      // 添加角色卡定义的昵称
      const nickNames = persona.getNickNames?.() ?? [];
      for (const nn of nickNames) {
        if (nn && !names.includes(nn)) {
          names.push(nn);
        }
      }
    }
    return names;
  }

  // ────── 触发检测 ──────

  function checkImmediateTrigger(message: IncomingMessage, profile: ChatFlowProfile): boolean {
    const content = message.content;

    // 1. @bot 检测（支持 <at self> 标记、CQ 码、通用 @ 格式）
    if (profile.triggerOnAt) {
      if (/<at self>[^<]*<\/at>/.test(content) ||
          /\[CQ:at,qq=\d+\]/.test(content) ||
          /@\S+/.test(content)) {
        return true;
      }
    }

    // 2. 昵称/名字检测（全局触发词 + 角色卡昵称）
    const names = getBotNames();
    for (const name of names) {
      if (name && content.includes(name)) {
        return true;
      }
    }

    return false;
  }

  // ────── 禁言检测 ──────

  function checkMuteKeyword(content: string, profile: ChatFlowProfile): boolean {
    // 检查 profile 配置的禁言关键词
    if (profile.muteKeywords.length > 0) {
      for (const keyword of profile.muteKeywords) {
        if (content.includes(keyword)) return true;
      }
    }
    // 检查角色卡定义的禁言关键词
    const persona = ctx.getService<PersonaService>('persona');
    const personaMuteKw = persona?.getMuteKeywords?.() ?? [];
    for (const keyword of personaMuteKw) {
      if (content.includes(keyword)) return true;
    }
    return false;
  }

  // ────── 动态评分计算 ──────

  function getCurrentThreshold(state: SessionState, profile: ChatFlowProfile): number {
    if (state.lastReplyTime === 0) return profile.activityScoreLower;

    const elapsed = Date.now() - state.lastReplyTime;
    const decayMs = profile.activityDecayMinutes * 60 * 1000;
    const factor = Math.max(0, 1 - elapsed / decayMs);

    return profile.activityScoreLower + (profile.activityScoreUpper - profile.activityScoreLower) * factor;
  }

  function calculateScoreIncrement(state: SessionState, profile: ChatFlowProfile, userId?: string): number {
    const base = 1.0 / Math.max(1, profile.fixedInterval);

    let userWeight = 1.0;
    if (userId) {
      const interaction = state.userInteractions.get(userId);
      if (interaction) {
        userWeight = 1.0 + 0.5 * Math.min(interaction.count / 10, 1.0);
      }
    }

    return base * userWeight;
  }

  // ────── 触发判定 ──────

  function shouldTrigger(state: SessionState, profile: ChatFlowProfile): boolean {
    const fixedOk = state.messageCount >= profile.fixedInterval;
    const dynamicOk = state.activityScore >= getCurrentThreshold(state, profile);
    switch (profile.intervalMode) {
      case 'fixed':   return fixedOk;
      case 'dynamic': return dynamicOk;
      case 'both':    return fixedOk || dynamicOk;
      default:        return fixedOk;
    }
  }

  // ────── 触发后重置状态 ──────

  function resetAfterTrigger(state: SessionState): void {
    state.messageCount = 0;
    state.activityScore = 0;
    state.lastReplyTime = Date.now();
  }

  // ────── 保存被拦截的消息到记忆 ──────

  async function saveBufferedMessage(incoming: IncomingMessage): Promise<void> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory) return;
    try {
      const senderLabel = incoming.nickname ?? incoming.userId;
      const contentToSave = senderLabel
        ? `[${senderLabel}]: ${incoming.content}`
        : incoming.content;
      await memory.saveMessage(incoming.sessionId, {
        role: 'user',
        content: contentToSave,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn(`保存缓冲消息失败: ${err}`);
    }
  }

  // ────── 空闲触发 ──────

  function scheduleIdleTrigger(state: SessionState, sessionId: string, profile: ChatFlowProfile): void {
    clearIdleTimer(state);

    if (!profile.enableIdleTrigger) return;

    let delayMs: number;
    if (profile.idleTriggerStyle === 'exponential') {
      delayMs = Math.min(
        profile.idleTriggerMinutes * state.idleBackoff * 60 * 1000,
        profile.idleTriggerMaxMinutes * 60 * 1000,
      );
    } else {
      delayMs = profile.idleTriggerMinutes * 60 * 1000;
    }

    // 抖动 ±10%
    if (profile.idleTriggerJitter) {
      const jitter = delayMs * (0.1 * (Math.random() * 2 - 1));
      delayMs = Math.max(60_000, delayMs + jitter); // 至少 1 分钟
    }

    state.idleTimer = setTimeout(async () => {
      try {
        logger.info(`空闲触发: session=${sessionId} (退避 x${state.idleBackoff})`);

        if (profile.idleTriggerStyle === 'exponential') {
          state.idleBackoff = Math.min(state.idleBackoff * 2, 64);
        }

        await ctx.emit('message:received', {
          content: IDLE_TRIGGER_MARKER,
          sessionId,
          platform: state.platform,
        });

        scheduleIdleTrigger(state, sessionId, profile);
      } catch (err) {
        logger.warn(`空闲触发执行失败: ${err}`);
      }
    }, delayMs);

    logger.debug(`空闲触发已调度: session=${sessionId}, ${Math.round(delayMs / 60_000)}分钟后`);
  }

  function clearIdleTimer(state: SessionState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  // ────── message:before 中间件（核心拦截逻辑） ──────
  // 不调用 next() = 中断整个消息处理管道（包括 LLM 调用），这是标准中间件模式

  ctx.middleware('message:before', async (data, next) => {
    const msg = data.message;

    // 查找匹配的 profile，找不到则直接放行（该平台不受流控）
    const profile = getProfileForPlatform(config, msg.platform, msg.sessionType);
    if (!profile) {
      await next();
      return;
    }

    // scheduler 来源的消息 — 不受流控，直接放行
    if (msg.source === 'scheduler') {
      data.metadata['chat-flow:scheduler'] = true;
      await next();
      return;
    }

    // 空闲触发的消息 — 替换内容为系统提示然后放行
    if (msg.content === IDLE_TRIGGER_MARKER) {
      data.message = {
        ...msg,
        content: '[系统提示: 群里已经很久没人说话了，你可以主动发起一个话题或者分享一些有趣的内容。]',
      };
      data.metadata['chat-flow:idle-trigger'] = true;
      await next();
      return;
    }

    const state = getSession(msg.sessionId, msg.platform, msg.sessionType);
    const now = Date.now();

    // 更新用户交互记录
    if (msg.userId) {
      const prev = state.userInteractions.get(msg.userId) ?? { count: 0, lastTime: 0 };
      state.userInteractions.set(msg.userId, { count: prev.count + 1, lastTime: now });
    }

    // 更新时间戳
    state.lastMessageTime = now;

    // 禁言检测
    if (checkMuteKeyword(msg.content, profile)) {
      state.mutedUntil = now + profile.muteTimeSeconds * 1000;
      state.messageCount = 0;
      state.activityScore = 0;
      logger.info(`禁言触发: session=${msg.sessionId}, ${profile.muteTimeSeconds}秒`);
      await saveBufferedMessage(msg);
      scheduleIdleTrigger(state, msg.sessionId, profile);
      return;
    }

    // 仍在禁言中
    if (now < state.mutedUntil) {
      await saveBufferedMessage(msg);
      return;
    }

    // 仍在冷却中
    if (now < state.cooldownUntil) {
      state.messageCount++;
      state.activityScore += calculateScoreIncrement(state, profile, msg.userId);
      await saveBufferedMessage(msg);
      scheduleIdleTrigger(state, msg.sessionId, profile);
      return;
    }

    // 即时触发检测（@、名字）
    if (checkImmediateTrigger(msg, profile)) {
      logger.debug(`即时触发 (@ / 名字): session=${msg.sessionId}`);
      resetAfterTrigger(state);
      state.idleBackoff = 1;
      scheduleIdleTrigger(state, msg.sessionId, profile);
      await next();
      return;
    }

    // 累加计数和评分
    state.messageCount++;
    state.activityScore += calculateScoreIncrement(state, profile, msg.userId);

    // 间隔触发判定
    if (shouldTrigger(state, profile)) {
      logger.debug(
        `间隔触发: session=${msg.sessionId}, ` +
        `count=${state.messageCount}, score=${state.activityScore.toFixed(3)}, ` +
        `threshold=${getCurrentThreshold(state, profile).toFixed(3)}`
      );
      resetAfterTrigger(state);
      state.idleBackoff = 1;
      scheduleIdleTrigger(state, msg.sessionId, profile);
      await next();
      return;
    }

    // 未触发 — 缓冲消息，不调用 next()
    await saveBufferedMessage(msg);
    scheduleIdleTrigger(state, msg.sessionId, profile);
    // 不调用 next() → 中断管道，消息不会被送到 Agent
  }, 200); // 高优先级

  // ────── response:before 中间件（打字延迟） ──────

  ctx.middleware('response:before', async (data, next) => {
    const sessionId = data.sessionId;
    const state = sessions.get(sessionId);

    if (!state) {
      await next();
      return;
    }

    const profile = getProfileForPlatform(config, state.platform, state.sessionType);
    if (!profile || !profile.typingEnabled) {
      await next();
      return;
    }

    await next();

    if (data.content && data.content.length > 0) {
      const charCount = data.content.length;
      const delay = Math.min(charCount * profile.typingDelayPerChar, profile.typingMaxDelay);
      if (delay > 0) {
        logger.debug(`打字延迟: ${delay}ms (${charCount} chars)`);
        await sleep(delay);
      }
    }
  }, -100);

  // ────── 监听 message:send 事件设置冷却 ──────

  ctx.on('message:send', (msg) => {
    const state = sessions.get(msg.sessionId);
    if (!state) return;

    const profile = getProfileForPlatform(config, state.platform, state.sessionType);
    if (!profile) return;

    if (profile.cooldownSeconds > 0) {
      state.cooldownUntil = Date.now() + profile.cooldownSeconds * 1000;
    }

    state.idleBackoff = 1;
    scheduleIdleTrigger(state, msg.sessionId, profile);
  });

  // ────── 清理 ──────

  ctx.on('dispose', () => {
    for (const [, state] of sessions) {
      clearIdleTimer(state);
    }
    sessions.clear();
  });
}

// ────────────────── 导出 ──────────────────

export const name = '@aalis/plugin-chat-flow';

export const inject = {
  optional: ['memory', 'persona'],
};

export const configSchema: ConfigSchema = {
  profiles: {
    type: 'array',
    label: '平台配置列表',
    description: '为不同平台配置独立的聊天流控参数。每个条目可指定一组平台，留空平台名则作为默认/兜底规则。',
    items: {
      platforms: {
        type: 'multiselect',
        label: '作用平台',
        description: '选择要应用的平台。留空表示默认规则，匹配未被其他条目覆盖的平台。',
        dynamicOptions: 'platform',
        allowCustom: true,
      },
      sessionTypes: {
        type: 'multiselect',
        label: '会话类型',
        description: '限定生效的会话类型。留空表示不限制。可与平台配合使用，如为 OneBot 群聊和私聊设置不同频率。',
        options: [
          { label: '群聊', value: 'group' },
          { label: '私聊', value: 'private' },
          { label: '频道', value: 'channel' },
        ],
      },
      intervalMode: {
        type: 'select',
        label: '间隔模式',
        options: [
          { label: '固定消息条数', value: 'fixed' },
          { label: '动态活跃度评分', value: 'dynamic' },
          { label: '满足任一即触发', value: 'both' },
        ],
        default: 'both',
      },
      fixedInterval: { type: 'number', label: '固定间隔（条）', default: 5, description: '固定模式下每收到 N 条消息触发一次回复。' },
      activityScoreLower: { type: 'number', label: '活跃度下限阈值', default: 0.3, description: '长时间无回复后的触发阈值，越低越容易触发。' },
      activityScoreUpper: { type: 'number', label: '活跃度上限阈值', default: 0.85, description: '刚回复后的触发阈值，越高越不容易再次触发。' },
      activityDecayMinutes: { type: 'number', label: '衰减时间（分钟）', default: 10, description: '回复后阈值从上限衰减回下限所需时间。' },
      triggerOnAt: { type: 'boolean', label: '@ 触发', default: true, description: '消息中包含 @bot 时立刻触发回复。' },
      cooldownSeconds: { type: 'number', label: '冷却时间（秒）', default: 10, description: 'AI 回复后的冷却时间。' },
      typingEnabled: { type: 'boolean', label: '打字延迟', default: true, description: '是否模拟打字延迟。' },
      typingDelayPerChar: { type: 'number', label: '每字延迟（ms）', default: 50 },
      typingMaxDelay: { type: 'number', label: '最大延迟（ms）', default: 5000 },
      enableIdleTrigger: { type: 'boolean', label: '空闲主动触发', default: false, description: '长时间无人说话时 AI 是否主动发起话题。' },
      idleTriggerMinutes: { type: 'number', label: '空闲间隔（分钟）', default: 180 },
      idleTriggerStyle: {
        type: 'select',
        label: '空闲重试风格',
        options: [
          { label: '指数退避', value: 'exponential' },
          { label: '固定间隔', value: 'fixed' },
        ],
        default: 'exponential',
      },
      idleTriggerMaxMinutes: { type: 'number', label: '空闲最大间隔（分钟）', default: 1440 },
      idleTriggerJitter: { type: 'boolean', label: '空闲抖动', default: true },
      muteKeywords: { type: 'string', label: '禁言关键词', default: '', description: '逗号分隔。' },
      muteTimeSeconds: { type: 'number', label: '禁言时长（秒）', default: 60 },
    },
    default: [],
  },
  triggerNames: {
    type: 'string',
    label: '触发词 / 昵称',
    default: '',
    description: '消息中出现这些词时立刻触发回复，逗号分隔（自动包含人设名称）。全局生效。',
  },
};

export const defaultConfig = {
  profiles: [] as Record<string, unknown>[],
  triggerNames: '',
};

export { apply };
