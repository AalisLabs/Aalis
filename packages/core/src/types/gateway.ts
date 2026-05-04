// ----- Gateway 服务接口 -----
//
// Gateway 是 Aalis 的运行时编排中枢：
//   - 入站：监听 `inbound:message`，运行 `gateway:inbound` 钩子链，
//           默认动作是调用 agent.handleMessage。
//           中间件（commands / trigger-policy / flow-control 等）可拦截、过滤、改写。
//   - 出站：提供 `dispatchOutbound()` 接口，运行 `gateway:outbound` 钩子链，
//           默认动作是向 `outbound:message` 事件总线广播，平台插件接收并发送。
//
// core 不再绑定具体的路由实现，gateway 服务由 plugin-gateway 提供，
// 应用入口通过 `requiredServices` 声明依赖。

import type { IncomingMessage, OutgoingMessage } from './core.js';

/**
 * Gateway 服务 —— 消息流编排中枢
 *
 * 默认实现由 `@aalis/plugin-gateway` 提供。
 * 业务层不应再直接 `emit('outbound:message')`，而应调用 `dispatchOutbound()`，
 * 以便所有出站消息都经过 gateway 中间件链（脱敏、限速、审计等）。
 */
export interface GatewayService {
  /**
   * 主动注入一条入站消息（用于 idle-trigger、webui 直发、内部自检等）。
   * 与直接 `emit('inbound:message')` 等价 —— 都会走 gateway 入站钩子链。
   */
  ingressMessage(message: IncomingMessage): Promise<void>;

  /**
   * 派发一条出站消息。
   *
   * 替代 `ctx.emit('outbound:message', msg)` —— 后者将逐步迁移：
   *   - 平台适配器仍可监听 `outbound:message` 接收最终发送指令；
   *   - 发出方应改用本接口，以经过 `gateway:outbound` 钩子链。
   */
  dispatchOutbound(message: OutgoingMessage): Promise<void>;
}
