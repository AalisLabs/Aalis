// ----- Laya 触发判定配置 -----

type LayaMode = 'off' | 'shadow' | 'live';

interface LayaConfig {
  /** off=弃权不判定；shadow=判定只记日志，照常弃权交给后面的提供者；live=按模型判定开不开口 */
  mode: LayaMode;
  /** 开口阈值：logit ≥ 阈值即开口。undefined = 用侧车随响应返回的模型阈值 */
  threshold?: number;
  /** 侧车地址（不带末尾斜杠） */
  endpoint: string;
  /** 单次请求的超时（毫秒），含读完响应体 */
  timeoutMs: number;
  /** 窗口行数，只算 user / assistant 行（从 memory 多取一倍，过滤后留最后这么多行，与侧车渲染回归的取法一致） */
  historyRows: number;
  /** 提供者优先级，越大越先问；规则提供者为 0 */
  priority: number;
  /**
   * 分作用域覆盖 mode / threshold：最具体匹配优先（targetId > sessionType > platform > 通配）。
   * 没有自己的 scopes：哪些消息会问到本提供者由宿主 trigger-policy 的作用域决定。
   */
  overrides: LayaScopeOverride[];
}

interface LayaScopeOverride {
  scope: string;
  mode?: LayaMode;
  threshold?: number;
}

export const defaultLayaConfig: LayaConfig = {
  mode: 'shadow',
  endpoint: 'http://127.0.0.1:17878',
  timeoutMs: 1000,
  historyRows: 80,
  priority: 10,
  overrides: [],
};

function isMode(v: unknown): v is LayaMode {
  return v === 'off' || v === 'shadow' || v === 'live';
}

/** 有限数原样返回；留空（undefined / null / ''）与非法值都返回 undefined */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function resolveLayaConfig(raw: Record<string, unknown>): LayaConfig {
  const d = defaultLayaConfig;
  const timeoutMs = finite(raw.timeoutMs);
  const historyRows = raw.historyRows;
  return {
    mode: isMode(raw.mode) ? raw.mode : d.mode,
    threshold: finite(raw.threshold),
    endpoint:
      typeof raw.endpoint === 'string' && raw.endpoint.trim() ? raw.endpoint.trim().replace(/\/+$/, '') : d.endpoint,
    timeoutMs: timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : d.timeoutMs,
    historyRows: Number.isInteger(historyRows) && (historyRows as number) > 0 ? (historyRows as number) : d.historyRows,
    priority: finite(raw.priority) ?? d.priority,
    overrides: parseOverrides(raw.overrides),
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
    if (isMode(obj.mode)) o.mode = obj.mode;
    const threshold = finite(obj.threshold);
    if (threshold !== undefined) o.threshold = threshold;
    out.push(o);
  }
  return out;
}
