// ----- 触发策略配置 -----

export interface TriggerPolicyConfig {
  enabled: boolean;
  /** 仅对这些 platform 生效（空数组=所有 platform） */
  platforms: string[];
  /**
   * 仅对这些会话类型生效（空数组=所有）。
   * 默认 ['group']：私聊 / CLI / WebUI 不需触发判定，直接走 agent。
   */
  sessionTypes: string[];
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
  platforms: [],
  sessionTypes: ['group'],
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
    platforms: parseStringList(raw.platforms),
    sessionTypes: raw.sessionTypes === undefined ? d.sessionTypes : parseStringList(raw.sessionTypes),
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

export function isPlatformEnabled(cfg: TriggerPolicyConfig, platform: string | undefined): boolean {
  if (!cfg.enabled) return false;
  if (cfg.platforms.length === 0) return true;
  if (!platform) return false;
  return cfg.platforms.includes(platform);
}

/** 会话类型是否在触发判定范围内。空白名单 = 全部生效。 */
export function isSessionTypeEnabled(cfg: TriggerPolicyConfig, sessionType: string | undefined): boolean {
  if (cfg.sessionTypes.length === 0) return true;
  if (!sessionType) return false;
  return cfg.sessionTypes.includes(sessionType);
}
