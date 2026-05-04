// ----- 触发策略配置 -----

export interface TriggerPolicyConfig {
  enabled: boolean;
  /**
   * 统一作用域名单：platform:sessionType，支持 *。
   * 默认 ['*:group']；空数组 = 不生效（等于禁用触发策略）。
   */
  scopes: string[];
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

export const defaultTriggerPolicyConfig: TriggerPolicyConfig = {
  enabled: true,
  scopes: ['*:group'],
  intervalMode: 'both',
  triggerOnAt: true,
  triggerNames: [],
  muteKeywords: [],
  muteTimeSeconds: 60,
};

function parseStringList(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  if (typeof val === 'string' && val.trim()) {
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export function resolveTriggerPolicyConfig(raw: Record<string, unknown>): TriggerPolicyConfig {
  const d = defaultTriggerPolicyConfig;
  return {
    enabled: (raw.enabled as boolean) ?? d.enabled,
    scopes: raw.scopes === undefined ? d.scopes : parseStringList(raw.scopes),
    intervalMode: ((): TriggerPolicyConfig['intervalMode'] => {
      const v = raw.intervalMode;
      return v === 'fixed' || v === 'dynamic' || v === 'both' ? v : d.intervalMode;
    })(),
    triggerOnAt: (raw.triggerOnAt as boolean) ?? d.triggerOnAt,
    triggerNames: parseStringList(raw.triggerNames),
    muteKeywords: parseStringList(raw.muteKeywords),
    muteTimeSeconds: typeof raw.muteTimeSeconds === 'number' && raw.muteTimeSeconds > 0
      ? Math.floor(raw.muteTimeSeconds)
      : d.muteTimeSeconds,
  };
}

/** scope 匹配：platform:sessionType。详见 plugin-flow-control 同名函数。 */
export function isScopeEnabled(
  cfg: TriggerPolicyConfig,
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
