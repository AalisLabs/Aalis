// ----- 触发策略配置 -----

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
  /** 额外的触发名（除 persona 名字外的别名） */
  triggerNames: string[];
  /** mute 关键词（命中时设置自禁言） */
  muteKeywords: string[];
  /** mute 关键词命中时通知 flow-control 设置的禁言时长（秒） */
  muteTimeSeconds: number;
}

export interface TriggerScopeOverride {
  scope: string;
  intervalMode?: 'fixed' | 'dynamic' | 'both';
  triggerOnAt?: boolean;
  triggerNames?: string[];
  muteKeywords?: string[];
  muteTimeSeconds?: number;
}

export const defaultTriggerPolicyConfig: TriggerPolicyConfig = {
  scopes: ['*:group'],
  overrides: [],
  intervalMode: 'both',
  triggerOnAt: true,
  triggerNames: [],
  muteKeywords: [],
  muteTimeSeconds: 60,
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
    triggerNames: parseStringList(raw.triggerNames),
    muteKeywords: parseStringList(raw.muteKeywords),
    muteTimeSeconds:
      typeof raw.muteTimeSeconds === 'number' && raw.muteTimeSeconds > 0
        ? Math.floor(raw.muteTimeSeconds)
        : d.muteTimeSeconds,
  };
}

/** scope 匹配：3 段 platform:sessionType[:targetId]，支持 * 与省略。 */
export function isScopeEnabled(
  cfg: TriggerPolicyConfig,
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

export function resolveEffectiveConfig(
  cfg: TriggerPolicyConfig,
  platform: string | undefined,
  sessionType: string | undefined,
  targetId?: string | undefined,
): TriggerPolicyConfig {
  if (cfg.overrides.length === 0) return cfg;
  const p = platform ?? '';
  const t = sessionType ?? '';
  const tid = targetId ?? '';
  let best: TriggerScopeOverride | null = null;
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
  const merged: TriggerPolicyConfig = { ...cfg };
  if (best.intervalMode !== undefined) merged.intervalMode = best.intervalMode;
  if (best.triggerOnAt !== undefined) merged.triggerOnAt = best.triggerOnAt;
  if (best.triggerNames !== undefined) merged.triggerNames = best.triggerNames;
  if (best.muteKeywords !== undefined) merged.muteKeywords = best.muteKeywords;
  if (best.muteTimeSeconds !== undefined) merged.muteTimeSeconds = best.muteTimeSeconds;
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
    out.push(o);
  }
  return out;
}
