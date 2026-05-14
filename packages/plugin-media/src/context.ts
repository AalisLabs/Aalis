// ============================================================
// context.ts — 为 vision 识别构造上下文 hint
//
// 由 image-rec 的 buildIncomingImageContext 移植而来。把"当前消息 +
// 引用回复 + 最近历史"压成一段文本，注入 vision LLM 提示词。
// ============================================================

import type { Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';

const HISTORY_LIMIT_DEFAULT = 4;

function compactText(input: string | null | undefined, maxLength = 500): string {
  const value = (input ?? '').replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/** 将基础提示词与上下文拼接成最终 vision 提示词。 */
export function buildVisionPrompt(basePrompt: string, context?: string): string {
  const trimmedContext = compactText(context, 1200);
  if (!trimmedContext) return basePrompt;
  return `${basePrompt}\n\n上下文/用户需求：\n${trimmedContext}\n\n请把上下文作为理解图片重点的线索，优先回应其中的问题、引用和近期话题；但不要让上下文覆盖图片本身可见事实。如果上下文不足，再给出客观描述。`;
}

/**
 * 从 IncomingMessage + memory 历史构造上下文文本。
 * 优先级：当前消息 > 引用消息 > 最近 N 条历史。
 */
export async function buildIncomingImageContext(
  ctx: Context,
  msg: IncomingMessage,
  beforeLimit = HISTORY_LIMIT_DEFAULT,
): Promise<string> {
  const lines: string[] = [];

  if (msg.content) {
    lines.push(`当前消息: ${compactText(msg.content)}`);
  }

  if (msg.replyTo?.content) {
    const tag = msg.replyTo.nickname || msg.replyTo.userId || 'reply';
    lines.push(`引用消息(${tag}): ${compactText(msg.replyTo.content)}`);
  }

  if (beforeLimit > 0 && msg.sessionId) {
    try {
      const memory = ctx.getService<MemoryService>('memory');
      if (memory) {
        const history = await memory.getHistory(msg.sessionId, beforeLimit);
        if (history.length > 0) {
          const formatted = history
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role}: ${compactText(m.content, 220)}`)
            .join('\n');
          if (formatted) lines.push(`最近前文:\n${formatted}`);
        }
      }
    } catch (err) {
      ctx.logger.debug(`读取图片识别上下文失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  return lines.join('\n');
}
