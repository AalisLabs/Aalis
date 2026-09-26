// ----- 流控配置类型与默认值 -----

export interface FlowControlConfig {
  /**
   * 统一作用域名单（multiselect），元素格式 "platform:sessionType[:targetId]"，
   * 支持 "*" 通配：onebot:group / onebot:* / *:group / * / onebot:private:10001 。
   * 默认 ['*:group'] 与历史 OneBot ChatFlow 行为一致。
   * 空数组 = 冷却与限速不生效；但若存在任一 overrides[].scope 命中也视为启用。
   * 禁言不看作用域：禁言只由关键词或平台禁言针对具体会话写入。
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

  /** 回复后冷却（秒） */
  cooldownSeconds: number;

  /** 限速窗口（秒，0 关闭） */
  rateLimitWindow: number;
  /** 窗口内最大回复次数 */
  rateLimitMaxReplies: number;
}

/**
 * 分作用域覆盖项：含 scope 字符串 + 任意字段覆盖。
 * 未指定的字段会从顶层 FlowControlConfig 默认中穿透。
 */
export interface ScopeOverride {
  scope: string;
  cooldownSeconds?: number;
  rateLimitWindow?: number;
  rateLimitMaxReplies?: number;
}

export const defaultFlowControlConfig: FlowControlConfig = {
  scopes: ['*:group'],
  overrides: [],
  cooldownSeconds: 10,
  rateLimitWindow: 0,
  rateLimitMaxReplies: 10,
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
    cooldownSeconds: (raw.cooldownSeconds as number) ?? d.cooldownSeconds,
    rateLimitWindow: (raw.rateLimitWindow as number) ?? d.rateLimitWindow,
    rateLimitMaxReplies: (raw.rateLimitMaxReplies as number) ?? d.rateLimitMaxReplies,
  };
}

function parseOverrides(raw: unknown): ScopeOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopeOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.scope !== 'string' || !obj.scope.trim()) continue;
    const o: ScopeOverride = { scope: obj.scope.trim() };
    for (const k of ['cooldownSeconds', 'rateLimitWindow', 'rateLimitMaxReplies'] as const) {
      const v = obj[k];
      if (typeof v === 'number') o[k] = v;
    }
    out.push(o);
  }
  return out;
}
