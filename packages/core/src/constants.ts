/**
 * Aalis 核心常量
 */

/**
 * `gateway:inbound` 中间件优先级约定（数值越大越先执行）。
 *
 * 三个核心插件占用的优先级是稳定 API，第三方插件应避免冲突。
 * 自定义中间件请使用 `CUSTOM_MAX` 以下范围（即 0–600）。
 *
 * 优先级链：
 *   1000 → commands         （命令拦截：命中即中断，不 next()）
 *   900  → flow-control     （流控闸门：禁言/冷却/限速时 swallow）
 *   700  → trigger-policy   （触发策略：mute 关键词、@ 提及、计数/评分判定）
 *   0–600 → 用户自定义       （脱敏 / 审计 / 限流等）
 *   0    → default action   （ctx.hooks.run 默认动作：调用 agent.handleMessage）
 */
export const GATEWAY_MIDDLEWARE_PRIORITY = {
  COMMANDS: 1000,
  FLOW_CONTROL: 900,
  TRIGGER_POLICY: 700,
  /** 第三方插件中间件应选择 [0, CUSTOM_MAX] 范围 */
  CUSTOM_MAX: 600,
} as const;
