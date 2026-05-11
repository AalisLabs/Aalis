// ----- Gateway 服务接口 -----
//
// Gateway 是 Aalis 的运行时编排中枢：
//   - 入站：监听 `inbound:message`，按 INBOUND_PHASE_ORDER 顺序运行
//           inbound:command → inbound:flow → inbound:trigger → inbound:dispatch
//           四个命名相位，dispatch 的默认动作是调用 agent.handleMessage。
//           前三相位任一被 swallow（handler 不调用 next）即停止后续调度。
//   - 出站：提供 `dispatchOutbound()` 接口，运行 `outbound:dispatch` 钩子链，
//           默认动作是向 `outbound:message` 事件总线广播，平台插件接收并发送。
//
// core 不再绑定具体的路由实现，gateway 服务由 plugin-gateway 提供。
// 完整发行入口可通过 `requiredServices` 声明 gateway 依赖；最小应用可不加载 gateway，
// 由 core fallback 入站路由直接派发给 agent。

import type { AgentService } from '@aalis/plugin-agent-api';
import type { IncomingMessage, OutgoingMessage } from '@aalis/plugin-message-api';

/**
 * 入站相位共享数据结构
 *
 * 同一条消息在 `inbound:command` → `inbound:flow` → `inbound:trigger`
 * → `inbound:dispatch` 四个相位间被同一对象引用传递。
 */
export interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  /** 当前可用的 agent 服务；plugin-gateway 在调度前已注入。 */
  agent: AgentService | undefined;
}

// ----- Gateway 域钩子声明 -----

declare module '@aalis/core' {
  interface HookContextMap {
    'inbound:command': InboundPhaseData;
    'inbound:flow': InboundPhaseData;
    'inbound:trigger': InboundPhaseData;
    'inbound:dispatch': InboundPhaseData;
    /**
     * Gateway 出站钩子链（洋葱模型）。
     * 由 `GatewayService.dispatchOutbound()` 发起。
     */
    'outbound:dispatch': {
      message: OutgoingMessage;
      metadata: Record<string, unknown>;
    };
  }
  interface AalisEvents {
    /**
     * Gateway 某个入站相位执行完毕（无论是否被 swallow）。
     *
     * 遥测插件可订阅此事件以：
     *   - 记录每个相位耗时
     *   - 统计 swallow 率
     *   - 追踪消息在管道中的流转路径
     *
     * 对主流程零侵入：observer 的异常不会影响入站处理。
     */
    'gateway:phase:done': [
      data: {
        phase: string;
        /** true = 链走到底（未被 swallow）；false = 某 handler 未调用 next() 终止了链 */
        reachedEnd: boolean;
        durationMs: number;
        sessionId: string;
        platform: string;
      },
    ];
  }
}

/**
 * Gateway 服务 —— 消息流编排中枢
 *
 * 默认实现由 `@aalis/plugin-gateway` 提供。
 * 业务层不应再直接 `emit('outbound:message')`，而应调用 `dispatchOutbound()`，
 * 以便所有出站消息都经过 outbound:dispatch 钩子链（脱敏、限速、审计等）。
 */
export interface GatewayService {
  /**
   * 主动注入一条入站消息（用于 idle-trigger、webui 直发、内部自检等）。
   * 与直接 `emit('inbound:message')` 等价 —— 都会走 gateway 入站相位链。
   */
  ingressMessage(message: IncomingMessage): Promise<void>;

  /**
   * 派发一条出站消息。
   *
   * 替代 `ctx.emit('outbound:message', msg)` —— 后者将逐步迁移：
   *   - 平台适配器仍可监听 `outbound:message` 接收最终发送指令；
   *   - 发出方应改用本接口，以经过 `outbound:dispatch` 钩子链。
   */
  dispatchOutbound(message: OutgoingMessage): Promise<void>;
}

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
 *
 * @note 该常量原位于 @aalis/core，cleanup-7 后迁到此处——入站相位是 gateway 的概念，
 *       core 不应知晓。
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

export type InboundPhase = (typeof INBOUND_PHASE_ORDER)[number];
