// ----- Laya 触发判定配置 -----

interface LayaConfig {
  /**
   * 作用域名单：platform:sessionType[:targetId]，支持 *。默认 ['*:group']；空数组 = 不判定任何会话。
   * 作用域外的消息直接放行（私聊默认不在内：放行后由 flow 与 agent 照常处理）。
   * 若存在任一 overrides[].scope 命中也视为启用。
   */
  scopes: string[];
  /**
   * 分作用域覆盖 threshold：最具体匹配优先（targetId > sessionType > platform > 通配）。
   * 写一条 override 即自动启用该 scope，无需重复在 scopes 中列出。
   */
  overrides: LayaScopeOverride[];
  /** 开口阈值：logit ≥ 阈值即开口。undefined = 用侧车随响应返回的模型阈值 */
  threshold?: number;
  // 以下三项决定"被点名"。点名不决定开不开口（由模型判定），只决定开口后的类别（immediate / interval）
  // 与授权主体，以及判定不可用时的兜底（只回点名）
  /** @ 自己算点名 */
  triggerOnAt: boolean;
  /** 戳一戳等注意力动作（noticeType=poke）算点名 */
  triggerOnPoke: boolean;
  /** 额外的点名名字（除 persona 名字与昵称外的别名） */
  triggerNames: string[];
  /** 禁言关键词（命中时设置自禁言、吞掉本条） */
  muteKeywords: string[];
  /** 禁言关键词命中时通知 flow-control 设置的禁言时长（秒） */
  muteTimeSeconds: number;
  /** 带附件的消息等识别写好描述的上限（毫秒），超时照常判定、识别在后台继续 */
  mediaWaitMs: number;
  /** 侧车地址（不带末尾斜杠） */
  endpoint: string;
  /** 单次请求的超时（毫秒），含读完响应体 */
  timeoutMs: number;
  /** 窗口行数，只算 user / assistant 且正文是字符串的行（从 memory 多取一倍，过滤后留最后这么多行；取法见 toRows） */
  historyRows: number;
  /** 在 trigger 服务里的优先级，越大越优先；规则判定 trigger-policy 为 0 */
  priority: number;
}

interface LayaScopeOverride {
  scope: string;
  threshold?: number;
}

export const defaultLayaConfig: LayaConfig = {
  scopes: ['*:group'],
  overrides: [],
  triggerOnAt: true,
  triggerOnPoke: true,
  triggerNames: [],
  muteKeywords: [],
  muteTimeSeconds: 60,
  mediaWaitMs: 8000,
  endpoint: 'http://127.0.0.1:17878',
  timeoutMs: 1000,
  historyRows: 80,
  priority: 10,
};

/** 有限数原样返回；留空（undefined / null / ''）与非法值都返回 undefined */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

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

export function resolveLayaConfig(raw: Record<string, unknown>): LayaConfig {
  const d = defaultLayaConfig;
  const muteTimeSeconds = finite(raw.muteTimeSeconds);
  const mediaWaitMs = finite(raw.mediaWaitMs);
  const timeoutMs = finite(raw.timeoutMs);
  const historyRows = raw.historyRows;
  return {
    scopes: raw.scopes === undefined ? d.scopes : parseStringList(raw.scopes),
    overrides: parseOverrides(raw.overrides),
    threshold: finite(raw.threshold),
    triggerOnAt: typeof raw.triggerOnAt === 'boolean' ? raw.triggerOnAt : d.triggerOnAt,
    triggerOnPoke: typeof raw.triggerOnPoke === 'boolean' ? raw.triggerOnPoke : d.triggerOnPoke,
    triggerNames: parseStringList(raw.triggerNames),
    muteKeywords: parseStringList(raw.muteKeywords),
    muteTimeSeconds:
      muteTimeSeconds !== undefined && muteTimeSeconds > 0 ? Math.floor(muteTimeSeconds) : d.muteTimeSeconds,
    mediaWaitMs: mediaWaitMs !== undefined && mediaWaitMs >= 0 ? mediaWaitMs : d.mediaWaitMs,
    endpoint:
      typeof raw.endpoint === 'string' && raw.endpoint.trim() ? raw.endpoint.trim().replace(/\/+$/, '') : d.endpoint,
    timeoutMs: timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : d.timeoutMs,
    historyRows: Number.isInteger(historyRows) && (historyRows as number) > 0 ? (historyRows as number) : d.historyRows,
    priority: finite(raw.priority) ?? d.priority,
  };
}

function parseOverrides(raw: unknown): LayaScopeOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: LayaScopeOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.scope !== 'string' || !obj.scope.trim()) continue;
    // 留空的字段不写键：resolveEffectiveConfig 只叠加有值的键，未列字段穿透到顶层
    const o: LayaScopeOverride = { scope: obj.scope.trim() };
    const threshold = finite(obj.threshold);
    if (threshold !== undefined) o.threshold = threshold;
    out.push(o);
  }
  return out;
}
