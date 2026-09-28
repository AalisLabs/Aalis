import type { PublishOrigin } from '@aalis/api-publish';
import type { Events, Logger } from '@aalis/core';
import { selfInitiatedActor } from '@aalis/schema-message';

/** 待发正文由 ReviewStore 持久化；冷启动不开闸，失败不确认投递。 */
export class ReviewNotices {
  #open = false;
  #closed = false;
  constructor(
    private readonly events: Events,
    private readonly logger: Logger,
  ) {}
  open(): void {
    this.#open = true;
  }
  close(): void {
    this.#closed = true;
  }
  async enqueue(origin: PublishOrigin, content: string, id: string): Promise<void> {
    if (!this.#open || this.#closed) throw new Error('作品通知尚未开放');
    if (!origin.notify) return;
    try {
      await this.events.emit('inbound:message', {
        content,
        sessionId: origin.notify.sessionId,
        platform: origin.notify.platform,
        source: `publish:${id}`,
        actor: selfInitiatedActor(origin.notify.platform),
        hostNotice: { kind: 'publish-review', id },
      });
    } catch (error) {
      this.logger.warn(`作品 ${id} 的通知注入失败，稍后重试`);
      throw error;
    }
  }
}
