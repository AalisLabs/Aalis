import type { ToolCallContext, ToolCallRequest } from '../../packages/api-tools/src/index.js';

/** 调用方的上下文，参与者可以不写 */
export type RequestDraft = Omit<ToolCallRequest, 'participants'> & Partial<Pick<ToolCallRequest, 'participants'>>;

/**
 * 调用方交给执行器的上下文。没写参与者的按一条消息的口径补上：参与者就是物理发言者，没有发言者的是无主体（agent 由
 * api-authority 的 originTurnOf 算）
 */
export function toolRequest(request: RequestDraft): ToolCallRequest {
  return {
    ...request,
    participants: request.participants ?? [{ platform: request.platform ?? '', userId: request.userId ?? '' }],
  };
}

/**
 * 直接调工具的处理函数时交给它的上下文（参与者同 {@link toolRequest}）：取用判定照执行器在回合之外的做法，只按参与者都过判、
 * 不出审批，过不了的回第一位的原因。要出审批的用例走真的工具注册表
 */
export function toolContext(request: RequestDraft): ToolCallContext {
  const full = toolRequest(request);
  return {
    ...full,
    approveFor: async check => full.participants.map(check).find(verdict => !verdict.ok) ?? { ok: true },
  };
}
