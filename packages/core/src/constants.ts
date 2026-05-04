/**
 * Aalis 核心常量
 */

/**
 * `gateway:inbound` 中间件优先级约定（数值越大越先执行）。
 *
 * 核心插件只占用少量锚点；第三方插件应优先选择下方命名分段，
 * 并在分段内使用小 offset（例如 CUSTOM_AFTER_TRIGGER - 10）。
 * 同优先级按注册顺序执行，因此同分值只适合顺序无关的中间件。
 *
 * 优先级链：
 *   1000 → commands         （命令拦截：命中即中断，不 next()）
 *   900  → flow-control     （流控闸门：禁言/冷却/限速时 swallow）
 *   700  → trigger-policy   （触发策略：mute 关键词、@ 提及、计数/评分判定）
 *   600  → custom before agent（脱敏 / 审计 / 追加 metadata 等）
 *   0    → 普通自定义中间件默认值
 *   <0   → late custom       （观测 / 兜底处理；仍早于 default action）
 *   default action           （所有中间件 next() 后调用 agent.handleMessage）
 */
export const GATEWAY_MIDDLEWARE_PRIORITY = {
  COMMANDS: 1000,
  FLOW_CONTROL: 900,
  TRIGGER_POLICY: 700,
  /** 第三方插件：在触发策略之后、agent 之前执行。 */
  CUSTOM_AFTER_TRIGGER: 600,
  /** 第三方插件：普通默认优先级；适合顺序无关的中间件。 */
  CUSTOM_DEFAULT: 0,
  /** 第三方插件：尽量靠后，但仍早于 default action。 */
  CUSTOM_LATE: -100,
} as const;

/** 通用 hook/middleware 默认优先级。 */
export const HOOK_DEFAULT_PRIORITY = 0;
