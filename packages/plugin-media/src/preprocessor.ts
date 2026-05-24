// ============================================================
// preprocessor.ts — agent:input:before 预处理器
//
// 接收 IncomingMessage，调用 MediaService.processMessage 写入 _attachmentDescriptions。
// 注意：不修改 message.content；content 拼接由 plugin-message-archive 在归档阶段统一负责，
// 避免双轨制导致的描述重复（preprocessor 与 archive 之前都会拼描述 → 出现两遍）。
// ============================================================

import type { Context } from '@aalis/core';
import type { PreprocessorFn } from '@aalis/plugin-agent-api';
import type { MediaService } from '@aalis/plugin-media-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';

export function buildPreprocessor(ctx: Context, getService: () => MediaService): PreprocessorFn {
  return async function mediaPreprocessor(message: IncomingMessage, next: () => Promise<void>) {
    if (!message) return next();
    if (!message.attachments || message.attachments.length === 0) return next();

    const svc = getService();
    if (!svc) return next();

    try {
      const report = await svc.processMessage(message);
      await ctx.emit('media:processed', { sessionId: message.sessionId, report });
    } catch (err) {
      ctx.logger.warn(`media preprocessor 失败: ${err instanceof Error ? err.message : err}`);
    }
    return next();
  };
}
