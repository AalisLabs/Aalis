// ============================================================
// preprocessor.ts — agent:input:before 预处理器
//
// 接收 IncomingMessage，归一化为 attachments，调用 MediaService.processMessage，
// 若有任何描述则把它们以 [图片描述] / [语音] / [视频] 等可读形式追加到 msg.content。
// ============================================================

import type { Context } from '@aalis/core';
import type { PreprocessorFn } from '@aalis/plugin-agent-api';
import type { MediaService } from '@aalis/plugin-media-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';

const KIND_TAG: Record<string, string> = {
  image: '图片',
  audio: '语音',
  video: '视频',
  file: '文件',
};

export function buildPreprocessor(ctx: Context, getService: () => MediaService): PreprocessorFn {
  return async function mediaPreprocessor(message: IncomingMessage, next: () => Promise<void>) {
    if (!message) return next();
    if (!message.attachments || message.attachments.length === 0) return next();

    const svc = getService();
    if (!svc) return next();

    try {
      const report = await svc.processMessage(message);
      if (report.successCount > 0) {
        const lines: string[] = [];
        const atts = message.attachments ?? [];
        const descs = message._attachmentDescriptions ?? [];
        for (let i = 0; i < atts.length; i++) {
          const d = descs[i];
          if (!d) continue;
          const tag = KIND_TAG[atts[i].kind] ?? '附件';
          lines.push(`[${tag}: ${d}]`);
        }
        if (lines.length > 0) {
          message.content = message.content ? `${message.content}\n${lines.join('\n')}` : lines.join('\n');
        }
      }
      await ctx.emit('media:processed', { sessionId: message.sessionId, report });
    } catch (err) {
      ctx.logger.warn(`media preprocessor 失败: ${err instanceof Error ? err.message : err}`);
    }
    return next();
  };
}
