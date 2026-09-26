// ----- 附件识别限时等待 -----

import type { MediaService } from '@aalis/api-media';
import type { Logger, ServiceRef } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';

/**
 * 等这条消息的附件识别写好 `_attachmentDescriptions`，最多 waitMs 毫秒。带附件、尚无描述且 media 在场
 * 才启动识别；超时照常返回（识别在后台继续，描述可能仍缺），识别失败记 warn，永不抛错。
 *
 * 放行与吞掉都不必等识别跑完：agent 预处理器与归档对同一个消息对象调 processMessage，media 按消息
 * 对象记忆命中这次识别（在途则等它），不再识别第二遍。
 */
export async function waitForAttachmentDescriptions(
  message: IncomingMessage,
  media: Pick<ServiceRef<MediaService>, 'current'>,
  waitMs: number,
  logger: Logger,
): Promise<void> {
  const svc = media.current;
  if (!svc || !message.attachments?.length || message._attachmentDescriptions) return;
  const recognition = Promise.resolve()
    .then(() => svc.processMessage(message))
    .then(
      () => undefined,
      err => logger.warn(`[laya] 附件识别失败: ${err}`),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([recognition, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
