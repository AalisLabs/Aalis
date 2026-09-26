// ----- 流控配置类型与默认值 -----

export interface FlowControlConfig {
  /**
   * 统一作用域名单（multiselect），元素格式 "platform:sessionType[:targetId]"，
   * 支持 "*" 通配：onebot:group / onebot:* / *:group / * / onebot:private:10001 。
   * 默认 ['*:group'] 与历史 OneBot ChatFlow 行为一致；默认作用域不含 WebUI/CLI，如需纳入，显式添加。
   * 冷却与限速只对作用域内会话生效：入站过闸与回复记账都看它（委派闸门、闲置选会话读的是这份记账）；
   * 禁言不看（禁言只由关键词或平台禁言针对具体会话写入）。入站不带会话类型的消息（定时任务等内部注入）与回复
   * 记账先用会话记下的类型，没有再按会话 ID 约定推断；不符合约定、类型未知的只有会话类型段为通配的作用域
   * （onebot:*、*）命中。
   * 空数组 = 冷却与限速对任何会话都不生效；但若存在任一 overrides[].scope 命中也视为启用。
   */
  scopes: string[];

  /**
   * 分作用域覆盖：每条覆盖针对一个 scope 字符串（语法同 scopes，3 段），
   * 仅在该 scope 命中时把列出的字段覆盖到顶层默认之上；未列字段穿透到顶层。
   * 命中时按"最具体优先"挑选（targetId > sessionType > platform > 通配）。
   * 写一条 override 即自动启用该 scope，无需重复在 scopes 中列出。
   * 局限：从未有真人消息经过本相位、会话 ID 又不符合约定的会话（如仅经委派抵达的 WebUI 会话）没有
   * sessionType / targetId，按类型或目标写的覆盖对其不生效，走顶层配置。
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
