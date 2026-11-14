// ============================================================
// input-middleware.ts — 挂在 agent:input:before 上的中间件
//
// 每条输入进一轮之前调用 MediaService.processMessage 写入 _attachmentDescriptions。
// 注意：不修改 message.content；content 拼接由 plugin-message-archive 在归档阶段统一负责，
// 避免双轨制导致的描述重复（这里与 archive 之前都会拼描述 → 出现两遍）。
// ============================================================

import type { Events } from '@aalis/api-events';
import type { HookContextMap, MiddlewareFn } from '@aalis/api-hooks';
import type { MediaService } from '@aalis/api-media';
import type { Logger, ServiceSelection } from '@aalis/core';

/** 这条中间件用到的能力：广播 media:processed 的 events，与记失败的 logger */
interface InputMiddlewareCaps {
  events: ServiceSelection<Events>;
  logger: ServiceSelection<Logger>;
}

export function buildInputMiddleware(
  caps: InputMiddlewareCaps,
  svc: MediaService,
): MiddlewareFn<HookContextMap['agent:input:before']> {
  return async function mediaInputMiddleware({ message }, next) {
    if (!message) return next();
    if (!message.attachments || message.attachments.length === 0) return next();

    try {
      const report = await svc.processMessage(message);
      await caps.events.use.emit('media:processed', { sessionId: message.sessionId, report });
    } catch (err) {
      caps.logger.use.warn(`输入阶段的媒体中间件失败: ${err instanceof Error ? err.message : err}`);
    }
    return next();
  };
}
