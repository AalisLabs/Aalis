// ----- 宿主问触发提供者：截止时间与附件识别等待 -----

import type { MediaService } from '@aalis/api-media';
import type { TriggerDecision, TriggerInput, TriggerProvider } from '@aalis/api-trigger';
import type { Logger, ServiceRef } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';

/**
 * 一条消息的附件识别：提供者按需启动并限时等待。宿主放行与归档都不等识别跑完：agent 预处理器与
 * 归档对同一个消息对象调 processMessage，按对象记忆命中这次识别（在途则等它），不再识别第二遍
 */
export interface AttachmentRecognition {
  /** 提供者要附件描述时调用：尚无描述且 media 在场才启动识别（每条消息只启动一次），限时等待，永不抛错 */
  wait(): Promise<void>;
}

export function createAttachmentRecognition(
  message: IncomingMessage,
  media: Pick<ServiceRef<MediaService>, 'current'>,
  waitMs: number,
  logger: Logger,
): AttachmentRecognition {
  let bounded: Promise<void> | undefined;
  return {
    wait() {
      if (bounded) return bounded;
      const svc = media.current;
      if (!svc || !message.attachments?.length || message._attachmentDescriptions) return Promise.resolve();
      const recognition = Promise.resolve()
        .then(() => svc.processMessage(message))
        .then(
          () => undefined,
          err => logger.warn(`[trigger] 附件识别失败: ${err}`),
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>(resolve => {
        timer = setTimeout(resolve, waitMs);
      });
      bounded = Promise.race([recognition, timeout]).finally(() => clearTimeout(timer));
      return bounded;
    },
  };
}

/** 问一个提供者的结果：decision 为 null 即弃权，abstain 记原因（出错时带上错误） */
interface ProviderAnswer {
  decision: TriggerDecision | null;
  abstain?: '弃权' | '超时' | '出错';
  error?: unknown;
}

/**
 * 问一个提供者，带截止时间。截止时间只计提供者自己的耗时：它等附件识别的那段暂停计时
 * （识别另有 mediaWaitMs 上限）。返回 null、抛错与超时都算弃权。超时或得出结果后宿主即放弃
 * 这个提供者：它再等附件描述时直接返回，不启动识别，也不再计时。
 */
export function askProvider(
  provider: TriggerProvider,
  input: Omit<TriggerInput, 'awaitAttachmentDescriptions'>,
  attachments: AttachmentRecognition,
  timeoutMs: number,
): Promise<ProviderAnswer> {
  return new Promise(resolve => {
    let remaining = timeoutMs;
    let since = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = 0;
    let done = false;
    const finish = (answer: ProviderAnswer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const arm = (): void => {
      since = Date.now();
      timer = setTimeout(() => finish({ decision: null, abstain: '超时' }), remaining);
    };
    arm();
    Promise.resolve()
      .then(() =>
        provider.decide({
          ...input,
          async awaitAttachmentDescriptions() {
            if (done) return;
            if (waiting++ === 0) {
              clearTimeout(timer);
              remaining -= Date.now() - since;
            }
            try {
              await attachments.wait();
            } finally {
              if (--waiting === 0 && !done) arm();
            }
          },
        }),
      )
      .then(
        decision => finish(decision ? { decision } : { decision: null, abstain: '弃权' }),
        error => finish({ decision: null, abstain: '出错', error }),
      );
  });
}
