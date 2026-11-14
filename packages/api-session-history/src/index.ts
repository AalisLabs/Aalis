/**
 * api-session-history —— `session-history` 服务的公共类型。
 *
 * `SessionHistoryService.getHistory` 是读会话历史的统一入口：通用工具 `session_get_history` 与平台专属工具（如
 * `onebot_get_session_history`）都经它读，每次按会话管理的规则判能不能读（api-session-manager 的 `takeFrom`），
 * 经工具调用上下文的 approveFor 逐个参与者判。
 */

import type { ToolCallContext } from '@aalis/api-tools';
import { defineService } from '@aalis/core';

/**
 * `session-history` 返回结果。要么 `ok: true` 携带消息列表，要么 `error` 携带原因。
 */
export type SessionHistoryReadResult =
  | {
      ok: true;
      sessionId: string;
      count: number;
      limit: number;
      includeArchived: boolean;
      /** 若按时间区间检索，回显实际生效的 [fromTs, toTs]（毫秒）；纯条数检索时缺省。 */
      range?: { fromTs: number; toTs: number };
      /** 区间模式：窗口内消息多于返回条数（被 limit/后端上限截断）时为 true。 */
      truncated?: boolean;
      /**
       * 条数模式：返回不满 limit 条时，读到的记录里略去的非对话记录（事件标记，如指令的回复、压缩分隔线）条数；没略去时缺省。
       */
      omittedNonConversation?: number;
      messages: Array<Record<string, unknown>>;
    }
  | { error: string };

/**
 * `session-history` 服务公开接口。
 * 平台插件 / webui 等：`import { sessionHistory } from '@aalis/api-session-history'`，写入 uses。
 */
export interface SessionHistoryService {
  /**
   * 读 options.sessionId 的历史。callCtx 的会话是取的一方，经 callCtx 的 approveFor 逐个参与者过会话管理的规则（有人过不了
   * 时发一道参与者审批，由过得了的人批）；不放行时回 `{ error: 原因 }`
   */
  getHistory(
    options: {
      sessionId: string;
      limit?: number;
      includeArchived?: boolean;
      /** 时间区间下界（毫秒）。给定 sinceTs 或 untilTs 任一即进入区间检索模式。 */
      sinceTs?: number;
      /** 时间区间上界（毫秒）。区间模式下省略时默认取「现在」。 */
      untilTs?: number;
    },
    callCtx: ToolCallContext,
  ): Promise<SessionHistoryReadResult>;
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const sessionHistory = defineService<SessionHistoryService>('session-history');
