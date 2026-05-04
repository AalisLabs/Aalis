/**
 * Aalis 核心常量
 */

// ----- Gateway 入站生命周期相位 -----

/**
 * Gateway 入站消息生命周期相位（按下面的顺序串行执行）。
 *
 * 每个相位是一个独立的命名钩子键，对应一个职责清晰的拦截点。
 * 同一相位内部的多个 handler 按 **注册顺序** 执行洋葱模型 (next 语义)，
 * 跨相位则由 plugin-gateway 顺序调度，无需任何优先级数字。
 *
 *   COMMAND  → 指令解析与执行（由 plugin-commands 占据）
 *   FLOW     → 流控前置闸门（禁言/冷却/限速；由 plugin-flow-control 占据）
 *   TRIGGER  → 触发策略判定（mute 关键词/@/计数评分；由 plugin-trigger-policy 占据）
 *   DISPATCH → 默认派发到 agent.handleMessage（plugin-gateway 提供 default action）
 *
 * 任一相位的 handler 不调用 next() 即视为"我已处理"，
 * 整个入站管道立即停止（不再进入后续相位）。
 *
 * 第三方插件可以注册到任一相位以获得清晰的语义位置，
 * 无需理解优先级数字、无需与其他插件协商占位。
 */
export const INBOUND_PHASE = {
  COMMAND: 'inbound:command',
  FLOW: 'inbound:flow',
  TRIGGER: 'inbound:trigger',
  DISPATCH: 'inbound:dispatch',
} as const;

/** 默认相位执行顺序（gateway 内部调度使用）。 */
export const INBOUND_PHASE_ORDER = [
  INBOUND_PHASE.COMMAND,
  INBOUND_PHASE.FLOW,
  INBOUND_PHASE.TRIGGER,
  INBOUND_PHASE.DISPATCH,
] as const;

export type InboundPhase = typeof INBOUND_PHASE_ORDER[number];
