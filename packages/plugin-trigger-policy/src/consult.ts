// ----- 宿主问触发提供者：截止时间与附件识别等待 -----

import type { MediaService } from '@aalis/api-media';
import type { TriggerDecision, TriggerInput, TriggerProvider } from '@aalis/api-trigger';
import type { Logger, ServiceRef } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';

/** 一条消息的附件识别：提供者按需启动并限时等待；宿主往下传或归档前等它跑完 */
export interface AttachmentRecognition {
  /** 提供者要附件描述时调用：尚无描述且 media 在场才启动识别（每条消息只启动一次），限时等待，永不抛错 */
  wait(): Promise<void>;
  /** 宿主判定结束时调用：此后不再启动识别；已启动的等它跑完（不设上限，错误已吞） */
  settle(): Promise<void>;
}

export function createAttachmentRecognition(
  message: IncomingMessage,
  media: Pick<ServiceRef<MediaService>, 'current'>,
  waitMs: number,
  logger: Logger,
): AttachmentRecognition {
  let recognition: Promise<void> | undefined;
  let bounded: Promise<void> | undefined;
  let settled = false;
  return {
    wait() {
      if (bounded) return bounded;
      const svc = media.current;
      if (settled || !svc || !message.attachments?.length || message._attachmentDescriptions) return Promise.resolve();
      recognition = Promise.resolve()
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
    async settle() {
      settled = true;
      await recognition;
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
 * （识别另有 mediaWaitMs 上限）。返回 null、抛错与超时都算弃权。
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
    const arm = (): void => {
      since = Date.now();
      timer = setTimeout(() => resolve({ decision: null, abstain: '超时' }), remaining);
    };
    arm();
    Promise.resolve()
      .then(() =>
        provider.decide({
          ...input,
          async awaitAttachmentDescriptions() {
            if (waiting++ === 0) {
              clearTimeout(timer);
              remaining -= Date.now() - since;
            }
            try {
              await attachments.wait();
            } finally {
              if (--waiting === 0) arm();
            }
          },
        }),
      )
      .then(
        decision => resolve(decision ? { decision } : { decision: null, abstain: '弃权' }),
        error => resolve({ decision: null, abstain: '出错', error }),
      )
      .finally(() => clearTimeout(timer));
  });
}
