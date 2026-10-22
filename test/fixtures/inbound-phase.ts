import { chatScopeOf, type InboundPhaseData } from '../../packages/api-gateway/src/index.js';
import { sessionTypesOf } from '../../packages/api-platform/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';

/**
 * 入站相位的数据，与网关在平台服务缺席时给的相同：没有 source 的入站带聊天窗口（按没声明类型算：类型名是 private 或不带类型名的
 * 按一对一，别的按多方），带 source 的不带。直接驱动相位钩子链的用例用它
 */
export const phaseData = (message: IncomingMessage): InboundPhaseData => ({
  message,
  metadata: {},
  agent: undefined,
  ...(message.source ? {} : { chat: chatScopeOf(message, sessionTypesOf(undefined)) }),
});
