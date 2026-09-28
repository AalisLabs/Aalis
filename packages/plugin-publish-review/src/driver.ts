import type { Logger } from '@aalis/core';
import type { PublishReviewService } from './service.js';
import type { ReviewStore } from './state.js';

/** 单件串行审核；apply 不执行模型或网络请求，停止后不再出队。 */
export class ReviewDriver {
  #open = false;
  #timer?: ReturnType<typeof setTimeout>;
  #periodic?: ReturnType<typeof setInterval>;
  #flight?: Promise<void>;
  readonly #off: () => void;
  constructor(
    private readonly service: PublishReviewService,
    private readonly store: ReviewStore,
    private readonly signal: AbortSignal,
    private readonly logger: Logger,
  ) {
    this.#off = service.onQueueChange(() => this.kick());
  }
  start(): void {
    if (this.#open || this.signal.aborted) return;
    this.#open = true;
    this.#periodic = setInterval(() => this.kick(), 30_000);
    this.kick();
  }
  kick(): void {
    if (!this.#open || this.signal.aborted || this.#flight || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flight = this.#run()
        .catch(() => this.logger.warn('作品审核暂时失败，稍后重试'))
        .finally(() => {
          this.#flight = undefined;
        });
    }, 0);
  }
  async stop(): Promise<void> {
    this.#open = false;
    this.#off();
    clearTimeout(this.#timer);
    clearInterval(this.#periodic);
    await this.#flight;
  }
  async #run(): Promise<void> {
    await this.service.flushNotices();
    await this.service.reconcile();
    while (
      this.#open &&
      !this.signal.aborted &&
      !this.store.failure &&
      Object.values(this.store.data.queue).some(item => item.state !== 'awaiting-owner')
    ) {
      await this.service.processNext();
    }
  }
}
