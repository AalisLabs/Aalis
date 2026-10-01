import { AsyncLocalStorage } from 'node:async_hooks';
import type {} from '@aalis/api-agent';
import type { GatewayService } from '@aalis/api-gateway';
import type { HookContextMap, Hooks } from '@aalis/api-hooks';
import type { PublishOrigin } from '@aalis/api-publish';
import { wrapUntrustedContent } from '@aalis/api-tools';
import type { Events, Logger, ServiceRef } from '@aalis/core';
import { awaitDelivery, type OutgoingMessage, selfInitiatedActor } from '@aalis/schema-message';

/**
 * 等平台回执的上限：适配器每个发送分支都会结算（OneBot 单个附件最坏约 150 秒），这里只防它一直不结算时卡住
 * 整条通知队列；插件停机时立即不等
 */
const DELIVERY_WAIT_MS = 5 * 60_000;

/**
 * 通知已进入出站总线、平台却没确认收下（没有适配器接手、发送失败、等不到回执）。服务据此记下「已转述过」，
 * 下次重发直接发宿主原文，不再让她转述一遍。用 {@link isNoticeUndelivered} 认，不用 instanceof
 */
class NoticeUndelivered extends Error {
  override name = 'NoticeUndelivered';
}

export function isNoticeUndelivered(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'NoticeUndelivered';
}

/**
 * 待发正文由 ReviewStore 持久化。第一次由她按人设转述（宿主通知回合），转述静默或出错时派发宿主正文兜底；
 * 平台确认收下才算发出。重发（direct）直接派发宿主正文，同样等平台确认。
 */
export class ReviewNotices {
  #open = false;
  #closed = false;
  constructor(
    private readonly events: Events,
    private readonly logger: Logger,
    private readonly gateway: ServiceRef<GatewayService>,
    private readonly hooks: Hooks,
    /** 插件的生命周期信号：停机时不再等平台回执，免得拖过清理时限 */
    private readonly signal?: AbortSignal,
  ) {}
  open(): void {
    this.#open = true;
  }
  close(): void {
    this.#closed = true;
  }
  ready(): boolean {
    return this.#open && !this.#closed && !!this.gateway.current;
  }
  async enqueue(
    origin: PublishOrigin,
    content: string,
    id: string,
    title?: string,
    opts: { direct?: boolean } = {},
  ): Promise<void> {
    if (!this.#open || this.#closed) throw new Error('作品通知尚未开放');
    if (!origin.notify) return;
    const gateway = this.gateway.current;
    if (!gateway) throw new Error('作品通知等待消息网关');
    const { sessionId, platform } = origin.notify;
    // 仅观察这次可等待调用内的出站：同房其他通知/真人回合不能代它确认。
    // 用异步调用归属而非消息对象引用，中间件复制或改写信封仍可识别；记下的是总线上实际发出的那个对象，
    // 平台适配器把回执填在它上面。
    const scope = new AsyncLocalStorage<boolean>();
    let sent: OutgoingMessage | undefined;
    let fallback = opts.direct === true;
    let outcome: HookContextMap['agent:turn:after']['outcome'] | undefined;
    const offOutbound = this.events.on('outbound:message', message => {
      if (
        scope.getStore() &&
        message.content.trim().length > 0 &&
        message.sessionId === sessionId &&
        (message.platform === undefined || message.platform === platform) &&
        message.hostNotice?.kind === 'publish-review' &&
        message.hostNotice.id === id &&
        (message.source === 'agent' || (fallback && message.source === 'system'))
      )
        sent = message;
    });
    const offTurn = this.hooks.middleware('agent:turn:after', async (data, next) => {
      if (scope.getStore() && data.sessionId === sessionId && data.message.source === `publish:${id}`) {
        outcome = data.outcome;
      }
      await next();
    });
    const offDispatch = this.hooks.middleware('outbound:dispatch', async (data, next) => {
      if (
        this.#closed &&
        scope.getStore() &&
        data.message.sessionId === sessionId &&
        data.message.hostNotice?.kind === 'publish-review' &&
        data.message.hostNotice.id === id
      )
        return;
      await next();
    });
    // 宿主正文：重发时直接发；转述静默或出错时兜底。正文由宿主根据账本生成，绝不发送格式校验失败的模型原文
    const dispatchHostText = () =>
      gateway.dispatchOutbound({
        content: `[作品通知] ${content}`,
        sessionId,
        platform,
        source: 'system',
        hostNotice: { kind: 'publish-review', id },
      });
    let failure: unknown;
    try {
      await scope.run(true, async () => {
        if (opts.direct) {
          await dispatchHostText();
          return;
        }
        await gateway.ingressMessage({
          content,
          sessionId,
          platform,
          source: `publish:${id}`,
          actor: selfInitiatedActor(platform),
          hostNotice: {
            kind: 'publish-review',
            id,
            reportOnly: true,
            ...(title ? { untrusted: wrapUntrustedContent(title, '作品标题') } : {}),
          },
        });
        // 只兜底已走完整入站流程的静默回合，不绕过禁言、取消或停机。
        if (!sent && (outcome === 'silent' || outcome === 'error') && !this.#closed) {
          this.logger.warn(`作品 ${id} 的转述回合${outcome === 'silent' ? '静默' : '失败'}，改派发宿主结果通知`);
          fallback = true;
          await dispatchHostText();
        }
      });
    } catch (error) {
      // 已出站后后置观察者抛错不能让通知重发；平台有没有收下照样看回执。
      failure = error;
    } finally {
      offTurn();
      offOutbound();
      offDispatch();
      scope.disable();
    }
    const message = sent as OutgoingMessage | undefined;
    if (!message) {
      this.logger.warn(`作品 ${id} 的通知尚未派发，保留待发状态`);
      throw failure ?? new Error('作品通知未进入出站总线');
    }
    await this.#confirm(message, id);
  }

  /** 等平台确认收下；没确认就抛 {@link NoticeUndelivered}，留待重发 */
  async #confirm(message: OutgoingMessage, id: string): Promise<void> {
    const delivery = message.delivery;
    if (!delivery) throw new NoticeUndelivered('没有平台适配器接手这条通知');
    const result = await awaitDelivery(delivery, this.signal, DELIVERY_WAIT_MS);
    if (!result) {
      throw new NoticeUndelivered(this.signal?.aborted ? '停机时这条通知还没得到平台确认' : '平台一直没有确认这条通知');
    }
    if (!result.ok) {
      this.logger.warn(`作品 ${id} 的通知平台没有收下：${result.error}`);
      throw new NoticeUndelivered(`平台没有收下这条通知：${result.error}`);
    }
  }
}
