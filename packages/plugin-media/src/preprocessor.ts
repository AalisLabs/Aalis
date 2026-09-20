// ============================================================
// preprocessor.ts — agent:input:before 预处理器
//
// 接收 IncomingMessage，调用 MediaService.processMessage 写入 _attachmentDescriptions。
// 注意：不修改 message.content；content 拼接由 plugin-message-archive 在归档阶段统一负责，
// 避免双轨制导致的描述重复（preprocessor 与 archive 之前都会拼描述 → 出现两遍）。
// ============================================================

import type { PreprocessorFn } from '@aalis/api-agent';
import type { MediaService } from '@aalis/api-media';
import type { Events, Logger } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';

/** 预处理器用到的能力：广播 media:processed 的 events，与记失败的 logger */
export interface PreprocessorCaps {
  events: Events;
  logger: Logger;
}

export function buildPreprocessor(caps: PreprocessorCaps, getService: () => MediaService): PreprocessorFn {
  return async function mediaPreprocessor(message: IncomingMessage, next: () => Promise<void>) {
    if (!message) return next();
    if (!message.attachments || message.attachments.length === 0) return next();

    const svc = getService();
    if (!svc) return next();

    try {
      const report = await svc.processMessage(message);
      await caps.events.emit('media:processed', { sessionId: message.sessionId, report });
    } catch (err) {
      caps.logger.warn(`media preprocessor 失败: ${err instanceof Error ? err.message : err}`);
    }
    return next();
  };
}
