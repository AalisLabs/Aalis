/**
 * plugin-tool-session-api —— `session-history` 服务的公共类型，
 * 以及供平台插件注入访问控制规则的 hook 接口。
 *
 * 设计要点：
 * - `SessionHistoryService.getHistory` 是统一入口，无论调用方是通用工具
 *   `session_get_history` 还是平台专属工具（如 `onebot_get_session_history`），
 *   都会走同一条 access checker 链 —— 不存在"绕过"路径。
 * - 平台插件用 `registerAccessChecker({ platform: 'onebot', check })` 注入
 *   各自的细粒度规则。每个 checker 只关心自己 platform 前缀的 sessionId，
 *   跨平台目标由 service 自带的 scope 配置粗筛。
 * - any-deny 短路：同一 platform 多个 checker 时，只要任一个返回 deny 即拒绝。
 */

import type { ToolCallContext } from '@aalis/plugin-tools-api';

/**
 * Access checker 的判定结果。
 * - `allow` / `deny` 表示显式表态
 * - 返回 `undefined` = "我不表态，继续走下一个 checker / 默认通过"
 */
export type AccessDecision = { decision: 'allow' | 'deny'; reason?: string };

export interface AccessCheckArgs {
  /** 触发调用的当前会话 sessionId（callCtx 提供） */
  currentSessionId: string;
  /** LLM 想读取的目标 sessionId */
  targetSessionId: string;
  /** 完整的工具调用上下文（含 platform/userId 等） */
  callCtx: ToolCallContext;
}

export interface AccessChecker {
  /**
   * 该 checker 只对 `targetSessionId.startsWith(platform + ':')` 的目标生效。
   * 例如 onebot 插件传 'onebot'，仅当目标是 `onebot:*` 时被询问。
   */
  platform: string;
  /**
   * 同步判定：返回 `deny` 立即拒绝；`allow` 标记显式通过；
   * 返回 `undefined` 表示不表态，由后续 checker 或默认策略接管。
   */
  check(args: AccessCheckArgs): AccessDecision | undefined;
}

/**
 * Disposer 模式：调用一次即解除注册（插件 dispose 时使用）。
 */
export type AccessCheckerDisposer = () => void;

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
      messages: Array<Record<string, unknown>>;
    }
  | { error: string };

/**
 * `session-history` 服务公开接口。由 `@aalis/plugin-tool-session` 实现并 provide。
 * 平台插件 / webui 等通过 `ctx.getService<SessionHistoryService>('session-history')` 获取。
 */
export interface SessionHistoryService {
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

  /**
   * 注册一个 access checker。返回 disposer，平台插件在 dispose 时调用以解绑。
   */
  registerAccessChecker(checker: AccessChecker): AccessCheckerDisposer;
}

declare module '@aalis/core' {
  interface ServiceTypeMap {
    'session-history': SessionHistoryService;
  }
}
