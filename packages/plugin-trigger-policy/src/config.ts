// ----- 触发策略配置 -----

export interface TriggerPolicyConfig {
  enabled: boolean;
  /** 仅对这些 platform 生效（空数组=所有 platform） */
  platforms: string[];
  /** 模式：fixed=按计数，dynamic=按评分阈值，both=任一满足 */
  intervalMode: 'fixed' | 'dynamic' | 'both';
  /** 是否检测 @ 提及作为即时触发 */
  triggerOnAt: boolean;
  /** 额外的触发名（除 persona 名字外的别名） */
  triggerNames: string[];
  /** mute 关键词（命中时设置自禁言） */
  muteKeywords: string[];
}

export const defaultTriggerPolicyConfig: TriggerPolicyConfig = {
  enabled: true,
  platforms: [],
  intervalMode: 'both',
  triggerOnAt: true,
  triggerNames: [],
  muteKeywords: [],
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
    platforms: parseStringList(raw.platforms),
    intervalMode: ((): TriggerPolicyConfig['intervalMode'] => {
      const v = raw.intervalMode;
      return v === 'fixed' || v === 'dynamic' || v === 'both' ? v : d.intervalMode;
    })(),
    triggerOnAt: (raw.triggerOnAt as boolean) ?? d.triggerOnAt,
    triggerNames: parseStringList(raw.triggerNames),
    muteKeywords: parseStringList(raw.muteKeywords),
  };
}

export function isPlatformEnabled(cfg: TriggerPolicyConfig, platform: string | undefined): boolean {
  if (!cfg.enabled) return false;
  if (cfg.platforms.length === 0) return true;
  if (!platform) return false;
  return cfg.platforms.includes(platform);
}
