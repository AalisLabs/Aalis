// ============================================================
// @aalis/api-flow-control — 流控服务契约
//
// 导出运行时描述符 `flowControl`（defineService）与类型。下游消费者
// （平台 adapter、trigger-policy 等）应当 `import { flowControl } from
// '@aalis/api-flow-control'` 写入 uses，而不是依赖 plugin-flow-control
// 具体实现：实现包可被替换、可被禁用。
//
// FlowControlService 是会话级节流硬闸，只管"能不能说"，不管"要不要说"：
//   - 禁言（禁言关键词或平台禁言事件写入，落盘，重启后恢复）
//   - 回复后冷却
//   - 限速窗口
// 冷却与限速按 agent 的真实回复（outbound:message，source=agent）计。
// "要不要开口"由触发插件决定（trigger 服务的胜者，如 trigger-policy 的 @/名字/计数评分/闲置主动开口）。
//
// 服务名：'flow-control'
// ============================================================

import { defineService } from '@aalis/core';

export interface FlowControlService {
  /** 当前是否在禁言期 */
  isMuted(sessionId: string): boolean;
  /** 当前是否在回复后冷却期 */
  isCoolingDown(sessionId: string): boolean;
  /** 限速窗口内的回复数是否已达上限（true 表示已超限） */
  isRateLimited(sessionId: string): boolean;
  /**
   * 设置或解除禁言（禁言关键词命中或平台禁言事件时调用）。
   * - durationSec > 0：禁言到 now + durationSec 秒
   * - durationSec <= 0：解除禁言
   * 会话尚无流控状态时，只有同时给出 platform 才会建立状态并禁言。
   */
  setMuted(sessionId: string, durationSec: number, platform?: string): void;
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
// 下游把 `flowControl` 写入 uses；类型随描述符走，不必依赖实现包。
export const flowControl = defineService<FlowControlService>('flow-control');
