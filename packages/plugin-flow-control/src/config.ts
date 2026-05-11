// ----- 流控配置类型与默认值 -----

export interface FlowControlConfig {
  /**
   * 统一作用域名单（multiselect），元素格式 "platform:sessionType"，
   * 支持 "*" 通配：onebot:group / onebot:* / *:group / * 。
   * 默认 ['*:group'] 与历史 OneBot ChatFlow 行为一致。
   * 空数组 = 不生效（等于禁用流控）。
   */
  scopes: string[];

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
  scopes: ['*:group'],
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
    return val
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function resolveFlowControlConfig(raw: Record<string, unknown>): FlowControlConfig {
  const d = defaultFlowControlConfig;
  return {
    scopes: raw.scopes === undefined ? d.scopes : parseStringList(raw.scopes),
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
      return v === 'off' || v === 'session' || v === 'platform' ? v : d.idleTriggerScope;
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

/** 统一作用域匹配：`(platform, sessionType)` 是否命中 cfg.scopes 中任一项（支持 *）。 */
export function isScopeEnabled(
  cfg: FlowControlConfig,
  platform: string | undefined,
  sessionType: string | undefined,
): boolean {
  if (cfg.scopes.length === 0) return false;
  const p = platform ?? '';
  const t = sessionType ?? '';
  for (const raw of cfg.scopes) {
    const [sp, st] = raw.includes(':') ? raw.split(':', 2) : [raw, '*'];
    const platOk = sp === '*' || sp === '' || sp === p;
    const typeOk = st === '*' || st === '' || st === t;
    if (platOk && typeOk) return true;
  }
  return false;
}
