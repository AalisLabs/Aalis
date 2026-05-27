// ----- 流控配置类型与默认值 -----

export interface FlowControlConfig {
  /**
   * 统一作用域名单（multiselect），元素格式 "platform:sessionType[:targetId]"，
   * 支持 "*" 通配：onebot:group / onebot:* / *:group / * / onebot:private:10001 。
   * 默认 ['*:group'] 与历史 OneBot ChatFlow 行为一致。
   * 空数组 = 不生效（等于禁用流控）；但若存在任一 overrides[].scope 命中也视为启用。
   */
  scopes: string[];

  /**
   * 分作用域覆盖：每条覆盖针对一个 scope 字符串（语法同 scopes，3 段），
   * 仅在该 scope 命中时把列出的字段覆盖到顶层默认之上；未列字段穿透到顶层。
   * 命中时按"最具体优先"挑选（targetId > sessionType > platform > 通配）。
   * 写一条 override 即自动启用该 scope，无需重复在 scopes 中列出。
   * 例：private 单独 10 秒冷却而群聊不变 →
   *   overrides: [{ scope: '*:private', cooldownSeconds: 10 }]
   */
  overrides: ScopeOverride[];

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

/**
 * 分作用域覆盖项：含 scope 字符串 + 任意字段覆盖。
 * 未指定的字段会从顶层 FlowControlConfig 默认中穿透。
 */
export interface ScopeOverride {
  scope: string;
  fixedInterval?: number;
  activityScoreLower?: number;
  activityScoreUpper?: number;
  activityDecayMinutes?: number;
  scoreDecayMinutes?: number;
  cooldownSeconds?: number;
  muteTimeSeconds?: number;
  rateLimitWindow?: number;
  rateLimitMaxReplies?: number;
  idleTriggerScope?: 'off' | 'session' | 'platform';
  idleTriggerStrategy?: 'all-quiet' | 'fixed';
  idleTriggerMinutes?: number;
  idleTriggerStyle?: 'exponential' | 'fixed';
  idleTriggerMaxMinutes?: number;
  idleTriggerJitter?: boolean;
  idleTriggerPrompt?: string;
}

export const defaultFlowControlConfig: FlowControlConfig = {
  scopes: ['*:group'],
  overrides: [],
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
    overrides: parseOverrides(raw.overrides),
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

/** 统一作用域匹配：`(platform, sessionType[, targetId])` 是否命中 cfg.scopes 或任一 overrides[].scope。 */
export function isScopeEnabled(
  cfg: FlowControlConfig,
  platform: string | undefined,
  sessionType: string | undefined,
  targetId?: string | undefined,
): boolean {
  const p = platform ?? '';
  const t = sessionType ?? '';
  const tid = targetId ?? '';
  for (const raw of cfg.scopes) {
    if (matchScopeString(raw, p, t, tid)) return true;
  }
  for (const o of cfg.overrides) {
    if (matchScopeString(o.scope, p, t, tid)) return true;
  }
  return false;
}

/**
 * 在 cfg.overrides 中找出最具体匹配项，把其字段叠加到 base cfg 之上；无匹配时原样返回。
 * 具体度：精确 targetId > 精确 sessionType > 精确 platform > 通配。
 */
export function resolveEffectiveConfig(
  cfg: FlowControlConfig,
  platform: string | undefined,
  sessionType: string | undefined,
  targetId?: string | undefined,
): FlowControlConfig {
  if (cfg.overrides.length === 0) return cfg;
  const p = platform ?? '';
  const t = sessionType ?? '';
  const tid = targetId ?? '';
  let best: ScopeOverride | null = null;
  let bestSpec = -1;
  for (const o of cfg.overrides) {
    const parts = parseScopePattern(o.scope);
    if (!matchScopeParts(parts, p, t, tid)) continue;
    const spec = scopeSpecificity(parts);
    if (spec > bestSpec) {
      best = o;
      bestSpec = spec;
    }
  }
  if (!best) return cfg;
  const merged: FlowControlConfig = { ...cfg };
  for (const [k, v] of Object.entries(best)) {
    if (k === 'scope') continue;
    if (v === undefined) continue;
    (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return merged;
}

interface ScopePattern {
  platform: string;
  sessionType: string;
  targetId: string;
}

function parseScopePattern(s: string): ScopePattern {
  const parts = (s || '').split(':');
  return {
    platform: parts[0] || '*',
    sessionType: parts[1] || '*',
    targetId: parts[2] || '*',
  };
}

function matchScopeParts(pat: ScopePattern, p: string, t: string, tid: string): boolean {
  return (
    (pat.platform === '*' || pat.platform === '' || pat.platform === p) &&
    (pat.sessionType === '*' || pat.sessionType === '' || pat.sessionType === t) &&
    (pat.targetId === '*' || pat.targetId === '' || pat.targetId === tid)
  );
}

function matchScopeString(raw: string, p: string, t: string, tid: string): boolean {
  return matchScopeParts(parseScopePattern(raw), p, t, tid);
}

function scopeSpecificity(pat: ScopePattern): number {
  return (
    (pat.platform !== '*' && pat.platform !== '' ? 4 : 0) +
    (pat.sessionType !== '*' && pat.sessionType !== '' ? 2 : 0) +
    (pat.targetId !== '*' && pat.targetId !== '' ? 1 : 0)
  );
}

function parseOverrides(raw: unknown): ScopeOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopeOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.scope !== 'string' || !obj.scope.trim()) continue;
    const o: ScopeOverride = { scope: obj.scope.trim() };
    for (const k of [
      'fixedInterval',
      'activityScoreLower',
      'activityScoreUpper',
      'activityDecayMinutes',
      'scoreDecayMinutes',
      'cooldownSeconds',
      'muteTimeSeconds',
      'rateLimitWindow',
      'rateLimitMaxReplies',
      'idleTriggerMinutes',
      'idleTriggerMaxMinutes',
    ] as const) {
      if (typeof obj[k] === 'number') (o as unknown as Record<string, unknown>)[k] = obj[k];
    }
    if (typeof obj.idleTriggerJitter === 'boolean') o.idleTriggerJitter = obj.idleTriggerJitter;
    // 字符串字段：仅在非空时视为覆盖；空串/未填 → 穿透到顶层默认
    if (typeof obj.idleTriggerPrompt === 'string' && obj.idleTriggerPrompt !== '') {
      o.idleTriggerPrompt = obj.idleTriggerPrompt;
    }
    const sScope = obj.idleTriggerScope;
    if (sScope === 'off' || sScope === 'session' || sScope === 'platform') o.idleTriggerScope = sScope;
    const sStrat = obj.idleTriggerStrategy;
    if (sStrat === 'all-quiet' || sStrat === 'fixed') o.idleTriggerStrategy = sStrat;
    const sStyle = obj.idleTriggerStyle;
    if (sStyle === 'exponential' || sStyle === 'fixed') o.idleTriggerStyle = sStyle;
    out.push(o);
  }
  return out;
}
