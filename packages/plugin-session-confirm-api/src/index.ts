// ----- 会话确认服务契约 -----
//
// 确认的「协调器」（待确认登记 / 超时 / 解析 / 文案）是平台无关的逻辑，应只实现一份。
// 但「投递」（怎么把提示发到用户）与「拦截点」（在哪儿截获回复）因平台而异：
//   - onebot/cli：投递走 gateway 总线，拦截在 inbound:confirm 相位（后端一层即可）。
//   - webui：投递走 WS type:'confirm'（兼作前端「确认模式」信号，抑制富客户端的「打字即打断」），
//            拦截在 WS-onmessage。
//
// 本服务（由 plugin-session-confirm 提供）把协调器做成可复用工厂：调用方注入自己的 deliver，
// 拿回 { handler, feed } —— handler 注册到 authority.setConfirmHandler，feed 在自己的拦截点调用。
// 功能在插件、契约在本 -api，各平台经 DI 复用，零重复、零 plugin→plugin 依赖。

import type {} from '@aalis/core'; // declaration merging 锚点
import type { AccessConfirmHandler, AccessRequest } from '@aalis/plugin-authority-api';

/** 一条确认通道：handler 注册到 authority；feed 在平台拦截点喂回复。 */
export interface ConfirmChannel {
  /** authority 确认回调（注册到 setConfirmHandler(platform, ...)）。 */
  handler: AccessConfirmHandler;
  /**
   * 在平台自己的拦截点喂一条回复给该 session 的未决确认：
   * 命中并消费 → true（调用方据此「吞掉」该输入）；无未决 → false（放行）。
   */
  feed(sessionId: string, replyText: string): boolean;
}

export interface SessionConfirmService {
  /**
   * 创建一条确认通道：用 deliver 投递提示文案到 request 所在会话；返回 { handler, feed }。
   * 调用方把 handler 注册到 authority.setConfirmHandler(platform, ...)，并在自己的拦截点调 feed。
   */
  createChannel(deliver: (request: AccessRequest, text: string) => void): ConfirmChannel;
}

declare module '@aalis/core' {
  interface ServiceTypeMap {
    'session-confirm': SessionConfirmService;
  }
}
