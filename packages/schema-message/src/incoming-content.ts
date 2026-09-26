// ============================================================
// incoming-content.ts — 入站消息的归档文本
//
// 归档（plugin-message-archive）与需要"看到和归档一样的这条消息"的判定方（如触发判定模型）
// 共用同一份拼法；两边各写一份会让判定时看到的当前消息与历史里存下的那条逐字漂移。
// ============================================================

import { getSenderLabel, prefixSender } from './identity.js';
import type { IncomingMessage } from './index.js';

/** 单用户平台：无需发送者前缀（不存在多人说话歧义） */
const SINGLE_USER_PLATFORMS = new Set(['webui', 'cli']);

/**
 * 入站消息 → 归档文本：多用户平台加发送者前缀，引用回复与附件描述（`_attachmentDescriptions`）
 * 追加在末尾。附件描述须已写好（识别由 plugin-media 负责，本函数只拼接）。
 */
export function buildIncomingContent(incoming: IncomingMessage): string {
  const useSenderPrefix = !SINGLE_USER_PLATFORMS.has(incoming.platform);
  let content = useSenderPrefix ? prefixSender(incoming.content, incoming.nickname, incoming.userId) : incoming.content;

  // 引用回复：把被引用消息的标签 + 内容拼到末尾，作为不可分割的上下文
  // 与图片描述、forward 摘要相同处理逻辑——把"非当前指令"的素材烘焙进归档文本，
  // 这样下一轮从 memory 拉历史时仍能看到引用关系。
  if (incoming.replyTo?.content) {
    const replyLabel = getSenderLabel(incoming.replyTo.nickname, incoming.replyTo.userId) ?? '?';
    content += `\n[引用 ${replyLabel} 的消息: ${incoming.replyTo.content}]`;
  }

  // 把 plugin-media 写入的 _attachmentDescriptions 按 attachments 顺序追加。
  // 这里是图片/语音/视频描述合入对话文本的**唯一**入口——preprocessor 只负责写 descs，不改 content。
  const attDescs = incoming._attachmentDescriptions;
  if (attDescs && attDescs.length > 0) {
    const lines = attDescs.filter((d): d is string => Boolean(d?.trim()));
    if (lines.length > 0) {
      const attachText = lines.join('\n');
      content = content ? `${content}\n${attachText}` : attachText;
    }
  }

  return content;
}
