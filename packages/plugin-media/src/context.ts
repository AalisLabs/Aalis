// ============================================================
// context.ts — 为 vision 识别构造上下文 hint
//
// 由 image-rec 的 buildIncomingImageContext 移植而来。把"当前消息 +
// 引用回复 + 最近历史 + (可选) 发送者画像"压成一段文本，注入 vision LLM 提示词。
//
// 设计要点：
// - 发送者画像（sender context）从 plugin-user-profile 写入的 memory metadata
//   namespace `user:profile` 读取。namespace 名称是 user-profile 的内部常量，
//   这里 hardcode 是有意的折中：避免 plugin-media 反向 import user-profile，
//   也避免新增一个空的 user-profile-api 包。两边保持一致即可。
// - 任何读取失败/服务缺失都**静默跳过**，绝不阻断 vision 主流程。
// ============================================================

import type { Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';

const HISTORY_LIMIT_DEFAULT = 4;
/** plugin-user-profile 写入 metadata 时使用的 namespace；保持同步！ */
const USER_PROFILE_NAMESPACE = 'user:profile';

/**
 * vision 上下文中发送者画像注入的配置。
 * - enabled=false → 整块跳过
 * - profileMaxChars=0 → 不注入 profile（当前仅 profile 一项，等同 enabled=false）
 */
interface SenderContextConfig {
  enabled: boolean;
  /** profile 摘要的总字符上限，超过截断。0=禁用 profile 部分。 */
  profileMaxChars: number;
}

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
 * 读取发送者的 user-profile 摘要（仅事实文本列表，以 "；" 分隔）。
 * 任何失败都返回空串，调用方原样跳过。
 */
async function loadSenderProfileSummary(
  ctx: Context,
  platform: string | undefined,
  userId: string | undefined,
  maxChars: number,
): Promise<string> {
  if (maxChars <= 0 || !userId) return '';
  try {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getMetadata) return '';
    const key = `${platform ?? ''}:${userId}`;
    const doc = await memory.getMetadata(USER_PROFILE_NAMESPACE, key);
    if (!doc) return '';
    const rawFacts = Array.isArray(doc.facts) ? (doc.facts as unknown[]) : [];
    const texts = rawFacts
      .map(item => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const t = (item as Record<string, unknown>).text;
          return typeof t === 'string' ? t.trim() : '';
        }
        return '';
      })
      .filter(t => t.length > 0);
    if (texts.length === 0) return '';
    const joined = texts.join('；');
    return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
  } catch (err) {
    ctx.logger.debug(`读取发送者 user-profile 失败: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

/**
 * 从 IncomingMessage + memory 历史构造上下文文本。
 * 优先级：当前消息 > 引用消息 > 最近 N 条历史 > 发送者画像。
 */
export async function buildIncomingImageContext(
  ctx: Context,
  msg: IncomingMessage,
  beforeLimit = HISTORY_LIMIT_DEFAULT,
  senderCfg?: SenderContextConfig,
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

  // 发送者画像（可配置，失败不阻断）
  if (senderCfg?.enabled && msg.userId) {
    const summary = await loadSenderProfileSummary(ctx, msg.platform, msg.userId, senderCfg.profileMaxChars);
    if (summary) {
      const who = msg.nickname ? `${msg.nickname}(${msg.userId})` : msg.userId;
      lines.push(`发送者画像[${who}]: ${summary}`);
    }
  }

  return lines.join('\n');
}
