// ----- 流控配置类型与默认值 -----

export interface FlowControlConfig {
  /** 是否启用流控（关闭时所有判定都返回 false / 放行） */
  enabled: boolean;
  /** 仅对这些 platform 生效（空数组=所有 platform） */
  platforms: string[];
  /**
   * 仅对这些会话类型生效（空数组=所有会话类型）。
   * 默认 ['group']：与历史 OneBot ChatFlow 一致，只对群聊限速/冷却，
   * 避免一对一私聊 / CLI / WebUI 被误伤。
   * 可设为 [] 对所有会话启用，或加入 'channel'/'guild' 等未来型别。
   */
  sessionTypes: string[];

  /** 固定间隔：每 N 条消息累计一次触发 */
  fixedInterval: number;

  /** 动态阈值上下限（用于回复后高、长时间无回复后低） */
  activityScoreLower: number;
  activityScoreUpper: number;
  /** 阈值衰减分钟数：上次回复到当前的时间差越大，阈值越低 */
  activityDecayMinutes: number;
  /** 评分本身的衰减分钟数（0 表示评分不主动衰减） */
  scoreDecayMinutes: number;

  /** 回复后冷却（秒） */
  cooldownSeconds: number;
  /** mute 关键词命中时的禁言时长（秒） */
  muteTimeSeconds: number;

  /** 限速窗口（秒，0 关闭） */
  rateLimitWindow: number;
  /** 窗口内最大回复次数 */
  rateLimitMaxReplies: number;

  /** 闲置触发范围 */
  idleTriggerScope: 'off' | 'session' | 'platform';
  idleTriggerStrategy: 'all-quiet' | 'fixed';
  idleTriggerMinutes: number;
  idleTriggerStyle: 'exponential' | 'fixed';
  idleTriggerMaxMinutes: number;
  idleTriggerJitter: boolean;
  /** 闲置触发注入的 system 提示文本 */
  idleTriggerPrompt: string;
}

export const defaultFlowControlConfig: FlowControlConfig = {
  enabled: true,
  platforms: [],
  sessionTypes: ['group'],
  fixedInterval: 5,
  activityScoreLower: 0.3,
  activityScoreUpper: 0.85,
  activityDecayMinutes: 10,
  scoreDecayMinutes: 0,
  cooldownSeconds: 10,
  muteTimeSeconds: 60,
  rateLimitWindow: 0,
  rateLimitMaxReplies: 10,
  idleTriggerScope: 'off',
  idleTriggerStrategy: 'all-quiet',
  idleTriggerMinutes: 180,
  idleTriggerStyle: 'exponential',
  idleTriggerMaxMinutes: 1440,
  idleTriggerJitter: true,
  idleTriggerPrompt: '',
};

function parseStringList(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  if (typeof val === 'string' && val.trim()) {
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export function resolveFlowControlConfig(raw: Record<string, unknown>): FlowControlConfig {
  const d = defaultFlowControlConfig;
  return {
    enabled: (raw.enabled as boolean) ?? d.enabled,
    platforms: parseStringList(raw.platforms),
    sessionTypes: raw.sessionTypes === undefined ? d.sessionTypes : parseStringList(raw.sessionTypes),
    fixedInterval: (raw.fixedInterval as number) ?? d.fixedInterval,
    activityScoreLower: (raw.activityScoreLower as number) ?? d.activityScoreLower,
    activityScoreUpper: (raw.activityScoreUpper as number) ?? d.activityScoreUpper,
    activityDecayMinutes: (raw.activityDecayMinutes as number) ?? d.activityDecayMinutes,
    scoreDecayMinutes: (raw.scoreDecayMinutes as number) ?? d.scoreDecayMinutes,
    cooldownSeconds: (raw.cooldownSeconds as number) ?? d.cooldownSeconds,
    muteTimeSeconds: (raw.muteTimeSeconds as number) ?? d.muteTimeSeconds,
    rateLimitWindow: (raw.rateLimitWindow as number) ?? d.rateLimitWindow,
    rateLimitMaxReplies: (raw.rateLimitMaxReplies as number) ?? d.rateLimitMaxReplies,
    idleTriggerScope: ((): FlowControlConfig['idleTriggerScope'] => {
      const v = raw.idleTriggerScope;
      return (v === 'off' || v === 'session' || v === 'platform') ? v : d.idleTriggerScope;
    })(),
    idleTriggerStrategy: ((): FlowControlConfig['idleTriggerStrategy'] => {
      const v = raw.idleTriggerStrategy;
      return v === 'fixed' ? 'fixed' : 'all-quiet';
    })(),
    idleTriggerMinutes: (raw.idleTriggerMinutes as number) ?? d.idleTriggerMinutes,
    idleTriggerStyle: (raw.idleTriggerStyle as FlowControlConfig['idleTriggerStyle']) ?? d.idleTriggerStyle,
    idleTriggerMaxMinutes: (raw.idleTriggerMaxMinutes as number) ?? d.idleTriggerMaxMinutes,
    idleTriggerJitter: (raw.idleTriggerJitter as boolean) ?? d.idleTriggerJitter,
    idleTriggerPrompt: (raw.idleTriggerPrompt as string) || d.idleTriggerPrompt,
  };
}

export function isPlatformEnabled(cfg: FlowControlConfig, platform: string | undefined): boolean {
  if (!cfg.enabled) return false;
  if (cfg.platforms.length === 0) return true;
  if (!platform) return false;
  return cfg.platforms.includes(platform);
}

/** 会话类型是否在流控生效范围内。空白名单 = 全部生效。 */
export function isSessionTypeEnabled(cfg: FlowControlConfig, sessionType: string | undefined): boolean {
  if (cfg.sessionTypes.length === 0) return true;
  if (!sessionType) return false;
  return cfg.sessionTypes.includes(sessionType);
}
