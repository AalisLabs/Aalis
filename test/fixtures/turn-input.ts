import type { TurnInput } from '../../packages/api-agent/src/index.js';
import type { IncomingMessage, Message } from '../../packages/schema-message/src/index.js';

/**
 * 一轮里的一条输入：没写的几项取占位（会话 s1、平台 onebot、空正文）；给了 archived 的带上归档的那一条。直接构造提示词
 * 贡献的视图与回合钩子数据的用例用它
 */
export function turnInput(message: Partial<IncomingMessage> = {}, archived?: Message): TurnInput {
  return {
    message: { content: '', sessionId: 's1', platform: 'onebot', ...message },
    ...(archived ? { archived } : {}),
  };
}

/**
 * 这一轮只有一条输入：messages 里最后一条 user 消息，归档的就是它（直接构造视图、按这一轮输入取材的用例用，如向量召回的检索词）。
 * 没有 user 消息时没有输入
 */
export function inputFromLastUser(messages: readonly Message[]): TurnInput[] {
  const last = messages.findLast(m => m.role === 'user');
  return last ? [turnInput({ content: typeof last.content === 'string' ? last.content : '' }, last)] : [];
}
