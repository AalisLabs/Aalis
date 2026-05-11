// ----- Trigger Policy 服务接口 -----
//
// TriggerPolicyService 决定一条入站消息是否应当触发 agent。
// 决策只读：实际状态变更（计数器重置、冷却记录）由 FlowControlService 完成。

import type { IncomingMessage } from '@aalis/plugin-message-api';

export type TriggerKind = 'immediate' | 'interval' | 'swallow' | 'direct';

export interface TriggerDecision {
  kind: TriggerKind;
  /** 调试/日志用 */
  reason: string;
}

export interface TriggerPolicyService {
  /** 综合决策（含 @/名字检测、间隔/评分判定、私聊直放等） */
  decide(message: IncomingMessage): TriggerDecision;
  /** 当前生效的 bot 名称别名列表（含 persona） */
  getBotNames(): string[];
  /** 检查内容是否含 mute 关键词 */
  detectMuteKeyword(content: string): boolean;
}
