// ----- 触发策略配置 -----

export type IdleTriggerScope = 'off' | 'session' | 'platform';
export type IdleTriggerStrategy = 'all-quiet' | 'fixed';
export type IdleTriggerStyle = 'exponential' | 'fixed';

export interface TriggerPolicyConfig {
  /**
   * 统一作用域名单：platform:sessionType[:targetId]，支持 *。
   * 默认 ['*:group']；空数组 = 不生效（等于禁用触发策略）。
   * 若存在任一 overrides[].scope 命中也视为启用。
   */
  scopes: string[];
  /**
   * 分作用域覆盖：每条针对一个 scope，仅在命中时覆盖列出的字段；未列字段穿透到顶层默认。
   * 最具体匹配优先（targetId > sessionType > platform > 通配）。
   * 写一条 override 即自动启用该 scope，无需重复在 scopes 中列出。
   */
  overrides: TriggerScopeOverride[];
  /** 模式：fixed=按计数，dynamic=按评分阈值，both=任一满足 */
  intervalMode: 'fixed' | 'dynamic' | 'both';
  /** 是否检测 @ 提及作为即时触发 */
  triggerOnAt: boolean;
  /** 戳一戳等注意力动作（noticeType=poke）是否视同 @ 即时触发；关闭后落回正常意愿评估 */
  triggerOnPoke: boolean;
  /** 额外的触发名（除 persona 名字外的别名） */
  triggerNames: string[];
  /** mute 关键词（命中时设置自禁言） */
  muteKeywords: string[];
  /** mute 关键词命中时通知 flow-control 设置的禁言时长（秒） */
  muteTimeSeconds: number;

  /** 固定间隔：每 N 条消息累计一次触发 */
  fixedInterval: number;
  /** 动态阈值上下限（刚触发后高、长时间未触发后低） */
  activityScoreLower: number;
  activityScoreUpper: number;
  /** 阈值衰减分钟数：距上次触发越久，阈值越低 */
  activityDecayMinutes: number;
  /** 评分本身的衰减分钟数（0 表示评分不主动衰减） */
  scoreDecayMinutes: number;

  /** 闲置触发范围 */
  idleTriggerScope: IdleTriggerScope;
  idleTriggerStrategy: IdleTriggerStrategy;
  idleTriggerMinutes: number;
  idleTriggerStyle: IdleTriggerStyle;
  idleTriggerMaxMinutes: number;
  idleTriggerJitter: boolean;
  /** 闲置触发注入的 system 提示文本 */
  idleTriggerPrompt: string;
}

export interface TriggerScopeOverride {
  scope: string;
  intervalMode?: 'fixed' | 'dynamic' | 'both';
  triggerOnAt?: boolean;
  triggerOnPoke?: boolean;
  triggerNames?: string[];
  muteKeywords?: string[];
  muteTimeSeconds?: number;
  fixedInterval?: number;
  activityScoreLower?: number;
  activityScoreUpper?: number;
  activityDecayMinutes?: number;
  scoreDecayMinutes?: number;
  idleTriggerScope?: IdleTriggerScope;
  idleTriggerMinutes?: number;
  idleTriggerStyle?: IdleTriggerStyle;
  idleTriggerMaxMinutes?: number;
  idleTriggerJitter?: boolean;
  idleTriggerPrompt?: string;
}

export const defaultTriggerPolicyConfig: TriggerPolicyConfig = {
  scopes: ['*:group'],
  overrides: [],
  intervalMode: 'both',
  triggerOnAt: true,
  triggerOnPoke: true,
  triggerNames: [],
  muteKeywords: [],
  muteTimeSeconds: 60,
  fixedInterval: 5,
  activityScoreLower: 0.3,
  activityScoreUpper: 0.85,
  activityDecayMinutes: 10,
  scoreDecayMinutes: 0,
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

export function resolveTriggerPolicyConfig(raw: Record<string, unknown>): TriggerPolicyConfig {
  const d = defaultTriggerPolicyConfig;
  return {
    scopes: raw.scopes === undefined ? d.scopes : parseStringList(raw.scopes),
    overrides: parseOverrides(raw.overrides),
    intervalMode: ((): TriggerPolicyConfig['intervalMode'] => {
      const v = raw.intervalMode;
      return v === 'fixed' || v === 'dynamic' || v === 'both' ? v : d.intervalMode;
    })(),
    triggerOnAt: (raw.triggerOnAt as boolean) ?? d.triggerOnAt,
    triggerOnPoke: (raw.triggerOnPoke as boolean) ?? d.triggerOnPoke,
    triggerNames: parseStringList(raw.triggerNames),
    muteKeywords: parseStringList(raw.muteKeywords),
    muteTimeSeconds:
      typeof raw.muteTimeSeconds === 'number' && raw.muteTimeSeconds > 0
        ? Math.floor(raw.muteTimeSeconds)
        : d.muteTimeSeconds,
    fixedInterval: (raw.fixedInterval as number) ?? d.fixedInterval,
    activityScoreLower: (raw.activityScoreLower as number) ?? d.activityScoreLower,
    activityScoreUpper: (raw.activityScoreUpper as number) ?? d.activityScoreUpper,
    activityDecayMinutes: (raw.activityDecayMinutes as number) ?? d.activityDecayMinutes,
    scoreDecayMinutes: (raw.scoreDecayMinutes as number) ?? d.scoreDecayMinutes,
    idleTriggerScope: ((): IdleTriggerScope => {
      const v = raw.idleTriggerScope;
      return v === 'off' || v === 'session' || v === 'platform' ? v : d.idleTriggerScope;
    })(),
    idleTriggerStrategy: raw.idleTriggerStrategy === 'fixed' ? 'fixed' : 'all-quiet',
    idleTriggerMinutes: (raw.idleTriggerMinutes as number) ?? d.idleTriggerMinutes,
    idleTriggerStyle: (raw.idleTriggerStyle as IdleTriggerStyle) ?? d.idleTriggerStyle,
    idleTriggerMaxMinutes: (raw.idleTriggerMaxMinutes as number) ?? d.idleTriggerMaxMinutes,
    idleTriggerJitter: (raw.idleTriggerJitter as boolean) ?? d.idleTriggerJitter,
    idleTriggerPrompt: (raw.idleTriggerPrompt as string) || d.idleTriggerPrompt,
  };
}

function parseOverrides(raw: unknown): TriggerScopeOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: TriggerScopeOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.scope !== 'string' || !obj.scope.trim()) continue;
    const o: TriggerScopeOverride = { scope: obj.scope.trim() };
    const mode = obj.intervalMode;
    if (mode === 'fixed' || mode === 'dynamic' || mode === 'both') o.intervalMode = mode;
    if (typeof obj.triggerOnAt === 'boolean') o.triggerOnAt = obj.triggerOnAt;
    if (typeof obj.triggerOnPoke === 'boolean') o.triggerOnPoke = obj.triggerOnPoke;
    // 字符串字段：仅在非空时视为覆盖；空串/未填 → 穿透到顶层默认
    if (typeof obj.triggerNames === 'string' && obj.triggerNames.trim() !== '') {
      o.triggerNames = parseStringList(obj.triggerNames);
    } else if (Array.isArray(obj.triggerNames) && obj.triggerNames.length > 0) {
      o.triggerNames = parseStringList(obj.triggerNames);
    }
    if (typeof obj.muteKeywords === 'string' && obj.muteKeywords.trim() !== '') {
      o.muteKeywords = parseStringList(obj.muteKeywords);
    } else if (Array.isArray(obj.muteKeywords) && obj.muteKeywords.length > 0) {
      o.muteKeywords = parseStringList(obj.muteKeywords);
    }
    if (typeof obj.muteTimeSeconds === 'number' && obj.muteTimeSeconds > 0) {
      o.muteTimeSeconds = Math.floor(obj.muteTimeSeconds);
    }
    for (const k of [
      'fixedInterval',
      'activityScoreLower',
      'activityScoreUpper',
      'activityDecayMinutes',
      'scoreDecayMinutes',
      'idleTriggerMinutes',
      'idleTriggerMaxMinutes',
    ] as const) {
      const v = obj[k];
      if (typeof v === 'number') o[k] = v;
    }
    if (typeof obj.idleTriggerJitter === 'boolean') o.idleTriggerJitter = obj.idleTriggerJitter;
    if (typeof obj.idleTriggerPrompt === 'string' && obj.idleTriggerPrompt !== '') {
      o.idleTriggerPrompt = obj.idleTriggerPrompt;
    }
    const sScope = obj.idleTriggerScope;
    if (sScope === 'off' || sScope === 'session' || sScope === 'platform') o.idleTriggerScope = sScope;
    const sStyle = obj.idleTriggerStyle;
    if (sStyle === 'exponential' || sStyle === 'fixed') o.idleTriggerStyle = sStyle;
    out.push(o);
  }
  return out;
}
